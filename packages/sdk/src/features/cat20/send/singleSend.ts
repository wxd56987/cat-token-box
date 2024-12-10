import { CatPsbt, DUST_LIMIT } from '../../../lib/catPsbt'
import { Ripemd160, Sig, UTXO } from 'scrypt-ts'
import { Postage } from '../../../lib/constants'
import { Signer } from '../../../lib/signer'
import { getDummyUtxo, getDummyUtxos, isP2TR } from '../../../lib/utils'
import {
    UtxoProvider,
    ChainProvider,
    Cat20Utxo,
    markSpent,
} from '../../../lib/provider'
import { Psbt } from 'bitcoinjs-lib'
import { int32, MAX_INPUT } from '../../../contracts/utils/txUtil'
import {
    CAT20Covenant,
    TracedCat20Token,
} from '../../../covenants/cat20Covenant'
import {
    Cat20GuardCovenant,
    GuardType,
} from '../../../covenants/cat20GuardCovenant'
import { pickLargeFeeUtxo } from './pick'
import { FbtcCat20SwapperCovenant } from '../../../covenants/fbtcCat20SwapperCovenant2'
import { PoolState, SwapDirection } from '../../../contracts/token/fbtcCat20Swapper2'

/**
 * Send CAT20 tokens to the list of recipients.
 * @param signer a signer, such as {@link DefaultSigner} or {@link UnisatSigner}
 * @param utxoProvider a  {@link UtxoProvider}
 * @param chainProvider a  {@link ChainProvider}
 * @param minterAddr the minter address of the CAT20 token
 * @param inputTokenUtxos CAT20 token utxos to be sent
 * @param receivers the recipient's address and token amount
 * @param tokenChangeAddress the address to receive change CAT20 tokens
 * @param feeRate the fee rate for constructing transactions
 * @returns the guard transaction, the send transaction and the CAT20 token outputs
 */
