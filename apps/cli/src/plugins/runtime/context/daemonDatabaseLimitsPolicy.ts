import {
    PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1,
    PLUGIN_DAEMON_DATABASE_PROTOCOL_MAXIMUM_BYTES_V1,
} from '@happier-dev/protocol';

import type {
    PluginDaemonDatabaseLimits,
    PluginDaemonDatabaseLimitsPolicy,
} from './daemonDatabase';

const limits = Object.freeze({
    ...PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1,
}) satisfies PluginDaemonDatabaseLimits;

/**
 * One production policy for trusted Preview plugins. The database host remains
 * the sole enforcement point; this source injects the evidence-backed Preview
 * allocation measured by Background Indexer. It is not API-frozen while the
 * remaining compiled-runtime, platform/lifecycle, and event-loop plan gates
 * are still open.
 */
export const DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY: PluginDaemonDatabaseLimitsPolicy = Object.freeze({
    protocolMaximumDatabaseBytes: PLUGIN_DAEMON_DATABASE_PROTOCOL_MAXIMUM_BYTES_V1,
    resolvePluginLimits: () => limits,
});
