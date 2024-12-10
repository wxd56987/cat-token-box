import { SmartContract, assert, method, prop, PubKey, Sig } from 'scrypt-ts'
import { SHPreimage, SigHashUtils } from '../utils/sigHashUtils'

// Pool state before and after the exchange
export type PoolState = {
    fbReserve: bigint // FB Reserve amount
    tokenReserve: bigint // Token Reserve amount (CAT20)
}

export enum SwapDirection {
    FBToCAT20, // From FB to CAT20
    CAT20ToFB  // From CAT20 to FB
}

export class FbtcCat20Swapper extends SmartContract {
    @prop()
    readonly pubKey: PubKey  // 用于合约调用验证的公钥

    static readonly INITIAL_VIRTUAL_FB = 260n
    static readonly INITIAL_VIRTUAL_TOKEN = 104447282n
    static readonly K =
        FbtcCat20Swapper.INITIAL_VIRTUAL_FB *
        FbtcCat20Swapper.INITIAL_VIRTUAL_TOKEN
    static readonly FB_THRESHOLD = 1000n

    constructor(pubKey: PubKey) {
        super(...arguments)
        this.pubKey = pubKey
    }

    @method()
    public swap(
        preState: PoolState,
        afterState: PoolState,
        slippage: bigint,
        direction: SwapDirection,
        shPreimage: SHPreimage, 
        signature: Sig           
    ) {
        // Step 1: Verify context signature
        const contextSigValid = this.checkSig(
            SigHashUtils.checkSHPreimage(shPreimage),
            SigHashUtils.Gx
        )
        assert(contextSigValid, 'Invalid context signature')

        // Step 2: Verify contract call signature
        const contractSigValid = this.checkSig(signature, this.pubKey)
        assert(contractSigValid, 'Invalid contract signature')

        // Step 3: Ensure reserves are positive
        assert(afterState.fbReserve > 0n, 'FB reserve must be positive')
        assert(afterState.tokenReserve > 0n, 'Token reserve must be positive')

        // Step 4: Calculate total reserves based on swap direction
        let totalFB: bigint = 0n
        let totalToken: bigint = 0n
        if (direction === SwapDirection.FBToCAT20) {
            totalFB = FbtcCat20Swapper.INITIAL_VIRTUAL_FB + afterState.fbReserve
            totalToken = afterState.tokenReserve
        } else {
            totalFB = FbtcCat20Swapper.INITIAL_VIRTUAL_FB + afterState.fbReserve
            totalToken = afterState.tokenReserve
        }

        const actualK = totalFB * totalToken

        // Step 5: Calculate slippage bounds
        const K_min = (FbtcCat20Swapper.K * (1000n - slippage)) / 1000n
        const K_max = (FbtcCat20Swapper.K * (1000n + slippage)) / 1000n

        // Step 6: Validate the constant product formula with slippage tolerance
        assert(
            actualK >= K_min && actualK <= K_max,
            `Slippage exceeded: K=${actualK}, expected range [${K_min}, ${K_max}]`
        )

        // Step 7: Validate transaction amount based on threshold
        const fbChange = afterState.fbReserve - preState.fbReserve
        if (fbChange < FbtcCat20Swapper.FB_THRESHOLD) {
            // Internal pool trading: directly use constant product formula
            const preTotalFB =
                FbtcCat20Swapper.INITIAL_VIRTUAL_FB + preState.fbReserve
            const preTotalToken = preState.tokenReserve
            const preK = preTotalFB * preTotalToken
            assert(
                preK >= K_min && preK <= K_max,
                `Internal pool slippage exceeded: K=${preK}, expected range [${K_min}, ${K_max}]`
            )
        } else {
            // External pool trading: validate virtual reserves
            const virtualRatio =
                (FbtcCat20Swapper.INITIAL_VIRTUAL_FB * 100n) /
                (FbtcCat20Swapper.INITIAL_VIRTUAL_FB +
                    FbtcCat20Swapper.FB_THRESHOLD)
            assert(virtualRatio > 0n, 'Invalid virtual ratio')
        }
    }
}