import {
    DEFAULT_MEMORY_SETTINGS,
    MemorySettingsV1Schema,
    RPC_ERROR_CODES,
    RPC_METHODS,
    readRpcErrorCode,
    type MemorySettingsV1,
} from '@happier-dev/protocol';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type DaemonMemorySettingsFetchResult = Readonly<
    | {
        supported: true;
        settings: MemorySettingsV1;
    }
    | {
        supported: false;
        settings: MemorySettingsV1;
    }
>;

export async function fetchDaemonMemorySettings(args: Readonly<{
    serverId: string | null | undefined;
    machineId: string | null | undefined;
}>): Promise<DaemonMemorySettingsFetchResult> {
    const serverId = typeof args.serverId === 'string' ? args.serverId.trim() : '';
    const machineId = typeof args.machineId === 'string' ? args.machineId.trim() : '';
    if (!serverId || !machineId) {
        return {
            supported: false,
            settings: DEFAULT_MEMORY_SETTINGS,
        };
    }

    try {
        const raw = await machineRpcWithServerScope<unknown, unknown>({
            machineId,
            serverId,
            method: RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET,
            payload: {},
        });
        return {
            supported: true,
            settings: MemorySettingsV1Schema.parse(raw),
        };
    } catch (error) {
        if (readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
            return {
                supported: false,
                settings: DEFAULT_MEMORY_SETTINGS,
            };
        }
        throw error;
    }
}

export async function writeDaemonMemorySettings(args: Readonly<{
    serverId: string | null | undefined;
    machineId: string | null | undefined;
    settings: MemorySettingsV1;
}>): Promise<DaemonMemorySettingsFetchResult> {
    const serverId = typeof args.serverId === 'string' ? args.serverId.trim() : '';
    const machineId = typeof args.machineId === 'string' ? args.machineId.trim() : '';
    if (!serverId || !machineId) {
        return {
            supported: false,
            settings: DEFAULT_MEMORY_SETTINGS,
        };
    }

    try {
        const raw = await machineRpcWithServerScope<unknown, unknown>({
            machineId,
            serverId,
            method: RPC_METHODS.DAEMON_MEMORY_SETTINGS_SET,
            payload: args.settings,
        });
        return {
            supported: true,
            settings: MemorySettingsV1Schema.parse(raw),
        };
    } catch (error) {
        if (readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
            return {
                supported: false,
                settings: DEFAULT_MEMORY_SETTINGS,
            };
        }
        throw error;
    }
}
