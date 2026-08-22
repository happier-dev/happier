import { describe, expect, it, vi } from 'vitest';
import {
    PluginContributesV2Schema,
    type PluginMachineExecutionOriginV1,
    type PluginProjectedActionV2,
} from '@happier-dev/protocol';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';

import { createPluginReactNativeBundleCache } from './bundleCache';
import {
    createPluginUiClientExecutableComposition,
    createPluginUiClientExecutableRegistrationIndex,
    getPluginUiClientExecutableTargetAddressKey,
    resolvePluginUiClientActionRegistration,
} from './clientExecutableContributions';
import {
    createPluginUiExecutableModuleHost,
    type PluginUiExecutableModuleHost,
} from './executableModuleHost';
import type {
    PluginReactNativeExecutableExport,
    PluginReactNativeLoaderBackend,
} from './loader';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

const pluginId = 'acme.preview';
const target = Object.freeze({
    artifactId: 'client-runtime',
    modulePath: './clientRuntime',
    exportName: 'activate',
    platform: 'web' as const,
});
const executionOrigin: PluginMachineExecutionOriginV1 = Object.freeze({
    serverIdentityId: 'srv_server1',
    materializationRef: Object.freeze({
        machineId: 'machine-1',
        materializationId: 'materialization-1',
        pluginId,
    }),
});
const identity: PluginReactNativeBundleCacheIdentity = Object.freeze({
    pluginId,
    contributionId: target.artifactId,
    artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    reactNativeVersion: '0.83.4',
    platform: 'web',
    channel: 'internal',
    nativeCapabilitiesDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    projectionGeneration: 12,
});
const authority = Object.freeze({
    serverId: 'server-1',
    machineId: 'machine-1',
    projectionGeneration: 12,
});
const moduleReference = Object.freeze({
    containerName: 'acme_preview_client_runtime',
    modulePath: target.modulePath,
    exportName: target.exportName,
});

describe('getPluginUiClientExecutableTargetAddressKey', () => {
    it('keeps every executable target address field distinct', () => {
        const address = Object.freeze({
            pluginId,
            target,
            executionOrigin,
            projectionGeneration: identity.projectionGeneration,
            authority,
        });

        const keys = [
            address,
            { ...address, pluginId: 'acme.other' },
            { ...address, target: { ...target, artifactId: 'other-runtime' } },
            { ...address, target: { ...target, modulePath: './otherRuntime' } },
            { ...address, target: { ...target, exportName: 'otherActivate' } },
            { ...address, target: { ...target, platform: 'ios' as const } },
            { ...address, executionOrigin: { ...executionOrigin, serverIdentityId: 'srv_other' } },
            {
                ...address,
                executionOrigin: {
                    ...executionOrigin,
                    materializationRef: { ...executionOrigin.materializationRef, machineId: 'machine-2' },
                },
            },
            {
                ...address,
                executionOrigin: {
                    ...executionOrigin,
                    materializationRef: { ...executionOrigin.materializationRef, materializationId: 'materialization-2' },
                },
            },
            {
                ...address,
                executionOrigin: {
                    ...executionOrigin,
                    materializationRef: { ...executionOrigin.materializationRef, pluginId: 'acme.other' },
                },
            },
            { ...address, projectionGeneration: identity.projectionGeneration + 1 },
            { ...address, authority: { ...authority, serverId: 'server-2' } },
            { ...address, authority: { ...authority, machineId: 'machine-2' } },
            { ...address, authority: { ...authority, projectionGeneration: authority.projectionGeneration + 1 } },
        ].map(getPluginUiClientExecutableTargetAddressKey);

        expect([...new Set(keys)]).toHaveLength(keys.length);
    });
});

