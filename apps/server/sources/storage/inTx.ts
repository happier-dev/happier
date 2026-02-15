import { delay } from "@/utils/runtime/delay";
import { db } from "@/storage/db";
import { getDbProviderFromEnv, isPrismaErrorCode, type TransactionClient } from "@/storage/prisma";

export type Tx = TransactionClient;

const symbol = Symbol();

function errorMessage(err: unknown): string {
    if (err instanceof Error && typeof err.message === "string") return err.message;
    if (err && typeof err === "object" && "message" in err) {
        const value = (err as any).message;
        if (typeof value === "string") return value;
    }
    return "";
}

export function isRetryableTransactionError(params: Readonly<{ provider: string; err: unknown }>): boolean {
    if (isPrismaErrorCode(params.err, "P2034")) return true;

    if (params.provider === "sqlite") {
        if (isPrismaErrorCode(params.err, "P1008")) return true;
        if (isPrismaErrorCode(params.err, "P2028")) return true;
        const message = errorMessage(params.err).toLowerCase();
        if (message.includes("socket timeout")) return true;
        if (message.includes("database is locked")) return true;
        if (message.includes("sqlite_busy")) return true;
    }

    return false;
}

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
    const provider = getDbProviderFromEnv(process.env, "postgres");
    const maxRetries = provider === "sqlite" ? 8 : 3;
    let counter = 0;
    let wrapped = async (tx: Tx) => {
        (tx as any)[symbol] = [];
        let result = await fn(tx);
        let callbacks = (tx as any)[symbol] as (() => void)[];
        return { result, callbacks };
    }
    while (true) {
        try {
            const txOpts = provider === "sqlite" ? null : { isolationLevel: "Serializable" as const, timeout: 10000 };
            let result = txOpts ? await db.$transaction(wrapped, txOpts) : await db.$transaction(wrapped);
            for (let callback of result.callbacks) {
                try {
                    callback();
                } catch {
                    // Ignore callback failures; transactional result is already committed.
                }
            }
            return result.result;
        } catch (e) {
            if (isRetryableTransactionError({ provider, err: e }) && counter < maxRetries) {
                counter++;
                await delay(counter * 100);
                continue;
            }
            throw e;
        }
    }
}
