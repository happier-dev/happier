import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createPluginUiHostApiClient } from '@happier-dev/plugin-sdk/ui/client';
import type { PluginUiHostApi, SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import {
    DaemonPluginStructuredMessageActionExecuteRequestSchema,
    PLUGIN_INVOCABLE_ACTION_IDS,
    PluginProjectionInstalledPackageV2Schema,
    PluginProjectedActionV2Schema,
    type PluginActionCurrentIntentResult,
    type PluginContributionIdentityV1,
    type PluginMachineExecutionOriginV1,
    type PluginProjectedActionV2,
} from '@happier-dev/protocol';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    PluginUiArtifactsManifestEntryV1Schema,
    PluginHostedWebBridgeEnvelopeV1Schema,
    PluginUiExecuteActionRequestV1Schema,
    PluginUiJsonValueV1Schema,
    PluginUiTargetedContributionsV1Schema,
    type
    CurrentUiContextSnapshotV1,
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiJsonValueV1,
    PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';

import { createPluginHostedWebHostApiBridgeHandler } from '@/components/plugins/hostApi/hostedWebAdapter';
import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';

import { projectPluginUiTheme } from './pluginUiThemeProjection';
import { createCanonicalPluginReactNativeHostApiAdapter } from '@/components/plugins/reactNative/hostApi';
import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import {
    getInstalledPluginUiClientExecutableComposition,
    resolvePluginUiClientActionRegistration,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import { resolveProjectedPluginUiClientExecutables } from '@/components/plugins/reactNative/clientExecutableProjection';
import type {
    PluginReactNativeExecutableExport,
    PluginReactNativeLoaderBackend,
} from '@/components/plugins/reactNative/loader';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY } from '@/sync/domains/plugins/ui/projectionUnion';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

import {
    createPluginSurfaceActionHostApi as createPluginSurfaceActionHostApiImpl,
    dispatchPluginSurfaceAction as dispatchPluginSurfaceActionImpl,
    type DispatchPluginSurfaceActionInput,
    type PluginSurfaceContributedActionTransport,
    type PluginSurfaceHostActionExecute,
} from './pluginSurfaceActionDispatch';
import { createBoundPluginSurfaceController } from './boundPluginSurfaceController';

// The dispatcher and serializer stay real. The server-scoped RPC is the
// system boundary that terminates this UI-side transport path.
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

const CALLER_PLUGIN_ID = 'happier.inspector';
const CALLER_MATERIALIZATION = {
    pluginId: CALLER_PLUGIN_ID,
    machineId: 'machine-1',
    materializationId: 'materialization-inspector-current',
} as const;

function mountedCallerBinding(input: Readonly<{
    pluginId?: string;
    contributionLocalId?: string;
    machineId?: string;
    materializationId?: string;
}> = {}) {
    const pluginId = input.pluginId ?? CALLER_PLUGIN_ID;
    const contributionLocalId = input.contributionLocalId ?? 'inspector-app';
    const machineId = input.machineId ?? 'machine-1';
    return {
        contributionLocalId,
        materializationRef: {
            pluginId,
            machineId,
            materializationId: input.materializationId ?? 'materialization-inspector-current',
        },
    } as const;
}

function mountedActionBinding(input: Readonly<{
    machineId?: string;
    expectedGeneration?: string;
}> = {}) {
    return {
        machineId: input.machineId ?? 'machine-1',
        expectedGeneration: input.expectedGeneration ?? '9',
    } as const;
}

const CLIENT_ACTION_TARGET = Object.freeze({
    artifactId: 'client-action-bundle',
    modulePath: './actions/clientAction',
    exportName: 'execute',
    platform: 'web' as const,
});
const CLIENT_ACTION_ORIGIN: PluginMachineExecutionOriginV1 = Object.freeze({
    serverIdentityId: 'srv_client_action',
    materializationRef: Object.freeze({
        pluginId: CALLER_PLUGIN_ID,
        machineId: 'machine-client-action',
        materializationId: 'materialization-client-action',
    }),
});
const CLIENT_ACTION_GENERATION = 9;
const CLIENT_ACTION_ARTIFACT_GRAPH = PluginUiArtifactsManifestEntryV1Schema.parse({
    contributionId: CLIENT_ACTION_TARGET.artifactId,
    tier: 'reactNative',
    platform: CLIENT_ACTION_TARGET.platform,
    entry: 'react-native/client-action-bundle/index.js',
    files: [{
        relativePath: 'react-native/client-action-bundle/index.js',
        digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        byteSize: 10,
    }],
    digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    builtWith: { bundler: 'vite', version: '7.0.0' },
    hostUiApiVersion: '1.0.0',
    compat: { react: '19.0.0', reactNative: '0.83.4' },
});
const CLIENT_ACTION_HOST_ORIGIN = Object.freeze({
    machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId,
    serverId: 'server-client-action',
    generation: CLIENT_ACTION_GENERATION,
    interactionEnabled: true,
    phase: 'current' as const,
    executionOrigin: CLIENT_ACTION_ORIGIN,
});

function clientActionIdentity(localId: string): PluginReactNativeBundleCacheIdentity {
    return Object.freeze({
        pluginId: CALLER_PLUGIN_ID,
        contributionId: localId,
        artifactDigest: CLIENT_ACTION_ARTIFACT_GRAPH.digest,
        hostAppVersion: '2.0.0',
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.83.4',
        platform: CLIENT_ACTION_TARGET.platform,
        channel: 'internal',
        nativeCapabilitiesDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        projectionGeneration: CLIENT_ACTION_GENERATION,
    });
}
const CLIENT_ACTION_AUTHORIZATION = Object.freeze({
    packageTrust: Object.freeze({
        packageIdentity: `${CALLER_PLUGIN_ID}/actions/refresh-index`,
        reviewedPackageIdentity: `${CALLER_PLUGIN_ID}/actions/refresh-index`,
    }),
    generation: Object.freeze({
        targetGeneration: String(CLIENT_ACTION_GENERATION),
        desiredGeneration: String(CLIENT_ACTION_GENERATION),
        appliedGeneration: String(CLIENT_ACTION_GENERATION),
    }),
    resourceSelections: Object.freeze([]),
    scopedGrants: Object.freeze([]),
    serviceAvailability: Object.freeze([]),
    operatingSystemAuthorization: Object.freeze([]),
});

function createClientTargetAction(input: Readonly<{
    identity: PluginContributionIdentityV1;
    dangerLevel?: 'safe' | 'writesRemote';
    surfaces?: readonly ('ui' | 'voice')[];
}>): PluginProjectedActionV2 {
    const dangerLevel = input.dangerLevel ?? 'safe';
    return PluginProjectedActionV2Schema.parse({
        id: input.identity.localId,
        pluginId: input.identity.pluginId,
        title: input.identity.localId,
        scopes: ['global'],
        surfaces: input.surfaces ?? ['ui'],
        placementBindings: ['detailsPanel'],
        execution: {
            target: 'client',
            client: {
                artifactId: CLIENT_ACTION_TARGET.artifactId,
                modulePath: CLIENT_ACTION_TARGET.modulePath,
                exportName: CLIENT_ACTION_TARGET.exportName,
            },
            platforms: [CLIENT_ACTION_TARGET.platform],
        },
        serverIdentityId: CLIENT_ACTION_ORIGIN.serverIdentityId,
        materializationRef: CLIENT_ACTION_ORIGIN.materializationRef,
        dangerLevel,
        ...(dangerLevel === 'safe'
            ? {}
            : {
                confirmation: {
                    title: 'Confirm client action',
                    body: 'This action changes remote state.',
                },
            }),
        available: true,
        authorization: CLIENT_ACTION_AUTHORIZATION,
    });
}

function createClientActionActivation(input: Readonly<{
    localId?: string;
    dangerLevel?: 'safe' | 'writesRemote';
    surfaces?: readonly ('ui' | 'voice')[];
    handler: PluginClientActionHandler;
}>) {
    const localId = input.localId ?? 'refresh-index';
    const action = createClientTargetAction({
        identity: { pluginId: CALLER_PLUGIN_ID, localId },
        dangerLevel: input.dangerLevel,
        surfaces: input.surfaces,
    });
    const identity = clientActionIdentity(localId);
    const projectedAction = Object.freeze({
        ...action,
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: CLIENT_ACTION_HOST_ORIGIN,
    });
    const bundleId = `reactNativeBundle:${CALLER_PLUGIN_ID}:${localId}`;
    const projection = Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: CLIENT_ACTION_GENERATION,
        installedPackagesById: Object.freeze({
            [CALLER_PLUGIN_ID]: PluginProjectionInstalledPackageV2Schema.parse({
                id: CALLER_PLUGIN_ID,
                displayName: 'Happier Inspector',
                version: '1.2.3',
                enabled: true,
                source: { kind: 'localPath', locator: CALLER_PLUGIN_ID },
            }),
        }),
        actionsById: Object.freeze({
            [`${CALLER_PLUGIN_ID}/${localId}`]: projectedAction,
        }),
        reactNativeBundlesById: Object.freeze({
            [bundleId]: Object.freeze({
                id: bundleId,
                pluginId: CALLER_PLUGIN_ID,
                contributionKind: 'reactNativeBundle' as const,
                contributionId: localId,
                generatedOwnerKind: 'clientContribution' as const,
                artifactGraph: CLIENT_ACTION_ARTIFACT_GRAPH,
                runtime: Object.freeze({
                    decision: Object.freeze({ state: 'load' }),
                    loadPolicy: Object.freeze({ source: 'installedArtifact' }),
                    cacheIdentity: identity,
                }),
                [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: CLIENT_ACTION_HOST_ORIGIN,
            }),
        }),
    }) satisfies PluginUiProjectionModel;
    const resolved = resolveProjectedPluginUiClientExecutables({
        actionProjection: Object.freeze({ projection }),
        platform: CLIENT_ACTION_TARGET.platform,
    });
    const resolvedAction = resolved[0];
    if (!resolvedAction || resolved.length !== 1) {
        throw new Error('client Action fixture did not resolve through the production projection');
    }
    const cache = createPluginReactNativeBundleCache();
    cache.putInstalledArtifact({
        identity: resolvedAction.cacheIdentity,
        bytes: new Uint8Array([47, 47, 32, 99, 108, 105, 101, 110, 116]),
        format: 'plainJs',
    });
    const activate = vi.fn((api: PluginClientApi) => {
        // The registration transaction is real: only the artifact loader is a
        // system-boundary test double.
        api.actions.register(localId, input.handler);
    });
    const backend: PluginReactNativeLoaderBackend = Object.freeze({
        backendId: 'reactNativeWebModule',
        available: true,
        loadInstalledBundle: vi.fn(async () => activate as PluginReactNativeExecutableExport),
    });
    const activation = Object.freeze({
        pluginId: resolvedAction.pluginId,
        ...(resolvedAction.pluginVersion === undefined ? {} : { pluginVersion: resolvedAction.pluginVersion }),
        contributes: resolvedAction.contributes,
        target: resolvedAction.target,
        executionOrigin: resolvedAction.executionOrigin,
        projectionGeneration: resolvedAction.projectionGeneration,
        cache,
        identity: resolvedAction.cacheIdentity,
        moduleReference: resolvedAction.moduleReference,
        backend,
        authority: resolvedAction.authority,
        isCurrent: () => true,
    });
    return Object.freeze({
        activation,
        activate,
        action: projectedAction as PluginProjectedActionV2,
        composition: getInstalledPluginUiClientExecutableComposition(),
    });
}