const contributes = PluginContributesV2Schema.parse({
    actions: [{
        id: 'open-preview',
        title: 'Open preview',
        scopes: ['session'],
        surfaces: ['ui'],
        placementBindings: ['detailsPanel'],
        dangerLevel: 'safe',
        execution: {
            target: 'client',
            client: {
                artifactId: target.artifactId,
                modulePath: target.modulePath,
                exportName: target.exportName,
            },
            platforms: [target.platform],
        },
    }],
    voiceProviders: [{
        id: 'conversation',
        title: 'Synthetic Conversation',
        kind: 'conversation',
        roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
        platforms: [target.platform],
        capabilities: {
            turn: {
                cancelResponse: true,
                bargeIn: false,
                clearInput: true,
                resumption: 'resume',
                replay: 'stable_ids',
                exactMessage: true,
                interruptionPolicy: 'provider_immediate',
            },
        },
        client: {
            artifactId: target.artifactId,
            modulePath: target.modulePath,
            exportName: target.exportName,
        },
    }],
});

function projectedClientAction(): PluginProjectedActionV2 {
    const action = {
        id: 'open-preview',
        pluginId,
        title: 'Open preview',
        scopes: ['session'],
        surfaces: ['ui'],
        execution: {
            target: 'client',
            client: {
                artifactId: target.artifactId,
                modulePath: target.modulePath,
                exportName: target.exportName,
            },
            platforms: [target.platform],
        },
        serverIdentityId: executionOrigin.serverIdentityId,
        materializationRef: executionOrigin.materializationRef,
        placementBindings: ['detailsPanel'],
        priority: 0,
        dangerLevel: 'safe',
        available: true,
    } satisfies PluginProjectedActionV2;
    return Object.freeze(action);
}

function withCurrentAuthorization(action: PluginProjectedActionV2): PluginProjectedActionV2 {
    const authorization: NonNullable<PluginProjectedActionV2['authorization']> = {
        packageTrust: {
            packageIdentity: 'package:acme.preview:generation-12',
            reviewedPackageIdentity: 'package:acme.preview:generation-12',
        },
        generation: {
            targetGeneration: '12',
            desiredGeneration: '12',
            appliedGeneration: '12',
        },
        resourceSelections: [],
        scopedGrants: [],
        serviceAvailability: [],
        operatingSystemAuthorization: [],
    };
    return Object.freeze({
        ...action,
        authorization,
    });
}

function actionOnlyContributes() {
    return PluginContributesV2Schema.parse({
        actions: [{
            id: 'open-preview',
            title: 'Open preview',
            scopes: ['session'],
            surfaces: ['ui'],
            placementBindings: ['detailsPanel'],
            dangerLevel: 'safe',
            execution: {
                target: 'client',
                client: {
                    artifactId: target.artifactId,
                    modulePath: target.modulePath,
                    exportName: target.exportName,
                },
                platforms: [target.platform],
            },
        }],
    });
}

function createProviderLeaf() {
    return {
        kind: 'conversation' as const,
        protocol: {
            async prepare() {
                return { kind: 'prepared' as const, session: { config: {}, safeMetadata: null } };
            },
            decodeControl: () => [],
            encodeTurnControl: (action: string) => action === 'cancel_response' ? { type: 'cancel' } : null,
        },
        async createConnection() {
            let open = false;
            return {
                kind: 'sdk_handle' as const,
                async connect() { open = true; },
                async sendControl() {},
                controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                async close() { open = false; },
                state: () => open ? 'open' as const : 'closed' as const,
                currentProviderSessionId: () => null,
                playbackCursorMs: () => null,
                beginOutputInterruptionCandidate: () => 'unsupported' as const,
                resolveOutputInterruptionCandidate() {},
            };
        },
        encodeToolResults: () => [],
        encodeToolContinuation: (responseId: string) => ({ type: 'continue', responseId }),
        encodeContextUpdate: (text: string) => [{ type: 'context', text }],
        encodeTextTurn: (text: string) => [{ type: 'text', text }],
        async forgetProviderConversation() {},
        microphoneMode: 'provider_managed' as const,
        setInputMuted: () => {},
    };
}

function cacheWithIdentity() {
    const cache = createPluginReactNativeBundleCache();
    cache.putInstalledArtifact({
        identity,
        bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
        format: 'plainJs',
    });
    return cache;
}

