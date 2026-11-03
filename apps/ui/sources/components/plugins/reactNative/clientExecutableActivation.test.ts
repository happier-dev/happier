import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    PluginContributesV2Schema,
    PluginProjectionV2Schema,
    type PluginMachineExecutionOriginV1,
} from '@happier-dev/protocol';
import {
    PluginUiArtifactsManifestEntryV2Schema,
} from '@happier-dev/protocol/plugins/ui';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';

import {
    createPluginReactNativeBundleCache,
    type PluginReactNativeBundleCache,
} from './bundleCache';
import {
    getPluginUiClientExecutableComposition,
    type PluginUiClientExecutableRegistrationAddress,
} from './clientExecutableContributions';
import { createPluginUiExecutableModuleHost } from './executableModuleHost';
import type { PluginReactNativeLoaderBackend } from './loader';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    normalizePluginUiProjection,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY } from '@/sync/domains/plugins/ui/projectionUnion';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

const artifactAvailabilitySpy = vi.hoisted(() => vi.fn());
const installedRuntime = vi.hoisted(() => ({
    cache: null as PluginReactNativeBundleCache | null,
}));

vi.mock('@/sync/domains/plugins/availability/reactNativeArtifactAvailability', () => ({
    acquirePluginReactNativeArtifactAvailability: (...args: unknown[]) => artifactAvailabilitySpy(...args),
}));

vi.mock('./bundleCache', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./bundleCache')>();
    return {
        ...actual,
        getInstalledPluginReactNativeBundleCache: () => installedRuntime.cache ?? actual.getInstalledPluginReactNativeBundleCache(),
    };
});

import { reconcileProjectedPluginUiClientExecutables } from './clientExecutableActivation';

const pluginId = 'acme.shared-runtime';
const serverId = 'server-1';
const machineId = 'machine-1';
const occurrenceIdForGeneration = (generation: number) => `${pluginId}:occurrence:${generation}`;
const target = Object.freeze({
    artifactId: 'shared-runtime',
    exportName: 'activate',
    platform: 'web' as const,
});
const origin: PluginMachineExecutionOriginV1 = Object.freeze({
    serverIdentityId: 'srv_shared_runtime',
    materializationRef: Object.freeze({
        pluginId,
        machineId,
        materializationId: 'shared-runtime-install',
    }),
});

function identity(localId: string, _generation: number): PluginReactNativeBundleCacheIdentity {
    return Object.freeze({
        pluginId,
        contributionId: localId,
        artifactId: target.artifactId,
        artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        platform: target.platform,
    });
}

function artifactGraph() {
    return PluginUiArtifactsManifestEntryV2Schema.parse({
        artifactId: target.artifactId,
        tier: 'reactNative',
        entry: 'react-native/shared-runtime/entry.cjs.bundle',
        files: [{
            relativePath: 'react-native/shared-runtime/entry.cjs.bundle',
            digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            byteSize: 1,
        }],
        digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        builtWith: { bundler: 'esbuild', version: '0.27.2' },
        executable: { exports: ['activate'] },
        hostUiApiRange: '^1.0.0',
    });
}

function actionDeclaration() {
    return PluginContributesV2Schema.parse({
        actions: [{
            id: 'open-shared',
            title: 'Open shared',
            scopes: ['session'],
            surfaces: ['ui'],
            placementBindings: ['detailsPanel'],
            dangerLevel: 'safe',
            execution: {
                target: 'client',
                client: {
                    artifactId: target.artifactId,
                    exportName: target.exportName,
                },
                platforms: [target.platform],
            },
        }],
    }).actions[0]!;
}

function voiceDeclaration() {
    const declaration = PluginContributesV2Schema.parse({
        voiceProviders: [{
            id: 'conversation',
            title: 'Conversation',
            kind: 'conversation',
            roles: ['realtime_conversation'],
            platforms: [target.platform],
            capabilities: {
                turn: {
                    cancelResponse: true,
                    bargeIn: false,
                },
            },
            client: {
                artifactId: target.artifactId,
                exportName: target.exportName,
            },
        }],
    }).voiceProviders[0]!;
    if (declaration.kind !== 'conversation') throw new Error('conversation fixture missing');
    return declaration;
}

