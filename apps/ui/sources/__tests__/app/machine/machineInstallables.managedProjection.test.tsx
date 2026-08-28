import * as React from 'react';

import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flushHookEffects,
    renderSettingsView,
} from '@/dev/testkit';
import {
    createUseSettingMutableMockFromReader,
} from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const testState = vi.hoisted(() => ({
    alert: vi.fn(),
    invoke: vi.fn(),
    online: true,
    projection: null as unknown,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        ScrollView: 'ScrollView',
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        params: { id: 'machine-1', serverId: 'server-b' },
    }).module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { alert: testState.alert },
    }).module;
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const [
        { createStorageModuleMock },
        { createMachineFixture },
        { settingsDefaults },
    ] = await Promise.all([
        import('@/dev/testkit/mocks/storage'),
        import('@/dev/testkit/fixtures/machineFixtures'),
        import('@/sync/domains/settings/settings'),
    ]);
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useMachine: () => createMachineFixture(),
            useSettingMutable: createUseSettingMutableMockFromReader(() => [null, vi.fn()]),
            useSettings: () => settingsDefaults,
        },
    });
});

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerId: () => 'server-b',
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => testState.online,
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({
        phase: 'ready',
        inputs: {
            pluginProjectionV2: testState.projection,
        },
    }),
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    useMachineCapabilitiesCache: () => ({
        state: {
            status: 'loaded',
            snapshot: {
                response: {
                    results: {
                        'dep.antigravity.localharness': {
                            ok: true,
                            checkedAt: 1,
                            data: {
                                installed: false,
                                installedVersion: null,
                                sourceKind: 'managed_pypi_wheel_asset',
                                lastInstallLogPath: null,
                                lastBackgroundUpdateCheckAtMs: null,
                            },
                        },
                    },
                },
            },
        },
        refresh: vi.fn(),
    }),
}));

vi.mock('@/sync/ops/capabilities', () => ({
    machineCapabilitiesInvoke: testState.invoke,
}));

vi.mock('@/components/machines/DetectedClisList', () => ({
    DetectedClisList: () => null,
}));

vi.mock('@/components/settings/agents/setup/AgentSetupFlow', () => ({
    AgentSetupFlow: () => null,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props),
}));

describe('machine managed installables projection', () => {
    beforeEach(() => {
        testState.alert.mockReset();
        testState.invoke.mockReset();
        testState.online = true;
        testState.invoke.mockResolvedValue({
            supported: true,
            response: { ok: true, result: {} },
        });
        testState.projection = {
            v: 2,
            generation: 7,
            installedPackagesById: {},
            agentsById: {},
            backendsById: {},
            actionsById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            diagnostics: [],
            familiesById: {
                managedDependencies: {
                    family: 'managedDependencies',
                    entriesById: {
                        'happier.agent.antigravity/localharness': {
                            id: 'localharness',
                            pluginId: 'happier.agent.antigravity',
                            title: 'Raw declaration must not become an install action',
                            executable: 'localharness',
                            sources: [{ kind: 'system', executableNames: ['localharness'] }],
                        },
                        'dep.antigravity.localharness': {
                            id: 'dep.antigravity.localharness',
                            pluginId: 'happier.agent.antigravity',
                            key: 'dep.antigravity.localharness',
                            capabilityId: 'dep.antigravity.localharness',
                            sourceKind: 'managed_pypi_wheel_asset',
                            display: {
                                name: 'Antigravity localharness',
                                subtitle: 'Local browser harness',
                            },
                            ui: {
                                setupUrl: 'https://docs.example.test/antigravity/localharness',
                                iconName: 'browser',
                            },
                            defaultPolicy: {
                                autoInstallWhenNeeded: true,
                                autoUpdateMode: 'notify',
                            },
                            experimental: true,
                        },
                    },
                },
            },
        };
    });

    it('shows only the projected managed PyPI descriptor and invokes its existing consented install action', async () => {
        const { default: MachineInstallablesScreen } = await import('@/app/(app)/machine/[id]/installables');
        const screen = await renderSettingsView(<MachineInstallablesScreen />);

        expect(screen.findRowByTitle('Antigravity localharness')).not.toBeNull();
        expect(screen.findRowByTitle('Antigravity localharness')?.props.subtitle).toBe('Local browser harness • deps.ui.notInstalled');
        expect(screen.findRowByTitle('common.open')?.props.subtitle).toBe('https://docs.example.test/antigravity/localharness');
        expect(screen.findRowByTitle('Raw declaration must not become an install action')).toBeNull();

        await act(async () => {
            screen.pressRowByTitle('common.install');
        });
        const confirmButtons = testState.alert.mock.calls.find((call) => Array.isArray(call[2]))?.[2];
        if (!Array.isArray(confirmButtons) || typeof confirmButtons[1]?.onPress !== 'function') {
            throw new Error('Expected the existing install confirmation action');
        }
        await act(async () => {
            await confirmButtons[1].onPress();
        });
        await flushHookEffects({ cycles: 1 });

        expect(testState.invoke).toHaveBeenCalledWith(
            'machine-1',
            { id: 'dep.antigravity.localharness', method: 'install' },
            expect.objectContaining({ timeoutMs: 5 * 60_000 }),
        );

        await screen.unmount();
    });

    it('keeps cached projected metadata read-only while the machine is offline', async () => {
        testState.online = false;
        const { default: MachineInstallablesScreen } = await import('@/app/(app)/machine/[id]/installables');
        const screen = await renderSettingsView(<MachineInstallablesScreen />);

        expect(screen.findRowByTitle('Antigravity localharness')).not.toBeNull();
        expect(screen.findRowByTitle('common.install')?.props.disabled).toBe(true);

        await screen.unmount();
    });
});
