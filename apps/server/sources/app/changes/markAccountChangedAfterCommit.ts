import { readDatabaseTransactionConfigFromEnv, resolveTransactionRetryDelayMs } from "@/config/databaseTransactions";
import { db } from "@/storage/db";
import { isRetryableTransactionError } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { delay } from "@/utils/runtime/delay";

import { markAccountChanged } from "./markAccountChanged";

type MarkAccountChangedParams = Readonly<{
    accountId: string;
    kind: Parameters<typeof markAccountChanged>[1]["kind"];
    entityId: string;
    hint?: unknown;
}>;

export async function markAccountChangedAfterCommit(params: MarkAccountChangedParams): Promise<number> {
    const provider = getDbProviderFromEnv(process.env, "postgres");
    const transactionConfig = readDatabaseTransactionConfigFromEnv(process.env, provider);
    let attempt = 0;

    while (true) {
        try {
            const transactionOptions =
                provider === "postgres" || provider === "mysql"
                    ? {
                          isolationLevel: "ReadCommitted" as const,
                          timeout: transactionConfig.timeoutMs,
                          maxWait: transactionConfig.maxWaitMs,
                      }
                    : undefined;

            if (transactionOptions) {
                return await db.$transaction(
                    async (tx) => await markAccountChanged(tx as Parameters<typeof markAccountChanged>[0], params),
                    transactionOptions,
                );
            }

            return await db.$transaction(
                async (tx) => await markAccountChanged(tx as Parameters<typeof markAccountChanged>[0], params),
            );
        } catch (error) {
            if (!isRetryableTransactionError({ provider, err: error }) || attempt >= transactionConfig.maxRetries) {
                throw error;
            }
            attempt += 1;
            await delay(
                resolveTransactionRetryDelayMs({
                    attempt,
                    retryBaseDelayMs: transactionConfig.retryBaseDelayMs,
                    retryMaxDelayMs: transactionConfig.retryMaxDelayMs,
                    retryJitterFactor: transactionConfig.retryJitterFactor,
                }),
            );
        }
    }
}