export async function singleSend(
    signer: Signer,
    utxoProvider: UtxoProvider,
    chainProvider: ChainProvider,
    minterAddr: string,
    inputTokenUtxos: Cat20Utxo[],
    receivers: Array<{
        address: Ripemd160
        amount: int32
    }>,
    tokenChangeAddress: Ripemd160,
    feeRate: number
): Promise<{
    guardTx: CatPsbt
    sendTx: CatPsbt
    sendTxId: string
    guardTxId: string
    newCat20Utxos: Cat20Utxo[]
    changeTokenOutputIndex: number
}> {
    const pubkey = await signer.getPublicKey()
    const changeAddress = await signer.getAddress()

    const tracableTokens = await CAT20Covenant.backtrace(
        inputTokenUtxos.map((utxo) => {
            return { ...utxo, minterAddr }
        }),
        chainProvider
    )

    const inputTokens = tracableTokens.map((token) => token.token)

    const { guard, outputTokens, changeTokenOutputIndex } =
        CAT20Covenant.createTransferGuard(
            inputTokens.map((token, i) => ({
                token,
                inputIndex: i,
            })),
            receivers.map((receiver, index) => ({
                ...receiver,
                outputIndex: index + 1,
            })),
            {
                address: tokenChangeAddress,
            }
        )

    const preState: PoolState = {
        fbReserve: 0n,
        tokenReserve: 104447282n,
    }

    const swapper = new FbtcCat20SwapperCovenant(preState)

    const { estGuardTxVSize, dummyGuardPsbt } = estimateGuardTxVSize(
        guard.bindToUtxo({ ...getDummyUtxo(changeAddress), script: undefined }),
        swapper.bindToUtxo({
            ...getDummyUtxo(changeAddress),
            script: undefined,
        }),
        changeAddress
    )

    const estSendTxVSize = estimateSentTxVSize(
        tracableTokens,
        guard,
        swapper,
        dummyGuardPsbt,
        pubkey,
        outputTokens,
        changeAddress,
        feeRate
    )

    const total =
        feeRate * (estGuardTxVSize + estSendTxVSize) +
        Postage.TOKEN_POSTAGE +
        Postage.CURVE_POSTAGE // for a token change output

    const utxos = await utxoProvider.getUtxos(changeAddress, { total })

    if (utxos.length === 0) {
        throw new Error('Insufficient satoshis input amount')
    }

    const feeUtxo = pickLargeFeeUtxo(utxos)

    const guardPsbt = buildGuardTx(
        guard,
        swapper,
        feeUtxo,
        changeAddress,
        feeRate,
        estGuardTxVSize
    )

    const sendPsbt = buildSendTx(
        tracableTokens,
        guard,
        swapper,
        guardPsbt,
        pubkey,
        outputTokens,
        changeAddress,
        feeRate,
        estSendTxVSize
    )

    // sign the psbts
    const [signedGuardPsbt, signedSendPsbt] = await signer.signPsbts([
        {
            psbtHex: guardPsbt.toHex(),
            options: guardPsbt.psbtOptions(),
        },
        {
            psbtHex: sendPsbt.toHex(),
            options: sendPsbt.psbtOptions(),
        },
    ])

    // combine and finalize the psbts
    const guardTxPsbt = await guardPsbt
        .combine(Psbt.fromHex(signedGuardPsbt))
        .finalizeAllInputsAsync()
    const guardTx = guardTxPsbt.extractTransaction()
    await chainProvider.broadcast(guardTx.toHex())
    markSpent(utxoProvider, guardTx)

    const sendTxPsbt = await sendPsbt
        .combine(Psbt.fromHex(signedSendPsbt))
        .finalizeAllInputsAsync()

    const sendTx = sendTxPsbt.extractTransaction()
    // broadcast the transactions

    await chainProvider.broadcast(sendTx.toHex())
    markSpent(utxoProvider, sendTx)

    const txStatesInfo = sendPsbt.getTxStatesInfo()
    const newCat20Utxos: Cat20Utxo[] = outputTokens
        .filter((outputToken) => typeof outputToken !== 'undefined')
        .map((covenant, index) => ({
            utxo: {
                txId: sendTx.getId(),
                outputIndex: index + 1,
                script: Buffer.from(sendTx.outs[index + 1].script).toString(
                    'hex'
                ),
                satoshis: Number(sendTx.outs[index + 1].value),
            },
            txoStateHashes: txStatesInfo.txoStateHashes,
            state: covenant.state,
        }))

    const newFeeUtxo = sendPsbt.getChangeUTXO()

    utxoProvider.addNewUTXO(newFeeUtxo)

    return {
        sendTxId: sendTx.getId(),
        guardTxId: guardTx.getId(),
        guardTx: guardTxPsbt,
        sendTx: sendPsbt,
        newCat20Utxos,
        changeTokenOutputIndex,
    }
}

function buildGuardTx(
    guard: Cat20GuardCovenant,
    swapper: FbtcCat20SwapperCovenant,
    feeUtxo: UTXO,
    changeAddress: string,
    feeRate: number,
    estimatedVSize?: number
) {
    if (
        feeUtxo.satoshis <
        Postage.GUARD_POSTAGE +
            Postage.CURVE_POSTAGE +
            feeRate * (estimatedVSize || 1)
    ) {
        throw new Error('Insufficient satoshis input amount')
    }

    const guardTx = new CatPsbt()
        .addFeeInputs([feeUtxo])
        .addCovenantOutput(guard, Postage.GUARD_POSTAGE)
        .addCovenantOutput(swapper, Postage.CURVE_POSTAGE)
        .change(changeAddress, feeRate, estimatedVSize)

    guard.bindToUtxo(guardTx.getUtxo(1))
    swapper.bindToUtxo(guardTx.getUtxo(2))

    return guardTx
}

