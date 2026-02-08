export type AfterTxCallback = () => void | Promise<void>;
export type TxWithAfterTxCallbacks = {
    __afterTxCallbacks: AfterTxCallback[];
};

export function withAfterTxCallbacks<TTx extends object>(
    txState: TTx,
): TTx & TxWithAfterTxCallbacks {
    return {
        __afterTxCallbacks: [],
        ...txState,
    };
}

export function registerAfterTxCallback(
    tx: TxWithAfterTxCallbacks,
    callback: AfterTxCallback,
): void {
    tx.__afterTxCallbacks.push(callback);
}

export async function flushAfterTxCallbacks(
    tx: TxWithAfterTxCallbacks,
): Promise<void> {
    for (const callback of tx.__afterTxCallbacks) {
        await callback();
    }
}

export function createInTxHarness<TTx extends object>(createTxState: () => TTx) {
    const afterTx = (tx: any, callback: AfterTxCallback) => {
        registerAfterTxCallback(tx, callback);
    };

    const inTx = async <T>(fn: (tx: TTx) => Promise<T>): Promise<T> => {
        const tx = withAfterTxCallbacks(createTxState()) as any;

        const result = await fn(tx as TTx);
        await flushAfterTxCallbacks(tx);
        return result;
    };

    return { inTx, afterTx };
}
