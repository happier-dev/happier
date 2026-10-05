import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isPluginError } from '@happier-dev/plugin-sdk';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import {
    manifest as publicAuthoringManifest,
} from '../../../../../../packages/plugin-sdk/examples/public-authoring/index.ts';
import {
    activate as activatePublicAuthoringReviewClientActions,
} from '../../../../../../packages/plugin-sdk/examples/public-authoring/ui/reviewClientActions.ts';
import {
    createActionExecutor,
    formatQualifiedPluginActionId,
    PluginProjectionInstalledPackageV2Schema,
    PluginProjectedActionV2Schema,
    type ActionExecutorDeps,
    type CurrentUiContextSnapshotV1,
    type PluginContributionClientPlatform,
    type PluginMachineExecutionOriginV1,
    type PluginProjectedActionV2,
} from '@happier-dev/protocol';
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiActionProjection, PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY } from '@/sync/domains/plugins/ui/projectionUnion';
import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import { getInstalledPluginUiClientExecutableComposition } from '@/components/plugins/reactNative/clientExecutableContributions';
import { resolveProjectedPluginUiClientExecutables } from '@/components/plugins/reactNative/clientExecutableProjection';
import { dispatchPluginSurfaceAction } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import type {
    PluginReactNativeExecutableExport,
    PluginReactNativeLoaderBackend,
} from '@/components/plugins/reactNative/loader';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import { setPreferredLanguageFromSettings } from '@/text';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