function estimateGuardTxVSize(
    guard: Cat20GuardCovenant,
    swapper: FbtcCat20SwapperCovenant,
    changeAddress: string
) {
    const dummyGuardPsbt = buildGuardTx(
        guard,
        swapper,
        getDummyUtxos(changeAddress, 1)[0],
        changeAddress,
        DUST_LIMIT
    )
    return {
        dummyGuardPsbt,
        estGuardTxVSize: dummyGuardPsbt.estimateVSize(),
    }
}

function buildSendTx(
    tracableTokens: TracedCat20Token[],
    guard: Cat20GuardCovenant,
    swapper: FbtcCat20SwapperCovenant,
    guardPsbt: CatPsbt,
    pubKey: string,
    outputTokens: (CAT20Covenant | undefined)[],
    changeAddress: string,
    feeRate: number,
    estimatedVSize?: number
) {
    const inputTokens = tracableTokens.map((token) => token.token)

    if (inputTokens.length + 2 > MAX_INPUT) {
        throw new Error(
            `Too many inputs that exceed the maximum input limit of ${MAX_INPUT}`
        )
    }

    const sendPsbt = new CatPsbt()

    // add token outputs
    for (const outputToken of outputTokens) {
        if (outputToken) {
            sendPsbt.addCovenantOutput(outputToken, Postage.TOKEN_POSTAGE)
        }
    }

    // add token inputs
    for (const inputToken of inputTokens) {
        sendPsbt.addCovenantInput(inputToken)
    }

    sendPsbt
        .addCovenantInput(guard, GuardType.Transfer)
        .addCovenantInput(swapper, 'swap')
        .addFeeInputs([guardPsbt.getUtxo(3)])
        .change(changeAddress, feeRate, estimatedVSize)

    const inputCtxs = sendPsbt.calculateInputCtxs()
    const guardInputIndex = inputTokens.length
    const swapperInputIndex = inputTokens.length + 1
    // unlock tokens
    for (let i = 0; i < inputTokens.length; i++) {
        sendPsbt.updateCovenantInput(
            i,
            inputTokens[i],
            inputTokens[i].userSpend(
                i,
                inputCtxs,
                tracableTokens[i].trace,
                guard.getGuardInfo(guardInputIndex, guardPsbt.toTxHex()),
                isP2TR(changeAddress),
                pubKey
            )
        )
    }

    // unlock guard
    sendPsbt.updateCovenantInput(
        guardInputIndex,
        guard,
        guard.transfer(
            guardInputIndex,
            inputCtxs,
            outputTokens,
            guardPsbt.toTxHex()
        )
    )

    const afterPoolState: PoolState = {
        fbReserve: 20n,
        tokenReserve: 96986762n,
    }

    const direction = SwapDirection.FBToCAT20
    const slippage = 10n

    // const signature = await signer.signMessage(messageToSign)
    const base64Sig =
        'H4eKEzoLWSbyvkpSlVbes1F3v335iRqSpLBz+DYi7RWNC7BAf4zsQ8TXgC4k5mTQ4OrBdV8AxdYWMpY5w7TTLmE='
    const hexSig = Buffer.from(base64Sig, 'base64').toString('hex')
    const sig = Sig(hexSig)

    // unlock swapper
    sendPsbt.updateCovenantInput(
        swapperInputIndex,
        swapper,
        swapper.swap(
            swapperInputIndex,
            inputCtxs,
            afterPoolState,
            direction,
            slippage,
            sig
        )
    )

    return sendPsbt
}

function estimateSentTxVSize(
    tracableTokens: TracedCat20Token[],
    guard: Cat20GuardCovenant,
    swapper: FbtcCat20SwapperCovenant,
    guardPsbt: CatPsbt,
    pubKey: string,
    outputTokens: CAT20Covenant[],
    changeAddress: string,
    feeRate: number
) {
    return buildSendTx(
        tracableTokens,
        guard,
        swapper,
        guardPsbt,
        pubKey,
        outputTokens,
        changeAddress,
        feeRate
    ).estimateVSize()
}
