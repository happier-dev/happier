import { resolveMachineDatabaseAllocation } from '@/daemon/resources/machineResourcesPolicy';
import { readStoragePathCapacity } from '@/storage/pathCapacity';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1, PLUGIN_DAEMON_DATABASE_PROTOCOL_MAXIMUM_BYTES_V1 } from '@happier-dev/protocol/plugins/data/daemonDatabaseLimitsV1';

import type {
    PluginDaemonDatabaseLimits,
    PluginDaemonDatabaseLimitsPolicy,
} from './daemonDatabase';

const limits = Object.freeze({
    ...PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1,
}) satisfies PluginDaemonDatabaseLimits;

/** Unretained stores keep the existing Preview profile and statement bounds. */
export const DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY = Object.freeze({
    protocolMaximumDatabaseBytes: PLUGIN_DAEMON_DATABASE_PROTOCOL_MAXIMUM_BYTES_V1,
    resolvePluginLimits: (_pluginId: string) => limits,
}) satisfies PluginDaemonDatabaseLimitsPolicy;

/** Retention declarations opt the existing plugin-wide owner into Machine allocation. */
export function createMachinePluginDaemonDatabaseLimitsPolicy(dependencies: Readonly<{
    readPolicy: Parameters<typeof resolveMachineDatabaseAllocation>[0]['readPolicy'];
    readCapacity?: Parameters<typeof resolveMachineDatabaseAllocation>[0]['readCapacity'];
}>): PluginDaemonDatabaseLimitsPolicy {
    return {
        protocolMaximumDatabaseBytes: PLUGIN_DAEMON_DATABASE_PROTOCOL_MAXIMUM_BYTES_V1,
        resolvePluginLimits(_pluginId, context) {
            if (!context) return limits;
            return resolveMachineDatabaseAllocation({
                readPolicy: dependencies.readPolicy,
                readCapacity: dependencies.readCapacity ?? (path => readStoragePathCapacity(path, { readVolumes: () => [] })),
                directory: context.directory,
                retainedBytes: context.retainedBytes,
            }).then(maximumDatabaseBytes => maximumDatabaseBytes === null ? null : { ...limits, maximumDatabaseBytes, protocolMaximumDatabaseBytes: maximumDatabaseBytes });
        },
    };
}
