import {
    type PrismaSqliteDatabaseUrlOptions,
    resolvePrismaSqliteDatabaseUrlOptionsFromEnv,
} from '@happier-dev/cli-common/firstPartyRuntime';

export function resolveLightSqliteBusyTimeoutMsFromEnv(env: NodeJS.ProcessEnv): number {
    return resolvePrismaSqliteDatabaseUrlOptionsFromEnv(env).busyTimeoutMs ?? 0;
}

export function resolveLightSqliteConnectionLimitFromEnv(env: NodeJS.ProcessEnv): number | undefined {
    return resolveLightSqliteDatabaseUrlOptionsFromEnv(env).connectionLimit;
}

export function resolveLightSqliteDatabaseUrlOptionsFromEnv(env: NodeJS.ProcessEnv): PrismaSqliteDatabaseUrlOptions {
    const options = resolvePrismaSqliteDatabaseUrlOptionsFromEnv(env);
    return {
        ...options,
        connectionLimit: options.connectionLimit ?? 1,
    };
}