function resolveExactClientAction(action: PluginProjectedActionV2) {
    return (identity: PluginContributionIdentityV1): PluginProjectedActionV2 | null => (
        identity.pluginId === action.pluginId && identity.localId === action.id
            ? action
            : null
    );
}

function resolveDaemonTargetAction(
    identity: PluginContributionIdentityV1,
): PluginProjectedActionV2 {
    return {
        id: identity.localId,
        pluginId: identity.pluginId,
        title: identity.localId,
        scopes: ['session'],
        surfaces: ['ui'],
        execution: { target: 'daemon' },
        dangerLevel: 'safe',
    };
}

/** Test-only raw projection producer for pre-existing daemon-arm cases. */
function dispatchPluginSurfaceAction(input: DispatchPluginSurfaceActionInput) {
    return dispatchPluginSurfaceActionImpl({
        ...input,
        resolveContributedAction: input.resolveContributedAction ?? resolveDaemonTargetAction,
    });
}

/** Keeps existing host-API cases on the same raw V2 descriptor path. */
function createPluginSurfaceActionHostApi(
    input: Parameters<typeof createPluginSurfaceActionHostApiImpl>[0],
) {
    return createPluginSurfaceActionHostApiImpl({
        ...input,
        resolveContributedAction: input.resolveContributedAction ?? resolveDaemonTargetAction,
    });
}

/**
 * A first-party ActionSpec that really carries `surfaces.plugin`. Read from the
 * canonical runtime companion so this suite cannot drift from the master key:
 * if `surfaces.plugin` were reverted, every branch-1 case fails loudly instead of
 * silently reclassifying as a contributed action.
 */
const HOST_ACTION_ID = 'plugins.reload';

function surfaceContext(pluginId = CALLER_PLUGIN_ID): PluginUiSurfaceContextV1 {
    return {
        pluginId,
        contributionId: 'inspector-app',
        surfaceId: `surfacePlacement:${pluginId}:inspector-app`,
        placement: 'appSurface',
        platform: 'web',
        channel: 'internal',
        resourceScope: [],
        diagnostics: [],
    };
}

function executeActionRequest(payload: PluginUiJsonValueV1): PluginUiHostApiRequestEnvelopeV1 {
    return {
        version: 1,
        requestId: 'request-1',
        surface: surfaceContext(),
        method: 'executeAction',
        payload,
    };
}

