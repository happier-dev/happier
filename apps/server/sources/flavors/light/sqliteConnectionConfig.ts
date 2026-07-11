import {
    DEFAULT_SERVER_LIGHT_SQLITE_CONNECTION_LIMIT,
    type PrismaSqliteDatabaseUrlOptions,
    resolveServerLightSqliteDatabaseUrlOptionsFromEnv,
} from '@happier-dev/cli-common/firstPartyRuntime';

export const DEFAULT_LIGHT_SQLITE_CONNECTION_LIMIT = DEFAULT_SERVER_LIGHT_SQLITE_CONNECTION_LIMIT;

export function resolveLightSqliteBusyTimeoutMsFromEnv(env: NodeJS.ProcessEnv): number {
    return resolveServerLightSqliteDatabaseUrlOptionsFromEnv(env).busyTimeoutMs ?? 0;
}

export function resolveLightSqliteConnectionLimitFromEnv(env: NodeJS.ProcessEnv): number | undefined {
    return resolveLightSqliteDatabaseUrlOptionsFromEnv(env).connectionLimit;
}

export function resolveLightSqliteDatabaseUrlOptionsFromEnv(env: NodeJS.ProcessEnv): PrismaSqliteDatabaseUrlOptions {
    return resolveServerLightSqliteDatabaseUrlOptionsFromEnv(env);
}
