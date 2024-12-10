import {
    ByteString,
    int2ByteString,
    PubKey,
    Sig,
    toByteString,
} from 'scrypt-ts'
import { Covenant } from '../lib/covenant'
import { CatPsbt, SubContractCall } from '../lib/catPsbt'
import { TapLeafSmartContract } from '../lib/tapLeafSmartContract'
import { InputContext } from '../contracts/utils/sigHashUtils'
import { SupportedNetwork } from '../lib/constants'
import {
    FbtcCat20Swapper,
    PoolState,
    SwapDirection,
} from '../contracts/token/fbtcCat20Swapper2'

export class FbtcCat20SwapperCovenant extends Covenant<PoolState> {
    // locked artifacts md5
    static readonly LOCKED_ASM_VERSION = '90ee4063b5bd3dd22db407e73f5d1a93'
    static readonly PUBLICK_KEY = PubKey(
        toByteString(
            '03669377d2f0adc28c810262280795544d648c0c8a03eb525ac182a0d7d08b9308'
        )
    )

    constructor(state?: PoolState, network?: SupportedNetwork) {
        super(
            [
                {
                    alias: 'swap',
                    contract: new FbtcCat20Swapper(
                        FbtcCat20SwapperCovenant.PUBLICK_KEY
                    ),
                },
            ],
            {
                lockedAsmVersion: FbtcCat20SwapperCovenant.LOCKED_ASM_VERSION,
                network,
            }
        )
        this.state = state
    }

    serializedState(): ByteString {
        const state = this.state
        if (!state) {
            throw new Error('Pool state is not available')
        }
        return (
            int2ByteString(state.fbReserve) + int2ByteString(state.tokenReserve)
        )
    }

    swap(
        inputIndex: number,
        inputCtxs: Map<number, InputContext>,
        afterState: PoolState,
        direction: SwapDirection, // 增加 direction 参数来确定交易方向
        slippage: bigint, // 滑点容忍度
        signature: Sig
    ): SubContractCall {
        const inputCtx = inputCtxs.get(inputIndex)
        if (!inputCtx) {
            throw new Error('Input context is not available')
        }

        const preState = this.state
        if (!preState) {
            throw new Error('Pool state is not available')
        }

        if (afterState.fbReserve <= 0n || afterState.tokenReserve <= 0n) {
            throw new Error('Invalid pool reserves')
        }

        let totalFB: bigint, totalToken: bigint
        if (direction === SwapDirection.FBToCAT20) {
            totalFB = FbtcCat20Swapper.INITIAL_VIRTUAL_FB + afterState.fbReserve
            totalToken = afterState.tokenReserve
        } else {
            totalFB = FbtcCat20Swapper.INITIAL_VIRTUAL_FB + afterState.fbReserve
            totalToken = afterState.tokenReserve
        }

        const actualK = totalFB * totalToken
        const K_min = (FbtcCat20Swapper.K * (1000n - slippage)) / 1000n
        const K_max = (FbtcCat20Swapper.K * (1000n + slippage)) / 1000n

        // 滑点检查：确保实际的 K 在容忍范围内
        if (actualK < K_min || actualK > K_max) {
            throw new Error(
                `Slippage exceeded: K=${actualK}, expected range [${K_min}, ${K_max}]`
            )
        }

        const fbDiff = afterState.fbReserve - preState.fbReserve
        if (fbDiff < FbtcCat20Swapper.FB_THRESHOLD) {
            const preTotalFB =
                FbtcCat20Swapper.INITIAL_VIRTUAL_FB + preState.fbReserve
            const preTotalToken = preState.tokenReserve
            const preK = preTotalFB * preTotalToken

            // 内部池交易：检查 K 是否在容忍范围内
            if (preK < K_min || preK > K_max) {
                throw new Error(
                    `Internal pool slippage exceeded: K=${preK}, expected range [${K_min}, ${K_max}]`
                )
            }
        } else {
            const virtualRatio =
                (FbtcCat20Swapper.INITIAL_VIRTUAL_FB * 100n) /
                (FbtcCat20Swapper.INITIAL_VIRTUAL_FB +
                    FbtcCat20Swapper.FB_THRESHOLD)
            if (virtualRatio <= 0n) {
                throw new Error('Invalid virtual ratio')
            }
        }

        return {
            method: 'swap',
            contractAlias: 'swap',
            argsBuilder: (
                curPsbt: CatPsbt,
                tapLeafContract: TapLeafSmartContract
            ) => {
                const { shPreimage } = inputCtx
                const args = []
                args.push(preState) // preState
                args.push(afterState) // afterState
                args.push(slippage) // slippage
                args.push(direction) // 传入方向
                args.push(shPreimage) // shPreimage
                args.push(signature) // sig
                return args
            },
        }
    }
}
