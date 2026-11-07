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
    const hydratedMachine = home!.storage.getState().machines[machine.id];
    if (!hydratedMachine) throw new Error('Expected the Machine hydrated by the Home runtime');
    // Presence changes preserve the runtime's admitted content mode and key basis.
    machine = { ...hydratedMachine, active: testState.online, activeAt: testState.online ? Date.now() : Date.now() - 86400000 };
    home!.storage.getState().applyMachines([machine], true, {
        sourceServerId: home!.home.id, sourceAccountId: home!.home.accountId,
    });
    return function MachineInstallablesScreen() {
        return <MachineInstallablesSection machineId={machine.id} serverId={home!.home.id} machineSentenceName={machine.id} />;
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

    it('shows only the projected managed PyPI descriptor and installs through the present-user Action default', async () => {
            const MachineInstallablesScreen = await loadMachineInstallablesSection();
            const screen = await renderSettingsView(home!.element(MachineInstallablesScreen));

            await vi.waitFor(() => {
                expect(screen.findRowByTitle('Antigravity localharness')).not.toBeNull();
                // One row per tool: its state on the row, its policy only once the tool is opened.
                expect(screen.findRowByTitle('Antigravity localharness')?.props.subtitle)
                    .toBe('machineDetailPage.toolsPage.experimental · Local browser harness');
                expect(screen.findRowByTitle('Raw declaration must not become an install action')).toBeNull();
                expect(screen.findRowByTitle('common.install')).not.toBeNull();
            });
            expect(screen.findRowByTitle('machineDetailPage.toolsPage.autoInstallTitle')).toBeNull();
            await act(async () => {
                screen.pressRow('machine-tool-dep.antigravity.localharness');
            });
            await vi.waitFor(() => {
                expect(screen.findRowByTitle('machineDetailPage.toolsPage.autoInstallTitle')).not.toBeNull();
                expect(screen.findRowByTitle('machineDetailPage.toolsPage.setupGuide')?.props.subtitle).toBe('https://docs.example.test/antigravity/localharness');
            });

            // Tools publishes the same exact-Account held read that the passive Overview consumes.
            const { getMachineCapabilitiesCacheState } = await import('@/hooks/server/useMachineCapabilitiesCache');
            const { readCachedDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
            const { getInstallablesRegistryEntries } = await import('@/capabilities/installablesRegistry');
            const { summarizeInstallables } = await import('@/capabilities/installablesSummary');
            await vi.waitFor(() => expect(getMachineCapabilitiesCacheState(machine.id, home!.home.id, undefined, home!.home.accountId))
                .toMatchObject({ status: 'loaded' }));
            const projection = readCachedDaemonMergedProjectionCacheEntry({ machineId: machine.id, serverId: home!.home.id });
            if (projection?.kind !== 'ready') throw new Error('Tools projection has not settled');
            const entries = getInstallablesRegistryEntries({ pluginProjection: projection.inputs.pluginProjectionV2 ?? undefined });
            const reads = network.requests.length;
            for (let read = 0; read < 12; read++) {
                expect(summarizeInstallables(entries, getMachineCapabilitiesCacheState(machine.id, home!.home.id, undefined, home!.home.accountId)))
                    .toEqual({ status: 'ready', installed: 0, ready: 0, held: false });
            }
            expect(network.requests).toHaveLength(reads);

            await act(async () => {
                screen.pressRowByTitle('common.install');
            });
            // The canonical Action policy admits this reversible present-user
            // intent directly; an extra installer confirmation would be a second floor.
            await vi.waitFor(() => expect(testState.invoke).toHaveBeenCalledWith('machine-1', expect.objectContaining({
                id: 'dep.antigravity.localharness', method: 'install',
            })));
            expect(testState.confirm).not.toHaveBeenCalled();

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

            // Exercise the settled projected row, rather than a transient catalog fallback.
            await vi.waitFor(() => expect(screen.findRowByTitle('Antigravity localharness')).not.toBeNull());
            await act(async () => {
                screen.pressRow('machine-tool-dep.antigravity.localharness');
            });
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
                // Offline, the row keeps its last answer and offers no install it cannot run.
                expect(screen.findRowByTitle('common.install')).toBeNull();
            });

            } finally { vi.useRealTimers(); }
            await screen.unmount();
        });
});
