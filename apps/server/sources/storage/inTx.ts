import { delay } from "@/utils/delay";
import { db } from "@/storage/db";
import { getDbProviderFromEnv, isPrismaErrorCode, type TransactionClient } from "@/storage/prisma";

export type Tx = TransactionClient;

const symbol = Symbol();

export function afterTx(tx: Tx, callback: () => void) {
    // Golden rule:
    // - Do NOT emit socket updates inside a DB transaction.
    // - Instead, schedule them with afterTx so they only fire after commit.
    //
    // `afterTx` is only valid for transactions created via `inTx()`.
    const callbacks = (tx as any)[symbol] as (() => void)[] | undefined;
    if (!callbacks) {
        throw new Error('afterTx(tx, ...) called outside inTx() transaction');
    }
    callbacks.push(callback);
}

export async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    let counter = 0;
    let wrapped = async (tx: Tx) => {
        (tx as any)[symbol] = [];
        let result = await fn(tx);
        let callbacks = (tx as any)[symbol] as (() => void)[];
        return { result, callbacks };
    }
    while (true) {
        try {
            const provider = getDbProviderFromEnv(process.env, "postgres");
            const txOpts = provider === "sqlite" ? null : { isolationLevel: "Serializable" as const, timeout: 10000 };
            let result = txOpts ? await db.$transaction(wrapped, txOpts) : await db.$transaction(wrapped);
            for (let callback of result.callbacks) {
                try {
                    callback();
                } catch (e) { // Ignore errors in callbacks because they are used mostly for notifications
                    console.error(e);
                }
            }
            return result.result;
        } catch (e) {
            if (isPrismaErrorCode(e, "P2034") && counter < 3) {
                counter++;
                await delay(counter * 100);
                continue;
            }
            throw e;
        }
    }
}