describe('plugin-surface action branch selection', () => {
    it('reads the current UI snapshot only after current-intent approval for a writes-remote client Action', async () => {
        const snapshotAtDispatch: CurrentUiContextSnapshotV1 = {
            navigation: { area: 'app' as const, screen: 'initial' },
            commands: [],
        };
        let currentSnapshot = snapshotAtDispatch;
        const snapshotAfterApproval: CurrentUiContextSnapshotV1 = {
            navigation: { area: 'plugin' as const, screen: 'issue-detail', title: 'Issue 42' },
            entity: { kind: 'issue', label: 'Issue 42' },
            commands: [],
        };
        const readCurrentUiContext = vi.fn(() => currentSnapshot);
        let resolveCurrentIntent!: (result: Readonly<{
            status: 'approved';
            fingerprint: string;
        }>) => void;
        let requestedFingerprint!: string;
        let currentIntentRequested!: () => void;
        const currentIntentRequestedPromise = new Promise<void>((resolve) => {
            currentIntentRequested = resolve;
        });
        const handler = vi.fn(async (_input: PluginUiJsonValueV1, context: Parameters<PluginClientActionHandler>[1]) => ({
            currentUiContext: context.currentUiContext ?? null,
        }));
        const activation = createClientActionActivation({
            dangerLevel: 'writesRemote',
            handler,
        });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const requestCurrentIntent = vi.fn(({ fingerprint }: Readonly<{ fingerprint: string }>) => {
                requestedFingerprint = fingerprint;
                currentIntentRequested();
                return new Promise<PluginActionCurrentIntentResult>((resolve) => { resolveCurrentIntent = resolve; });
            });
            const pending = dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: 'refresh-index',
                input: null,
                resolveContributedAction: resolveExactClientAction(activation.action),
                clientAction: {
                    projectionGeneration: CLIENT_ACTION_GENERATION,
                    currentUiContext: readCurrentUiContext,
                    requestCurrentIntent,
                },
            });
            await currentIntentRequestedPromise;
            expect(readCurrentUiContext).not.toHaveBeenCalled();
            expect(handler).not.toHaveBeenCalled();

            currentSnapshot = snapshotAfterApproval;
            resolveCurrentIntent({
                status: 'approved',
                fingerprint: requestedFingerprint,
            });

            await expect(pending).resolves.toEqual({
                ok: true,
                result: {
                    currentUiContext: snapshotAfterApproval,
                },
            });
            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler).toHaveBeenCalledWith(null, expect.objectContaining({
                currentUiContext: snapshotAfterApproval,
            }));
            expect(requestCurrentIntent).toHaveBeenCalledTimes(1);
            expect(readCurrentUiContext).toHaveBeenCalledTimes(1);
        } finally {
            await activation.composition.unload();
        }
    });

    it('invokes an Action-only exact client registration without daemon fallback', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { daemonShouldNotRun: true } },
        }));
        let receivedContext: unknown;
        const handler = vi.fn(async (input: PluginUiJsonValueV1, context: unknown) => {
            receivedContext = context;
            return { input, executed: true };
        });
        const clientHandler: PluginClientActionHandler = async (input, context) => handler(input, context);
        const activation = createClientActionActivation({ handler: clientHandler });
        const action = activation.action;
        await activation.composition.unload();
        try {
            await expect(activation.composition.reconcile([activation.activation])).resolves.toEqual([
                expect.objectContaining({ result: { ok: true } }),
            ]);

            await expect(dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: 'refresh-index',
                input: { source: 'surface' },
                resolveContributedAction: resolveExactClientAction(action),
                // A daemon outage must not decide a client Action's availability.
                isContributedActionAvailable: () => false,
                contributedAction: {
                    ...mountedActionBinding(),
                    execute: contributed,
                },
                clientAction: {
                    projectionGeneration: CLIENT_ACTION_GENERATION,
                },
            })).resolves.toEqual({
                ok: true,
                result: {
                    input: { source: 'surface' },
                    executed: true,
                },
            });

            expect(receivedContext).toEqual(expect.objectContaining({
                plugin: { id: CALLER_PLUGIN_ID, version: '1.2.3' },
                contribution: {
                    id: 'refresh-index',
                    qualifiedId: `${CALLER_PLUGIN_ID}/actions/refresh-index`,
                },
                invocationSurface: 'ui',
            }));

            expect(resolvePluginUiClientActionRegistration({
                action,
                projectionGeneration: CLIENT_ACTION_GENERATION,
                platform: CLIENT_ACTION_TARGET.platform,
                reader: activation.composition,
            })).not.toBeNull();
            expect(handler).toHaveBeenCalledTimes(1);
            expect(contributed).not.toHaveBeenCalled();
        } finally {
            await activation.composition.unload();
        }
    });

    it('does not repurpose an Action-only exact registration for a Voice invocation', async () => {
        const handler = vi.fn(async () => ({ shouldNotRun: true }));
        const clientHandler: PluginClientActionHandler = async () => handler();
        const activation = createClientActionActivation({ handler: clientHandler });
        const action = activation.action;
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);

            await expect(dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: 'refresh-index',
                input: null,
                resolveContributedAction: resolveExactClientAction(action),
                invocationSurface: 'voice',
                clientAction: { projectionGeneration: CLIENT_ACTION_GENERATION },
            })).resolves.toEqual({
                ok: false,
                code: 'unavailable',
                reason: 'plugin_action_surface_unavailable',
            });
            expect(handler).not.toHaveBeenCalled();
        } finally {
            await activation.composition.unload();
        }
    });

    it('invokes the same exact client Action registration from UI and Voice when both surfaces are declared', async () => {
        const handler = vi.fn(async (_input: PluginUiJsonValueV1, context: Parameters<PluginClientActionHandler>[1]) => ({
            invocationSurface: context.invocationSurface,
        }));
        const activation = createClientActionActivation({
            handler,
            surfaces: ['ui', 'voice'],
        });
        const action = activation.action;
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);

            const common = {
                callerPluginId: CALLER_PLUGIN_ID,
                action: 'refresh-index',
                input: null,
                resolveContributedAction: resolveExactClientAction(action),
                clientAction: { projectionGeneration: CLIENT_ACTION_GENERATION },
            } as const;
            await expect(dispatchPluginSurfaceAction(common)).resolves.toEqual({
                ok: true,
                result: { invocationSurface: 'ui' },
            });
            await expect(dispatchPluginSurfaceAction({
                ...common,
                invocationSurface: 'voice',
            })).resolves.toEqual({
                ok: true,
                result: { invocationSurface: 'voice' },
            });

            expect(handler).toHaveBeenCalledTimes(2);
            expect(resolvePluginUiClientActionRegistration({
                action,
                projectionGeneration: CLIENT_ACTION_GENERATION,
                platform: CLIENT_ACTION_TARGET.platform,
                reader: activation.composition,
            })).not.toBeNull();
        } finally {
            await activation.composition.unload();
        }
    });

    it('withdraws an exact client registration before a pending confirmation can enter its handler', async () => {
        let resolveIntent!: (result: Readonly<{
            status: 'approved';
            fingerprint: string;
        }>) => void;
        let intentRequested!: () => void;
        const intentRequestedPromise = new Promise<void>((resolve) => { intentRequested = resolve; });
        const handler = vi.fn(async () => ({ shouldNotRun: true }));
        const clientHandler: PluginClientActionHandler = async () => handler();
        const activation = createClientActionActivation({
            dangerLevel: 'writesRemote',
            handler: clientHandler,
        });
        const action = activation.action;
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const pending = dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: 'refresh-index',
                input: { source: 'surface' },
                resolveContributedAction: resolveExactClientAction(action),
                clientAction: {
                    projectionGeneration: CLIENT_ACTION_GENERATION,
                    requestCurrentIntent: ({ fingerprint }: Readonly<{ fingerprint: string }>) => {
                        intentRequested();
                        return new Promise((resolve) => { resolveIntent = resolve; });
                    },
                },
            });
            await intentRequestedPromise;
            await activation.composition.unload();
            resolveIntent({
                status: 'approved',
                fingerprint: 'the retired confirmation must not be accepted',
            });

            await expect(pending).resolves.toEqual({
                ok: false,
                code: 'stale_surface',
                reason: 'plugin_action_generation_retired',
            });
            expect(handler).not.toHaveBeenCalled();
        } finally {
            await activation.composition.unload();
        }
    });

    it('keeps a known client handler fulfillment when caller cancellation arrives afterwards', async () => {
        const cancellation = new AbortController();
        let handlerReturned!: () => void;
        const handlerReturnedPromise = new Promise<void>((resolve) => { handlerReturned = resolve; });
        const handler = vi.fn(() => {
            handlerReturned();
            return { committed: true };
        });
        const clientHandler: PluginClientActionHandler = () => handler();
        const activation = createClientActionActivation({ handler: clientHandler });
        const action = activation.action;
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const pending = dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: 'refresh-index',
                input: null,
                resolveContributedAction: resolveExactClientAction(action),
                signal: cancellation.signal,
                clientAction: { projectionGeneration: CLIENT_ACTION_GENERATION },
            });
            await handlerReturnedPromise;
            cancellation.abort(new Error('caller stopped after the client effect settled'));

            await expect(pending).resolves.toEqual({ ok: true, result: { committed: true } });
        } finally {
            await activation.composition.unload();
        }
    });

    it('projects post-handler client cancellation without a non-start proof as outcome unknown', async () => {
        const cancellation = new AbortController();
        let handlerEntered!: () => void;
        const handlerEnteredPromise = new Promise<void>((resolve) => { handlerEntered = resolve; });
        const handler = vi.fn(() => {
            handlerEntered();
            return new Promise<never>(() => {});
        });
        const clientHandler: PluginClientActionHandler = () => handler();
        const activation = createClientActionActivation({ handler: clientHandler });
        const action = activation.action;
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const pending = dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: 'refresh-index',
                input: null,
                resolveContributedAction: resolveExactClientAction(action),
                signal: cancellation.signal,
                clientAction: { projectionGeneration: CLIENT_ACTION_GENERATION },
            });
            await handlerEnteredPromise;
            cancellation.abort(new Error('caller stopped after the client handler started'));

            await expect(pending).resolves.toEqual({
                ok: false,
                code: 'timeout',
                reason: 'plugin_ui_action_outcome_unknown',
            });
        } finally {
            await activation.composition.unload();
        }
    });

    it('does not bypass current-intent denial for a non-safe client Action', async () => {
        const handler = vi.fn(async () => ({ shouldNotRun: true }));
        const clientHandler: PluginClientActionHandler = async () => handler();
        const activation = createClientActionActivation({
            dangerLevel: 'writesRemote',
            handler: clientHandler,
        });
        const action = activation.action;
        const requestCurrentIntent = vi.fn(async () => ({
            status: 'rejected' as const,
            code: 'plugin_action_current_intent_rejected',
        }));
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            await expect(dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: 'refresh-index',
                input: null,
                resolveContributedAction: resolveExactClientAction(action),
                clientAction: {
                    projectionGeneration: CLIENT_ACTION_GENERATION,
                    requestCurrentIntent,
                },
            })).resolves.toEqual({
                ok: false,
                code: 'unavailable',
                reason: 'plugin_action_current_intent_rejected',
            });
            expect(requestCurrentIntent).toHaveBeenCalledTimes(1);
            expect(handler).not.toHaveBeenCalled();
        } finally {
            await activation.composition.unload();
        }
    });

    // The selected-operation carrier is a dispatcher-level settlement, not a
    // daemon-transport detail. A client-target Action must receive the same
    // reconstructed selected input, the same exact-input comparison, and the
    // same mounted-target ownership rule as a daemon-target Action (C1).
    it('settles the host-selected operation before branching to a client Action', async () => {
        const handler = vi.fn(async (input: PluginUiJsonValueV1) => ({ received: input }));
        const clientHandler: PluginClientActionHandler = async (input) => handler(input);
        const activation = createClientActionActivation({ handler: clientHandler });
        const action = activation.action;
        const targetedOperation = {
            point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
            contributor: {
                pluginId: CALLER_PLUGIN_ID,
                contributionId: 'github-connection',
                immutableGenerationId: 'contributor-generation-a',
            },
            role: 'setup',
            action: { pluginId: CALLER_PLUGIN_ID, localId: 'refresh-index' },
        } as const;
        const account = {
            service: { pluginId: 'acme.github', localId: 'github' },
            accountId: 'account-a',
        } as const;
        const selectedActionInput = {
            kind: 'submitted' as const,
            action: targetedOperation.action,
            input: { repository: 'happier-dev/happier' },
            selection: {
                target: {
                    pluginId: CALLER_PLUGIN_ID,
                    immutableGenerationId: 'target-generation-a',
                },
                point: targetedOperation.point,
                contributor: targetedOperation.contributor,
            },
            connectedAccount: {
                kind: 'selected' as const,
                fieldPath: 'credentialRef',
                ref: account,
            },
        };
        const dispatch = (overrides: Partial<DispatchPluginSurfaceActionInput> = {}) => dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            callerContributionLocalId: 'inspector-app',
            callerBinding: mountedCallerBinding(),
            action: { pluginId: CALLER_PLUGIN_ID, localId: 'refresh-index' },
            input: { repository: 'happier-dev/happier' },
            resolveContributedAction: resolveExactClientAction(action),
            clientAction: { projectionGeneration: CLIENT_ACTION_GENERATION },
            targetedOperation,
            selectedActionInput,
            ...overrides,
        });

        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);

            // The selected Connected Account is reconstructed into the input the
            // client handler observes, exactly as on the daemon arm.
            await expect(dispatch()).resolves.toEqual({
                ok: true,
                result: {
                    received: {
                        repository: 'happier-dev/happier',
                        credentialRef: account,
                    },
                },
            });

            // A tampered input cannot ride an admitted selection.
            await expect(dispatch({ input: { repository: 'tampered' } })).resolves.toEqual({
                ok: false,
                code: 'invalid_payload',
                reason: 'plugin_surface_targeted_selection_invalid',
            });

            // The carrier is anchored to the exact mounted target.
            await expect(dispatch({
                selectedActionInput: {
                    ...selectedActionInput,
                    selection: {
                        ...selectedActionInput.selection,
                        target: { pluginId: 'other.plugin', immutableGenerationId: 'target-generation-a' },
                    },
                },
            })).resolves.toEqual({
                ok: false,
                code: 'invalid_payload',
                reason: 'plugin_surface_targeted_selection_invalid',
            });

            // A relay carrier is a daemon-request field with no client channel.
            // The combination is refused explicitly rather than executing with
            // the caller's selection silently dropped.
            const relayOperation = {
                ...targetedOperation,
                action: { pluginId: CALLER_PLUGIN_ID, localId: 'prepare-v1' },
            } as const;
            await expect(dispatch({
                targetedOperation: relayOperation,
                selectedActionInput: {
                    ...selectedActionInput,
                    action: relayOperation.action,
                },
            })).resolves.toEqual({
                ok: false,
                code: 'unsupported_method',
                reason: 'plugin_surface_targeted_selection_relay_unsupported',
            });

            expect(handler).toHaveBeenCalledTimes(1);
        } finally {
            await activation.composition.unload();
        }
    });

    it('composes exact mount-owned host semantics into the canonical facade and retires them with it', async () => {
        const readComposer = vi.fn(() => ({ status: 'unavailable' as const, reason: 'scopeClosed' as const }));
        const disposeHostResource = vi.fn(() => null);
        const disposeMountedHostApiHandlers = vi.fn();
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext(),
            mountedHostApiHandlers: { readComposer, disposeHostResource },
            disposeMountedHostApiHandlers,
        });
        const request = {
            version: 1 as const,
            requestId: 'composer-read',
            surface: surfaceContext(),
            method: 'readComposer' as const,
            payload: { ref: { kind: 'session' as const, sessionId: 'session-1' } },
        };

        expect(api.installedMethods).toContain('readComposer');
        expect(api.handleRequest(request)).toEqual({ status: 'unavailable', reason: 'scopeClosed' });
        expect(readComposer).toHaveBeenCalledWith(request, undefined);

        await api.handleRequest({
            ...request,
            requestId: 'composer-dispose',
            method: 'disposeHostResource',
            payload: { subscriptionId: 'composer-watch-1' },
        });
        expect(disposeHostResource).toHaveBeenCalledTimes(1);

        api.dispose?.();
        expect(disposeMountedHostApiHandlers).toHaveBeenCalledTimes(1);
    });

    it('keeps the first-party host action id inside the canonical plugin surface key', () => {
        expect(PLUGIN_INVOCABLE_ACTION_IDS).toContain(HOST_ACTION_ID);
        expect(PLUGIN_INVOCABLE_ACTION_IDS).not.toContain('refresh-index');
    });

    it('routes a plugin-surfaced ActionSpec id to the host executor with the host-stamped caller', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: { reloaded: true } }));
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>();

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            callerContributionLocalId: 'inspector-app',
            callerBinding: mountedCallerBinding(),
            action: HOST_ACTION_ID,
            input: { pluginId: CALLER_PLUGIN_ID },
            hostAction: { execute, context: { serverId: 'server-1' } },
            contributedAction: {
                ...mountedActionBinding(),
                execute: contributed,
            },
        })).resolves.toEqual({ ok: true, result: { reloaded: true } });

        expect(contributed).not.toHaveBeenCalled();
        expect(execute).toHaveBeenCalledWith(HOST_ACTION_ID, { pluginId: CALLER_PLUGIN_ID }, {
            serverId: 'server-1',
            surface: 'plugin',
            actionCaller: {
                kind: 'plugin',
                pluginId: CALLER_PLUGIN_ID,
                contributionLocalId: 'inspector-app',
                materialization: CALLER_MATERIALIZATION,
            },
        });
    });

    it('carries caller cancellation into the canonical host Action executor', async () => {
        const cancellation = new AbortController();
        const execute = vi.fn(async () => ({ ok: true as const, result: { reloaded: true } }));

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            callerContributionLocalId: 'inspector-app',
            callerBinding: mountedCallerBinding(),
            action: HOST_ACTION_ID,
            input: {},
            signal: cancellation.signal,
            hostAction: { execute, context: { serverId: 'server-1' } },
            contributedAction: mountedActionBinding(),
        })).resolves.toEqual({ ok: true, result: { reloaded: true } });

        expect(execute).toHaveBeenCalledWith(HOST_ACTION_ID, {}, {
            serverId: 'server-1',
            signal: cancellation.signal,
            surface: 'plugin',
            actionCaller: {
                kind: 'plugin',
                pluginId: CALLER_PLUGIN_ID,
                contributionLocalId: 'inspector-app',
                materialization: CALLER_MATERIALIZATION,
            },
        });
    });

    it('rejects a host ActionSpec that lacks an authenticated plugin caller', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: { reloaded: true } }));

        await expect(dispatchPluginSurfaceAction({
            action: HOST_ACTION_ID,
            input: {},
            hostAction: { execute },
        } as DispatchPluginSurfaceActionInput)).resolves.toEqual({
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_host_action_caller_missing',
        });

        expect(execute).not.toHaveBeenCalled();
    });

    it('fails closed before host Action dispatch when the plugin caller lacks a stamped materialization', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: { reloaded: true } }));

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            callerContributionLocalId: 'inspector-app',
            action: HOST_ACTION_ID,
            input: {},
            hostAction: { execute },
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_mounted_caller_unavailable',
        });

        expect(execute).not.toHaveBeenCalled();
    });

    // A host ActionSpec id that is NOT plugin-surfaced must never reach the
    // ActionSpec executor: a wrong implementation validating with `ActionIdSchema`
    // would admit all 275 rows to the plugin surface — a security-relevant
    // widening. It falls through to the contributed branch, where a dotted
    // first-party id is not even a valid contribution local id.
    it('does not admit a non-plugin-surfaced ActionSpec id to the host branch', async () => {
        const nonPluginActionId = 'session.handoff.status.get';
        expect(PLUGIN_INVOCABLE_ACTION_IDS).not.toContain(nonPluginActionId);
        const execute = vi.fn(async () => ({ ok: true as const, result: {} }));
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>();

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: nonPluginActionId,
            input: {},
            hostAction: { execute },
            contributedAction: {
                ...mountedActionBinding(),
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_action_reference_invalid',
        });

        expect(execute).not.toHaveBeenCalled();
        expect(contributed).not.toHaveBeenCalled();
    });

    it('qualifies a cross-plugin structured reference without adding a caller allowlist', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { refreshed: true } },
        }));

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            callerContributionLocalId: 'inspector-app',
            callerBinding: mountedCallerBinding(),
            action: { pluginId: 'acme.reviewer', localId: 'refresh-index' },
            input: { reason: 'cross-plugin' },
            contributedAction: {
                ...mountedActionBinding(),
                serverId: 'server-1',
                execute: contributed,
            },
        })).resolves.toEqual({ ok: true, result: { refreshed: true } });

        expect(contributed).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-1',
            expectedGeneration: '9',
            qualifiedActionId: 'acme.reviewer/refresh-index',
            input: { reason: 'cross-plugin' },
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: mountedCallerBinding(),
            },
        });
    });

    it('forwards the opaque message reference beside, not inside, the contributed action input', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { refreshed: true } },
        }));
        const messageActionReference = {
            v: 1,
            sessionId: 'session-1',
            messageId: 'message-1',
            observedRevision: 'revision-9',
        } as const;

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            callerContributionLocalId: 'inspector-app',
            callerBinding: mountedCallerBinding(),
            action: { pluginId: 'acme.reviewer', localId: 'refresh-index' },
            input: { reason: 'message-action' },
            contributedAction: {
                ...mountedActionBinding(),
                messageActionReference,
                execute: contributed,
            },
        })).resolves.toEqual({ ok: true, result: { refreshed: true } });

        expect(contributed).toHaveBeenCalledWith('machine-1', {
            serverId: null,
            expectedGeneration: '9',
            qualifiedActionId: 'acme.reviewer/refresh-index',
            input: { reason: 'message-action' },
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: mountedCallerBinding(),
            },
            messageActionReference,
        });
    });

    it('dispatches a host-presented exact reference without inventing a mounted caller', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { opened: true } },
        }));
        const messageActionReference = {
            v: 1,
            sessionId: 'session-1',
            messageId: 'message-1',
            observedRevision: 'revision-9',
        } as const;

        await expect(dispatchPluginSurfaceAction({
            action: { pluginId: 'acme.preview', localId: 'open-preview' },
            input: {},
            invocation: {
                kind: 'hostPresentedMessage',
                currentMessageIntent: messageActionReference,
            },
            contributedAction: {
                machineId: 'machine-1',
                serverId: 'server-1',
                expectedGeneration: '7',
                messageActionReference,
                execute: contributed,
            },
        })).resolves.toEqual({ ok: true, result: { opened: true } });

        expect(contributed).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-1',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/open-preview',
            input: {},
            executionSurface: 'ui',
            messageActionReference,
            invocation: {
                kind: 'hostPresentedMessage',
                currentMessageIntent: messageActionReference,
            },
        });
        const request = contributed.mock.calls[0]?.[1];
        expect(request).not.toHaveProperty('mountedBinding');
    });

    it('does not bind a bare direct-host reference to an invented caller', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>();

        await expect(dispatchPluginSurfaceAction({
            action: 'open-preview',
            input: {},
            contributedAction: {
                machineId: 'machine-1',
                expectedGeneration: '7',
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_action_reference_invalid',
        });

        expect(contributed).not.toHaveBeenCalled();
    });

    // An action the plugin never declared is answered by the daemon front door,
    // not by a UI-side registry: the dispatcher forwards it and surfaces the
    // daemon's typed code.
    it('surfaces an undeclared contributed action as the daemon front door reported it', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: false as const, code: 'plugin_action_unavailable' },
        }));

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            callerContributionLocalId: 'inspector-app',
            callerBinding: mountedCallerBinding(),
            action: 'never-declared',
            input: {},
            contributedAction: {
                ...mountedActionBinding(),
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_action_unavailable',
        });
    });

    // The dispatcher's emitted request must satisfy the daemon front-door wire
    // schema exactly — including the now-required `executionSurface` — so the
    // composed UI half and the daemon handler test meet on one contract instead
    // of two independently-shaped fixtures.
    it('emits a request the daemon front-door wire schema accepts', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: {} },
        }));

        await dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            callerContributionLocalId: 'inspector-app',
            callerBinding: mountedCallerBinding({ machineId: 'machine-wire' }),
            action: { pluginId: 'acme.reviewer', localId: 'refresh-index' },
            input: { reason: 'wire' },
            contributedAction: {
                ...mountedActionBinding({ machineId: 'machine-wire' }),
                serverId: 'server-wire',
                sessionId: 'session-wire',
                execute: contributed,
            },
        });

        const invocation = contributed.mock.calls[0];
        expect(invocation).toBeDefined();
        if (!invocation) throw new Error('Expected the contributed action transport to be invoked.');
        const [machineId, request] = invocation;
        const { serverId: _serverId, timeoutMs: _timeoutMs, signal: _signal, ...wire } = request;
        expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
            machineId,
            ...wire,
        })).toEqual({
            machineId: 'machine-wire',
            expectedGeneration: '9',
            qualifiedActionId: 'acme.reviewer/refresh-index',
            input: { reason: 'wire' },
            sessionId: 'session-wire',
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: mountedCallerBinding({ machineId: 'machine-wire' }),
            },
        });
    });

    it('retains an exact catalog Action immutable generation for an unmounted host invocation', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { configured: true } },
        }));

        await expect(dispatchPluginSurfaceAction({
            action: { pluginId: 'acme.events', localId: 'configure-source' },
            input: { repository: 'happier-dev/happier' },
            contributedAction: {
                machineId: 'machine-1',
                expectedGeneration: '9',
                expectedImmutableGenerationId: 'events-generation-a',
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: true,
            result: { configured: true },
        });

        expect(contributed).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            qualifiedActionId: 'acme.events/configure-source',
            expectedContributorImmutableGenerationId: 'events-generation-a',
        }));
    });

    it('sends a mounted binding through the default daemon transport and omits it for unmounted dispatch', async () => {
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({ ok: true, result: { route: 'same' } })
            .mockResolvedValueOnce({ ok: true, result: { route: 'cross' } })
            .mockResolvedValueOnce({ ok: true, result: { route: 'unmounted' } });

        const caller = {
            pluginId: 'acme.preview',
            contributionLocalId: 'message-preview',
        };
        const mountedBinding = {
            contributionLocalId: caller.contributionLocalId,
            materializationRef: {
                machineId: 'machine-default',
                materializationId: 'materialization-preview-current',
                pluginId: caller.pluginId,
            },
        } as const;
        const contributedAction = {
            machineId: 'machine-default',
            serverId: 'server-default',
            expectedGeneration: '7',
        };

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: caller.pluginId,
            callerContributionLocalId: caller.contributionLocalId,
            callerBinding: mountedBinding,
            action: 'open-preview',
            input: { route: 'same' },
            contributedAction,
        })).resolves.toEqual({ ok: true, result: { route: 'same' } });

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: caller.pluginId,
            callerContributionLocalId: caller.contributionLocalId,
            callerBinding: mountedBinding,
            action: { pluginId: 'acme.reviewer', localId: 'publish' },
            input: { route: 'cross' },
            contributedAction,
        })).resolves.toEqual({ ok: true, result: { route: 'cross' } });

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: caller.pluginId,
            action: 'open-preview',
            input: { route: 'unmounted' },
            contributedAction: {
                machineId: contributedAction.machineId,
                serverId: contributedAction.serverId,
                expectedGeneration: contributedAction.expectedGeneration,
            },
        })).resolves.toEqual({ ok: true, result: { route: 'unmounted' } });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-default',
            serverId: 'server-default',
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            payload: {
                machineId: 'machine-default',
                expectedGeneration: '7',
                qualifiedActionId: 'acme.preview/open-preview',
                input: { route: 'same' },
                executionSurface: 'ui',
                invocation: {
                    kind: 'mountedPluginSurface',
                    mountedBinding,
                },
            },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-default',
            serverId: 'server-default',
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            payload: {
                machineId: 'machine-default',
                expectedGeneration: '7',
                qualifiedActionId: 'acme.reviewer/publish',
                input: { route: 'cross' },
                executionSurface: 'ui',
                invocation: {
                    kind: 'mountedPluginSurface',
                    mountedBinding,
                },
            },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
            machineId: 'machine-default',
            serverId: 'server-default',
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            payload: {
                machineId: 'machine-default',
                expectedGeneration: '7',
                qualifiedActionId: 'acme.preview/open-preview',
                input: { route: 'unmounted' },
                executionSurface: 'ui',
            },
        }));
        const unmountedRequest = machineRpcWithServerScopeMock.mock.calls[2]?.[0] as
            | Readonly<{ payload?: Readonly<Record<string, unknown>> }>
            | undefined;
        expect(unmountedRequest?.payload).not.toHaveProperty('mountedBinding');
        expect(unmountedRequest?.payload).not.toHaveProperty('invocation');
        expect(unmountedRequest?.payload).not.toHaveProperty('caller');
    });

    it('rejects a malformed contribution reference as a typed invalid payload', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>();

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: { pluginId: 'Not A Plugin Id', localId: 'refresh-index' },
            input: {},
            contributedAction: {
                machineId: 'machine-1',
                expectedGeneration: '9',
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_action_reference_invalid',
        });
        expect(contributed).not.toHaveBeenCalled();
    });

    it('fails closed when the mount installed no contributed-action binding', async () => {
        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: 'refresh-index',
            input: {},
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_surface_contributed_action_unavailable',
        });
    });

    it('refuses to dispatch after cancellation, before any effect reaches the transport', async () => {
        const controller = new AbortController();
        controller.abort();
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>();

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: 'refresh-index',
            input: {},
            signal: controller.signal,
            contributedAction: {
                machineId: 'machine-1',
                expectedGeneration: '9',
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_ui_invocation_aborted',
        });
        expect(contributed).not.toHaveBeenCalled();
    });

    it('reports a retired generation as a stale surface before dispatching', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>();

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: 'refresh-index',
            input: {},
            isCurrent: () => false,
            contributedAction: {
                machineId: 'machine-1',
                expectedGeneration: '9',
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'stale_surface',
            reason: 'plugin_ui_generation_retired',
        });
        expect(contributed).not.toHaveBeenCalled();
    });

    // Settlement is authoritative: a success observed by the daemon must never be
    // hidden by a local retirement observed afterwards, or the caller is invited
    // to blind-retry a mutation that already happened.
    it('keeps a settled success authoritative even when the surface retires during the call', async () => {
        let current = true;
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => {
            current = false;
            return { supported: true as const, result: { ok: true as const, result: { applied: 1 } } };
        });

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: 'refresh-index',
            input: {},
            isCurrent: () => current,
            contributedAction: {
                machineId: 'machine-1',
                expectedGeneration: '9',
                execute: contributed,
            },
        })).resolves.toEqual({ ok: true, result: { applied: 1 } });
    });

    it('keeps a known daemon failure when the surface retires after settlement', async () => {
        let current = true;
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => {
            current = false;
            return { supported: true as const, result: { ok: false as const, code: 'plugin_action_unavailable' } };
        });

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: 'refresh-index',
            input: {},
            isCurrent: () => current,
            contributedAction: {
                machineId: 'machine-1',
                expectedGeneration: '9',
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_action_unavailable',
        });
    });

    it('keeps a pre-handler daemon retirement as an ordinary unavailable result', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: false as const, code: 'plugin_action_generation_retired' },
        }));

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: 'refresh-index',
            input: {},
            contributedAction: {
                machineId: 'machine-1',
                expectedGeneration: '9',
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_action_generation_retired',
        });
    });

    it('projects a post-handler daemon retirement as outcome unknown', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: false as const, code: 'plugin_action_outcome_unknown' },
        }));

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: 'refresh-index',
            input: {},
            invocationSurface: 'voice',
            contributedAction: {
                machineId: 'machine-1',
                expectedGeneration: '9',
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'timeout',
            reason: 'plugin_ui_action_outcome_unknown',
        });
    });
});

