import { inReadSnapshot, type InTxOptions, type Tx } from "./inTx";

export async function captureReadSnapshot<T, Capture = T>(
    read: ((tx: Tx) => Promise<T>) | Readonly<{
        capture: (tx: Tx) => Promise<Capture>;
        materialize: (captured: Capture) => Promise<T>;
    }>,
    options?: Pick<InTxOptions, "transactionClass">,
): Promise<T> {
    if (typeof read === "function") return inReadSnapshot(read, options);
    const captured = await inReadSnapshot(read.capture, options);
    return read.materialize(captured);
}
