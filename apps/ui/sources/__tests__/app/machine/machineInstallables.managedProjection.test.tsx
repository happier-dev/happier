import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderSettingsView, standardCleanup } from '@/dev/testkit';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installTerminalRouteCommonModuleMocks } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { arrangeMachineDetailsHomeForTests, initializeMachineDetailsRuntimeForTests } from './machineDetailsRuntimeHarness';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const testState = vi.hoisted(() => ({
    alert: vi.fn(),
    confirm: vi.fn(async () => true),
    invoke: vi.fn(),
    online: true,
    projection: null as unknown,
    language: 'en',
}));
const routerParamsRef = vi.hoisted(() => ({ current: { id: 'machine-1' } as Record<string, string> }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { alert: testState.alert, confirm: testState.confirm },
    }).module;
});

installTerminalRouteCommonModuleMocks({
    text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    // English returns the key; another language prefixes it, so a label shows which language built it.
    return createTextModuleMock({
        translate: (key) => (testState.language === 'en' ? key : `${testState.language}:${key}`),
        getPreferredLanguage: () => testState.language,
    });
},
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        params: () => routerParamsRef.current,
    }).module,
});

const network = await initializeMachineDetailsRuntimeForTests();
const disposeActionExecutorLoader = await installRealActionExecutorModuleLoader();
afterAll(disposeActionExecutorLoader);
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
let home: Awaited<ReturnType<typeof arrangeMachineDetailsHomeForTests>> | null = null;
let machine = createMachineFixture({ id: 'machine-1' });
const capabilityResponse = { protocolVersion: 1, ...{
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
                } };

async function loadMachineInstallablesSection() {
    const { MachineInstallablesSection } = await import('@/components/machines/installables/MachineInstallablesSection');
    machine = { ...machine, active: testState.online, activeAt: testState.online ? Date.now() : Date.now() - 86400000 };
    home!.storage.getState().applyMachines([machine], true, {
        sourceServerId: home!.home.id, sourceAccountId: home!.home.accountId,
    });
    return function MachineInstallablesScreen() {
        return <MachineInstallablesSection machineId={machine.id} serverId={home!.home.id} />;
    };
}

describe('machine managed installables projection', () => {
    beforeEach(async () => {

        testState.alert.mockReset();
        testState.confirm.mockReset();
        testState.confirm.mockResolvedValue(true);
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
            actionsById: {},


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

        clearDaemonMergedProjectionCacheForTests();
        machine = createMachineFixture({ id: 'machine-1', active: true, activeAt: Date.now() });
        home = await arrangeMachineDetailsHomeForTests(network, {
            serverUrl: 'https://installables.example.test', machines: [machine],
        });
        routerParamsRef.current = { id: machine.id, serverId: home.home.id };
        network.setRpcResponder(async request => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload, 'rpc');
            const response = request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
                ? { protocolVersion: 1, projection: testState.projection }
                : request.method === RPC_METHODS.CAPABILITIES_DETECT
                    ? capabilityResponse
                    : request.method === RPC_METHODS.CAPABILITIES_INVOKE
                        ? (await testState.invoke(request.targetId, decoded.params)).response
                        : {};
            return await socketRpcCodec.encodeResponse({ mode: 'plain' }, response, decoded.callId);
        });
    });

    afterEach(async () => {
        await standardCleanup();
        await home?.dispose();
        home = null;
        network.resetRequests();
    });

    it('shows only the projected managed PyPI descriptor, behind its existing install confirmation', async () => {
            const MachineInstallablesScreen = await loadMachineInstallablesSection();
            const screen = await renderSettingsView(home!.element(MachineInstallablesScreen));

            await vi.waitFor(() => {
                expect(screen.findRowByTitle('Antigravity localharness')).not.toBeNull();
                expect(screen.findRowByTitle('Antigravity localharness')?.props.subtitle).toBe('Local browser harness • deps.ui.notInstalled');
                expect(screen.findRowByTitle('common.open')?.props.subtitle).toBe('https://docs.example.test/antigravity/localharness');
                expect(screen.findRowByTitle('Raw declaration must not become an install action')).toBeNull();
            });

            await act(async () => {
                screen.pressRowByTitle('common.install');
            });
            // Install runs through the front-door `machines.capabilities.install` Action, which asks for
            // its confirmation first and then reaches the machine RPC.
            await vi.waitFor(() => expect(testState.invoke).toHaveBeenCalledWith('machine-1', expect.objectContaining({
                id: 'dep.antigravity.localharness', method: 'install',
            })));
            expect(testState.confirm).toHaveBeenCalledTimes(1);

            await screen.unmount();
        });

    it('relabels the auto-update choices when the language changes', async () => {
            testState.language = 'en';
            const MachineInstallablesScreen = await loadMachineInstallablesSection();
            const screen = await renderSettingsView(home!.element(MachineInstallablesScreen));
            const optionLabels = () => screen.findAll((node) => (
                typeof node.props?.testIDPrefix === 'string'
                && node.props.testIDPrefix.startsWith('machine-installables-auto-update-')
                && Array.isArray(node.props.options)
            ))[0]?.props.options.map((option: { label: string }) => option.label) as string[] | undefined;

            await vi.waitFor(() => {
                expect(optionLabels()?.length).toBeGreaterThan(0);
                expect(optionLabels()!.every((label) => !label.startsWith('fr:'))).toBe(true);
            });

            try {
                testState.language = 'fr';
                await screen.update(home!.element(MachineInstallablesScreen));
                expect(optionLabels()!.every((label) => label.startsWith('fr:'))).toBe(true);
            } finally {
                testState.language = 'en';
                await screen.unmount();
            }
        });

    it('keeps cached projected metadata read-only while the machine is offline', async () => {

            const MachineInstallablesScreen = await loadMachineInstallablesSection();
            const screen = await renderSettingsView(home!.element(MachineInstallablesScreen));
        await vi.waitFor(() => {
            if (!network.requests.some(request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
                || !screen.findRowByTitle('Antigravity localharness')) {
                throw new Error('Online installables metadata has not settled');
            }
        });
        testState.online = false;
        // Presence is the heartbeat's grace, so the machine goes offline when its last heartbeat ages out
        // and the daemon then reports inactive. A late older heartbeat never rewinds newer presence.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 120_000);
        try {
        await act(async () => {
            machine = { ...machine, active: false };
            home!.storage.getState().applyMachines([machine], true, {
                sourceServerId: home!.home.id, sourceAccountId: home!.home.accountId,
            });
        });

            await vi.waitFor(() => {
                expect(screen.findRowByTitle('Antigravity localharness')).not.toBeNull();
                expect(screen.findRowByTitle('common.install')?.props.disabled).toBe(true);
            });

            } finally { vi.useRealTimers(); }
            await screen.unmount();
        });
});