describe('mounted executeAction handler', () => {
    it('preserves omitted declarative input as absence and explicit null as null at the daemon boundary', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { applied: true } },
        }));
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext(),
            callerBinding: mountedCallerBinding(),
            contributedAction: {
                machineId: 'machine-1',
                expectedGeneration: '9',
                execute: contributed,
            },
        });

        await expect(api.handleRequest(
            executeActionRequest({ action: 'refresh-index' }),
        )).resolves.toEqual({ applied: true });
        const omitted = contributed.mock.calls[0]?.[1] as Readonly<Record<string, unknown>> | undefined;
        expect(omitted).toBeDefined();
        expect(Object.prototype.hasOwnProperty.call(omitted, 'input')).toBe(false);

        await expect(api.handleRequest(
            executeActionRequest({ action: 'refresh-index', input: null }),
        )).resolves.toEqual({ applied: true });
        const explicitNull = contributed.mock.calls[1]?.[1] as Readonly<Record<string, unknown>> | undefined;
        expect(explicitNull).toBeDefined();
        expect(Object.prototype.hasOwnProperty.call(explicitNull, 'input')).toBe(true);
        expect(explicitNull?.input).toBeNull();
    });

    it('rehydrates the host-selected GitHub Account ref before canonical dispatch and forwards only its exact contributor generation', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { applied: true } },
        }));
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext(),
            callerBinding: mountedCallerBinding(),
            contributedAction: {
                machineId: 'machine-1',
                expectedGeneration: '9',
                execute: contributed,
            },
        });
        const targetedOperation = {
            point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
            contributor: {
                pluginId: 'acme.reviewer',
                contributionId: 'github-connection',
                immutableGenerationId: 'contributor-generation-a',
            },
            role: 'setup',
            action: { pluginId: 'acme.reviewer', localId: 'prepare-v1' },
        } as const;
        const account = {
            service: { pluginId: 'acme.github', localId: 'github' },
            accountId: 'account-a',
        } as const;
        const selectedActionInput = {
            kind: 'submitted' as const,
            action: targetedOperation.action,
            input: { repository: 'happier-dev/happier' },
            selection: {
                target: {
                    pluginId: CALLER_PLUGIN_ID,
                    immutableGenerationId: 'target-generation-a',
                },
                point: targetedOperation.point,
                contributor: targetedOperation.contributor,
            },
            connectedAccount: {
                kind: 'selected' as const,
                fieldPath: 'credentialRef',
                ref: account,
            },
        };

        await expect(api.handleRequest(
            executeActionRequest({ action: targetedOperation.action, input: { repository: 'happier-dev/happier' } }),
            { targetedOperation, selectedActionInput },
        )).resolves.toEqual({ applied: true });
        expect(contributed).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            qualifiedActionId: 'acme.reviewer/prepare-v1',
            expectedContributorImmutableGenerationId: 'contributor-generation-a',
            input: {
                repository: 'happier-dev/happier',
                credentialRef: account,
            },
        }));

        await expect(api.handleRequest(
            executeActionRequest({ action: { pluginId: 'acme.reviewer', localId: 'other-v1' }, input: {} }),
            { targetedOperation, selectedActionInput },
        )).resolves.toEqual({
            code: 'invalid_payload',
            diagnostics: ['plugin_surface_targeted_selection_invalid'],
        });

        // The selected target contributor can be relayed only through an
        // Action owned by this exact mounted target. An arbitrary provider
        // Action cannot borrow the carrier.
        await expect(api.handleRequest(
            executeActionRequest({
                action: { pluginId: CALLER_PLUGIN_ID, localId: 'connection/create' },
                input: { providerSetupInput: { repository: 'happier-dev/happier' } },
            }),
            { targetedOperation, selectedActionInput },
        )).resolves.toEqual({ applied: true });
        expect(contributed).toHaveBeenLastCalledWith('machine-1', expect.objectContaining({
            qualifiedActionId: `${CALLER_PLUGIN_ID}/connection/create`,
            input: { providerSetupInput: { repository: 'happier-dev/happier' } },
            selectedActionInputCarrier: {
                operation: targetedOperation,
                result: selectedActionInput,
            },
        }));

        await expect(api.handleRequest(
            executeActionRequest({ action: targetedOperation.action, input: { repository: 'tampered' } }),
            { targetedOperation, selectedActionInput },
        )).resolves.toEqual({
            code: 'invalid_payload',
            diagnostics: ['plugin_surface_targeted_selection_invalid'],
        });
        expect(contributed).toHaveBeenCalledTimes(2);
    });

    it('rejects a payload that carries no canonical action reference', async () => {
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext(),
            hostAction: { execute: vi.fn(async () => ({ ok: true as const, result: {} })) },
        });

        await expect(api.handleRequest(executeActionRequest({ input: {} }))).resolves.toEqual({
            code: 'invalid_payload',
            diagnostics: ['plugin_surface_action_payload_invalid'],
        });
    });

    // The predecessor `actionId` spelling is retired, not aliased: no released tag
    // and no `remote-dev` revision ships `packages/protocol/src/plugins/**`, so no
    // reachable client can send it.
    it('does not resurrect the predecessor actionId spelling', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: {} }));
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext(),
            hostAction: { execute },
        });

        await expect(api.handleRequest(executeActionRequest({
            actionId: HOST_ACTION_ID,
            input: {},
        }))).resolves.toEqual({
            code: 'invalid_payload',
            diagnostics: ['plugin_surface_action_payload_invalid'],
        });
        expect(execute).not.toHaveBeenCalled();
    });

    it('rejects a structured action reference with fields outside the Protocol request contract', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { shouldNotRun: true } },
        }));
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext(),
            callerBinding: mountedCallerBinding(),
            contributedAction: {
                machineId: 'machine-1',
                expectedGeneration: '9',
                execute: contributed,
            },
        });

        await expect(api.handleRequest(executeActionRequest({
            action: {
                pluginId: 'acme.reviewer',
                localId: 'refresh-index',
                unexpected: true,
            },
            input: {},
        }))).resolves.toEqual({
            code: 'invalid_payload',
            diagnostics: ['plugin_surface_action_payload_invalid'],
        });
        expect(contributed).not.toHaveBeenCalled();
    });

    it('host-stamps the mounted plugin rather than trusting the request payload', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: {} }));
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext('acme.other-app-surface'),
            callerBinding: mountedCallerBinding({ pluginId: 'acme.other-app-surface' }),
            hostAction: { execute },
        });

        await expect(api.handleRequest({
            ...executeActionRequest({ action: HOST_ACTION_ID, input: { pluginId: CALLER_PLUGIN_ID } }),
            surface: surfaceContext('acme.other-app-surface'),
        })).resolves.toEqual({});
        expect(execute).toHaveBeenCalledWith(HOST_ACTION_ID, { pluginId: CALLER_PLUGIN_ID }, {
            surface: 'plugin',
            actionCaller: {
                kind: 'plugin',
                pluginId: 'acme.other-app-surface',
                contributionLocalId: 'inspector-app',
                materialization: {
                    pluginId: 'acme.other-app-surface',
                    machineId: 'machine-1',
                    materializationId: 'materialization-inspector-current',
                },
            },
        });
    });

    it('forwards caller cancellation through the mounted handler before dispatching', async () => {
        const cancellation = new AbortController();
        cancellation.abort();
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { shouldNotReachDaemon: true } },
        }));
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext(),
            contributedAction: {
                machineId: 'machine-cancel',
                expectedGeneration: '5',
                execute: contributed,
            },
        });

        await expect(api.handleRequest(
            executeActionRequest({ action: 'refresh-index', input: {} }),
            { signal: cancellation.signal },
        )).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_ui_invocation_aborted'],
        });
        expect(contributed).not.toHaveBeenCalled();
    });
});

