import {
    isSharedDatabaseConsumer,
    resolveManagedServerLightPathEnvValue,
    resolveServerIdentityRecordPath,
    resolveServerPrivateRuntimeDir as resolveServerPrivateRuntimeDirIn,
} from '@happier-dev/cli-common/firstPartyRuntime/server';

/**
 * A Stack shared-database consumer (a QA stack on its source stack's database) shares rows
 * with the source but is a distinct server. Per-server runtime facts such as its Home identity
 * and descriptor continuity live in its private runtime directory, never in shared rows.
 * The predicate is cli-common's, so the server and the Stack decide it one way.
 */
export { isSharedDatabaseConsumer };

function resolveServerLightDataDir(env: NodeJS.ProcessEnv): string {
    return resolveManagedServerLightPathEnvValue(
        env,
        'HAPPIER_SERVER_LIGHT_DATA_DIR',
        'HAPPY_SERVER_LIGHT_DATA_DIR',
    ).trim();
}

/** The server's private runtime directory under its light data directory; null when none is configured. */
export function resolveServerPrivateRuntimeDir(env: NodeJS.ProcessEnv): string | null {
    const dataDir = resolveServerLightDataDir(env);
    return dataDir ? resolveServerPrivateRuntimeDirIn(dataDir) : null;
}

/** Where a shared-database consumer keeps its own Home identity; null without a light data directory. */
export function resolveServerIdentityRecordPathFromEnv(env: NodeJS.ProcessEnv): string | null {
    const dataDir = resolveServerLightDataDir(env);
    return dataDir ? resolveServerIdentityRecordPath(dataDir) : null;
}