// Keep the Action dispatcher and its currentness checks real. The
// server-scoped daemon RPC is the system boundary at the far end of this
// AppShell bridge.
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const clientExecutablePlatformState = vi.hoisted(() => ({
    platform: 'web' as PluginContributionClientPlatform,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('@/sync/domains/local/services/preview/platform', () => ({
    resolveLocalServicePreviewPlatform: () => clientExecutablePlatformState.platform,
}));

// The shared approval owner is real; native dialog presentation confirms this
// transport-lifetime case before the mock daemon RPC becomes pending.
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});

/** Declared Action schemas the daemon answers per Action; never projected. */
const actionSchemasByQualifiedId = new Map<string, Readonly<{ inputSchema: object; outputSchema?: object }>>();

beforeEach(() => {
    actionSchemasByQualifiedId.clear();
    resetMachineProjectionReadsForTests();
    machineRpcWithServerScopeMock.mockClear();
    machineRpcWithServerScopeMock.mockImplementation(async (request: Readonly<{
        method?: string;
        payload?: Readonly<{ qualifiedActionId?: string }>;
    }>) => {
        if (request.method !== RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return undefined;
        const schemas = actionSchemasByQualifiedId.get(request.payload?.qualifiedActionId ?? '');
        return schemas ? { ok: true, ...schemas } : { ok: false, code: 'plugin_action_schemas_unavailable' };
    });
});

import { resetMachineProjectionReadsForTests } from '@/sync/ops/machineContributionRegistryProjection';
import type { CurrentUiContextResolvedCommand } from './CurrentUiContextProvider';
import { executeCurrentUiContextAction, registerCurrentUiContextActionPort } from './currentUiContextActionRuntime';
import {
    createCurrentUiContributedActionRpcHandler,
    bindCurrentUiContextVoiceToolPortToAdmission,
    createCurrentUiContextVoiceToolPort,
    type CurrentUiContextVoiceCommandInvocationInput,
    type CurrentUiContextVoiceInvocationOutcome,
    type CurrentUiContextVoiceToolPort,
} from './currentUiContextVoiceToolPort';

const COMMAND_ID = 'current-ui-command:1';
const ACTION_ID = Object.freeze({ pluginId: 'acme.triage', localId: 'file-ticket' });
const ACTION_DISCOVERY_ID = formatQualifiedPluginActionId(ACTION_ID);
const ACTION_ORIGIN = Object.freeze({
    machineId: 'machine-actions',
    serverId: 'server-actions',
    generation: 27,
    interactionEnabled: true,
    phase: 'current' as const,
    executionOrigin: {
        serverIdentityId: 'srv_actions',
        materializationRef: {
            pluginId: ACTION_ID.pluginId,
            machineId: 'machine-actions',
            materializationId: 'action-materialization-current',
        },
    },
});

const CLIENT_ACTION_ID = Object.freeze({ pluginId: 'acme.current-ui', localId: 'retiring-client-action' });
const CLIENT_ACTION_TARGET = Object.freeze({
    artifactId: 'current-ui-client-action-bundle',
    exportName: 'activate',
    platform: 'web' as const,
});
const CLIENT_ACTION_GENERATION = 41;
const CLIENT_ACTION_EXECUTION_ORIGIN: PluginMachineExecutionOriginV1 = Object.freeze({
    serverIdentityId: 'srv_current_ui_client_action',
    materializationRef: Object.freeze({
        pluginId: CLIENT_ACTION_ID.pluginId,
        machineId: 'machine-current-ui-client-action',
        materializationId: 'materialization-current-ui-client-action',
    }),
});
const CLIENT_ACTION_HOST_ORIGIN = Object.freeze({
    machineId: CLIENT_ACTION_EXECUTION_ORIGIN.materializationRef.machineId,
    serverId: 'server-current-ui-client-action',
    generation: CLIENT_ACTION_GENERATION,
    interactionEnabled: true,
    phase: 'current' as const,
    executionOrigin: CLIENT_ACTION_EXECUTION_ORIGIN,
});
const CLIENT_ACTION_ARTIFACT_GRAPH = PluginUiArtifactsManifestEntryV2Schema.parse({
    artifactId: CLIENT_ACTION_TARGET.artifactId,
    tier: 'reactNative',
    entry: 'react-native/current-ui-client-action-bundle/entry.cjs.bundle',
    files: [{
        relativePath: 'react-native/current-ui-client-action-bundle/entry.cjs.bundle',
        digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        byteSize: 10,
    }],
    digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    builtWith: { bundler: 'esbuild', version: '0.27.2' },
    executable: { exports: [CLIENT_ACTION_TARGET.exportName] },
    hostUiApiRange: '^1.0.0',
});
const CLIENT_ACTION_AUTHORIZATION = Object.freeze({
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

const PUBLIC_AUTHORING_CLIENT_ACTION_GENERATION = 52;
const PUBLIC_AUTHORING_CLIENT_ACTION_EXECUTION_ORIGIN: PluginMachineExecutionOriginV1 = Object.freeze({
    serverIdentityId: 'srv_public_authoring_client_action',
    materializationRef: Object.freeze({
        pluginId: 'examples.public-sdk-review-assistant',
        machineId: 'machine-public-authoring-client-action',
        materializationId: 'materialization-public-authoring-client-action',
    }),
});
const PUBLIC_AUTHORING_CLIENT_ACTION_HOST_ORIGIN = Object.freeze({
    machineId: PUBLIC_AUTHORING_CLIENT_ACTION_EXECUTION_ORIGIN.materializationRef.machineId,
    serverId: 'server-public-authoring-client-action',
    generation: PUBLIC_AUTHORING_CLIENT_ACTION_GENERATION,
    interactionEnabled: true,
    phase: 'current' as const,
    executionOrigin: PUBLIC_AUTHORING_CLIENT_ACTION_EXECUTION_ORIGIN,
});
const PUBLIC_AUTHORING_CLIENT_ACTION_LOCAL_IDS = [
    'open-review-status',
    'open-review-status-web-only-fixture',
] as const;
type PublicAuthoringClientActionLocalId = (typeof PUBLIC_AUTHORING_CLIENT_ACTION_LOCAL_IDS)[number];

const PUBLIC_AUTHORING_CLIENT_ACTION_ARTIFACT_DIGESTS = Object.freeze({
    web: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ios: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    android: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
}) satisfies Readonly<Record<
    PluginContributionClientPlatform,
    PluginReactNativeBundleCacheIdentity['artifactDigest']
>>;

function publicAuthoringClientActionArtifactDigest(
    platform: PluginContributionClientPlatform,
): PluginReactNativeBundleCacheIdentity['artifactDigest'] {
    return PUBLIC_AUTHORING_CLIENT_ACTION_ARTIFACT_DIGESTS[platform];
}

function readPublicAuthoringActionDeclaration(
    value: unknown,
    localId: PublicAuthoringClientActionLocalId,
): object | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return Reflect.get(value, 'id') === localId ? value : null;
}

function createPublicAuthoringClientActionFixture(input: Readonly<{
    localId: PublicAuthoringClientActionLocalId;
    platform: PluginContributionClientPlatform;
}>) {
    const declarations = publicAuthoringManifest.contributes.actions ?? [];
    const declaration = declarations
        .map((candidate) => readPublicAuthoringActionDeclaration(candidate, input.localId))
        .find((candidate) => candidate !== null);
    if (!declaration) {
        throw new Error(`public_authoring_client_action_missing:${input.localId}`);
    }
    const {
        inputSchema: declaredInputSchema,
        outputSchema: declaredOutputSchema,
        ...projectedDeclaration
    } = declaration as Readonly<Record<string, unknown>>;
    actionSchemasByQualifiedId.set(`${publicAuthoringManifest.id}/${input.localId}`, {
        inputSchema: (declaredInputSchema as object | undefined) ?? {},
        ...(declaredOutputSchema ? { outputSchema: declaredOutputSchema as object } : {}),
    });
    const action = PluginProjectedActionV2Schema.parse({
        ...projectedDeclaration,
        pluginId: publicAuthoringManifest.id,
        occurrenceId: `public-authoring-client-action-occurrence-${PUBLIC_AUTHORING_CLIENT_ACTION_GENERATION}`,
        serverIdentityId: PUBLIC_AUTHORING_CLIENT_ACTION_EXECUTION_ORIGIN.serverIdentityId,
        materializationRef: PUBLIC_AUTHORING_CLIENT_ACTION_EXECUTION_ORIGIN.materializationRef,
        available: true,
        authorization: {
            generation: {
                targetGeneration: String(PUBLIC_AUTHORING_CLIENT_ACTION_GENERATION),
                desiredGeneration: String(PUBLIC_AUTHORING_CLIENT_ACTION_GENERATION),
                appliedGeneration: String(PUBLIC_AUTHORING_CLIENT_ACTION_GENERATION),
            },
            resourceSelections: [],
            scopedGrants: [],
            serviceAvailability: [],
            operatingSystemAuthorization: [],
        },
    });
    if (action.execution.target !== 'client') {
        throw new Error(`public_authoring_client_action_not_client:${input.localId}`);
    }
    const projectedAction = Object.freeze({
        ...action,
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: PUBLIC_AUTHORING_CLIENT_ACTION_HOST_ORIGIN,
    });
    const supportsPlatform = action.execution.platforms.includes(input.platform);
    const bundleId = `reactNativeBundle:${action.pluginId}:${action.id}`;
    const artifactDigest = publicAuthoringClientActionArtifactDigest(input.platform);
    const cacheIdentity: PluginReactNativeBundleCacheIdentity = Object.freeze({
        pluginId: action.pluginId,
        contributionId: action.id,
        artifactId: action.execution.client.artifactId,
        artifactDigest,
        platform: input.platform,
    });
    const artifactGraph = supportsPlatform
        ? PluginUiArtifactsManifestEntryV2Schema.parse({
            artifactId: action.execution.client.artifactId,
            tier: 'reactNative',
            entry: 'react-native/review-client-actions/entry.cjs.bundle',
            files: [{
                relativePath: 'react-native/review-client-actions/entry.cjs.bundle',
                digest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                byteSize: 9,
            }],
            digest: artifactDigest,
            builtWith: { bundler: 'esbuild', version: '0.27.2' },
            executable: { exports: [action.execution.client.exportName] },
            hostUiApiRange: '^1.0.0',
        })
        : null;
    const projection = Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: PUBLIC_AUTHORING_CLIENT_ACTION_GENERATION,
        installedPackagesById: Object.freeze({
            [action.pluginId]: PluginProjectionInstalledPackageV2Schema.parse({
                id: action.pluginId,
                displayName: publicAuthoringManifest.displayName,
                version: publicAuthoringManifest.version,
                enabled: true,
                source: { kind: 'localPath', locator: action.pluginId },
            }),
        }),
        actionsById: Object.freeze({
            [`${action.pluginId}/${action.id}`]: projectedAction,
        }),
        reactNativeBundlesById: Object.freeze(artifactGraph === null ? {} : {
            [bundleId]: Object.freeze({
                id: bundleId,
                pluginId: action.pluginId,
                occurrenceId: action.occurrenceId,
                contributionKind: 'reactNativeBundle' as const,
                contributionId: action.id,
                generatedOwnerKind: 'clientContribution' as const,
                artifactGraph,
                runtime: Object.freeze({
                    decision: Object.freeze({ state: 'load' }),
                    loadPolicy: Object.freeze({ source: 'installedArtifact' }),
                    cacheIdentity: Object.freeze({ artifactDigest: cacheIdentity.artifactDigest }),
                }),
                [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: PUBLIC_AUTHORING_CLIENT_ACTION_HOST_ORIGIN,
            }),
        }),
    }) satisfies PluginUiProjectionModel;
    const resolved = resolveProjectedPluginUiClientExecutables({
        actionProjection: Object.freeze({ projection }),
        platform: input.platform,
    });
    const executable = resolved[0];
    if (supportsPlatform && (!executable || resolved.length !== 1)) {
        throw new Error('public_authoring_client_action_did_not_resolve_through_generic_projection');
    }
    const cache = createPluginReactNativeBundleCache();
    if (executable) {
        cache.putInstalledArtifact({
            identity: executable.cacheIdentity,
            bytes: new Uint8Array([47, 47, 32, 99, 108, 105, 101, 110, 116]),
            format: 'plainJs',
        });
    }
    const backend: PluginReactNativeLoaderBackend = Object.freeze({
        backendId: 'commonJs',
        available: true,
        loadInstalledBundle: vi.fn(async () => (
            activatePublicAuthoringReviewClientActions as PluginReactNativeExecutableExport
        )),
    });
    const activation = executable
        ? Object.freeze({
            pluginId: executable.pluginId,
            occurrenceId: executable.occurrenceId,
            hostUiApiRange: executable.hostUiApiRange,
            ...(executable.pluginVersion === undefined ? {} : { pluginVersion: executable.pluginVersion }),
            contributes: executable.contributes,
            target: executable.target,
            executionOrigin: executable.executionOrigin,
            cache,
            identity: executable.cacheIdentity,
            moduleReference: executable.moduleReference,
            backend,
            authority: executable.authority,
            isCurrent: () => true,
        })
        : null;
    return Object.freeze({
        action: projectedAction as PluginProjectedActionV2,
        projection,
        resolved,
        activation,
        composition: getInstalledPluginUiClientExecutableComposition(),
    });
}

function clientActionIdentity(): PluginReactNativeBundleCacheIdentity {
    return Object.freeze({
        pluginId: CLIENT_ACTION_ID.pluginId,
        contributionId: CLIENT_ACTION_ID.localId,
        artifactId: CLIENT_ACTION_TARGET.artifactId,
        artifactDigest: CLIENT_ACTION_ARTIFACT_GRAPH.digest,
        platform: CLIENT_ACTION_TARGET.platform,
    });
}

function createCurrentUiClientActionFixture(input: Readonly<{
    handler: PluginClientActionHandler;
    scopes?: PluginProjectedActionV2['scopes'];
    surfaces?: PluginProjectedActionV2['surfaces'];
    serverId?: string;
    dangerLevel?: PluginProjectedActionV2['dangerLevel'];
}>) {
    actionSchemasByQualifiedId.set(`${CLIENT_ACTION_ID.pluginId}/${CLIENT_ACTION_ID.localId}`, { inputSchema: {} });
    const action = PluginProjectedActionV2Schema.parse({
        id: CLIENT_ACTION_ID.localId,
        pluginId: CLIENT_ACTION_ID.pluginId,
        occurrenceId: `current-ui-client-action-occurrence-${CLIENT_ACTION_GENERATION}`,
        title: 'Retiring client action',
        scopes: input.scopes ?? ['global'],
        surfaces: input.surfaces ?? ['voice'],
        execution: {
            target: 'client',
            client: {
                artifactId: CLIENT_ACTION_TARGET.artifactId,
                exportName: CLIENT_ACTION_TARGET.exportName,
            },
            platforms: [CLIENT_ACTION_TARGET.platform],
        },
        serverIdentityId: CLIENT_ACTION_EXECUTION_ORIGIN.serverIdentityId,
        materializationRef: CLIENT_ACTION_EXECUTION_ORIGIN.materializationRef,
        dangerLevel: input.dangerLevel ?? 'safe',
        ...(input.dangerLevel && input.dangerLevel !== 'safe' ? { confirmation: { title: 'Confirm client mutation' } } : {}),
        available: true,
        authorization: CLIENT_ACTION_AUTHORIZATION,
    });
    const hostOrigin = { ...CLIENT_ACTION_HOST_ORIGIN, serverId: input.serverId ?? CLIENT_ACTION_HOST_ORIGIN.serverId };
    const projectedAction = Object.freeze({
        ...action,
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: hostOrigin,
    });
    const identity = clientActionIdentity();
    const bundleId = `reactNativeBundle:${CLIENT_ACTION_ID.pluginId}:${CLIENT_ACTION_ID.localId}`;
    const projection = Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: CLIENT_ACTION_GENERATION,
        installedPackagesById: Object.freeze({
            [CLIENT_ACTION_ID.pluginId]: PluginProjectionInstalledPackageV2Schema.parse({
                id: CLIENT_ACTION_ID.pluginId,
                displayName: 'Current UI test plugin',
                version: '1.2.3',
                enabled: true,
                source: { kind: 'localPath', locator: CLIENT_ACTION_ID.pluginId },
            }),
        }),
        actionsById: Object.freeze({
            [`${CLIENT_ACTION_ID.pluginId}/${CLIENT_ACTION_ID.localId}`]: projectedAction,
        }),
        reactNativeBundlesById: Object.freeze({
            [bundleId]: Object.freeze({
                id: bundleId,
                pluginId: CLIENT_ACTION_ID.pluginId,
                occurrenceId: action.occurrenceId,
                contributionKind: 'reactNativeBundle' as const,
                contributionId: CLIENT_ACTION_ID.localId,
                generatedOwnerKind: 'clientContribution' as const,
                artifactGraph: CLIENT_ACTION_ARTIFACT_GRAPH,
                runtime: Object.freeze({
                    decision: Object.freeze({ state: 'load' }),
                    loadPolicy: Object.freeze({ source: 'installedArtifact' }),
                    cacheIdentity: Object.freeze({ artifactDigest: identity.artifactDigest }),
                }),
                [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: hostOrigin,
            }),
        }),
    }) satisfies PluginUiProjectionModel;
    const resolved = resolveProjectedPluginUiClientExecutables({
        actionProjection: Object.freeze({ projection }),
        platform: CLIENT_ACTION_TARGET.platform,
    });
    const executable = resolved[0];
    if (!executable || resolved.length !== 1) {
        throw new Error('current UI client Action fixture did not resolve through the production projection');
    }
    const cache = createPluginReactNativeBundleCache();
    cache.putInstalledArtifact({
        identity: executable.cacheIdentity,
        bytes: new Uint8Array([47, 47, 32, 99, 108, 105, 101, 110, 116]),
        format: 'plainJs',
    });
    const activate = vi.fn((api: PluginClientApi) => {
        api.actions.register(CLIENT_ACTION_ID.localId, input.handler);
    });
    const backend: PluginReactNativeLoaderBackend = Object.freeze({
        backendId: 'commonJs',
        available: true,
        loadInstalledBundle: vi.fn(async () => activate as PluginReactNativeExecutableExport),
    });
    const activation = Object.freeze({
        pluginId: executable.pluginId,
        occurrenceId: executable.occurrenceId,
        hostUiApiRange: executable.hostUiApiRange,
        ...(executable.pluginVersion === undefined ? {} : { pluginVersion: executable.pluginVersion }),
        contributes: executable.contributes,
        target: executable.target,
        executionOrigin: executable.executionOrigin,
        cache,
        identity: executable.cacheIdentity,
        moduleReference: executable.moduleReference,
        backend,
        authority: executable.authority,
        isCurrent: () => true,
    });
    return Object.freeze({
        action: projectedAction as PluginProjectedActionV2,
        projection,
        activation,
        composition: getInstalledPluginUiClientExecutableComposition(),
    });
}

function withoutAbortSignalAny(): () => void {
    const original = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', {
        configurable: true,
        writable: true,
        value: undefined,
    });
    return () => {
        if (original) {
            Object.defineProperty(AbortSignal, 'any', original);
        } else {
            Reflect.deleteProperty(AbortSignal, 'any');
        }
    };
}