/**
 * Composed public-client <-> host seam (plan §7 layer 3, UI-D23).
 *
 * Every owner-level test above proves one side. This block wires the REAL public
 * SDK client (`@happier-dev/plugin-sdk/ui/client`) to the REAL hosted-web host
 * adapter to the REAL mounted host API. The only substituted pieces are the
 * iframe/postMessage hop — a genuine realm boundary — and the two terminal
 * executors, which are spied so the test can observe exactly what reaches them.
 * No envelope is hand-constructed.
 */
const COMPOSED_HOST_ORIGIN = 'https://host.happier.test';
const COMPOSED_IDENTITY = {
    pluginId: CALLER_PLUGIN_ID,
    pluginVersion: '1.4.2',
    viewId: 'inspector-app',
    generation: '9',
} as const;
const COMPOSED_BRIDGE_NONCE = 'composed-bridge-nonce';
const COMPOSED_SURFACE = surfaceContext();
const COMPOSED_MOUNTED_BINDING = {
    contributionLocalId: COMPOSED_SURFACE.contributionId,
    materializationRef: {
        machineId: 'machine-composed',
        materializationId: 'materialization-composed-current',
        pluginId: COMPOSED_SURFACE.pluginId,
    },
} as const;
const COMPOSED_TARGETED_OPERATION = {
    point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
    contributor: {
        pluginId: 'acme.reviewer',
        contributionId: 'github-connection',
        immutableGenerationId: 'contributor-generation-composed',
    },
    role: 'setup',
    action: { pluginId: 'acme.reviewer', localId: 'prepare-v1' },
} as const;
// Keep this as a JSON tree, rather than reusing the operation object's nested
// records. The hosted wire deliberately rejects shared object references so a
// descriptor is always serializable across the frame boundary.
const COMPOSED_TARGETED_CONTRIBUTIONS = PluginUiTargetedContributionsV1Schema.parse({
    target: {
        pluginId: CALLER_PLUGIN_ID,
        immutableGenerationId: 'target-generation-composed',
    },
    points: [{
        pointId: 'connection',
        protocols: [{
            protocol: { id: 'connection', version: 1 },
            contributions: [{
                contributor: {
                    pluginId: 'acme.reviewer',
                    contributionId: 'github-connection',
                    immutableGenerationId: 'contributor-generation-composed',
                },
                protocol: { id: 'connection', version: 1 },
                operations: [{
                    point: {
                        pointId: 'connection',
                        protocol: { id: 'connection', version: 1 },
                    },
                    contributor: {
                        pluginId: 'acme.reviewer',
                        contributionId: 'github-connection',
                        immutableGenerationId: 'contributor-generation-composed',
                    },
                    role: 'setup',
                    action: { pluginId: 'acme.reviewer', localId: 'prepare-v1' },
                }],
                // The projection contract always carries both role families,
                // even when this composed Action-only fixture has no Surface.
                surfaces: [],
            }],
        }],
    }],
});
/**
 * The canonical surface snapshot the mount projects. Its `theme` comes from the
 * canonical projection owner rather than a literal, so this suite cannot pass
 * against a hand-built neighbour envelope that the real host would never emit.
 */
