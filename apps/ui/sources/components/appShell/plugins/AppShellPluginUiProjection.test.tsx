import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
    PluginContributesV2Schema,
    type PluginVoiceProviderContributionV1,
} from '@happier-dev/protocol';
import {
    PluginUiArtifactsManifestV1Schema,
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';

import { createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import type { PluginReactNativeLoaderBackend } from '@/components/plugins/reactNative/loader';
import {
    settleAppShellPluginRuntimeUpdate,
    useAppShellPluginUiProjection,
} from './AppShellPluginUiProjection';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import {
    getConnectedServiceRegistryEntry,
    getConnectedServiceRegistrySnapshot,
    installConnectedAccountDescriptorProjection,
} from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { createConnectedAccountDescriptorProjectionLoadingState } from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import { acquireBundledConversationRuntimeGeneration } from '@/voice/registry/bundledConversationRuntimeGeneration';
import { createBundledConversationRuntimeHostLease } from '@/voice/registry/bundledConversationRuntimeHost';
import type {
    ExternalVoiceProviderActivationApi,
    ExternalVoiceProviderRuntimeRegistration,
    PluginVoiceConversationProviderContributionV1,
} from '@/voice/registry/externalVoiceProviderActivation';
import { getVoiceAdapterRegistry } from '@/voice/session/voiceAdapterRegistry';
import { encodeBase64 } from '@/encryption/base64';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projectionDescribeSpy = vi.hoisted(() => vi.fn());
const pluginRuntimeSpies = vi.hoisted(() => ({
    activate: vi.fn<(input: unknown) => Promise<readonly unknown[]>>(async () => []),
    invalidate: vi.fn<(
        previous: Readonly<{ generation: number | null }>,
        next: Readonly<{ generation: number | null }>,
    ) => Promise<void>>(async () => {}),
    invalidateCacheOnly: vi.fn<(
        previous: Readonly<{ generation: number | null }>,
        next: Readonly<{ generation: number | null }>,
    ) => Promise<void>>(async () => {}),
    replaceAuthority: vi.fn<(authority: unknown) => Promise<void>>(async () => {}),
}));
const pluginExecutableHostState = vi.hoisted(() => ({
    override: null as null | Readonly<{
        replaceAuthority(authority: unknown): Promise<void>;
    }>,
}));
const storageState = vi.hoisted(() => ({
    machines: [] as Array<Record<string, unknown>>,
    voiceExecutionMachine: {
        mode: 'auto' as 'auto' | 'fixed',
        machineId: null as string | null,
        autoMachineId: null as string | null,
    },
    activeServer: { serverId: 'server-1', serverUrl: 'https://server.example.test', generation: 1 },
    endpointConnectivity: {
        status: 'online' as 'online' | 'offline',
        lastConnectedAt: 1 as number | null,
    },
    machineTargets: {} as Record<string, { daemonStateVersion: number; isOnline: boolean }>,
}));
const projectionRefreshState = vi.hoisted(() => {
    let revision = 0;
    const listeners = new Set<() => void>();
    return {
        getRevision: () => revision,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        publish: () => {
            revision += 1;
            for (const listener of listeners) listener();
        },
        reset: () => {
            revision = 0;
            listeners.clear();
        },
    };
});

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machineContributionRegistryProjectionDescribe: (...args: unknown[]) => projectionDescribeSpy(...args),
    getMachineContributionRegistryProjectionRevision: () => projectionRefreshState.getRevision(),
    subscribeMachineContributionRegistryProjectionInvalidation: (
        _scope: unknown,
        listener: () => void,
    ) => projectionRefreshState.subscribe(listener),
}));

vi.mock('@/voice/registry/projectedExternalVoiceProviderActivation', () => ({
    activateProjectedExternalVoiceProviders: (input: unknown) => pluginRuntimeSpies.activate(input),
}));

vi.mock('@/components/plugins/reactNative/projectionInvalidation', () => ({
    applyInstalledAppShellPluginUiReactNativeRuntimeProjectionInvalidation: (
        previous: Readonly<{ generation: number | null }>,
        next: Readonly<{ generation: number | null }>,
    ) => pluginRuntimeSpies.invalidate(previous, next),
    applyInstalledPluginUiReactNativeRuntimeProjectionInvalidation: (
        previous: Readonly<{ generation: number | null }>,
        next: Readonly<{ generation: number | null }>,
    ) => pluginRuntimeSpies.invalidateCacheOnly(previous, next),
}));