function backend(exported: PluginReactNativeExecutableExport): PluginReactNativeLoaderBackend {
    return Object.freeze({
        backendId: 'reactNativeWebModule',
        available: true,
        loadInstalledBundle: vi.fn(async () => exported),
    });
}

function readRegistrationInput(family: 'actions' | 'voiceProviders', localId: string) {
    return Object.freeze({
        family,
        pluginId,
        localId,
        target,
        executionOrigin,
        projectionGeneration: identity.projectionGeneration,
    });
}

function createLifecycle() {
    const controller = new AbortController();
    return Object.freeze({
        signal: controller.signal,
        isCurrent: () => !controller.signal.aborted,
    });
}

describe('generic client executable contribution registration', () => {
    it('resolves an Action only after its exact registration commits and retires it synchronously', async () => {
        const index = createPluginUiClientExecutableRegistrationIndex();
        const listener = vi.fn();
        const unsubscribe = index.subscribe(listener);
        const action = projectedClientAction();
        const authorizedAction = withCurrentAuthorization(action);
        const scope = index.createScope({
            pluginId,
            contributes: actionOnlyContributes(),
            target,
            executionOrigin,
            projectionGeneration: identity.projectionGeneration,
            pluginVersion: '1.0.0',
            lifecycle: createLifecycle(),
        });
        scope.api.actions.register('open-preview', async () => null);

        expect(resolvePluginUiClientActionRegistration({
            action,
            projectionGeneration: identity.projectionGeneration,
            platform: target.platform,
            reader: index,
        })).toBeNull();

        scope.commit();

        expect(index.revision()).toBe(1);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(resolvePluginUiClientActionRegistration({
            action,
            projectionGeneration: identity.projectionGeneration,
            platform: target.platform,
            reader: index,
        })).toBeNull();
        const reader = Object.freeze({
            read: vi.fn(index.read),
        });
        const resolvedRegistration = resolvePluginUiClientActionRegistration({
            action: authorizedAction,
            projectionGeneration: identity.projectionGeneration,
            platform: target.platform,
            reader,
        });
        expect(resolvedRegistration).toMatchObject({
            pluginVersion: '1.0.0',
            handler: expect.any(Function),
        });
        expect(resolvedRegistration).not.toHaveProperty('address');
        expect(reader.read).toHaveBeenCalledWith(readRegistrationInput('actions', 'open-preview'));
        expect(resolvePluginUiClientActionRegistration({
            action: authorizedAction,
            projectionGeneration: identity.projectionGeneration + 1,
            platform: target.platform,
            reader: index,
        })).toBeNull();
        expect(resolvePluginUiClientActionRegistration({
            action: authorizedAction,
            projectionGeneration: identity.projectionGeneration,
            platform: 'ios',
            reader: index,
        })).toBeNull();

        const retirement = scope.unwind();
        expect(resolvePluginUiClientActionRegistration({
            action: authorizedAction,
            projectionGeneration: identity.projectionGeneration,
            platform: target.platform,
            reader: index,
        })).toBeNull();
        await retirement;
        expect(index.revision()).toBe(2);
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
    });

    it('fails closed when a client Action registration has no installed version', async () => {
        const index = createPluginUiClientExecutableRegistrationIndex();
        const action = projectedClientAction();
        const scope = index.createScope({
            pluginId,
            contributes: actionOnlyContributes(),
            target,
            executionOrigin,
            projectionGeneration: identity.projectionGeneration,
            lifecycle: createLifecycle(),
        });
        scope.api.actions.register('open-preview', async () => null);
        scope.commit();

        expect(resolvePluginUiClientActionRegistration({
            action,
            projectionGeneration: identity.projectionGeneration,
            platform: target.platform,
            reader: index,
        })).toBeNull();
        await scope.unwind();
    });

    it('captures the exact Action and Voice registrations in one scope', async () => {
        const index = createPluginUiClientExecutableRegistrationIndex();
        const scope = index.createScope({
            pluginId,
            contributes,
            target,
            executionOrigin,
            projectionGeneration: identity.projectionGeneration,
            lifecycle: createLifecycle(),
        });

        scope.api.actions.register('open-preview', async () => null);
        scope.api.voiceProviders.register('conversation', createProviderLeaf());

        scope.commit();
        expect(scope.registrations()).toHaveLength(2);
        expect(index.read(readRegistrationInput('voiceProviders', 'conversation'))?.right).toMatchObject({
            family: 'voiceProviders',
            localId: 'conversation',
            voiceProviderDeclaration: {
                id: 'conversation',
                kind: 'conversation',
            },
        });
        await scope.unwind();
    });

    it('activates one exact target once, publishes Actions and Voice atomically, and withdraws before cleanup', async () => {
        const index = createPluginUiClientExecutableRegistrationIndex();
        const host = createPluginUiExecutableModuleHost();
        const cleanup = vi.fn(async () => {});
        const lifecycle = createLifecycle();
        const activate = vi.fn((api: PluginClientApi) => {
            // The index cannot expose a partially staged registration to a
            // consumer while the one shared client module is still activating.
            expect(index.read(readRegistrationInput('actions', 'open-preview'))).toBeNull();
            api.actions.register('open-preview', async () => null);
            api.voiceProviders.register('conversation', createProviderLeaf());
            return cleanup;
        });

        await host.replaceAuthority(authority);
        const input = Object.freeze({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(activate),
            hostPlatform: target.platform,
            authority,
            createScope: () => index.createScope({
                pluginId,
                contributes,
                target,
                executionOrigin,
                projectionGeneration: identity.projectionGeneration,
                lifecycle,
            }),
        });

        await expect(host.activate(input)).resolves.toEqual({ ok: true });
        await expect(host.activate(input)).resolves.toEqual({ ok: true });
        expect(activate).toHaveBeenCalledTimes(1);

        const action = index.read(readRegistrationInput('actions', 'open-preview'));
        const voice = index.read(readRegistrationInput('voiceProviders', 'conversation'));
        expect(action).toMatchObject({
            registration: { family: 'actions', localId: 'open-preview' },
            target,
            executionOrigin,
            projectionGeneration: identity.projectionGeneration,
        });
        expect(voice).toMatchObject({
            registration: { family: 'voiceProviders', localId: 'conversation' },
            target,
            executionOrigin,
            projectionGeneration: identity.projectionGeneration,
        });
        expect(Object.isFrozen(action)).toBe(true);
        expect(Object.isFrozen(voice)).toBe(true);

        const retiring = host.replaceAuthority(null);
        expect(index.read(readRegistrationInput('actions', 'open-preview'))).toBeNull();
        expect(index.read(readRegistrationInput('voiceProviders', 'conversation'))).toBeNull();
        await retiring;
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('never publishes one family when its shared target misses another declared registration', async () => {
        const index = createPluginUiClientExecutableRegistrationIndex();
        const host = createPluginUiExecutableModuleHost();
        const lifecycle = createLifecycle();
        const activate = vi.fn((api: PluginClientApi) => {
            api.actions.register('open-preview', async () => null);
        });

        await host.replaceAuthority(authority);
        await expect(host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(activate),
            hostPlatform: target.platform,
            authority,
            createScope: () => index.createScope({
                pluginId,
                contributes,
                target,
                executionOrigin,
                projectionGeneration: identity.projectionGeneration,
                lifecycle,
            }),
        })).resolves.toEqual({
            ok: false,
            code: 'activation_failed',
            diagnostics: ['activation_failed'],
        });

        expect(index.read(readRegistrationInput('actions', 'open-preview'))).toBeNull();
        expect(index.read(readRegistrationInput('voiceProviders', 'conversation'))).toBeNull();
    });

    it('keeps independent exact targets live together and withdraws only the retired target before cleanup', async () => {
        // A single plugin may declare more than one client executable target.
        // Retiring one must not use the host's broad plugin invalidation and
        // accidentally withdraw its still-current sibling.
        const secondPluginId = pluginId;
        const secondTarget = Object.freeze({
            artifactId: 'second-runtime',
            modulePath: './secondRuntime',
            exportName: 'activateSecond',
            platform: 'web' as const,
        });
        const secondOrigin: PluginMachineExecutionOriginV1 = executionOrigin;
        const secondIdentityProjectionGeneration = identity.projectionGeneration;
        const secondAuthority = authority;
        const secondIdentity: PluginReactNativeBundleCacheIdentity = Object.freeze({
            ...identity,
            pluginId: secondPluginId,
            contributionId: secondTarget.artifactId,
            artifactDigest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        });
        const actionOnlyContributes = PluginContributesV2Schema.parse({
            actions: [{
                id: 'open-preview',
                title: 'Open preview',
                scopes: ['session'],
                surfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
                execution: {
                    target: 'client',
                    client: {
                        artifactId: target.artifactId,
                        modulePath: target.modulePath,
                        exportName: target.exportName,
                    },
                    platforms: [target.platform],
                },
            }],
        });
        const secondActionOnlyContributes = PluginContributesV2Schema.parse({
            actions: [{
                id: 'open-second',
                title: 'Open second',
                scopes: ['session'],
                surfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
                execution: {
                    target: 'client',
                    client: {
                        artifactId: secondTarget.artifactId,
                        modulePath: secondTarget.modulePath,
                        exportName: secondTarget.exportName,
                    },
                    platforms: [secondTarget.platform],
                },
            }],
        });
        const firstCleanup = vi.fn(async () => {});
        const secondCleanup = vi.fn(async () => {});
        const firstActivate = vi.fn((api: PluginClientApi) => {
            api.actions.register('open-preview', async () => null);
            return firstCleanup;
        });
        const secondActivate = vi.fn((api: PluginClientApi) => {
            api.actions.register('open-second', async () => null);
            return secondCleanup;
        });
        const createExecutableHost = vi.fn(() => createPluginUiExecutableModuleHost());
        const composition = createPluginUiClientExecutableComposition({ createExecutableHost });
        const firstActivation = Object.freeze({
            pluginId,
            contributes: actionOnlyContributes,
            target,
            executionOrigin,
            projectionGeneration: identity.projectionGeneration,
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(firstActivate),
            authority,
            isCurrent: () => true,
        });
        const secondActivation = Object.freeze({
            pluginId: secondPluginId,
            contributes: secondActionOnlyContributes,
            target: secondTarget,
            executionOrigin: secondOrigin,
            projectionGeneration: secondIdentity.projectionGeneration,
            cache: (() => {
                const cache = createPluginReactNativeBundleCache();
                cache.putInstalledArtifact({
                    identity: secondIdentity,
                    bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
                    format: 'plainJs',
                });
                return cache;
            })(),
            identity: secondIdentity,
            moduleReference: Object.freeze({
                containerName: 'acme_second_runtime',
                modulePath: secondTarget.modulePath,
                exportName: secondTarget.exportName,
            }),
            backend: backend(secondActivate),
            authority: secondAuthority,
            isCurrent: () => true,
        });

        await expect(composition.reconcile([firstActivation, secondActivation])).resolves.toEqual([
            expect.objectContaining({ result: { ok: true } }),
            expect.objectContaining({ result: { ok: true } }),
        ]);
        // One composition owns one incumbent host. Exact target retirement
        // still cannot let a sibling from the same authority disappear.
        expect(createExecutableHost).toHaveBeenCalledTimes(1);
        expect(firstActivate).toHaveBeenCalledTimes(1);
        expect(secondActivate).toHaveBeenCalledTimes(1);
        const firstRegistration = composition.read(readRegistrationInput('actions', 'open-preview'));
        expect(firstRegistration).not.toBeNull();
        expect(composition.read({
            family: 'actions',
            pluginId: secondPluginId,
            localId: 'open-second',
            target: secondTarget,
            executionOrigin: secondOrigin,
            projectionGeneration: secondIdentity.projectionGeneration,
        })).not.toBeNull();

        const retiring = composition.reconcile([secondActivation]);
        expect(firstRegistration?.lifecycle.signal.aborted).toBe(true);
        expect(firstRegistration?.lifecycle.isCurrent()).toBe(false);
        expect(composition.read(readRegistrationInput('actions', 'open-preview'))).toBeNull();
        expect(composition.read({
            family: 'actions',
            pluginId: secondPluginId,
            localId: 'open-second',
            target: secondTarget,
            executionOrigin: secondOrigin,
            projectionGeneration: secondIdentity.projectionGeneration,
        })).not.toBeNull();
        await retiring;
        expect(firstCleanup).toHaveBeenCalledTimes(1);
        expect(secondCleanup).not.toHaveBeenCalled();
    });

    it('keeps exact authority partitions live together and retires only the withdrawn origin', async () => {
        const firstContributes = PluginContributesV2Schema.parse({
            actions: [{
                id: 'open-preview',
                title: 'Open preview',
                scopes: ['session'],
                surfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
                execution: {
                    target: 'client',
                    client: {
                        artifactId: target.artifactId,
                        modulePath: target.modulePath,
                        exportName: target.exportName,
                    },
                    platforms: [target.platform],
                },
            }],
        });
        const otherPluginId = 'acme.other-preview';
        const otherTarget = Object.freeze({
            artifactId: 'other-client-runtime',
            modulePath: './otherClientRuntime',
            exportName: 'activateOther',
            platform: 'web' as const,
        });
        const otherOrigin: PluginMachineExecutionOriginV1 = Object.freeze({
            serverIdentityId: 'srv_server1',
            materializationRef: Object.freeze({
                machineId: 'machine-2',
                materializationId: 'materialization-2',
                pluginId: otherPluginId,
            }),
        });
        const otherAuthority = Object.freeze({
            serverId: 'server-1',
            machineId: 'machine-2',
            projectionGeneration: 12,
        });
        const otherIdentity: PluginReactNativeBundleCacheIdentity = Object.freeze({
            ...identity,
            pluginId: otherPluginId,
            contributionId: otherTarget.artifactId,
            artifactDigest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        });
        const otherContributes = PluginContributesV2Schema.parse({
            actions: [{
                id: 'open-other-preview',
                title: 'Open other preview',
                scopes: ['session'],
                surfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
                execution: {
                    target: 'client',
                    client: {
                        artifactId: otherTarget.artifactId,
                        modulePath: otherTarget.modulePath,
                        exportName: otherTarget.exportName,
                    },
                    platforms: [otherTarget.platform],
                },
            }],
        });
        const firstCleanup = vi.fn(async () => {});
        const otherCleanup = vi.fn(async () => {});
        const firstActivate = vi.fn((api: PluginClientApi) => {
            api.actions.register('open-preview', async () => null);
            return firstCleanup;
        });
        const otherActivate = vi.fn((api: PluginClientApi) => {
            api.actions.register('open-other-preview', async () => null);
            return otherCleanup;
        });
        const composition = createPluginUiClientExecutableComposition({
            createExecutableHost: () => createPluginUiExecutableModuleHost(),
        });
        const firstActivation = Object.freeze({
            pluginId,
            contributes: firstContributes,
            target,
            executionOrigin,
            projectionGeneration: identity.projectionGeneration,
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(firstActivate),
            authority,
            isCurrent: () => true,
        });
        const otherActivation = Object.freeze({
            pluginId: otherPluginId,
            contributes: otherContributes,
            target: otherTarget,
            executionOrigin: otherOrigin,
            projectionGeneration: otherIdentity.projectionGeneration,
            cache: (() => {
                const cache = createPluginReactNativeBundleCache();
                cache.putInstalledArtifact({
                    identity: otherIdentity,
                    bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
                    format: 'plainJs',
                });
                return cache;
            })(),
            identity: otherIdentity,
            moduleReference: Object.freeze({
                containerName: 'acme_other_preview_client_runtime',
                modulePath: otherTarget.modulePath,
                exportName: otherTarget.exportName,
            }),
            backend: backend(otherActivate),
            authority: otherAuthority,
            isCurrent: () => true,
        });

        await expect(composition.reconcile([firstActivation, otherActivation])).resolves.toEqual([
            expect.objectContaining({ result: { ok: true } }),
            expect.objectContaining({ result: { ok: true } }),
        ]);
        const firstRegistration = composition.read(readRegistrationInput('actions', 'open-preview'));
        expect(firstRegistration).not.toBeNull();
        expect(composition.read({
            family: 'actions',
            pluginId: otherPluginId,
            localId: 'open-other-preview',
            target: otherTarget,
            executionOrigin: otherOrigin,
            projectionGeneration: otherIdentity.projectionGeneration,
        })).not.toBeNull();

        const retireFirstOrigin = composition.reconcile([otherActivation]);
        expect(firstRegistration?.lifecycle.signal.aborted).toBe(true);
        expect(composition.read(readRegistrationInput('actions', 'open-preview'))).toBeNull();
        expect(composition.read({
            family: 'actions',
            pluginId: otherPluginId,
            localId: 'open-other-preview',
            target: otherTarget,
            executionOrigin: otherOrigin,
            projectionGeneration: otherIdentity.projectionGeneration,
        })).not.toBeNull();
        await retireFirstOrigin;
        expect(firstCleanup).toHaveBeenCalledTimes(1);
        expect(otherCleanup).not.toHaveBeenCalled();

        await composition.unload();
        expect(otherCleanup).toHaveBeenCalledTimes(1);
    });

    it('retries an authority leaf after replaceAuthority rejects without poisoning the reusable host', async () => {
        const realHost = createPluginUiExecutableModuleHost();
        let replaceAttempts = 0;
        const flakyHost: PluginUiExecutableModuleHost = Object.freeze({
            ...realHost,
            replaceAuthority: async (nextAuthority) => {
                replaceAttempts += 1;
                if (replaceAttempts === 1) throw new Error('replace_authority_failed');
                await realHost.replaceAuthority(nextAuthority);
            },
        });
        const createExecutableHost = vi.fn(() => flakyHost);
        const activation = Object.freeze({
            pluginId,
            contributes,
            target,
            executionOrigin,
            projectionGeneration: identity.projectionGeneration,
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend((api: PluginClientApi) => {
                api.actions.register('open-preview', async () => null);
                api.voiceProviders.register('conversation', createProviderLeaf());
            }),
            authority,
            isCurrent: () => true,
        });
        const composition = createPluginUiClientExecutableComposition({ createExecutableHost });

        await expect(composition.reconcile([activation])).rejects.toThrow('replace_authority_failed');
        await expect(composition.reconcile([activation])).resolves.toEqual([
            expect.objectContaining({ result: { ok: true } }),
        ]);

        expect(createExecutableHost).toHaveBeenCalledTimes(1);
        expect(replaceAttempts).toBe(2);
        await composition.unload();
    });

    it('remounts the same authority before retiring cleanup settles without letting that cleanup withdraw the new registration', async () => {
        const composition = createPluginUiClientExecutableComposition({
            executableHost: createPluginUiExecutableModuleHost(),
        });
        let releaseRetiringCleanup!: () => void;
        const retiringCleanup = new Promise<void>((resolve) => {
            releaseRetiringCleanup = resolve;
        });
        let activationCount = 0;
        const activate = vi.fn((api: PluginClientApi) => {
            activationCount += 1;
            api.actions.register('open-preview', async () => null);
            return activationCount === 1
                ? () => retiringCleanup
                : undefined;
        });
        const activation = Object.freeze({
            pluginId,
            contributes: actionOnlyContributes(),
            target,
            executionOrigin,
            projectionGeneration: identity.projectionGeneration,
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(activate),
            authority,
            isCurrent: () => true,
        });
        const readRegistration = () => composition.read(readRegistrationInput('actions', 'open-preview'));

        await expect(composition.reconcile([activation])).resolves.toEqual([
            expect.objectContaining({ result: { ok: true } }),
        ]);
        expect(readRegistration()).not.toBeNull();

        const retiring = composition.unload();
        expect(readRegistration()).toBeNull();
        try {
            await expect(composition.reconcile([activation])).resolves.toEqual([
                expect.objectContaining({ result: { ok: true } }),
            ]);
            const remountedRegistration = readRegistration();
            expect(remountedRegistration).not.toBeNull();

            releaseRetiringCleanup();
            await retiring;

            expect(readRegistration()).toBe(remountedRegistration);
        } finally {
            releaseRetiringCleanup();
            await retiring;
            await composition.unload();
        }
    });

    it('withdraws every generic registration synchronously on plugin retirement', async () => {
        const composition = createPluginUiClientExecutableComposition({
            executableHost: createPluginUiExecutableModuleHost(),
        });
        const cleanup = vi.fn(async () => {});
        const activate = vi.fn((api: PluginClientApi) => {
            api.actions.register('open-preview', async () => null);
            return cleanup;
        });
        const actionOnlyContributes = PluginContributesV2Schema.parse({
            actions: [{
                id: 'open-preview',
                title: 'Open preview',
                scopes: ['session'],
                surfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
                execution: {
                    target: 'client',
                    client: {
                        artifactId: target.artifactId,
                        modulePath: target.modulePath,
                        exportName: target.exportName,
                    },
                    platforms: [target.platform],
                },
            }],
        });
        const activation = Object.freeze({
            pluginId,
            contributes: actionOnlyContributes,
            target,
            executionOrigin,
            projectionGeneration: identity.projectionGeneration,
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(activate),
            authority,
            isCurrent: () => true,
        });

        await expect(composition.reconcile([activation])).resolves.toEqual([
            expect.objectContaining({ result: { ok: true } }),
        ]);
        const registration = composition.read(readRegistrationInput('actions', 'open-preview'));
        expect(registration).not.toBeNull();

        const retiring = composition.invalidatePlugin(pluginId);
        expect(registration?.lifecycle.signal.aborted).toBe(true);
        expect(composition.read(readRegistrationInput('actions', 'open-preview'))).toBeNull();
        await retiring;
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('cannot publish a module that finishes loading after its exact target retires', async () => {
        const composition = createPluginUiClientExecutableComposition({
            executableHost: createPluginUiExecutableModuleHost(),
        });
        const activate = vi.fn((api: PluginClientApi) => {
            api.actions.register('open-preview', async () => null);
        });
        let resolveLoaded: (exported: PluginReactNativeExecutableExport) => void = () => {};
        const loaded = new Promise<PluginReactNativeExecutableExport>((resolve) => {
            resolveLoaded = resolve;
        });
        const slowBackend: PluginReactNativeLoaderBackend = Object.freeze({
            backendId: 'reactNativeWebModule',
            available: true,
            loadInstalledBundle: vi.fn(() => loaded),
        });
        const actionOnlyContributes = PluginContributesV2Schema.parse({
            actions: [{
                id: 'open-preview',
                title: 'Open preview',
                scopes: ['session'],
                surfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
                execution: {
                    target: 'client',
                    client: {
                        artifactId: target.artifactId,
                        modulePath: target.modulePath,
                        exportName: target.exportName,
                    },
                    platforms: [target.platform],
                },
            }],
        });
        const activation = Object.freeze({
            pluginId,
            contributes: actionOnlyContributes,
            target,
            executionOrigin,
            projectionGeneration: identity.projectionGeneration,
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: slowBackend,
            authority,
            isCurrent: () => true,
        });

        const pending = composition.reconcile([activation]);
        await vi.waitFor(() => expect(slowBackend.loadInstalledBundle).toHaveBeenCalledTimes(1));
        const retiring = composition.reconcile([]);
        resolveLoaded(activate);

        await expect(pending).resolves.toEqual([
            expect.objectContaining({
                result: expect.objectContaining({
                    ok: false,
                    code: 'stale_projection_generation',
                }),
            }),
        ]);
        expect(composition.read(readRegistrationInput('actions', 'open-preview'))).toBeNull();
        expect(activate).not.toHaveBeenCalled();
        await retiring;
    });
});