const COMPOSED_CANONICAL_SURFACE: PluginUiJsonValueV1 = {
    // The public SDK sees the canonical destination-or-embedded mount union;
    // the bridge address below remains the host-private request classification.
    mount: {
        kind: 'destination',
        destination: { pluginId: CALLER_PLUGIN_ID, localId: COMPOSED_SURFACE.contributionId },
        container: 'appPage',
    },
    target: { kind: 'app' },
    accountEncryptionMode: 'plain',
    platform: 'web',
    locale: 'en',
    direction: 'ltr',
    colorScheme: 'light',
    contrast: 'normal',
    textScale: 1,
    reducedMotion: false,
    screenReaderEnabled: false,
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    theme: PluginUiJsonValueV1Schema.parse(projectPluginUiTheme(
        resolveThemeProfile({ mode: 'light', profile: null }),
    )),
    translations: {},
    targetedContributions: COMPOSED_TARGETED_CONTRIBUTIONS,
};

function composedRealmHref(): string {
    const url = new URL('https://preview.happier.test/plugin-surface');
    url.searchParams.set('happierPluginId', COMPOSED_IDENTITY.pluginId);
    url.searchParams.set('happierContributionId', COMPOSED_SURFACE.contributionId);
    url.searchParams.set('happierSurfaceId', COMPOSED_SURFACE.surfaceId);
    url.searchParams.set('happierBridgeNonce', COMPOSED_BRIDGE_NONCE);
    url.searchParams.set('happierHostOrigin', COMPOSED_HOST_ORIGIN);
    return url.toString();
}