function projection(input: Readonly<{
    generation: number;
    action?: boolean;
    voice?: boolean;
}>): Readonly<{
    model: PluginUiProjectionModel;
    actionIdentity: PluginReactNativeBundleCacheIdentity;
    voiceIdentity: PluginReactNativeBundleCacheIdentity;
}> {
    const action = actionDeclaration();
    const voice = voiceDeclaration();
    const actionIdentity = identity(action.id, input.generation);
    const voiceIdentity = identity(voice.id, input.generation);
    const hostOrigin = Object.freeze({
        machineId,
        serverId,
        interactionEnabled: true,
        phase: 'current' as const,
        executionOrigin: origin,
    });
    const graph = artifactGraph();
    const actionsById = input.action === false
        ? Object.freeze({})
        : Object.freeze({
            [`${pluginId}/${action.id}`]: Object.freeze({
                ...action,
                pluginId,
                occurrenceId: occurrenceIdForGeneration(input.generation),
                available: true,
                [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: hostOrigin,
            }),
        });
    const voiceProvidersById = input.voice === false
        ? Object.freeze({})
        : Object.freeze(Object.fromEntries(Object.entries(normalizePluginUiProjection(PluginProjectionV2Schema.parse({
            v: 2, generation: input.generation,
            installedPackagesById: {}, agentsById: {}, actionsById: {},
             resourcesById: {}, settingsById: {}, diagnostics: [],
            familiesById: { voiceProviders: { family: 'voiceProviders', entriesById: {
              [`${pluginId}/${voice.id}`]: {
                id: `${pluginId}/${voice.id}`,
                pluginId,
                occurrenceId: occurrenceIdForGeneration(input.generation),
                contributionKey: `${pluginId}/${voice.id}`,
                definition: voice,
              },
            } } },
        }), 'web').voiceProvidersById).map(([key, entry]) => [key, Object.freeze({
            ...entry,
            executionOrigin: origin,
            [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: hostOrigin,
        })])));
    const reactNativeBundlesById = Object.freeze({
        ...(input.action === false ? {} : {
            [`reactNativeBundle:${pluginId}:${action.id}`]: Object.freeze({
                id: `reactNativeBundle:${pluginId}:${action.id}`,
                pluginId,
                contributionKind: 'reactNativeBundle' as const,
                contributionId: action.id,
                generatedOwnerKind: 'clientContribution',
                executionOrigin: origin,
                artifactGraph: graph,
                runtime: Object.freeze({
                    decision: Object.freeze({ state: 'load' }),
                    loadPolicy: Object.freeze({ source: 'installedArtifact' }),
                    cacheIdentity: { artifactDigest: actionIdentity.artifactDigest },
                }),
                [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: hostOrigin,
            }),
        }),
        ...(input.voice === false ? {} : {
            [`reactNativeBundle:${pluginId}:${voice.id}`]: Object.freeze({
                id: `reactNativeBundle:${pluginId}:${voice.id}`,
                pluginId,
                contributionKind: 'reactNativeBundle' as const,
                contributionId: voice.id,
                generatedOwnerKind: 'voiceProvider',
                executionOrigin: origin,
                artifactGraph: graph,
                runtime: Object.freeze({
                    decision: Object.freeze({ state: 'load' }),
                    loadPolicy: Object.freeze({ source: 'installedArtifact' }),
                    cacheIdentity: { artifactDigest: voiceIdentity.artifactDigest },
                }),
                [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: hostOrigin,
            }),
        }),
    });
    return Object.freeze({
        model: Object.freeze({
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: input.generation,
            actionsById,
            voiceProvidersById,
            reactNativeBundlesById,
        }) satisfies PluginUiProjectionModel,
        actionIdentity,
        voiceIdentity,
    });
}

function createAccountLifetime(): ActiveServerAccountScopeLifetime {
    return Object.freeze({
        scope: Object.freeze({ serverId, accountId: 'account-1' }),
        isCurrent: () => true,
        onRetire: () => Object.freeze({ dispose: () => {} }),
    });
}

function availableArtifact() {
    const revokeListeners = new Set<() => void>();
    const dispose = vi.fn();
    let current = true;
    const revoke = (): void => {
        current = false;
        for (const listener of revokeListeners) listener();
    };
    return Object.freeze({
        handle: Object.freeze({
            kind: 'available' as const,
            cacheKey: 'shared-runtime',
            isCurrent: () => current,
            onRevoke: (listener: () => void) => {
                revokeListeners.add(listener);
                return Object.freeze({ dispose: () => revokeListeners.delete(listener) });
            },
            dispose,
        }),
        dispose,
        revoke,
    });
}

function installArtifact(identityToInstall: PluginReactNativeBundleCacheIdentity): void {
    installedRuntime.cache!.putInstalledArtifact({
        identity: identityToInstall,
        bytes: new Uint8Array([47, 47, 32, 114, 117, 110, 116, 105, 109, 101]),
        format: 'plainJs',
    });
}

function backend(activate: (api: PluginClientApi) => void): PluginReactNativeLoaderBackend {
    return Object.freeze({
        backendId: 'commonJs',
        available: true,
        loadInstalledBundle: vi.fn(async () => activate),
    });
}

function address(input: Readonly<{
    family: 'actions' | 'voiceProviders';
    localId: string;
    generation: number;
}>): PluginUiClientExecutableRegistrationAddress {
    return Object.freeze({
        family: input.family,
        pluginId,
        occurrenceId: occurrenceIdForGeneration(input.generation),
        localId: input.localId,
        target,
        executionOrigin: origin,
    });
}

function reconciliationInput(input: Readonly<{
    model: PluginUiProjectionModel;
    host: ReturnType<typeof createPluginUiExecutableModuleHost>;
    loaderBackend: PluginReactNativeLoaderBackend;
    isCurrent?: () => boolean;
}>) {
    return {
        actionProjection: Object.freeze({ projection: input.model }),
        voiceProviderIds: new Set(Object.keys(input.model.voiceProvidersById)),
        voiceProjection: Object.freeze({
            projection: input.model,
            directMachineAuthority: Object.freeze({ machineId, serverId }),
        }),
        platform: target.platform,
        executableHost: input.host,
        loaderBackend: input.loaderBackend,
        reader: Object.freeze({}) as never,
        accountLifetime: createAccountLifetime(),
        ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
    } as const;
}

afterEach(() => {
    artifactAvailabilitySpy.mockReset();
    installedRuntime.cache = null;
});

describe('projected client executable complete-set reconciliation', () => {
    it('acquires and loads one generic target, then atomically registers its raw Action and Voice leaves without a Voice preparer', async () => {
        installedRuntime.cache = createPluginReactNativeBundleCache();
        const source = projection({ generation: 12 });
        installArtifact(source.actionIdentity);
        const available = availableArtifact();
        artifactAvailabilitySpy.mockResolvedValue(available.handle);
        const host = createPluginUiExecutableModuleHost();
        const activate = vi.fn((api: PluginClientApi) => {
            api.actions.register('open-shared', async () => null);
            api.voiceProviders.register('conversation', {
                kind: 'conversation',
                protocol: {
                    async prepare() { return { kind: 'prepared' as const, session: { config: {}, safeMetadata: null } }; },
                    decodeControl: () => [],
                    encodeTurnControl: () => null,
                },
                async createConnection() {
                    return {
                        kind: 'sdk_handle' as const,
                        async connect() {}, async sendControl() {},
                        controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                        transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                        async close() {}, state: () => 'closed' as const,
                        currentProviderSessionId: () => null, playbackCursorMs: () => null,
                        beginOutputInterruptionCandidate: () => 'unsupported' as const,
                        resolveOutputInterruptionCandidate() {},
                    };
                },
                encodeToolResults: () => [], encodeToolContinuation: () => null,
                encodeContextUpdate: () => [], encodeTextTurn: () => [],
                microphoneMode: 'provider_managed' as const,
                setInputMuted: () => {},
            });
        });
        const loaderBackend = backend(activate);

        const attempts = await reconcileProjectedPluginUiClientExecutables(reconciliationInput({
            model: source.model,
            host,
            loaderBackend,
        }));
        const composition = getPluginUiClientExecutableComposition(host);

        expect(attempts).toMatchObject([{ result: { ok: true }, reused: false }]);
        expect(artifactAvailabilitySpy).toHaveBeenCalledTimes(1);
        expect(loaderBackend.loadInstalledBundle).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledTimes(1);
        expect(composition.read(address({ family: 'actions', localId: 'open-shared', generation: 12 }))).not.toBeNull();
        expect(composition.read(address({ family: 'voiceProviders', localId: 'conversation', generation: 12 }))).not.toBeNull();
        await composition.unload();
    });

    it('reports a shared Action and Voice activation failure, then recovers both only on explicit reconciliation', async () => {
        installedRuntime.cache = createPluginReactNativeBundleCache();
        const source = projection({ generation: 12 });
        installArtifact(source.actionIdentity);
        artifactAvailabilitySpy.mockImplementation(async () => availableArtifact().handle);
        const host = createPluginUiExecutableModuleHost();
        let failActivation = true;
        const activate = vi.fn((api: PluginClientApi) => {
            if (failActivation) throw new Error('synthetic shared activation failure');
            api.actions.register('open-shared', async () => null);
            api.voiceProviders.register('conversation', {
                kind: 'conversation',
                protocol: {
                    async prepare() { return { kind: 'prepared' as const, session: { config: {}, safeMetadata: null } }; },
                    decodeControl: () => [], encodeTurnControl: () => null,
                },
                async createConnection() { throw new Error('not reached'); },
                encodeToolResults: () => [], encodeToolContinuation: () => null,
                encodeContextUpdate: () => [], encodeTextTurn: () => [],
                microphoneMode: 'provider_managed' as const,
                setInputMuted: () => {},
            });
        });
        const loaderBackend = backend(activate);
        const composition = getPluginUiClientExecutableComposition(host);

        await expect(reconcileProjectedPluginUiClientExecutables(reconciliationInput({
            model: source.model,
            host,
            loaderBackend,
        }))).resolves.toMatchObject([{
            result: { ok: false, code: 'activation_failed' },
            reused: false,
        }]);
        expect(composition.read(address({ family: 'actions', localId: 'open-shared', generation: 12 }))).toBeNull();
        expect(composition.read(address({ family: 'voiceProviders', localId: 'conversation', generation: 12 }))).toBeNull();
        expect(activate).toHaveBeenCalledTimes(1);

        failActivation = false;
        await expect(reconcileProjectedPluginUiClientExecutables(reconciliationInput({
            model: source.model,
            host,
            loaderBackend,
        }))).resolves.toMatchObject([{
            result: { ok: true },
            reused: false,
        }]);
        expect(composition.read(address({ family: 'actions', localId: 'open-shared', generation: 12 }))).not.toBeNull();
        expect(composition.read(address({ family: 'voiceProviders', localId: 'conversation', generation: 12 }))).not.toBeNull();
        expect(activate).toHaveBeenCalledTimes(2);
        await composition.unload();
    });

    it('replaces the raw Voice target and synchronously withdraws the previous generic registration', async () => {
        installedRuntime.cache = createPluginReactNativeBundleCache();
        const first = projection({ generation: 12, action: false });
        const second = projection({ generation: 13, action: false });
        installArtifact(first.voiceIdentity);
        installArtifact(second.voiceIdentity);
        artifactAvailabilitySpy.mockImplementation(async () => availableArtifact().handle);
        const host = createPluginUiExecutableModuleHost();
        const activate = vi.fn((api: PluginClientApi) => {
            api.voiceProviders.register('conversation', {
                kind: 'conversation',
                protocol: {
                    async prepare() { return { kind: 'prepared' as const, session: { config: {}, safeMetadata: null } }; },
                    decodeControl: () => [], encodeTurnControl: () => null,
                },
                async createConnection() { throw new Error('not reached'); },
                encodeToolResults: () => [], encodeToolContinuation: () => null,
                encodeContextUpdate: () => [], encodeTextTurn: () => [],
                microphoneMode: 'provider_managed' as const,
                setInputMuted: () => {},
            });
        });
        const loaderBackend = backend(activate);
        const composition = getPluginUiClientExecutableComposition(host);

        await reconcileProjectedPluginUiClientExecutables(reconciliationInput({ model: first.model, host, loaderBackend }));
        expect(composition.read(address({ family: 'voiceProviders', localId: 'conversation', generation: 12 }))).not.toBeNull();

        await reconcileProjectedPluginUiClientExecutables(reconciliationInput({ model: second.model, host, loaderBackend }));

        expect(composition.read(address({ family: 'voiceProviders', localId: 'conversation', generation: 12 }))).toBeNull();
        expect(composition.read(address({ family: 'voiceProviders', localId: 'conversation', generation: 13 }))).not.toBeNull();
        expect(activate).toHaveBeenCalledTimes(2);
        await composition.unload();
    });

    it('releases a late generic Artifact acquisition without loading or publishing it', async () => {
        installedRuntime.cache = createPluginReactNativeBundleCache();
        const source = projection({ generation: 12, action: false });
        installArtifact(source.voiceIdentity);
        const available = availableArtifact();
        let resolveAcquisition: ((value: typeof available.handle) => void) | null = null;
        artifactAvailabilitySpy.mockImplementation(() => new Promise<typeof available.handle>((resolve) => {
            resolveAcquisition = resolve;
        }));
        const host = createPluginUiExecutableModuleHost();
        const loaderBackend = backend(() => {});
        let current = true;
        const pending = reconcileProjectedPluginUiClientExecutables(reconciliationInput({
            model: source.model,
            host,
            loaderBackend,
            isCurrent: () => current,
        }));

        await vi.waitFor(() => expect(resolveAcquisition).not.toBeNull());
        current = false;
        resolveAcquisition!(available.handle);

        await expect(pending).resolves.toEqual([]);
        expect(available.dispose).toHaveBeenCalledTimes(1);
        expect(loaderBackend.loadInstalledBundle).not.toHaveBeenCalled();
        expect(getPluginUiClientExecutableComposition(host).read(
            address({ family: 'voiceProviders', localId: 'conversation', generation: 12 }),
        )).toBeNull();
        await getPluginUiClientExecutableComposition(host).unload();
    });

    it('does not invoke an executable export after its generic Artifact lease is revoked while loading', async () => {
        installedRuntime.cache = createPluginReactNativeBundleCache();
        const source = projection({ generation: 12, action: false });
        installArtifact(source.voiceIdentity);
        const available = availableArtifact();
        artifactAvailabilitySpy.mockResolvedValue(available.handle);
        let resolveLoad: ((value: (api: PluginClientApi) => void) => void) | null = null;
        const activate = vi.fn((_api: PluginClientApi) => {});
        const loaderBackend: PluginReactNativeLoaderBackend = Object.freeze({
            backendId: 'commonJs',
            available: true,
            loadInstalledBundle: vi.fn(() => new Promise<(api: PluginClientApi) => void>((resolve) => {
                resolveLoad = resolve;
            })),
        });
        const host = createPluginUiExecutableModuleHost();
        const pending = reconcileProjectedPluginUiClientExecutables(reconciliationInput({
            model: source.model,
            host,
            loaderBackend,
        }));

        await vi.waitFor(() => expect(loaderBackend.loadInstalledBundle).toHaveBeenCalledOnce());
        available.revoke();
        resolveLoad!(activate);

        await pending;
        expect(activate).not.toHaveBeenCalled();
        expect(getPluginUiClientExecutableComposition(host).read(
            address({ family: 'voiceProviders', localId: 'conversation', generation: 12 }),
        )).toBeNull();
        await getPluginUiClientExecutableComposition(host).unload();
    });
});