vi.mock('@/components/plugins/reactNative/executableModuleHost', () => ({
    getInstalledPluginUiExecutableModuleHost: () => pluginExecutableHostState.override ?? ({
        replaceAuthority: pluginRuntimeSpies.replaceAuthority,
    }),
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => storageState.activeServer,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const readStorageState = () => ({
        machines: Object.fromEntries(storageState.machines.map((machine) => [machine.id, machine])),
        settings: {
            recentMachinePaths: [],
            voice: {
                executionMachine: storageState.voiceExecutionMachine,
            },
        },
    });
    const storage = Object.assign(
        (selector: (state: ReturnType<typeof readStorageState>) => unknown) => selector(readStorageState()),
        {
            getState: readStorageState,
            getInitialState: readStorageState,
            setState: () => undefined,
            subscribe: () => () => undefined,
            destroy: () => undefined,
        },
    );
    return createStorageModuleStub({
        storage,
        useAllMachines: () => storageState.machines,
        useEndpointStatus: () => storageState.endpointConnectivity.status,
        useMachineCliDetectionTarget: (machineId: string | null) => (
            machineId
                ? storageState.machineTargets[machineId] ?? {
                    daemonStateVersion: Number(
                        storageState.machines.find((machine) => machine.id === machineId)?.daemonStateVersion ?? 0,
                    ),
                    isOnline: storageState.machines.some((machine) => machine.id === machineId),
                }
                : { daemonStateVersion: 0, isOnline: false }
        ),
    });
});

afterEach(() => {
    vi.useRealTimers();
    standardCleanup();
    projectionDescribeSpy.mockReset();
    pluginRuntimeSpies.activate.mockReset();
    pluginRuntimeSpies.activate.mockResolvedValue([]);
    pluginRuntimeSpies.invalidate.mockReset();
    pluginRuntimeSpies.invalidate.mockResolvedValue(undefined);
    pluginRuntimeSpies.invalidateCacheOnly.mockReset();
    pluginRuntimeSpies.invalidateCacheOnly.mockResolvedValue(undefined);
    pluginRuntimeSpies.replaceAuthority.mockReset();
    pluginRuntimeSpies.replaceAuthority.mockResolvedValue(undefined);
    pluginExecutableHostState.override = null;
    storageState.machines = [];
    storageState.voiceExecutionMachine = {
        mode: 'auto',
        machineId: null,
        autoMachineId: null,
    };
    storageState.activeServer = { serverId: 'server-1', serverUrl: 'https://server.example.test', generation: 1 };
    storageState.endpointConnectivity = { status: 'online', lastConnectedAt: 1 };
    storageState.machineTargets = {};
    projectionRefreshState.reset();
    installConnectedAccountDescriptorProjection(createConnectedAccountDescriptorProjectionLoadingState('test-cleanup'));
});

function projection(entriesById: Record<string, unknown>): Record<string, unknown> {
    return {
        v: 2,
        generation: 5,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {
            connectedAccounts: {
                family: 'connectedAccounts',
                entriesById,
            },
        },
        diagnostics: [],
    };
}

function projectionWithConnectedAccount(input: Readonly<{
    serviceId: string;
    pluginId?: string;
    title?: string;
    availability?: 'available' | 'disabled' | 'blocked';
    diagnostics?: readonly string[];
}>): Record<string, unknown> {
    return projection({
        account: {
                        id: 'account',
                        serviceId: input.serviceId,
                        ...(input.pluginId ? { pluginId: input.pluginId } : {}),
                        provenance: 'external',
                        sourceKind: 'bundled',
                        title: input.title ?? 'Account',
                        authentication: {
                            defaultModeId: 'manual',
                            modes: [{
                                id: 'manual',
                                kind: 'manual',
                                outcomeReconciliation: 'none',
                                fields: [{
                                    id: 'token',
                                    title: 'Token',
                                    schema: { type: 'string', minLength: 1 },
                                    secret: true,
                                }],
                            }],
                        },
                        capabilities: [],
                        availability: {
                            state: input.availability ?? 'available',
                            reason: input.availability && input.availability !== 'available' ? 'plugin_diagnostics' : 'resolved',
                        },
                        diagnostics: input.diagnostics ?? [],
                    },
    });
}

function requireConversationDeclaration(
    declaration: PluginVoiceProviderContributionV1,
): PluginVoiceConversationProviderContributionV1 {
    if (declaration.kind !== 'conversation') throw new Error('expected conversation declaration');
    return declaration;
}

function createProviderLeaf(): ExternalVoiceProviderRuntimeRegistration {
    return {
        protocol: {
            async prepare() {
                return { kind: 'prepared', session: { config: {}, safeMetadata: null } };
            },
            decodeControl: () => [],
            encodeTurnControl: () => null,
        },
        async createConnection() {
            return {
                kind: 'sdk_handle',
                async connect() {},
                async sendControl() {},
                controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                async close() {},
                state: () => 'closed' as const,
                currentProviderSessionId: () => null,
                playbackCursorMs: () => null,
                beginOutputInterruptionCandidate: () => 'unsupported' as const,
                resolveOutputInterruptionCandidate() {},
            };
        },
        encodeToolResults: () => [],
        encodeToolContinuation: (responseId) => ({ type: 'continue', responseId }),
        encodeContextUpdate: (text) => [{ type: 'context', text }],
        encodeTextTurn: (text) => [{ type: 'text', text }],
        requiresMicForConnection: false,
    };
}

function ProjectionProbe() {
    const value = useAppShellPluginUiProjection();
    return React.createElement('ProjectionProbe', { value });
}

function ScopedProjectionProbe() {
    const value = useScopedPluginUiProjection({ machineId: 'machine-scoped', serverId: 'server-scoped' });
    return React.createElement('ScopedProjectionProbe', { value });
}

describe('AppShellPluginUiProjectionProvider', () => {
    it('contains projection invalidation and activation rejections from the React effect', async () => {
        const activationAfterFailedInvalidation = vi.fn(async () => {});
        await expect(settleAppShellPluginRuntimeUpdate({
            invalidate: async () => { throw new Error('invalidation failed'); },
            activate: activationAfterFailedInvalidation,
            isCancelled: () => false,
        })).resolves.toBeUndefined();
        expect(activationAfterFailedInvalidation).not.toHaveBeenCalled();

        await expect(settleAppShellPluginRuntimeUpdate({
            invalidate: async () => {},
            activate: async () => { throw new Error('activation failed'); },
            isCancelled: () => false,
        })).resolves.toBeUndefined();

        const supersededInvalidation = vi.fn(async () => {});
        const supersededActivation = vi.fn(async () => {});
        await expect(settleAppShellPluginRuntimeUpdate({
            invalidate: supersededInvalidation,
            activate: supersededActivation,
            isCancelled: () => true,
        })).resolves.toBeUndefined();
        expect(supersededInvalidation).not.toHaveBeenCalled();
        expect(supersededActivation).not.toHaveBeenCalled();
    });

    it('invalidates from the last applied projection when a queued refresh is superseded', async () => {
        storageState.machines = [{
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            metadata: { host: 'local' },
        }];
        let generation = 5;
        projectionDescribeSpy.mockImplementation(async () => ({
            supported: true,
            projection: {
                v: 2,
                generation,
                installedPackagesById: {},
                agentsById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                settingsById: {},
                familiesById: {},
                diagnostics: [],
            },
        }));
        const firstActivation = createDeferred<readonly unknown[]>();
        pluginRuntimeSpies.activate.mockImplementationOnce(async () => await firstActivation.promise);

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(1);
        pluginRuntimeSpies.invalidate.mockClear();

        generation = 6;
        await act(async () => {
            projectionRefreshState.publish();
        });
        await flushHookEffects({ cycles: 3 });

        generation = 7;
        await act(async () => {
            projectionRefreshState.publish();
        });
        await flushHookEffects({ cycles: 3 });

        firstActivation.resolve([]);
        await flushHookEffects({ cycles: 8 });

        expect(pluginRuntimeSpies.invalidate).toHaveBeenCalledWith(
            expect.objectContaining({ generation: 5 }),
            expect.objectContaining({ generation: 7 }),
        );
        expect(pluginRuntimeSpies.invalidate).not.toHaveBeenCalledWith(
            expect.objectContaining({ generation: 6 }),
            expect.objectContaining({ generation: 7 }),
        );

        await screen.unmount();
    });

    it('retries invalidation from the last applied projection after an invalidation failure', async () => {
        storageState.machines = [{
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            metadata: { host: 'local' },
        }];
        let generation = 5;
        projectionDescribeSpy.mockImplementation(async () => ({
            supported: true,
            projection: {
                v: 2,
                generation,
                installedPackagesById: {},
                agentsById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                settingsById: {},
                familiesById: {},
                diagnostics: [],
            },
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        pluginRuntimeSpies.invalidate.mockClear();
        pluginRuntimeSpies.invalidate.mockRejectedValueOnce(new Error('synthetic invalidation failure'));

        generation = 6;
        await act(async () => {
            projectionRefreshState.publish();
        });
        await flushHookEffects({ cycles: 5 });

        generation = 7;
        await act(async () => {
            projectionRefreshState.publish();
        });
        await flushHookEffects({ cycles: 5 });

        expect(pluginRuntimeSpies.invalidate).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ generation: 5 }),
            expect.objectContaining({ generation: 6 }),
        );
        expect(pluginRuntimeSpies.invalidate).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ generation: 5 }),
            expect.objectContaining({ generation: 7 }),
        );

        await screen.unmount();
    });

    it('installs an explicit loading lifecycle for the current server before the first projection settles', async () => {
        storageState.machines = [{
            id: 'machine-1', active: true, activeAt: Date.now(), metadata: { host: 'local' },
        }];
        const pending = createDeferred<{ supported: false; reason: 'error' }>();
        projectionDescribeSpy.mockReturnValue(pending.promise);

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 2 });

        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({
            scopeKey: 'server-1',
            status: 'loading',
            entries: expect.any(Array),
        });

        pending.resolve({ supported: false, reason: 'error' });
        await flushHookEffects({ cycles: 3 });
        await screen.unmount();
    });

    it('loads plugin UI projection for the active app-shell machine scope', async () => {
        storageState.machines = [{
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            metadata: { host: 'local' },
        }];
        projectionDescribeSpy.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 5,
                installedPackagesById: {},
                agentsById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                settingsById: {},
                familiesById: {},
                diagnostics: [],
            },
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider>
                <ProjectionProbe />
            </AppShellPluginUiProjectionProvider>,
        );

        await flushHookEffects({ cycles: 4 });

        const probe = screen.tree.findByType('ProjectionProbe' as never);
        expect(projectionDescribeSpy).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-1',
        }));
        expect(probe.props.value).toEqual(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            pluginUiProjection: expect.objectContaining({ generation: 5 }),
        }));
    });

    it('binds projected Voice activation to the fixed Voice execution machine instead of the newer AppShell target', async () => {
        storageState.machines = [
            {
                id: 'machine-a',
                active: true,
                activeAt: Date.now(),
                createdAt: 2,
                metadata: { host: 'newest-app-shell-target' },
            },
            {
                id: 'machine-b',
                active: true,
                activeAt: Date.now() - 1_000,
                createdAt: 1,
                metadata: { host: 'fixed-voice-target' },
            },
        ];
        storageState.voiceExecutionMachine = {
            mode: 'fixed',
            machineId: 'machine-b',
            autoMachineId: null,
        };
        projectionDescribeSpy.mockImplementation(async (machineId: string) => ({
            supported: true,
            projection: {
                v: 2,
                generation: machineId === 'machine-b' ? 7 : 5,
                installedPackagesById: {},
                agentsById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                settingsById: {},
                familiesById: {},
                diagnostics: [],
            },
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 6 });

        expect(screen.tree.findByType('ProjectionProbe' as never).props.value).toEqual(
            expect.objectContaining({ machineId: 'machine-a' }),
        );
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-b',
            projection: expect.objectContaining({ generation: 7 }),
        }));
        expect(pluginRuntimeSpies.activate).not.toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a',
        }));
    });

    it('does not activate projected Voice providers when the fixed Voice machine is offline and another machine is online', async () => {
        storageState.machines = [
            {
                id: 'machine-a',
                active: true,
                activeAt: Date.now(),
                createdAt: 2,
                metadata: { host: 'online-app-shell-target' },
            },
            {
                id: 'machine-b',
                active: false,
                activeAt: 0,
                createdAt: 1,
                metadata: { host: 'offline-fixed-voice-target' },
            },
        ];
        storageState.voiceExecutionMachine = {
            mode: 'fixed',
            machineId: 'machine-b',
            autoMachineId: null,
        };
        projectionDescribeSpy.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 5,
                installedPackagesById: {},
                agentsById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                settingsById: {},
                familiesById: {},
                diagnostics: [],
            },
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 6 });

        expect(screen.tree.findByType('ProjectionProbe' as never).props.value).toEqual(
            expect.objectContaining({ machineId: 'machine-a' }),
        );
        expect(pluginRuntimeSpies.activate).not.toHaveBeenCalled();
        expect(pluginRuntimeSpies.replaceAuthority).toHaveBeenCalledWith(null);
    });

    it('revokes an in-flight projection activation on unmount before same-generation remount', async () => {
        storageState.machines = [{
            id: 'machine-1', active: true, activeAt: Date.now(), metadata: { host: 'local' },
        }];
        projectionDescribeSpy.mockResolvedValue({
            supported: true,
            projection: {
                v: 2, generation: 5, installedPackagesById: {}, agentsById: {}, backendsById: {},
                actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {},
                settingsById: {}, familiesById: {}, diagnostics: [],
            },
        });
        const firstActivation = createDeferred<never[]>();
        pluginRuntimeSpies.activate.mockImplementationOnce(async () => await firstActivation.promise);

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const first = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(1);
        const nullInvalidationsBeforeUnmount = pluginRuntimeSpies.invalidate.mock.calls
            .filter(([, next]) => (next as { generation?: unknown }).generation === null).length;

        await first.unmount();
        await flushHookEffects({ cycles: 2 });
        expect(pluginRuntimeSpies.invalidate.mock.calls
            .filter(([, next]) => (next as { generation?: unknown }).generation === null)).toHaveLength(
                nullInvalidationsBeforeUnmount + 1,
            );

        await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(2);

        firstActivation.resolve([]);
        await flushHookEffects({ cycles: 4 });
        expect(pluginRuntimeSpies.invalidate.mock.calls
            .filter(([, next]) => (next as { generation?: unknown }).generation === null)).toHaveLength(
                nullInvalidationsBeforeUnmount + 1,
            );
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(2);
    });

    it('reapplies an unchanged projection when the Voice runtime host generation is replaced', async () => {
        storageState.machines = [{
            id: 'machine-1', active: true, activeAt: Date.now(), metadata: { host: 'local' },
        }];
        projectionDescribeSpy.mockResolvedValue({
            supported: true,
            projection: {
                v: 2, generation: 5, installedPackagesById: {}, agentsById: {}, backendsById: {},
                actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {},
                settingsById: {}, familiesById: {}, diagnostics: [],
            },
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(1);

        let replacementGeneration!: ReturnType<typeof acquireBundledConversationRuntimeGeneration>;
        await act(async () => {
            replacementGeneration = acquireBundledConversationRuntimeGeneration();
        });
        await flushHookEffects({ cycles: 5 });
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(2);

        await screen.unmount();
        replacementGeneration.revoke();
    });

    it('keeps the active plugin runtime when the same target republishes the same projection generation', async () => {
        storageState.machines = [{
            id: 'machine-1', active: true, activeAt: Date.now(), metadata: { host: 'local' },
        }];
        projectionDescribeSpy.mockImplementation(async () => ({
            supported: true,
            projection: {
                v: 2, generation: 5, installedPackagesById: {}, agentsById: {}, backendsById: {},
                actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {},
                settingsById: {}, familiesById: {}, diagnostics: [],
            },
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const renderApp = () => (
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>
        );
        const screen = await renderScreen(renderApp());
        await flushHookEffects({ cycles: 5 });
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(1);
        const describesAfterInitialLoad = projectionDescribeSpy.mock.calls.length;
        const invalidationsAfterInitialLoad = pluginRuntimeSpies.invalidate.mock.calls.length;

        storageState.machines = [{
            id: 'machine-1', active: true, activeAt: Date.now() + 1_000, metadata: { host: 'local' },
        }];
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 5 });

        expect(projectionDescribeSpy).toHaveBeenCalledTimes(describesAfterInitialLoad + 1);
        expect(pluginRuntimeSpies.invalidate).toHaveBeenCalledTimes(invalidationsAfterInitialLoad);
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(1);
    });

    it('does not load a projection when the app shell has no active machine scope', async () => {
        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider>
                <ProjectionProbe />
            </AppShellPluginUiProjectionProvider>,
        );

        await flushHookEffects({ cycles: 2 });

        const probe = screen.tree.findByType('ProjectionProbe' as never);
        expect(projectionDescribeSpy).not.toHaveBeenCalled();
        expect(probe.props.value).toEqual(expect.objectContaining({
            machineId: null,
            pluginUiProjection: null,
        }));
    });

    it('revokes executable authority when the mounted app shell loses its machine target', async () => {
        storageState.machines = [{
            id: 'machine-1', active: true, activeAt: Date.now(), metadata: { host: 'local' },
        }];
        projectionDescribeSpy.mockResolvedValue({
            supported: true,
            projection: {
                v: 2, generation: 5, installedPackagesById: {}, agentsById: {}, backendsById: {},
                actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {},
                settingsById: {}, familiesById: {}, diagnostics: [],
            },
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const renderApp = () => (
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>
        );
        const screen = await renderScreen(renderApp());
        await flushHookEffects({ cycles: 5 });
        pluginRuntimeSpies.replaceAuthority.mockClear();

        storageState.machines = [];
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 5 });

        expect(pluginRuntimeSpies.replaceAuthority).toHaveBeenCalledWith(null);
    });

    it('keeps scoped projection invalidation cache-only', async () => {
        storageState.machineTargets['machine-scoped'] = {
            daemonStateVersion: 5,
            isOnline: true,
        };
        projectionDescribeSpy.mockResolvedValue({
            supported: true,
            projection: {
                v: 2, generation: 5, installedPackagesById: {}, agentsById: {}, backendsById: {},
                actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {},
                settingsById: {}, familiesById: {}, diagnostics: [],
            },
        });

        await renderScreen(<ScopedProjectionProbe />);
        await flushHookEffects({ cycles: 5 });

        expect(pluginRuntimeSpies.invalidateCacheOnly).toHaveBeenCalled();
        expect(pluginRuntimeSpies.invalidate).not.toHaveBeenCalled();
        expect(pluginRuntimeSpies.replaceAuthority).not.toHaveBeenCalled();
    });

    it('keeps last-known projection authority inert until reconnect re-description settles', async () => {
        storageState.endpointConnectivity = { status: 'online', lastConnectedAt: null };
        storageState.machines = [{
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            metadata: { host: 'local' },
        }];
        storageState.machineTargets = {
            'machine-1': { daemonStateVersion: 5, isOnline: true },
        };
        projectionDescribeSpy.mockResolvedValue({
            supported: true,
            projection: {
                v: 2, generation: 5, installedPackagesById: {}, agentsById: {}, backendsById: {},
                actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {},
                settingsById: {}, familiesById: {}, diagnostics: [],
            },
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const renderApp = () => (
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>
        );
        const screen = await renderScreen(renderApp());
        await flushHookEffects({ cycles: 5 });

        type AuthorityAwareProjection = Readonly<{
            pluginUiProjection: Readonly<{ generation: number | null }> | null;
            pluginBrowserProjection: Readonly<{ generation: number | null }> | null;
            interactionEnabled?: boolean;
        }>;
        const readProjection = (): AuthorityAwareProjection => (
            screen.tree.findByType('ProjectionProbe' as never).props.value as AuthorityAwareProjection
        );
        expect(readProjection()).toEqual(expect.objectContaining({
            interactionEnabled: true,
            pluginUiProjection: expect.objectContaining({ generation: 5 }),
            pluginBrowserProjection: expect.objectContaining({ generation: 5 }),
        }));
        const currentnessRequestEpochs = () => projectionDescribeSpy.mock.calls
            .map((call) => (call[1] as { requestEpoch?: unknown } | undefined)?.requestEpoch)
            .filter((requestEpoch): requestEpoch is string => typeof requestEpoch === 'string');
        const initialRequestEpoch = currentnessRequestEpochs().at(-1);
        expect(typeof initialRequestEpoch).toBe('string');

        storageState.endpointConnectivity = { status: 'offline', lastConnectedAt: null };
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 2 });
        expect(readProjection()).toEqual(expect.objectContaining({
            interactionEnabled: false,
            pluginUiProjection: expect.objectContaining({ generation: 5 }),
            pluginBrowserProjection: null,
        }));

        const reDescription = createDeferred<{
            supported: true;
            projection: Record<string, unknown>;
        }>();
        projectionDescribeSpy.mockReturnValueOnce(reDescription.promise);
        storageState.endpointConnectivity = { status: 'online', lastConnectedAt: null };
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 2 });
        const reconnectRequestEpoch = currentnessRequestEpochs().at(-1);
        expect(reconnectRequestEpoch).not.toBe(initialRequestEpoch);

        expect(readProjection()).toEqual(expect.objectContaining({
            interactionEnabled: false,
            pluginUiProjection: expect.objectContaining({ generation: 5 }),
            pluginBrowserProjection: null,
        }));

        reDescription.resolve({
            supported: true,
            projection: {
                v: 2, generation: 6, installedPackagesById: {}, agentsById: {}, backendsById: {},
                actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {},
                settingsById: {}, familiesById: {}, diagnostics: [],
            },
        });
        await flushHookEffects({ cycles: 5 });
        expect(readProjection()).toEqual(expect.objectContaining({
            interactionEnabled: true,
            pluginUiProjection: expect.objectContaining({ generation: 6 }),
            pluginBrowserProjection: expect.objectContaining({ generation: 6 }),
        }));
    });

    it('unwinds executable Voice authority offline and restores it only after fresh re-description', async () => {
        const declaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
            voiceProviders: [{
                id: 'conversation',
                title: 'Synthetic',
                kind: 'conversation',
                roles: ['realtime_conversation'],
                platforms: ['web'],
                capabilities: {
                    readiness: { requirements: [] },
                    turn: { cancelResponse: true, bargeIn: false },
                },
                client: {
                    artifactId: 'voice-runtime-web',
                    modulePath: './voiceRuntime',
                    exportName: 'activate',
                },
            }],
        }).voiceProviders[0]!);
        const pluginId = 'acme.app-shell-currentness';
        const providerId = `${pluginId}/${declaration.id}`;
        const generation = 12;
        const entryPath = 'react-native/voice-runtime-web/index.js';
        const bytes = new TextEncoder().encode('// synthetic app-shell Voice executable');
        const entryDigest = computePluginUiArtifactSha256DigestV1(bytes);
        const digest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entryPath, bytes }]);
        const artifactGraph = PluginUiArtifactsManifestV1Schema.parse({
            version: 1,
            entries: [{
                contributionId: declaration.client.artifactId,
                tier: 'reactNative',
                platform: 'web',
                entry: entryPath,
                files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength }],
                digest,
                builtWith: { bundler: 'vite', version: '7.0.0' },
                hostUiApiVersion: '1.0.0',
                compat: { react: '19.0.0', reactNative: '0.83.4' },
            }],
        }).entries[0]!;
        const identity = Object.freeze({
            pluginId,
            contributionId: declaration.id,
            artifactDigest: digest,
            hostAppVersion: '2.0.0',
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.0.0',
            reactNativeVersion: '0.83.4',
            platform: 'web' as const,
            channel: 'internal',
            nativeCapabilitiesDigest: `sha256:${'c'.repeat(64)}`,
            projectionGeneration: generation,
        });
        const rawProjection = {
            v: 2,
            generation,
            installedPackagesById: {},
            agentsById: {},
            backendsById: {},
            actionsById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            familiesById: {
                voiceProviders: {
                    family: 'voiceProviders',
                    entriesById: {
                        [providerId]: {
                            id: providerId,
                            pluginId,
                            generation,
                            contributionKey: providerId,
                            definition: declaration,
                        },
                    },
                },
                pluginUi: {
                    family: 'pluginUi',
                    entriesById: {
                        [`reactNativeBundle:${pluginId}:${declaration.id}`]: {
                            id: `reactNativeBundle:${pluginId}:${declaration.id}`,
                            pluginId,
                            contributionKind: 'reactNativeBundle',
                            contributionId: declaration.id,
                            artifactGraph,
                            runtime: {
                                decision: { state: 'load' },
                                loadPolicy: { source: 'installedArtifact' },
                                cacheIdentity: identity,
                            },
                        },
                    },
                },
            },
            diagnostics: [],
        } as const;
        const executableModule = await vi.importActual<
            typeof import('@/components/plugins/reactNative/executableModuleHost')
        >('@/components/plugins/reactNative/executableModuleHost');
        const projectedActivationModule = await vi.importActual<
            typeof import('@/voice/registry/projectedExternalVoiceProviderActivation')
        >('@/voice/registry/projectedExternalVoiceProviderActivation');
        const executableHost = executableModule.createPluginUiExecutableModuleHost();
        const cache = createPluginReactNativeBundleCache();
        const loaderBackend: PluginReactNativeLoaderBackend = Object.freeze({
            backendId: 'reactNativeWebModule',
            available: true,
            async loadInstalledBundle() {
                return (api: ExternalVoiceProviderActivationApi) => {
                    api.voiceProviders.register(declaration.id, createProviderLeaf());
                };
            },
        });
        const runtimeHostLease = createBundledConversationRuntimeHostLease();
        pluginExecutableHostState.override = executableHost;
        pluginRuntimeSpies.activate.mockImplementation(async (input) => (
            await projectedActivationModule.activateProjectedExternalVoiceProviders({
                ...(input as Parameters<
                    typeof projectedActivationModule.activateProjectedExternalVoiceProviders
                >[0]),
                executableHost,
                cache,
                loaderBackend,
                fetchArtifactBytes: async () => ({
                    ok: true,
                    cacheIdentity: identity,
                    artifact: {
                        pluginId,
                        contributionId: declaration.id,
                        artifactKind: 'reactNativeBundle',
                        digest,
                        format: 'plainJs',
                        byteSize: bytes.byteLength,
                    },
                    bytesBase64: encodeBase64(bytes),
                    files: [{
                        relativePath: entryPath,
                        digest: entryDigest,
                        byteSize: bytes.byteLength,
                        bytesBase64: encodeBase64(bytes),
                    }],
                }),
            })
        ));
        onTestFinished(async () => {
            pluginExecutableHostState.override = null;
            await executableHost.unload();
            runtimeHostLease.revoke();
        });

        storageState.endpointConnectivity = { status: 'online', lastConnectedAt: null };
        storageState.machines = [{
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            metadata: { host: 'local' },
        }];
        storageState.machineTargets = {
            'machine-1': { daemonStateVersion: 5, isOnline: true },
        };
        let reconnectDescription: ReturnType<typeof createDeferred<{
            supported: true;
            projection: typeof rawProjection;
        }>> | null = null;
        projectionDescribeSpy.mockImplementation((
            _machineId: string,
            options?: Readonly<{ requestEpoch?: unknown }>,
        ) => (
            typeof options?.requestEpoch === 'string' && reconnectDescription
                ? reconnectDescription.promise
                : Promise.resolve({ supported: true as const, projection: rawProjection })
        ));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const renderApp = () => (
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>
        );
        const screen = await renderScreen(renderApp());
        await flushHookEffects({ cycles: 8 });
        expect(getVoiceAdapterRegistry().get(providerId)).not.toBeNull();
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(1);

        storageState.endpointConnectivity = { status: 'offline', lastConnectedAt: null };
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 3 });
        expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();

        reconnectDescription = createDeferred();
        storageState.endpointConnectivity = { status: 'online', lastConnectedAt: null };
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 3 });
        expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(1);

        reconnectDescription.resolve({ supported: true, projection: rawProjection });
        await flushHookEffects({ cycles: 8 });
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(2);
        expect(getVoiceAdapterRegistry().get(providerId)).not.toBeNull();
    });

    it('ignores a pre-disconnect describe result that settles after reconnect starts', async () => {
        storageState.endpointConnectivity = { status: 'online', lastConnectedAt: null };
        storageState.machines = [{
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            metadata: { host: 'local' },
        }];
        storageState.machineTargets = {
            'machine-1': { daemonStateVersion: 5, isOnline: true },
        };
        const beforeDisconnect = createDeferred<{
            supported: true;
            projection: Record<string, unknown>;
        }>();
        const afterReconnect = createDeferred<{
            supported: true;
            projection: Record<string, unknown>;
        }>();
        let currentnessRequestCount = 0;
        projectionDescribeSpy.mockImplementation((
            _machineId: string,
            options?: Readonly<{ requestEpoch?: unknown }>,
        ) => {
            if (typeof options?.requestEpoch !== 'string') {
                return Promise.resolve({
                    supported: true,
                    projection: {
                        v: 2, generation: 5, installedPackagesById: {}, agentsById: {}, backendsById: {},
                        actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {},
                        settingsById: {}, familiesById: {}, diagnostics: [],
                    },
                });
            }
            currentnessRequestCount += 1;
            return currentnessRequestCount === 1
                ? beforeDisconnect.promise
                : afterReconnect.promise;
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const renderApp = () => (
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>
        );
        const screen = await renderScreen(renderApp());
        await flushHookEffects({ cycles: 3 });
        expect(currentnessRequestCount).toBe(1);

        type AuthorityAwareProjection = Readonly<{
            pluginUiProjection: Readonly<{ generation: number | null }> | null;
            pluginBrowserProjection: Readonly<{ generation: number | null }> | null;
            interactionEnabled?: boolean;
        }>;
        const readProjection = (): AuthorityAwareProjection => (
            screen.tree.findByType('ProjectionProbe' as never).props.value as AuthorityAwareProjection
        );

        storageState.endpointConnectivity = { status: 'offline', lastConnectedAt: null };
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 2 });
        expect(readProjection()).toEqual(expect.objectContaining({
            interactionEnabled: false,
            pluginBrowserProjection: null,
        }));

        storageState.endpointConnectivity = { status: 'online', lastConnectedAt: null };
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 2 });
        expect(currentnessRequestCount).toBe(2);

        beforeDisconnect.resolve({
            supported: true,
            projection: {
                v: 2, generation: 5, installedPackagesById: {}, agentsById: {}, backendsById: {},
                actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {},
                settingsById: {}, familiesById: {}, diagnostics: [],
            },
        });
        await flushHookEffects({ cycles: 3 });
        expect(readProjection()).toEqual(expect.objectContaining({
            interactionEnabled: false,
            pluginBrowserProjection: null,
        }));

        afterReconnect.resolve({
            supported: true,
            projection: {
                v: 2, generation: 6, installedPackagesById: {}, agentsById: {}, backendsById: {},
                actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {},
                settingsById: {}, familiesById: {}, diagnostics: [],
            },
        });
        await flushHookEffects({ cycles: 5 });
        expect(readProjection()).toEqual(expect.objectContaining({
            interactionEnabled: true,
            pluginUiProjection: expect.objectContaining({ generation: 6 }),
            pluginBrowserProjection: expect.objectContaining({ generation: 6 }),
        }));
    });

    it('refetches the AppShell projection when its machine scope is invalidated after a plugin mutation', async () => {
        storageState.machines = [{
            id: 'machine-1', active: true, activeAt: Date.now(), metadata: { host: 'local' },
        }];
        let generation = 5;
        projectionDescribeSpy.mockImplementation(async () => ({
            supported: true,
            projection: {
                v: 2, generation, installedPackagesById: {}, agentsById: {}, backendsById: {},
                actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {},
                settingsById: {}, familiesById: {}, diagnostics: [],
            },
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        const describesBeforeInvalidation = projectionDescribeSpy.mock.calls.length;
        pluginRuntimeSpies.invalidate.mockClear();

        generation = 6;
        await act(async () => projectionRefreshState.publish());
        await flushHookEffects({ cycles: 5 });

        expect(projectionDescribeSpy.mock.calls.length).toBeGreaterThan(describesBeforeInvalidation);
        expect(pluginRuntimeSpies.invalidate).toHaveBeenCalledWith(
            expect.objectContaining({ generation: 5 }),
            expect.objectContaining({ generation: 6 }),
        );
    });

    it('keeps a divergent same-owner descriptor visible as a fail-closed conflict', async () => {
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
            { id: 'machine-b', active: true, activeAt: Date.now(), metadata: { host: 'b' } },
        ];
        projectionDescribeSpy.mockImplementation(async (machineId: string) => ({
            supported: true,
            projection: projectionWithConnectedAccount({
                serviceId: 'bitbucket',
                pluginId: 'acme.same',
                title: machineId === 'machine-a' ? 'Machine A' : 'Machine B',
            }),
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });

        expect(getConnectedServiceRegistryEntry('bitbucket')).toMatchObject({
            projectionStatus: 'conflict',
            executable: false,
            projectedDescriptorCandidates: expect.arrayContaining([
                expect.objectContaining({ title: 'Machine A' }),
                expect.objectContaining({ title: 'Machine B' }),
            ]),
        });
    });

    it('keeps different descriptor owners that claim the same service id visible and blocked', async () => {
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
            { id: 'machine-b', active: true, activeAt: Date.now(), metadata: { host: 'b' } },
        ];
        projectionDescribeSpy.mockImplementation(async (machineId: string) => ({
            supported: true,
            projection: projectionWithConnectedAccount({
                serviceId: 'bitbucket',
                pluginId: machineId === 'machine-a' ? 'acme.plugin.a' : 'acme.plugin.b',
            }),
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });

        expect(getConnectedServiceRegistryEntry('bitbucket')).toMatchObject({
            projectionStatus: 'conflict',
            executable: false,
            projectedDescriptorCandidates: expect.arrayContaining([
                expect.objectContaining({ pluginId: 'acme.plugin.a' }),
                expect.objectContaining({ pluginId: 'acme.plugin.b' }),
            ]),
        });
    });

    it('retains last-known-good through one machine transport failure and clears it when machines are removed', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-13T00:00:00Z'));
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
            { id: 'machine-b', active: true, activeAt: Date.now(), metadata: { host: 'b' } },
        ];
        let failMachineB = false;
        projectionDescribeSpy.mockImplementation(async (machineId: string) => {
            if (failMachineB && machineId === 'machine-b') throw new Error('offline');
            return { supported: true, projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.plugin.a' }) };
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(getConnectedServiceRegistryEntry('bitbucket')).toMatchObject({ supportsToken: true });

        failMachineB = true;
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        await flushHookEffects({ cycles: 4 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'stale', errorReason: 'partial_machine_failure' });
        expect(getConnectedServiceRegistryEntry('bitbucket')).toMatchObject({
            projectionStatus: 'stale',
            executable: false,
            projectedDescriptor: expect.objectContaining({ pluginId: 'acme.plugin.a' }),
        });

        storageState.machines = [];
        await screen.update(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 4 });
        expect(getConnectedServiceRegistryEntry('bitbucket')).toMatchObject({ supportsToken: false });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'ready' });
    });

    it('refreshes the global union so plugin disable or removal clears stale descriptors without a machine-list change', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-13T00:00:00Z'));
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        let includeDescriptor = true;
        projectionDescribeSpy.mockImplementation(async () => ({
            supported: true,
            projection: includeDescriptor
                ? projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.plugin.a' })
                : {
                    ...projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.plugin.a' }),
                    familiesById: {},
                },
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(getConnectedServiceRegistryEntry('bitbucket')).toMatchObject({ supportsToken: true });

        includeDescriptor = false;
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        await flushHookEffects({ cycles: 4 });
        expect(getConnectedServiceRegistryEntry('bitbucket')).toMatchObject({ supportsToken: false });
    });

    it('retains last-known-good through all-machine transport failure and recovers stale to ready', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-13T00:00:00Z'));
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        let mode: 'ready' | 'failed' = 'ready';
        projectionDescribeSpy.mockImplementation(async () => {
            if (mode === 'failed') return { supported: false, reason: 'error' };
            return { supported: true, projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.plugin.a' }) };
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'ready' });

        mode = 'failed';
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        await flushHookEffects({ cycles: 4 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'stale', errorReason: 'transport' });
        expect(getConnectedServiceRegistryEntry('bitbucket').projectedDescriptor).toEqual(expect.objectContaining({ pluginId: 'acme.plugin.a' }));

        mode = 'ready';
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        await flushHookEffects({ cycles: 4 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'ready', errorReason: null });
        expect(getConnectedServiceRegistryEntry('bitbucket')).toMatchObject({ executable: true, supportsToken: true });
    });

    it('does not clear last-known-good for malformed or unsupported projection responses', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-13T00:00:00Z'));
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        let mode: 'ready' | 'malformed' | 'unsupported' = 'ready';
        projectionDescribeSpy.mockImplementation(async () => {
            if (mode === 'unsupported') return { supported: false, reason: 'not-supported' };
            if (mode === 'malformed') {
                return { supported: true, projection: projection({ broken: { id: '' } }) };
            }
            return { supported: true, projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.plugin.a' }) };
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });

        mode = 'malformed';
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        await flushHookEffects({ cycles: 4 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'stale', errorReason: 'malformed' });
        expect(getConnectedServiceRegistryEntry('bitbucket').projectedDescriptor).toBeTruthy();

        mode = 'unsupported';
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        await flushHookEffects({ cycles: 4 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'stale', errorReason: 'unsupported' });
        expect(getConnectedServiceRegistryEntry('bitbucket').projectedDescriptor).toBeTruthy();
    });

    it('isolates last-known-good when the active server changes', async () => {
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        projectionDescribeSpy.mockImplementation(async (_machineId: string, options: { serverId: string }) => (
            options.serverId === 'server-1'
                ? { supported: true, projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.server.one' }) }
                : { supported: false, reason: 'error' }
        ));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(getConnectedServiceRegistryEntry('bitbucket').projectedDescriptor).toEqual(expect.objectContaining({ pluginId: 'acme.server.one' }));

        storageState.activeServer = { serverId: 'server-2', serverUrl: 'https://server-two.example.test', generation: 2 };
        await screen.update(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });

        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ scopeKey: 'server-2', status: 'error' });
        expect(getConnectedServiceRegistryEntry('bitbucket').projectedDescriptor).toBeUndefined();
    });

    it('ignores a late projection from the previous server after a server switch', async () => {
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        const serverOne = createDeferred<{ supported: true; projection: Record<string, unknown> }>();
        projectionDescribeSpy.mockImplementation(async (_machineId: string, options: { serverId: string }) => (
            options.serverId === 'server-1'
                ? serverOne.promise
                : { supported: true, projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.server.two' }) }
        ));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 2 });

        storageState.activeServer = { serverId: 'server-2', serverUrl: 'https://server-two.example.test', generation: 2 };
        await screen.update(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(getConnectedServiceRegistryEntry('bitbucket').projectedDescriptor).toEqual(expect.objectContaining({ pluginId: 'acme.server.two' }));

        serverOne.resolve({
            supported: true,
            projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.server.one' }),
        });
        await flushHookEffects({ cycles: 4 });

        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ scopeKey: 'server-2', status: 'ready' });
        expect(getConnectedServiceRegistryEntry('bitbucket').projectedDescriptor).toEqual(expect.objectContaining({ pluginId: 'acme.server.two' }));
    });

    it('removes a descriptor when its machine ages out of the online grace period', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-13T00:00:00Z'));
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        projectionDescribeSpy.mockResolvedValue({
            supported: true,
            projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.plugin.a' }),
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(getConnectedServiceRegistryEntry('bitbucket')).toMatchObject({ supportsToken: true });

        await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
        await flushHookEffects({ cycles: 4 });
        expect(getConnectedServiceRegistryEntry('bitbucket')).toMatchObject({ supportsToken: false });
    });

    it('clears account-scoped projected descriptors when the app-shell owner unmounts', async () => {
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        projectionDescribeSpy.mockResolvedValue({
            supported: true,
            projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.plugin.a' }),
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(getConnectedServiceRegistryEntry('bitbucket')).toMatchObject({ supportsToken: true });

        await screen.unmount();
        expect(getConnectedServiceRegistryEntry('bitbucket')).toMatchObject({ supportsToken: false });
    });
});