function createDaemonActionProjection(input: Readonly<{
    dangerLevel?: PluginProjectedActionV2['dangerLevel'];
}> = {}): PluginUiProjectionModel {
    const dangerLevel = input.dangerLevel ?? 'safe';
    const daemonAction: PluginProjectedActionV2 = {
        id: ACTION_ID.localId,
        pluginId: ACTION_ID.pluginId,
        occurrenceId: 'acme-triage-occurrence-27',
        title: 'File ticket',
        scopes: ['global'],
        surfaces: ['voice'],
        execution: { target: 'daemon' },
        dangerLevel,
        ...(dangerLevel === 'safe'
            ? {}
            : { confirmation: { title: 'Confirm ticket creation' } }),
        available: true,
    };
    const action: PluginUiActionProjection = Object.freeze({
        ...daemonAction,
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: ACTION_ORIGIN,
    });
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: ACTION_ORIGIN.generation,
        actionsById: Object.freeze({
            [`${ACTION_ID.pluginId}/${ACTION_ID.localId}`]: action,
        }),
    });
}

function createOpenCommand(): CurrentUiContextResolvedCommand {
    return {
        id: COMMAND_ID,
        command: {
            kind: 'openSurface',
            destination: { pluginId: 'acme.triage', localId: 'issues' },
            input: { issueNumber: 124, privateQuery: 'must-remain-local' },
        },
        retirementSignal: new AbortController().signal,
    };
}

function requireCommandInvoker(port: ReturnType<typeof createCurrentUiContextVoiceToolPort>) {
    if (!port.invokeCurrentUiCommand) throw new Error('missing current UI command invoker');
    return port.invokeCurrentUiCommand;
}

function requireActionInvoker(port: ReturnType<typeof createCurrentUiContextVoiceToolPort>) {
    if (!port.invokeAction) throw new Error('missing current UI action invoker');
    return port.invokeAction;
}