type ComposedSettlement =
    | Readonly<{ settled: 'fulfilled'; result: unknown }>
    | Readonly<{ settled: 'rejected'; code: string; diagnostics: readonly string[] }>;

async function settleComposed(pending: Promise<unknown>): Promise<ComposedSettlement> {
    return pending.then(
        (result): ComposedSettlement => ({ settled: 'fulfilled', result }),
        (error: unknown): ComposedSettlement => {
            const data = error as Readonly<{
                code?: unknown;
                diagnostics?: readonly Readonly<{ code?: unknown }>[];
            }>;
            return {
                settled: 'rejected',
                code: typeof data.code === 'string' ? data.code : 'unknown',
                diagnostics: (data.diagnostics ?? [])
                    .map((diagnostic) => diagnostic.code)
                    .filter((code): code is string => typeof code === 'string'),
            };
        },
    );
}

describe('composed public SDK client to canonical plugin-surface dispatcher', () => {
    const executeHostAction = vi.fn<PluginSurfaceHostActionExecute>(async () => ({
        ok: true as const,
        result: { plugins: [] },
    }));
    const contributedActionExecute = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
        supported: true as const,
        result: { ok: true as const, result: { refreshed: true } },
    }));
    const previousGlobals = {
        window: Reflect.get(globalThis, 'window'),
        location: Reflect.get(globalThis, 'location'),
        parent: Reflect.get(globalThis, 'parent'),
        addEventListener: Reflect.get(globalThis, 'addEventListener'),
        removeEventListener: Reflect.get(globalThis, 'removeEventListener'),
    };
    let client: PluginUiHostApi;
    let bridge: ReturnType<typeof createPluginHostedWebHostApiBridgeHandler>;
    const emittedExecuteActionPayloads: PluginUiJsonValueV1[] = [];
    const emittedTargetedOperations: unknown[] = [];

    beforeAll(async () => {
        const listeners = new Set<(event: unknown) => void>();
        const deliverFromHost = (message: unknown): void => {
            // Browser `postMessage` does not re-enter the guest while it is
            // sending `ready`; preserve that ordering so bootstrap can clear
            // the client timeout that is armed immediately afterwards.
            queueMicrotask(() => {
                for (const listener of [...listeners]) {
                    listener({ data: message, origin: COMPOSED_HOST_ORIGIN, source: parent });
                }
            });
        };
        const parent = {
            postMessage(message: unknown, targetOrigin: string): void {
                // Match the browser boundary: an incorrectly addressed guest
                // message never reaches the host bridge.
                if (targetOrigin !== COMPOSED_HOST_ORIGIN) return;
                const envelope = PluginHostedWebBridgeEnvelopeV1Schema.safeParse(message);
                if (!envelope.success) return;
                void Promise.resolve(bridge(envelope.data)).then((response) => {
                    deliverFromHost(response);
                });
            },
        };
        const hostApi = createPluginSurfaceActionHostApi({
            surfaceContext: COMPOSED_SURFACE,
            callerBinding: COMPOSED_MOUNTED_BINDING,
            hostAction: { execute: executeHostAction, context: { serverId: 'server-composed' } },
            contributedAction: {
                machineId: 'machine-composed',
                serverId: 'server-composed',
                expectedGeneration: '9',
                execute: contributedActionExecute,
            },
            selectActionInput: async (request): Promise<PluginUiJsonValueV1> => {
                const operation = (request.payload as { operation?: unknown } | undefined)?.operation;
                if (JSON.stringify(operation) !== JSON.stringify(COMPOSED_TARGETED_OPERATION)) {
                    return { code: 'invalid_payload', diagnostics: ['targeted_operation_missing'] };
                }
                return {
                    kind: 'submitted',
                    action: COMPOSED_TARGETED_OPERATION.action,
                    input: { repository: 'happier-dev/happier' },
                    selection: {
                        target: COMPOSED_TARGETED_CONTRIBUTIONS.target,
                        point: COMPOSED_TARGETED_OPERATION.point,
                        contributor: COMPOSED_TARGETED_OPERATION.contributor,
                    },
                    connectedAccount: { kind: 'none' },
                };
            },
        });
        bridge = createPluginHostedWebHostApiBridgeHandler({
            surface: COMPOSED_SURFACE,
            requestIdPrefix: 'composed',
            bridgeNonce: COMPOSED_BRIDGE_NONCE,
            handleRequest: async (request, options) => {
                if (request.method === 'executeAction' && request.payload !== undefined) {
                    emittedExecuteActionPayloads.push(request.payload);
                    emittedTargetedOperations.push(options?.targetedOperation);
                }
                return await hostApi.handleRequest(request, options);
            },
            canonicalHostApi: {
                identity: COMPOSED_IDENTITY,
                surface: COMPOSED_CANONICAL_SURFACE,
                methods: ['context', 'executeAction', 'selectActionInput'],
            },
            // The real frame adapter owns a distinct host->frame delivery
            // channel. `ready` is acknowledged on the request path, but only
            // this channel carries the post-ready bootstrap.
            postToFrame: deliverFromHost,
            bootstrap: {
                frameOrigin: new URL(composedRealmHref()).origin,
            },
        });

        // The plugin realm: the SDK's own hosted-web bootstrap installs the real
        // transport from these host-issued query parameters, so the wire and
        // bridge envelopes the client sends are production-built, not fixtures.
        Reflect.set(globalThis, 'location', { href: composedRealmHref() });
        Reflect.set(globalThis, 'parent', parent);
        Reflect.set(globalThis, 'addEventListener', (_type: string, listener: (event: unknown) => void): void => {
            listeners.add(listener);
        });
        Reflect.set(globalThis, 'removeEventListener', (_type: string, listener: (event: unknown) => void): void => {
            listeners.delete(listener);
        });
        Reflect.set(globalThis, 'window', globalThis);

        client = await createPluginUiHostApiClient();
    });

    afterAll(async () => {
        bridge?.dispose();
        // Disposal sends the real terminal host message on the simulated
        // browser task queue. Keep the realm boundary installed until that
        // message releases the SDK listener, just as a browser realm remains
        // alive while its frame is being torn down.
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        for (const [key, value] of Object.entries(previousGlobals)) {
            if (value === undefined) Reflect.deleteProperty(globalThis, key);
            else Reflect.set(globalThis, key, value);
        }
    });

    it('carries a plugin-surfaced ActionSpec from the public client to the canonical executor', async () => {
        executeHostAction.mockClear();
        emittedExecuteActionPayloads.length = 0;

        await expect(client.executeAction(HOST_ACTION_ID, { pluginId: CALLER_PLUGIN_ID }))
            .resolves.toEqual({ plugins: [] });

        expect(emittedExecuteActionPayloads).toEqual([{
            action: HOST_ACTION_ID,
            input: { pluginId: CALLER_PLUGIN_ID },
        }]);
        expect(PluginUiExecuteActionRequestV1Schema.safeParse(
            emittedExecuteActionPayloads[0],
        ).success).toBe(true);
        expect(executeHostAction).toHaveBeenCalledTimes(1);
        expect(executeHostAction).toHaveBeenCalledWith(HOST_ACTION_ID, { pluginId: CALLER_PLUGIN_ID }, {
            actionCaller: {
                kind: 'plugin',
                pluginId: CALLER_PLUGIN_ID,
                contributionLocalId: COMPOSED_SURFACE.contributionId,
                materialization: COMPOSED_MOUNTED_BINDING.materializationRef,
            },
            signal: expect.any(AbortSignal),
            surface: 'plugin',
            serverId: 'server-composed',
        });
    });

    it('rejects a malformed structured Action reference before it crosses the hosted transport', async () => {
        executeHostAction.mockClear();
        contributedActionExecute.mockClear();
        emittedExecuteActionPayloads.length = 0;
        // Plugin code crosses a runtime boundary; strict Protocol validation
        // must reject this rather than silently projecting it to two fields.
        const malformedAction = {
            pluginId: CALLER_PLUGIN_ID,
            localId: 'refresh-index',
            unexpected: true,
        };

        await expect(client.executeAction(malformedAction, null)).rejects.toMatchObject({
            code: 'invalid_payload',
        });
        expect(emittedExecuteActionPayloads).toEqual([]);
        expect(executeHostAction).not.toHaveBeenCalled();
        expect(contributedActionExecute).not.toHaveBeenCalled();
    });

    // The public client legitimately encodes a contributed-action reference as
    // `{ pluginId, localId }`. It must reach the contributed-action route, NOT the
    // first-party ActionId executor.
    it('routes a structured plugin reference to the contributed-action front door', async () => {
        executeHostAction.mockClear();
        contributedActionExecute.mockClear();

        await expect(client.executeAction(
            { pluginId: 'acme.reviewer', localId: 'refresh-index' },
            { reason: 'composed-seam' },
        )).resolves.toEqual({ refreshed: true });

        expect(executeHostAction).not.toHaveBeenCalled();
        expect(contributedActionExecute).toHaveBeenCalledWith('machine-composed', {
            serverId: 'server-composed',
            expectedGeneration: '9',
            qualifiedActionId: 'acme.reviewer/refresh-index',
            input: { reason: 'composed-seam' },
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: COMPOSED_MOUNTED_BINDING,
            },
            signal: expect.any(AbortSignal),
        });
    });

    it('carries a public SDK selected target operation through hosted execution only after host selection', async () => {
        contributedActionExecute.mockClear();
        emittedExecuteActionPayloads.length = 0;
        emittedTargetedOperations.length = 0;

        const selected = await client.selectActionInput({
            operation: COMPOSED_TARGETED_OPERATION,
        });
        expect(selected).toEqual({
            kind: 'submitted',
            action: COMPOSED_TARGETED_OPERATION.action,
            input: { repository: 'happier-dev/happier' },
            selection: {
                target: COMPOSED_TARGETED_CONTRIBUTIONS.target,
                point: COMPOSED_TARGETED_OPERATION.point,
                contributor: COMPOSED_TARGETED_OPERATION.contributor,
            },
            connectedAccount: { kind: 'none' },
        });
        if (selected.kind !== 'submitted') throw new Error('expected submitted selection');

        await expect(client.executeAction(selected.action, selected.input))
            .resolves.toEqual({ refreshed: true });

        expect(emittedExecuteActionPayloads).toEqual([{
            action: COMPOSED_TARGETED_OPERATION.action,
            input: { repository: 'happier-dev/happier' },
        }]);
        expect(emittedTargetedOperations).toEqual([COMPOSED_TARGETED_OPERATION]);
        expect(contributedActionExecute).toHaveBeenCalledWith('machine-composed', {
            serverId: 'server-composed',
            expectedGeneration: '9',
            expectedContributorImmutableGenerationId: 'contributor-generation-composed',
            qualifiedActionId: 'acme.reviewer/prepare-v1',
            input: { repository: 'happier-dev/happier' },
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: COMPOSED_MOUNTED_BINDING,
            },
            signal: expect.any(AbortSignal),
        });
    });

    // UI-D26: the `executionSurface: 'ui'` stamp is an invariant of the canonical
    // dispatcher, not an optional field each mounted transport must remember. A
    // request that reaches the daemon front door without it is evaluated on the
    // wrong surface, denying `surfaces:['ui']` actions and admitting agent-only
    // ones. Driving the real public client through the real mounted contract is
    // the only oracle that can observe the omission — a hand-built envelope
    // proves nothing.
    it('stamps the ui execution surface for a caller-local contributed action id', async () => {
        executeHostAction.mockClear();
        contributedActionExecute.mockClear();

        await expect(client.executeAction('refresh-index', { reason: 'local-ref' }))
            .resolves.toEqual({ refreshed: true });

        expect(executeHostAction).not.toHaveBeenCalled();
        expect(contributedActionExecute).toHaveBeenCalledWith('machine-composed', {
            serverId: 'server-composed',
            expectedGeneration: '9',
            qualifiedActionId: `${CALLER_PLUGIN_ID}/refresh-index`,
            input: { reason: 'local-ref' },
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: COMPOSED_MOUNTED_BINDING,
            },
            signal: expect.any(AbortSignal),
        });
    });

    it('rejects a failed host ActionSpec instead of resolving the failure envelope as a result', async () => {
        executeHostAction.mockClear();
        executeHostAction.mockResolvedValueOnce({
            ok: false as const,
            errorCode: 'plugins_reload_failed',
            error: 'reload failed',
        });

        const settlement = await settleComposed(client.executeAction(HOST_ACTION_ID, {
            pluginId: CALLER_PLUGIN_ID,
        }));

        expect(settlement.settled).toBe('rejected');
        expect(settlement.settled === 'rejected' ? settlement.diagnostics : [])
            .toContain('plugins_reload_failed');
    });

    it('rejects a failed contributed action instead of resolving the failure envelope as a result', async () => {
        contributedActionExecute.mockClear();
        contributedActionExecute.mockResolvedValueOnce({
            supported: true as const,
            result: { ok: false as const, code: 'plugin_action_surface_unavailable' },
        });

        const settlement = await settleComposed(client.executeAction('refresh-index', {}));

        expect(settlement.settled).toBe('rejected');
        expect(settlement.settled === 'rejected' ? settlement.diagnostics : [])
            .toContain('plugin_action_surface_unavailable');
    });

    it('rejects an unreachable daemon front door as a typed failure', async () => {
        contributedActionExecute.mockClear();
        contributedActionExecute.mockResolvedValueOnce({
            supported: false as const,
            reason: 'not-supported' as const,
        });

        const settlement = await settleComposed(client.executeAction('refresh-index', {}));

        expect(settlement.settled).toBe('rejected');
        expect(settlement.settled === 'rejected' ? settlement.diagnostics : [])
            .toContain('plugin_ui_action_host_unavailable');
    });
});

