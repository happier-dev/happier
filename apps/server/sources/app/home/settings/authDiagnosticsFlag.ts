import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';

import { log } from '@/utils/logging/log';

import { readHomeConfigSnapshot } from './homeSettings';
import { readHomeConfigSnapshotFlag } from './requestHomeEnv';

/**
 * The authentication decorator's diagnostics toggle (`HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS`).
 *
 * Every authenticated request consults it, so it must not cost a Home settings read per request.
 * This server instance reads it once at startup and again after its own committed Home settings
 * write: the server is the writer of that row, so it knows when the value changes. Another server
 * instance sees a change at its next restart or its own next Home settings write. That lag is
 * acceptable only because this flag controls diagnostic logging, never authentication or access.
 * Before the first read (bare test apps) the deployment environment alone decides.
 *
 * Each read applies the committed snapshot it observed, keyed by the Home settings revision, so
 * concurrent writes on one instance converge on the latest commit regardless of completion order.
 */
const entry = SERVER_CONFIG.HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS;
let admitted: Readonly<{ revision: number; enabled: boolean }> | null = null;

export function readAuthDiagnosticsLogsEnabled(): boolean {
    return admitted?.enabled ?? readServerConfig(process.env, entry);
}

/**
 * Startup and the Home settings write owner call this. It reads the committed rows without opening
 * secrets and never throws: a failed refresh keeps the previous value and is logged, so it cannot
 * turn an already committed write into a failure.
 */
export async function refreshAuthDiagnosticsLogsFlag(): Promise<void> {
    try {
        const snapshot = await readHomeConfigSnapshot(process.env);
        const revision = snapshot.record.revision;
        if (admitted && revision < admitted.revision) return;
        admitted = { revision, enabled: readHomeConfigSnapshotFlag(snapshot, entry) };
    } catch (error) {
        log({ module: 'home-settings', level: 'warn' },
            `Authentication diagnostics flag refresh failed; keeping the previous value (${error instanceof Error ? error.name : 'error'})`);
    }
}