describe('current UI context Voice tool port', () => {
    it('keeps a known reverse client Action result when its own navigation changes the viewed Session', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const { getStorage } = await import('@/sync/domains/state/storage');
        const { invalidateAccountEncryptionModeCache } = await import('@/sync/api/account/apiAccountEncryptionMode');
        const initialState = getStorage().getState();
        const serverId = (await upsertAndActivateServer({ serverUrl: 'https://reverse-action.test', name: 'Reverse Action Home' })).id;
        getStorage().getState().activateProfileScope({ serverId, accountId: 'reverse-account' });
        const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('reverse-account') });
        setRuntimeFetch(async (url) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/auth/ping') return Response.json({ ok: true });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            throw new Error(`Unexpected reverse Action request: ${path}`);
        });
        let viewedSessionId = 'unrelated-viewed-session';
        const listeners = new Set<() => void>();
        const fixture = createCurrentUiClientActionFixture({
            serverId, scopes: ['session'], surfaces: ['agent'],
            handler: async (_input, context) => {
                await context.ui.openSurface('result');
                return { navigated: true };
            },
        });
        const unregister = registerCurrentUiContextActionPort((invocationSurface, hostAction) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction,
            reader: {
                readCurrentSessionId: () => viewedSessionId,
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: () => null,
                subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            },
            readProjection: () => fixture.projection,
            readNavigationBinding: () => ({ targetKind: 'app', registerOwner: () => () => {}, openSurface: async () => {
                viewedSessionId = 'created-session';
                for (const listener of listeners) listener();
                return { ok: true };
            } }),
        }));
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const handler = createCurrentUiContributedActionRpcHandler({
                machineId: CLIENT_ACTION_HOST_ORIGIN.machineId, serverId,
                readProjection: () => fixture.projection, isCurrent: () => true,
                execute: createDefaultActionExecutor().execute,
            });
            expect(await handler({ v: 1, action: CLIENT_ACTION_ID, input: null, surface: 'agent',
                expectedContributorOccurrenceId: fixture.action.occurrenceId, defaultSessionId: 'invoking-session' }))
                .toEqual({ ok: true, result: { navigated: true } });
            expect(viewedSessionId).toBe('created-session');
        } finally {
            unregister(); await fixture.composition.unload(); credentials.mockRestore(); resetRuntimeFetch();
            getStorage().setState(initialState, true); invalidateAccountEncryptionModeCache();
        }
    });

    it('routes generic action.invoke through the answering default UI executor', async () => {
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.show).mockClear();
        const fixture = createCurrentUiClientActionFixture({
            surfaces: ['agent', 'mcp', 'cli'],
            handler: async (_input, context) => ({ surface: context.invocationSurface }),
        });
        await fixture.composition.unload();
        const unregister = registerCurrentUiContextActionPort((invocationSurface, hostAction) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction,
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
            readProjection: () => fixture.projection, readNavigationBinding: () => null,
        }));
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            for (const surface of ['agent', 'mcp', 'cli'] as const) {
                expect(await createDefaultActionExecutor().execute('action.invoke', { action: CLIENT_ACTION_ID, input: null }, {
                    surface, expectedContributedActionOccurrenceId: fixture.action.occurrenceId,
                })).toEqual({ ok: true, result: { surface } });
            }
            expect(Modal.show).not.toHaveBeenCalled();
        } finally { unregister(); await fixture.composition.unload(); }
    });

    it('rejects a reverse client Action for a replaced contributor occurrence before its handler runs', async () => {
        const handler = vi.fn(async () => ({ entered: true }));
        const fixture = createCurrentUiClientActionFixture({ handler, surfaces: ['agent', 'mcp', 'cli'] });
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const port = createCurrentUiContextVoiceToolPort({
                invocationSurface: 'agent',
                reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
                readProjection: () => fixture.projection, readNavigationBinding: () => null,
            });
            expect(await requireActionInvoker(port)({ action: CLIENT_ACTION_ID, expectedContributorOccurrenceId: 'retired-occurrence' }))
                .toMatchObject({ ok: false, code: 'stale_surface', actionHandlerInvocation: 'notStarted' });
            expect(handler).not.toHaveBeenCalled();
        } finally { await fixture.composition.unload(); }
    });

    it('enforces the safe-only guard at generic default execution before a client handler can start', async () => {
        const handler = vi.fn(async () => ({ mutated: true }));
        const fixture = createCurrentUiClientActionFixture({ handler, surfaces: ['agent'], dangerLevel: 'writesRemote' });
        await fixture.composition.unload();
        const unregister = registerCurrentUiContextActionPort((invocationSurface, hostAction) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction,
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
            readProjection: () => fixture.projection, readNavigationBinding: () => null,
        }));
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            expect(await createDefaultActionExecutor().execute('action.invoke', { action: CLIENT_ACTION_ID, input: null }, {
                surface: 'agent', expectedContributedActionOccurrenceId: fixture.action.occurrenceId,
                requiredContributedActionDangerLevel: 'safe',
            })).toEqual({ ok: false, errorCode: 'plugin_action_read_requires_safe', error: 'plugin_action_read_requires_safe',
                details: { actionHandlerInvocation: 'notStarted' } });
            expect(handler).not.toHaveBeenCalled();
            unregister();
            expect(await createDefaultActionExecutor().execute('action.invoke', { action: CLIENT_ACTION_ID, input: null }, {
                surface: 'agent',
            })).toMatchObject({ ok: false, details: { actionHandlerInvocation: 'notStarted' } });
        } finally { unregister(); await fixture.composition.unload(); }
    });

    it('binds nested builtin Actions to the canonical executor for each automated client origin', async () => {
        // Only the external project inventory is reached; all executor policy remains real.
        const executor = createActionExecutor({ projectsList: async () => ({ projects: [{ id: 'project-ui', name: 'Current project' }] }) } as unknown as ActionExecutorDeps);
        const fixture = createCurrentUiClientActionFixture({
            surfaces: ['agent', 'mcp', 'cli'],
            handler: async (_input, context) => ({ surface: context.invocationSurface, projects: await context.ui.executeAction('projects.list', {}) }),
        });
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            for (const invocationSurface of ['agent', 'mcp', 'cli'] as const) {
                const port = createCurrentUiContextVoiceToolPort({
                    invocationSurface, hostAction: { execute: executor.execute },
                    reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
                    readProjection: () => fixture.projection, readNavigationBinding: () => null,
                });
                expect(await requireActionInvoker(port)({ action: CLIENT_ACTION_ID, expectedContributorOccurrenceId: fixture.action.occurrenceId }))
                    .toEqual({ ok: true, result: { surface: invocationSurface, projects: { projects: [{ id: 'project-ui', name: 'Current project' }] } } });
            }
        } finally { await fixture.composition.unload(); }
    });

    it('fails closed across every port capability after its admitting lifetime retires while preserving a known in-flight settlement', async () => {
        const admission = new AbortController();
        const snapshot: CurrentUiContextSnapshotV1 = {
            navigation: { area: 'settings', screen: 'settings_page' },
            commands: [],
        };
        const sourceListener = { current: null as (() => void) | null };
        const unsubscribe = vi.fn();
        let settleKnownInvocation!: (outcome: CurrentUiContextVoiceInvocationOutcome) => void;
        const invokeCurrentUiCommand = vi.fn<(input: CurrentUiContextVoiceCommandInvocationInput) => Promise<CurrentUiContextVoiceInvocationOutcome>>(() => (
            new Promise<CurrentUiContextVoiceInvocationOutcome>((resolve) => {
                settleKnownInvocation = resolve;
            })
        ));
        const invokeAction = vi.fn(async (): Promise<CurrentUiContextVoiceInvocationOutcome> => ({ ok: true }));
        const listCurrentContributedActionDefinitions = vi.fn(() => []);
        const source: CurrentUiContextVoiceToolPort = {
            readCurrentUiContext: vi.fn(() => snapshot),
            resolveCurrentUiCommand: vi.fn(() => null),
            subscribe: vi.fn((listener) => {
                sourceListener.current = listener;
                return unsubscribe;
            }),
            listCurrentContributedActionDefinitions,
            invokeCurrentUiCommand,
            invokeAction,
        };
        const port = bindCurrentUiContextVoiceToolPortToAdmission(source, admission.signal);
        const listener = vi.fn();
        const release = port.subscribe(listener);
        if (!port.invokeCurrentUiCommand || !port.invokeAction || !port.listCurrentContributedActionDefinitions) {
            throw new Error('expected bound current UI capability surface');
        }

        expect(port.readCurrentUiContext()).toBe(snapshot);
        expect(port.resolveCurrentUiCommand('current-ui-command:admission')).toBeNull();
        expect(port.listCurrentContributedActionDefinitions()).toEqual([]);
        sourceListener.current?.();
        expect(listener).toHaveBeenCalledTimes(1);

        const pendingKnownInvocation = port.invokeCurrentUiCommand({ commandId: 'current-ui-command:admission' });
        const forwardedSignal = invokeCurrentUiCommand.mock.calls[0]?.[0]?.signal;
        expect(forwardedSignal?.aborted).toBe(false);
        admission.abort(new Error('the admitting Account retired'));
        expect(forwardedSignal?.aborted).toBe(true);
        settleKnownInvocation({ ok: true, result: { committed: true } });
        await expect(pendingKnownInvocation).resolves.toEqual({ ok: true, result: { committed: true } });

        expect(port.readCurrentUiContext()).toBeNull();
        expect(port.resolveCurrentUiCommand('current-ui-command:admission')).toBeNull();
        expect(port.listCurrentContributedActionDefinitions()).toEqual([]);
        sourceListener.current?.();
        release();
        expect(listener).toHaveBeenCalledTimes(1);
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(source.readCurrentUiContext).toHaveBeenCalledTimes(1);
        expect(source.resolveCurrentUiCommand).toHaveBeenCalledTimes(1);
        expect(listCurrentContributedActionDefinitions).toHaveBeenCalledTimes(1);
        await expect(port.invokeCurrentUiCommand({ commandId: 'current-ui-command:retired' })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
        });
        await expect(port.invokeAction({ action: ACTION_ID })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
        });
        expect(invokeCurrentUiCommand).toHaveBeenCalledTimes(1);
        expect(invokeAction).not.toHaveBeenCalled();
    });

    it('derives exact Voice Action definitions from the latest current AppShell projection', async () => {
        let projection = createDaemonActionProjection();
        const current = projection.actionsById[`${ACTION_ID.pluginId}/${ACTION_ID.localId}`]!;
        const inputSchema = {
            type: 'object',
            properties: {
                priority: { type: 'string', enum: ['normal', 'urgent'] },
            },
            required: ['priority'],
            additionalProperties: false,
        } as const;
        const outputSchema = {
            type: 'object',
            properties: { issueId: { type: 'string' } },
            required: ['issueId'],
            additionalProperties: false,
        } as const;
        actionSchemasByQualifiedId.set(`${ACTION_ID.pluginId}/${ACTION_ID.localId}`, { inputSchema, outputSchema });
        const voiceAction: PluginUiActionProjection = {
            ...current,
            description: 'Creates an issue in the current project.',
            inputHints: {
                title: 'File ticket',
                fields: [{
                    path: 'priority',
                    title: 'Priority',
                    widget: 'select',
                    options: [
                        { value: 'normal', label: 'Normal' },
                        { value: 'urgent', label: 'Urgent' },
                    ],
                }],
            },
        };
        const actionsById: Record<string, PluginUiActionProjection> = {
            ...projection.actionsById,
            [`${ACTION_ID.pluginId}/${ACTION_ID.localId}`]: voiceAction,
            'acme.triage/hidden': {
                ...current,
                id: 'hidden',
                available: false,
            },
            'acme.triage/ui-only': {
                ...current,
                id: 'ui-only',
                surfaces: ['ui'],
            },
            'acme.triage/stale': {
                ...current,
                id: 'stale',
                [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: Object.freeze({
                    ...ACTION_ORIGIN,
                    phase: 'retainedOffline',
                }),
            },
        };
        projection = Object.freeze({
            ...projection,
            actionsById: Object.freeze(actionsById),
        });
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: () => null,
                subscribe: () => () => undefined,
            },
            readProjection: () => projection,
            readNavigationBinding: () => null,
        });

        expect(port.listCurrentContributedActionDefinitions?.()).toEqual([{
            id: ACTION_DISCOVERY_ID,
            title: 'File ticket',
            description: 'Creates an issue in the current project.',
            safety: 'safe',
            approval: { result: 'none' },
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces: {
                ui: false,
                voice: true,
                agent: false,
                mcp: false,
                cli: false,
                rpc: false,
                api: false,
                plugin: false,
            },
            inputHints: {
                title: 'File ticket',
                fields: [{
                    path: 'priority',
                    title: 'Priority',
                    widget: 'select',
                    options: [
                        { value: 'normal', label: 'Normal' },
                        { value: 'urgent', label: 'Urgent' },
                    ],
                }],
            },
        }]);
        // Schemas are not listed; they are read per Action from its machine.
        await expect(port.readCurrentContributedActionSchemas?.(ACTION_DISCOVERY_ID)).resolves.toEqual({
            inputSchema,
            outputSchema,
        });
        await expect(port.readCurrentContributedActionSchemas?.(
            formatQualifiedPluginActionId({ pluginId: ACTION_ID.pluginId, localId: 'ui-only' }),
        )).resolves.toBeNull();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: ACTION_ORIGIN.machineId,
            serverId: ACTION_ORIGIN.serverId,
            method: RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ,
            payload: expect.objectContaining({
                qualifiedActionId: `${ACTION_ID.pluginId}/${ACTION_ID.localId}`,
                expectedOccurrenceId: current.occurrenceId,
            }),
        }));
    });

    it('resolves the same localized Action title and input hints that UI presentation consumes', () => {
        setPreferredLanguageFromSettings('es');
        try {
            const projection = createDaemonActionProjection();
            const current = projection.actionsById[`${ACTION_ID.pluginId}/${ACTION_ID.localId}`]!;
            const localizedAction: PluginUiActionProjection = {
                ...current,
                title: { key: 'actions.fileTicket.title', fallback: 'File ticket' },
                description: {
                    key: 'actions.fileTicket.description',
                    fallback: 'Creates an issue in the current project.',
                },
                inputHints: {
                    title: { key: 'actions.fileTicket.form.title', fallback: 'File ticket' },
                    submitLabel: { key: 'actions.fileTicket.form.submit', fallback: 'Create ticket' },
                    fields: [{
                        path: 'priority',
                        title: { key: 'actions.fileTicket.form.priority', fallback: 'Priority' },
                        widget: 'select',
                        options: [{
                            value: 'normal',
                            label: { key: 'actions.fileTicket.form.priority.normal', fallback: 'Normal' },
                        }],
                    }],
                },
            };
            const localizedProjection: PluginUiProjectionModel = Object.freeze({
                ...projection,
                translationsByPluginId: Object.freeze({
                    [ACTION_ID.pluginId]: Object.freeze({
                        id: `translations:${ACTION_ID.pluginId}`,
                        pluginId: ACTION_ID.pluginId,
                        contributionKind: 'translations' as const,
                        locales: ['en', 'es'],
                        bundles: Object.freeze({
                            en: Object.freeze({}),
                            es: Object.freeze({
                                'actions.fileTicket.title': 'Crear ticket',
                                'actions.fileTicket.description': 'Crea un ticket en el proyecto actual.',
                                'actions.fileTicket.form.title': 'Crear ticket',
                                'actions.fileTicket.form.submit': 'Crear ticket',
                                'actions.fileTicket.form.priority': 'Prioridad',
                                'actions.fileTicket.form.priority.normal': 'Normal',
                            }),
                        }),
                    }),
                }),
                actionsById: Object.freeze({
                    [`${ACTION_ID.pluginId}/${ACTION_ID.localId}`]: localizedAction,
                }),
            });
            const port = createCurrentUiContextVoiceToolPort({
                reader: {
                    readCurrentUiContext: () => null,
                    resolveCurrentUiCommand: () => null,
                    subscribe: () => () => undefined,
                },
                readProjection: () => localizedProjection,
                readNavigationBinding: () => null,
            });

            expect(port.listCurrentContributedActionDefinitions?.()).toEqual([
                expect.objectContaining({
                    title: 'Crear ticket',
                    description: 'Crea un ticket en el proyecto actual.',
                    inputHints: {
                        title: 'Crear ticket',
                        submitLabel: 'Crear ticket',
                        fields: [{
                            path: 'priority',
                            title: 'Prioridad',
                            widget: 'select',
                            options: [{ value: 'normal', label: 'Normal' }],
                        }],
                    },
                }),
            ]);

            setPreferredLanguageFromSettings('ja');
            expect(port.listCurrentContributedActionDefinitions?.()).toEqual([
                expect.objectContaining({
                    title: 'File ticket',
                    description: 'Creates an issue in the current project.',
                    inputHints: {
                        title: 'File ticket',
                        submitLabel: 'Create ticket',
                        fields: [{
                            path: 'priority',
                            title: 'Priority',
                            widget: 'select',
                            options: [{ value: 'normal', label: 'Normal' }],
                        }],
                    },
                }),
            ]);
        } finally {
            setPreferredLanguageFromSettings(null);
        }
    });

    it('does not advertise a client Voice Action before its exact client registration commits', () => {
        const projection = createDaemonActionProjection();
        const current = projection.actionsById[`${ACTION_ID.pluginId}/${ACTION_ID.localId}`]!;
        const clientAction: PluginUiActionProjection = {
            ...current,
            id: 'client-only',
            surfaces: ['voice'],
            execution: {
                target: 'client',
                client: {
                    artifactId: 'client-runtime',
                    exportName: 'activate',
                },
                platforms: ['web'],
            },
        };
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: () => null,
                subscribe: () => () => undefined,
            },
            readProjection: () => Object.freeze({
                ...projection,
                actionsById: Object.freeze({
                    [`${ACTION_ID.pluginId}/${clientAction.id}`]: clientAction,
                }),
            }),
            readNavigationBinding: () => null,
        });

        expect(port.listCurrentContributedActionDefinitions?.()).toEqual([]);
    });

    it('activates and dispatches the public-authoring review Action through the generic executable projection on web, iOS, and Android', async () => {
        const composition = getInstalledPluginUiClientExecutableComposition();
        await composition.unload();
        try {
            for (const platform of ['web', 'ios', 'android'] as const) {
                clientExecutablePlatformState.platform = platform;
                const fixture = createPublicAuthoringClientActionFixture({
                    localId: 'open-review-status',
                    platform,
                });
                if (!fixture.activation) {
                    throw new Error(`public_authoring_client_action_activation_missing:${platform}`);
                }
                const openSurface = vi.fn(async () => ({ ok: true as const }));
                try {
                    expect(fixture.resolved).toHaveLength(1);
                    await fixture.composition.reconcile([fixture.activation]);

                    const outcome = await dispatchPluginSurfaceAction({
                        action: { pluginId: fixture.action.pluginId, localId: fixture.action.id },
                        resolveContributedAction: (identity) => (
                            identity.pluginId === fixture.action.pluginId
                                && identity.localId === fixture.action.id
                                ? fixture.action
                                : null
                        ),
                        invocationSurface: 'voice',
                        clientAction: {
                            openSurface,
                        },
                        isCurrent: () => true,
                    });

                    expect(outcome).toEqual({ ok: true, result: null });
                    expect(openSurface).toHaveBeenCalledWith({
                        destination: {
                            pluginId: publicAuthoringManifest.id,
                            localId: 'review-session-status-details',
                        },
                    });
                } finally {
                    await fixture.composition.unload();
                }
            }
        } finally {
            clientExecutablePlatformState.platform = 'web';
            await composition.unload();
        }
    });

    it.each(['ios', 'android'] as const)(
        'keeps the public-authoring web-only fixture unavailable through the canonical dispatcher on %s',
        async (platform) => {
            const composition = getInstalledPluginUiClientExecutableComposition();
            await composition.unload();
            clientExecutablePlatformState.platform = platform;
            const fixture = createPublicAuthoringClientActionFixture({
                localId: 'open-review-status-web-only-fixture',
                platform,
            });
            try {
                expect(fixture.resolved).toEqual([]);
                await expect(dispatchPluginSurfaceAction({
                    action: { pluginId: fixture.action.pluginId, localId: fixture.action.id },
                    resolveContributedAction: (identity) => (
                        identity.pluginId === fixture.action.pluginId
                            && identity.localId === fixture.action.id
                            ? fixture.action
                            : null
                    ),
                    invocationSurface: 'voice',
                    clientAction: {
                    },
                    isCurrent: () => true,
                })).resolves.toEqual({
                    ok: false,
                    code: 'unavailable',
                    reason: 'plugin_surface_client_action_unavailable',
                });
            } finally {
                clientExecutablePlatformState.platform = 'web';
                await composition.unload();
            }
        },
    );

    it('delegates the exact opaque open-surface command through the incumbent navigation binding without returning its semantic payload', async () => {
        let current: CurrentUiContextResolvedCommand | null = createOpenCommand();
        const openSurface = vi.fn(async () => ({ ok: true as const }));
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => ({
                    navigation: { area: 'plugin', screen: 'triage' },
                    commands: [{ id: COMMAND_ID, title: 'Open issue #124' }],
                }),
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => null,
            readNavigationBinding: () => ({ targetKind: 'app' as const, openSurface, registerOwner: () => () => {} }),
        });

        const outcome = await requireCommandInvoker(port)({ commandId: COMMAND_ID });

        expect(openSurface).toHaveBeenCalledWith({
            destination: { pluginId: 'acme.triage', localId: 'issues' },
            input: { issueNumber: 124, privateQuery: 'must-remain-local' },
        });
        expect(outcome).toEqual({ ok: true });
        expect(JSON.stringify(outcome)).not.toContain('privateQuery');
        expect(JSON.stringify(outcome)).not.toContain(COMMAND_ID);
    });

    it('re-resolves an opaque command at the effect boundary and never opens a command retired before navigation starts', async () => {
        let current: CurrentUiContextResolvedCommand | null = createOpenCommand();
        const openSurface = vi.fn(async () => ({ ok: true as const }));
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => null,
            readNavigationBinding: () => {
                current = null;
                return { targetKind: 'app' as const, openSurface, registerOwner: () => () => {} };
            },
        });

        await expect(requireCommandInvoker(port)({ commandId: COMMAND_ID })).resolves.toEqual({
            ok: false,
            code: 'stale_surface',
        });
        expect(openSurface).not.toHaveBeenCalled();
    });

    it('preserves a known navigation success when the publishing mount retires while navigation settles', async () => {
        let current: CurrentUiContextResolvedCommand | null = createOpenCommand();
        const openSurface = vi.fn(async () => {
            current = null;
            return { ok: true as const };
        });
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => null,
            readNavigationBinding: () => ({ targetKind: 'app' as const, openSurface, registerOwner: () => () => {} }),
        });

        await expect(requireCommandInvoker(port)({ commandId: COMMAND_ID })).resolves.toEqual({ ok: true });
        expect(openSurface).toHaveBeenCalledTimes(1);
    });

    it('dispatches an opaque client command as Agent/MCP rather than borrowing Voice admission', async () => {
        const fixture = createCurrentUiClientActionFixture({
            surfaces: ['agent', 'mcp'],
            handler: async (_input, context) => ({ surface: context.invocationSurface }),
        });
        const current: CurrentUiContextResolvedCommand = {
            id: COMMAND_ID, retirementSignal: new AbortController().signal,
            command: { kind: 'executeAction', action: CLIENT_ACTION_ID },
        };
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            for (const invocationSurface of ['agent', 'mcp'] as const) {
                const port = createCurrentUiContextVoiceToolPort({
                    invocationSurface,
                    reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => current, subscribe: () => () => {} },
                    readProjection: () => fixture.projection, readNavigationBinding: () => null,
                });
                expect(await requireCommandInvoker(port)({ commandId: COMMAND_ID })).toEqual({ ok: true, result: { surface: invocationSurface } });
                const unregister = registerCurrentUiContextActionPort((surface) => surface === invocationSurface ? port : null);
                try {
                    expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: { commandId: COMMAND_ID }, context: { surface: invocationSurface } }))
                        .toEqual({ ok: true, result: { surface: invocationSurface } });
                } finally { unregister(); }
                expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: { commandId: COMMAND_ID }, context: { surface: invocationSurface } }))
                    .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
            }
        } finally {
            await fixture.composition.unload();
        }
    });

    it('preserves a known client-Action navigation failure when its exact Action retires while navigation settles', async () => {
        type NavigationDeniedOutcome = Readonly<{
            ok: false;
            code: 'denied';
            reason: 'denied';
        }>;
        let settleNavigation!: (outcome: NavigationDeniedOutcome) => void;
        let navigationStarted!: () => void;
        const navigationStartedPromise = new Promise<void>((resolve) => { navigationStarted = resolve; });
        const openSurface = vi.fn(() => new Promise<NavigationDeniedOutcome>((resolve) => {
            settleNavigation = resolve;
            navigationStarted();
        }));
        const handler: PluginClientActionHandler = vi.fn(async (_input, context) => {
            try {
                await context.ui.openSurface('issue-details');
            } catch (error) {
                return { navigationFailure: isPluginError(error) ? error.code : 'unexpected' };
            }
            return { navigationFailure: 'unexpected_success' };
        });
        const fixture = createCurrentUiClientActionFixture({ handler });
        let currentProjection: PluginUiProjectionModel | null = fixture.projection;
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: () => null,
                subscribe: () => () => {},
            },
            readProjection: () => currentProjection,
            readNavigationBinding: () => ({ targetKind: 'app' as const, openSurface, registerOwner: () => () => {} }),
        });

        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const pending = requireActionInvoker(port)({ action: CLIENT_ACTION_ID });
            await navigationStartedPromise;
            currentProjection = null;
            settleNavigation({ ok: false, code: 'denied', reason: 'denied' });

            await expect(pending).resolves.toEqual({
                ok: true,
                result: { navigationFailure: 'denied' },
            });
            expect(handler).toHaveBeenCalledTimes(1);
        } finally {
            await fixture.composition.unload();
        }
    });

    it('preserves a known opaque-command navigation failure when its exact command retires while navigation settles', async () => {
        type NavigationDeniedOutcome = Readonly<{
            ok: false;
            code: 'denied';
            reason: 'denied';
        }>;
        let current: CurrentUiContextResolvedCommand | null = createOpenCommand();
        let settleNavigation!: (outcome: NavigationDeniedOutcome) => void;
        let navigationStarted!: () => void;
        const navigationStartedPromise = new Promise<void>((resolve) => { navigationStarted = resolve; });
        const openSurface = vi.fn(() => new Promise<NavigationDeniedOutcome>((resolve) => {
            settleNavigation = resolve;
            navigationStarted();
        }));
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => null,
            readNavigationBinding: () => ({ targetKind: 'app' as const, openSurface, registerOwner: () => () => {} }),
        });

        const pending = requireCommandInvoker(port)({ commandId: COMMAND_ID });
        await navigationStartedPromise;
        current = null;
        settleNavigation({ ok: false, code: 'denied', reason: 'denied' });

        await expect(pending).resolves.toEqual({ ok: false, code: 'denied' });
        expect(openSurface).toHaveBeenCalledTimes(1);
    });

    it('returns only a typed navigation failure and never starts an effect after cancellation', async () => {
        const current = createOpenCommand();
        const openSurface = vi.fn(async () => ({
            ok: false as const,
            code: 'denied' as const,
            reason: 'private navigation policy detail',
        }));
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => null,
            readNavigationBinding: () => ({ targetKind: 'app' as const, openSurface, registerOwner: () => () => {} }),
        });

        const failure = await requireCommandInvoker(port)({ commandId: COMMAND_ID });
        expect(failure).toEqual({ ok: false, code: 'denied' });
        expect(JSON.stringify(failure)).not.toContain('private navigation policy detail');

        const aborted = new AbortController();
        aborted.abort();
        await expect(requireCommandInvoker(port)({
            commandId: COMMAND_ID,
            signal: aborted.signal,
        })).resolves.toEqual({ ok: false, code: 'unavailable' });
        expect(openSurface).toHaveBeenCalledTimes(1);
    });

    it('delegates a generic Voice Action through the canonical dispatcher with its exact origin and returns only its bounded settlement', async () => {
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockResolvedValue({
            ok: true,
            result: { ticketId: 'T-124' },
        });
        const projection = createDaemonActionProjection();
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                readCurrentSessionId: () => 'host-daemon-session',
                resolveCurrentUiCommand: () => null,
                subscribe: () => () => {},
            },
            readProjection: () => projection,
            readNavigationBinding: () => null,
        });

        const outcome = await requireActionInvoker(port)({
            action: ACTION_ID,
            input: { title: 'private ticket title' },
        });

        expect(outcome).toEqual({ ok: true, result: { ticketId: 'T-124' } });
        expect(JSON.stringify(outcome)).not.toContain('private ticket title');
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-actions',
            serverId: 'server-actions',
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            payload: expect.objectContaining({
                expectedContributorOccurrenceId: 'acme-triage-occurrence-27',
                qualifiedActionId: 'acme.triage/file-ticket',
                input: { title: 'private ticket title' },
                executionSurface: 'voice',
                sessionId: 'host-daemon-session',
            }),
        }));
    });

    it('projects an issued daemon Action acknowledgement loss to the retained Voice outcome_unknown settlement', async () => {
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockImplementation(async (input: Readonly<{ onIssued?: () => void }>) => {
            input.onIssued?.();
            throw new Error('active Action socket acknowledgement timed out after emission');
        });
        const projection = createDaemonActionProjection();
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: () => null,
                subscribe: () => () => {},
            },
            readProjection: () => projection,
            readNavigationBinding: () => null,
        });

        await expect(requireActionInvoker(port)({
            action: ACTION_ID,
            input: { title: 'private ticket title' },
        })).resolves.toEqual({ ok: false, code: 'outcome_unknown' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            onIssued: expect.any(Function),
        }));
    });

    it('retains a post-handler daemon retirement as outcome_unknown', async () => {
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockResolvedValue({
            ok: false,
            code: 'plugin_action_outcome_unknown',
        });
        const projection = createDaemonActionProjection();
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: () => null,
                subscribe: () => () => {},
            },
            readProjection: () => projection,
            readNavigationBinding: () => null,
        });

        await expect(requireActionInvoker(port)({
            action: ACTION_ID,
            input: { title: 'private ticket title' },
        })).resolves.toEqual({ ok: false, code: 'outcome_unknown' });
    });

    it('delegates an opaque execute-Action command through that same dispatcher and preserves a known success after its publication retires', async () => {
        let current: CurrentUiContextResolvedCommand | null = {
            id: COMMAND_ID,
            command: {
                kind: 'executeAction',
                action: ACTION_ID,
                input: { localSemanticInput: 'must-not-reach-provider-result' },
            },
            retirementSignal: new AbortController().signal,
        };
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockImplementation(async () => {
            current = null;
            return { ok: true, result: { ticketId: 'T-125' } };
        });
        const projection = createDaemonActionProjection();
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => projection,
            readNavigationBinding: () => null,
        });

        const outcome = await requireCommandInvoker(port)({ commandId: COMMAND_ID });

        expect(outcome).toEqual({ ok: true, result: { ticketId: 'T-125' } });
        expect(JSON.stringify(outcome)).not.toContain('localSemanticInput');
        expect(JSON.stringify(outcome)).not.toContain(COMMAND_ID);
    });

    it('keeps a known daemon Action failure after its current command retires', async () => {
        let current: CurrentUiContextResolvedCommand | null = {
            id: COMMAND_ID,
            command: {
                kind: 'executeAction',
                action: ACTION_ID,
            },
            retirementSignal: new AbortController().signal,
        };
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockImplementation(async () => {
            current = null;
            return { ok: false, errorCode: 'plugin_action_unavailable', error: 'target reported a known failure' };
        });
        const projection = createDaemonActionProjection();
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => projection,
            readNavigationBinding: () => null,
        });

        await expect(requireCommandInvoker(port)({ commandId: COMMAND_ID })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
        });
    });

    it('forwards exact command retirement to a pending non-safe daemon Action', async () => {
        const retirement = new AbortController();
        let current: CurrentUiContextResolvedCommand | null = {
            id: COMMAND_ID,
            command: {
                kind: 'executeAction',
                action: ACTION_ID,
                input: { localSemanticInput: 'must-not-reach-provider-result' },
            },
            retirementSignal: retirement.signal,
        };
        let rpcStarted!: () => void;
        const rpcStartedPromise = new Promise<void>((resolve) => { rpcStarted = resolve; });
        let resolveRpc = (_result: Readonly<{ ok: false; code: string }>): void => {
            throw new Error('daemon Action RPC did not start');
        };
        let observedSignal: AbortSignal | undefined;
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockImplementation((input: Readonly<{ signal?: AbortSignal }>) => (
            new Promise<Readonly<{ ok: false; code: string }>>((resolve) => {
                observedSignal = input.signal;
                resolveRpc = resolve;
                rpcStarted();
            })
        ));
        const projection = createDaemonActionProjection({ dangerLevel: 'writesRemote' });
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => projection,
            readNavigationBinding: () => null,
        });

        const pending = requireCommandInvoker(port)({ commandId: COMMAND_ID });
        await rpcStartedPromise;
        current = null;
        retirement.abort(new Error('the exact command retired while confirmation was pending'));
        try {
            expect(observedSignal?.aborted).toBe(true);
        } finally {
            resolveRpc({ ok: false, code: 'plugin_action_aborted' });
        }
        await expect(pending).resolves.toEqual({ ok: false, code: 'unavailable' });
    });

    it.each(['action', 'command'] as const)('admits a Session-scoped client %s using only the host current Session binding', async (entryPoint) => {
        const fixture = createCurrentUiClientActionFixture({
            scopes: ['session'],
            handler: async () => ({ admitted: true }),
        });
        const current: CurrentUiContextResolvedCommand = {
            id: COMMAND_ID,
            command: { kind: 'executeAction', action: CLIENT_ACTION_ID },
            retirementSignal: new AbortController().signal,
        };
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                readCurrentSessionId: () => 'host-current-session',
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => fixture.projection,
            readNavigationBinding: () => null,
        });
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            await expect(entryPoint === 'action'
                ? requireActionInvoker(port)({ action: CLIENT_ACTION_ID })
                : requireCommandInvoker(port)({ commandId: COMMAND_ID })
            ).resolves.toEqual({ ok: true, result: { admitted: true } });
        } finally {
            await fixture.composition.unload();
        }
    });

    it('does not take Session authority from Action input when the host has no current Session', async () => {
        const handler = vi.fn(async () => ({ admitted: true }));
        const fixture = createCurrentUiClientActionFixture({ scopes: ['session'], handler });
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                readCurrentSessionId: () => null,
                resolveCurrentUiCommand: () => null,
                subscribe: () => () => {},
            },
            readProjection: () => fixture.projection,
            readNavigationBinding: () => null,
        });
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            await expect(requireActionInvoker(port)({
                action: CLIENT_ACTION_ID,
                input: { sessionId: 'caller-chosen-session' },
            })).resolves.toEqual({ ok: false, code: 'unavailable' });
            expect(handler).not.toHaveBeenCalled();
        } finally {
            await fixture.composition.unload();
        }
    });

    it('retires a pending Session Action when the host moves away and back before navigation', async () => {
        let sessionId = 'host-session-a';
        const listeners = new Set<() => void>();
        let entered!: () => void;
        const handlerEntered = new Promise<void>((resolve) => { entered = resolve; });
        let resume!: () => void;
        const providerReply = new Promise<void>((resolve) => { resume = resolve; });
        let observedSignal: AbortSignal | undefined;
        const navigation = vi.fn(async () => ({ ok: true as const }));
        const fixture = createCurrentUiClientActionFixture({
            scopes: ['session'],
            handler: async (_input, context) => {
                observedSignal = context.signal;
                entered();
                await providerReply;
                await context.ui.openSurface('review-status');
                return { opened: true };
            },
        });
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                readCurrentSessionId: () => sessionId,
                resolveCurrentUiCommand: () => null,
                subscribe: (listener) => {
                    listeners.add(listener);
                    return () => { listeners.delete(listener); };
                },
            },
            readProjection: () => fixture.projection,
            readNavigationBinding: () => ({ targetKind: 'app', openSurface: navigation, registerOwner: () => () => {} }),
        });
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const pending = requireActionInvoker(port)({ action: CLIENT_ACTION_ID });
            await handlerEntered;
            sessionId = 'host-session-b';
            for (const listener of listeners) listener();
            sessionId = 'host-session-a';
            for (const listener of listeners) listener();
            expect(observedSignal?.aborted).toBe(true);
            resume();
            await expect(pending).resolves.toEqual({ ok: false, code: 'outcome_unknown' });
            expect(navigation).not.toHaveBeenCalled();
            expect(listeners.size).toBe(0);
        } finally {
            resume();
            await fixture.composition.unload();
        }
    });

    it('does not enter a client handler when its exact current command retirement is already signaled', async () => {
        const handler = vi.fn(async () => ({ shouldNotRun: true }));
        const fixture = createCurrentUiClientActionFixture({ handler });
        const retirement = new AbortController();
        const attempt = new AbortController();
        const current: CurrentUiContextResolvedCommand = {
            id: COMMAND_ID,
            command: {
                kind: 'executeAction',
                action: CLIENT_ACTION_ID,
            },
            retirementSignal: retirement.signal,
        };
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => fixture.projection,
            readNavigationBinding: () => null,
        });
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            retirement.abort(new Error('the exact current command retired before the client Action entered'));
            const restoreAbortSignalAny = withoutAbortSignalAny();
            try {
                await expect(requireCommandInvoker(port)({
                    commandId: COMMAND_ID,
                    signal: attempt.signal,
                })).resolves.toEqual({ ok: false, code: 'unavailable' });
            } finally {
                restoreAbortSignalAny();
            }
            expect(handler).not.toHaveBeenCalled();
        } finally {
            await fixture.composition.unload();
        }
    });

    it('projects a retirement after a client handler begins as outcome_unknown', async () => {
        let handlerEntered!: () => void;
        const handlerEnteredPromise = new Promise<void>((resolve) => { handlerEntered = resolve; });
        const handler = vi.fn(() => {
            handlerEntered();
            return new Promise<never>(() => {});
        });
        const fixture = createCurrentUiClientActionFixture({ handler });
        const retirement = new AbortController();
        const attempt = new AbortController();
        const current: CurrentUiContextResolvedCommand = {
            id: COMMAND_ID,
            command: {
                kind: 'executeAction',
                action: CLIENT_ACTION_ID,
            },
            retirementSignal: retirement.signal,
        };
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => fixture.projection,
            readNavigationBinding: () => null,
        });
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const restoreAbortSignalAny = withoutAbortSignalAny();
            try {
                const pending = requireCommandInvoker(port)({
                    commandId: COMMAND_ID,
                    signal: attempt.signal,
                });
                await handlerEnteredPromise;
                retirement.abort(new Error('the exact current command retired after its client Action entered'));
                await expect(pending).resolves.toEqual({ ok: false, code: 'outcome_unknown' });
            } finally {
                restoreAbortSignalAny();
            }
            expect(handler).toHaveBeenCalledTimes(1);
        } finally {
            await fixture.composition.unload();
        }
    });

    it('retains a known client settlement when the exact current command retires afterward', async () => {
        let handlerReturned!: () => void;
        const handlerReturnedPromise = new Promise<void>((resolve) => { handlerReturned = resolve; });
        const handler = vi.fn(() => {
            handlerReturned();
            return { committed: true };
        });
        const fixture = createCurrentUiClientActionFixture({ handler });
        const retirement = new AbortController();
        const attempt = new AbortController();
        const current: CurrentUiContextResolvedCommand = {
            id: COMMAND_ID,
            command: {
                kind: 'executeAction',
                action: CLIENT_ACTION_ID,
            },
            retirementSignal: retirement.signal,
        };
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => fixture.projection,
            readNavigationBinding: () => null,
        });
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const restoreAbortSignalAny = withoutAbortSignalAny();
            try {
                const pending = requireCommandInvoker(port)({
                    commandId: COMMAND_ID,
                    signal: attempt.signal,
                });
                await handlerReturnedPromise;
                retirement.abort(new Error('the exact current command retired after the client Action settled'));
                await expect(pending).resolves.toEqual({ ok: true, result: { committed: true } });
            } finally {
                restoreAbortSignalAny();
            }
            expect(handler).toHaveBeenCalledTimes(1);
        } finally {
            await fixture.composition.unload();
        }
    });
});
