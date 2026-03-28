import { vi } from 'vitest';

type ConnectionStatusModuleFactory = () => unknown | Promise<unknown>;
type ConnectionStatusStorageModuleFactory = (
    importOriginal: <T = unknown>() => Promise<T>,
) => unknown | Promise<unknown>;

type InstallConnectionStatusCommonModuleMocksOptions = Readonly<{
    activeSelectionMachineGroups?: ConnectionStatusModuleFactory;
    serverProfiles?: ConnectionStatusModuleFactory;
    storage?: ConnectionStatusStorageModuleFactory;
}>;

const connectionStatusModuleState = vi.hoisted(() => ({
    options: {
        activeSelectionMachineGroups: undefined as ConnectionStatusModuleFactory | undefined,
        serverProfiles: undefined as ConnectionStatusModuleFactory | undefined,
        storage: undefined as ConnectionStatusStorageModuleFactory | undefined,
    },
}));

export function installConnectionStatusCommonModuleMocks(
    options: InstallConnectionStatusCommonModuleMocksOptions,
): void {
    connectionStatusModuleState.options = {
        activeSelectionMachineGroups: options.activeSelectionMachineGroups,
        serverProfiles: options.serverProfiles,
        storage: options.storage,
    };

    vi.mock('react-native-unistyles', async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    status: {
                        connected: '#00ff00',
                        connecting: '#ffcc00',
                        actionRequired: '#ff9900',
                        disconnected: '#999999',
                        error: '#ff0000',
                        default: '#999999',
                    },
                },
            },
        });
    });

    vi.mock('@/components/settings/server/hooks/useActiveSelectionMachineGroups', async () => {
        const activeOptions = connectionStatusModuleState.options;
        if (activeOptions.activeSelectionMachineGroups) {
            return await activeOptions.activeSelectionMachineGroups();
        }

        return {
            useActiveSelectionMachineGroups: () => ({
                visibleMachineGroups: [],
            }),
        };
    });

    vi.mock('@/sync/domains/server/serverProfiles', async () => {
        const activeOptions = connectionStatusModuleState.options;
        if (activeOptions.serverProfiles) {
            return await activeOptions.serverProfiles();
        }

        return {
            getActiveServerSnapshot: () => null,
            listServerProfiles: () => [],
        };
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = connectionStatusModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
