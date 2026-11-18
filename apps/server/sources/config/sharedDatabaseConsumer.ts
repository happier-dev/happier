import { join } from 'node:path';

import { resolveManagedServerLightPathEnvValue } from '@happier-dev/cli-common/firstPartyRuntime/server';

/**
 * A Stack shared-database consumer (a QA stack on its source stack's database) shares rows
 * with the source but is a distinct server. Per-server runtime facts such as its Home identity
 * and descriptor continuity live in its private runtime directory, never in shared rows.
 */
export function isSharedDatabaseConsumer(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK?.trim());
}

/** The server's private runtime directory under its light data directory; null when none is configured. */
export function resolveServerPrivateRuntimeDir(env: NodeJS.ProcessEnv): string | null {
    const dataDir = resolveManagedServerLightPathEnvValue(
        env,
        'HAPPIER_SERVER_LIGHT_DATA_DIR',
        'HAPPY_SERVER_LIGHT_DATA_DIR',
    ).trim();
    return dataDir ? join(dataDir, 'runtime') : null;
}