/**
 * Composed React Native seam (plan §7 layer 3 / EU-2 gate).
 *
 * The canonical RN adapter is the public `PluginUiHostApi` an author holds
 * inside a React Native surface. Driving it over the real mounted host API
 * proves the same two branches and the same UI-D26 stamp reach the daemon front
 * door from RN, and that a failed dispatch REJECTS on this transport rather than
 * resolving the error envelope as an action result (UI-D08).
 */
describe('composed React Native host API to canonical plugin-surface dispatcher', () => {
    const canonicalSurface = {
        mount: {
            kind: 'embedded',
            role: 'plugin-surface-action-dispatch-test',
            presentation: 'content',
        },
        target: { kind: 'app' as const },
        accountEncryptionMode: 'e2ee' as const,
        theme: projectPluginUiTheme(resolveThemeProfile({ mode: 'light', profile: null })),
        translations: {},
        platform: 'ios' as const,
        locale: 'en',
        direction: 'ltr' as const,
        colorScheme: 'light' as const,
        contrast: 'normal' as const,
        textScale: 1,
        reducedMotion: false,
        screenReaderEnabled: false,
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        targetedContributions: {
            target: {
                pluginId: CALLER_PLUGIN_ID,
                immutableGenerationId: 'target-generation-a',
            },
            points: [],
        },
    } as const satisfies SurfaceContext;

    function createReactNativeSurface(input: Readonly<{
        executeHostAction: PluginSurfaceHostActionExecute;
        contributedActionExecute: PluginSurfaceContributedActionTransport;
    }>) {
        const requestSurface = surfaceContext();
        const mountedBinding = {
            contributionLocalId: requestSurface.contributionId,
            materializationRef: {
                machineId: 'machine-rn',
                materializationId: 'materialization-rn-current',
                pluginId: requestSurface.pluginId,
            },
        } as const;
        const hostApi = createPluginSurfaceActionHostApi({
            surfaceContext: requestSurface,
            callerBinding: mountedBinding,
            hostAction: { execute: input.executeHostAction, context: { serverId: 'server-rn' } },
            contributedAction: {
                machineId: 'machine-rn',
                serverId: 'server-rn',
                expectedGeneration: '9',
                execute: input.contributedActionExecute,
            },
        });
        return createCanonicalPluginReactNativeHostApiAdapter({
            surface: canonicalSurface,
            requestSurface,
            requestIdPrefix: 'rn-dispatch',
            handleRequest: hostApi.handleRequest,
            installedMethods: hostApi.installedMethods,
        });
    }

    it('carries both branches from the React Native public API with the host stamps intact', async () => {
        const executeHostAction = vi.fn(async () => ({ ok: true as const, result: { reloaded: true } }));
        const contributedActionExecute = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { refreshed: true } },
        }));
        const adapter = createReactNativeSurface({
            executeHostAction,
            contributedActionExecute,
        });

        // The advertised set is EU-1's contract (`watchContext` is served locally
        // from the one context snapshot); this lane asserts only that the action
        // method is factually installed by the mount.
        expect(adapter.api.version().methods).toContain('executeAction');

        await expect(adapter.api.executeAction(HOST_ACTION_ID, { pluginId: CALLER_PLUGIN_ID }))
            .resolves.toEqual({ reloaded: true });
        expect(executeHostAction).toHaveBeenCalledWith(HOST_ACTION_ID, { pluginId: CALLER_PLUGIN_ID }, {
            serverId: 'server-rn',
            surface: 'plugin',
            actionCaller: {
                kind: 'plugin',
                pluginId: CALLER_PLUGIN_ID,
                contributionLocalId: surfaceContext().contributionId,
                materialization: {
                    machineId: 'machine-rn',
                    materializationId: 'materialization-rn-current',
                    pluginId: CALLER_PLUGIN_ID,
                },
            },
        });

        await expect(adapter.api.executeAction('refresh-index', { reason: 'rn' }))
            .resolves.toEqual({ refreshed: true });
        expect(contributedActionExecute).toHaveBeenCalledWith('machine-rn', {
            serverId: 'server-rn',
            expectedGeneration: '9',
            qualifiedActionId: `${CALLER_PLUGIN_ID}/refresh-index`,
            input: { reason: 'rn' },
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    contributionLocalId: surfaceContext().contributionId,
                    materializationRef: {
                        machineId: 'machine-rn',
                        materializationId: 'materialization-rn-current',
                        pluginId: CALLER_PLUGIN_ID,
                    },
                },
            },
        });
    });

    it('rejects a failed dispatch on the React Native transport instead of resolving the envelope', async () => {
        const adapter = createReactNativeSurface({
            executeHostAction: vi.fn<PluginSurfaceHostActionExecute>(async () => ({
                ok: false as const,
                errorCode: 'plugins_reload_failed',
                error: 'reload failed',
            })),
            contributedActionExecute: vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
                supported: true as const,
                result: { ok: false as const, code: 'plugin_action_surface_unavailable' },
            })),
        });

        await expect(adapter.api.executeAction(HOST_ACTION_ID, {
            pluginId: CALLER_PLUGIN_ID,
        })).rejects.toMatchObject({
            code: 'unavailable',
            diagnostics: [{ code: 'plugins_reload_failed', severity: 'error' }],
        });
        await expect(adapter.api.executeAction('refresh-index', {})).rejects.toMatchObject({
            code: 'unavailable',
            diagnostics: [{ code: 'plugin_action_surface_unavailable', severity: 'error' }],
        });
    });
});
