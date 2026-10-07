import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DaemonPluginActionSchemasReadRequestSchema,
    DaemonPluginActionSchemasReadResponseSchema,
    DaemonPluginStructuredMessageActionExecuteRequestSchema,
    DaemonPluginStructuredMessageActionExecuteResponseSchema,
    PluginContributesV2Schema,
    PluginProjectedActionV2Schema,
    type PluginContributionIdentityV1,
    type PluginMachineExecutionOriginV1,
    type PluginProjectedActionV2,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    normalizePluginUiDestinationBindingV1,
} from '@happier-dev/protocol/plugins/ui';

import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import {
    getInstalledPluginUiClientExecutableComposition,
    resolvePluginUiClientActionRegistration,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import { createPluginUiCommonJsLoaderBackend } from '@/components/plugins/reactNative/commonJsLoaderBackend';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { resetMachineProjectionReadsForTests } from '@/sync/ops/machineContributionRegistryProjection';
import { createPluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import type { PluginSurfaceOpenRequest } from '@/components/plugins/surfaces/openPluginSurface';

import {
    createAppShellPluginUiInvocationHost,
} from './pluginUiInvocationHost';
import { PLUGIN_PRESENT_USER_INTERACTION_DEADLINE_MS } from '@/components/plugins/hostApi/interactionLifetime';

// Keep schema reads, dispatch, serialization and outcome classification real;
// only the external daemon RPC transport supplies fixture responses.
const machineRpc = vi.hoisted(() => vi.fn<(
    params: Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc')['machineRpcWithServerScope']>[0],
) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(machineRpc);
});

function answerDaemonAction(response: unknown, onDispatch?: () => void) {
    machineRpc.mockImplementation(async (params) => {
        if (params.method !== RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
            throw new Error(`Unexpected invocation fixture RPC: ${params.method}`);
        }
        DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(params.payload);
        params.onIssued?.();
        onDispatch?.();
        return response;
    });
}

function daemonSuccess(result: Record<string, string>) {
    return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({ ok: true, result });
}

beforeEach(() => {
    resetMachineProjectionReadsForTests();
    machineRpc.mockReset();
    machineRpc.mockImplementation(async (params) => {
        if (params.method !== RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) {
            throw new Error(`Unexpected invocation fixture RPC: ${params.method}`);
        }
        expect(DaemonPluginActionSchemasReadRequestSchema.parse(params.payload)).toEqual({
            machineId: 'machine-1',
            expectedOccurrenceId: 'acme-voice-client-action-occurrence-12',
            qualifiedActionId: `${CLIENT_ACTION_PLUGIN_ID}/${CLIENT_ACTION_LOCAL_ID}`,
        });
        expect(params.serverId).toBe(CLIENT_ACTION_ORIGIN.serverIdentityId);
        return DaemonPluginActionSchemasReadResponseSchema.parse({ ok: true, inputSchema: {} });
    });
});

const DAEMON_ACTION: PluginProjectedActionV2 = {
    id: 'mint-session',
    pluginId: 'acme.voice',
    occurrenceId: 'acme-voice-occurrence-12',
    title: 'Mint session',
    scopes: ['session'],
    // This host is the externally-contributed Voice surface. The dispatcher
    // receives that invoking surface so target policy does not treat it as an
    // interactive UI invocation.
    surfaces: ['voice'],
    execution: { target: 'daemon' },
    placementBindings: ['detailsPanel'],
    priority: 0,
    dangerLevel: 'safe',
    available: true,
};

const CLIENT_ACTION_PLUGIN_ID = 'acme.voice-client-action';
const CLIENT_ACTION_LOCAL_ID = 'open-client-destination';
const CLIENT_ACTION_GENERATION = 12;
const CLIENT_ACTION_TARGET = Object.freeze({
    artifactId: 'voice-client-action-bundle',
    exportName: 'activate',
    platform: 'web' as const,
});
const CLIENT_ACTION_ORIGIN: PluginMachineExecutionOriginV1 = Object.freeze({
    serverIdentityId: 'srv_voice_client_action',
    materializationRef: Object.freeze({
        pluginId: CLIENT_ACTION_PLUGIN_ID,
        machineId: 'machine-1',
        materializationId: 'materialization-client-action',
    }),
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

function createClientActionFixture() {
    const declaration = {
        id: CLIENT_ACTION_LOCAL_ID,
        title: 'Open client destination',
        scopes: ['global'],
        surfaces: ['ui', 'voice'],
        placementBindings: ['detailsPanel'],
        execution: {
            target: 'client' as const,
            client: {
                artifactId: CLIENT_ACTION_TARGET.artifactId,
                exportName: CLIENT_ACTION_TARGET.exportName,
            },
            platforms: [CLIENT_ACTION_TARGET.platform],
        },
        dangerLevel: 'safe' as const,
    };
    const action = PluginProjectedActionV2Schema.parse({
        ...declaration,
        pluginId: CLIENT_ACTION_PLUGIN_ID,
        occurrenceId: 'acme-voice-client-action-occurrence-12',
        serverIdentityId: CLIENT_ACTION_ORIGIN.serverIdentityId,
        materializationRef: CLIENT_ACTION_ORIGIN.materializationRef,
        available: true,
        authorization: CLIENT_ACTION_AUTHORIZATION,
    });
    // The public activate(api) ABI registers the actual executable handler.
    // Re-entering a denied invocation would produce a distinct error, exposing
    // a stale/cancelled caller that reached plugin code.
    const bytes = new TextEncoder().encode(`
        let activations = 0;
        let invocations = 0;
        exports.activate = function (api) {
            activations++;
            api.actions.register('${CLIENT_ACTION_LOCAL_ID}', async function (_input, context) {
                if (++invocations !== 1) throw new Error('unexpected_client_action_reentry');
                await context.ui.openSurface({ pluginId: 'acme.destination', localId: 'issue-details' },
                    { issue: 'UCX-EXTERNAL-VOICE' });
                return { navigated: true, activations, invocations };
            });
        };
    `);
    const identity: PluginReactNativeBundleCacheIdentity = Object.freeze({
        pluginId: CLIENT_ACTION_PLUGIN_ID,
        contributionId: CLIENT_ACTION_LOCAL_ID,
        artifactId: CLIENT_ACTION_TARGET.artifactId,
        artifactDigest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: 'index.cjs', bytes }]),
        platform: CLIENT_ACTION_TARGET.platform,
    });
    const cache = createPluginReactNativeBundleCache();
    expect(cache.putInstalledArtifact({
        identity,
        bytes,
        format: 'plainJs',
        entryRelativePath: 'index.cjs',
        files: [{ relativePath: 'index.cjs', bytes, byteSize: bytes.byteLength, digest: computePluginUiArtifactSha256DigestV1(bytes) }],
    })).toMatchObject({ ok: true });
    return Object.freeze({
        action,
        activation: Object.freeze({
            pluginId: CLIENT_ACTION_PLUGIN_ID,
            occurrenceId: action.occurrenceId,
            hostUiApiRange: '^1.0.0',
            pluginVersion: '1.2.3',
            contributes: PluginContributesV2Schema.parse({ actions: [declaration] }),
            target: CLIENT_ACTION_TARGET,
            executionOrigin: CLIENT_ACTION_ORIGIN,
            cache,
            identity,
            moduleReference: {
                exportName: CLIENT_ACTION_TARGET.exportName,
            },
            backend: createPluginUiCommonJsLoaderBackend(),
            authority: {
                serverId: 'srv_voice_client_action',
                machineId: 'machine-1',
            },
            isCurrent: () => true,
        }),
        composition: getInstalledPluginUiClientExecutableComposition(),
        resolve(identityToResolve: PluginContributionIdentityV1): PluginProjectedActionV2 | null {
            return identityToResolve.pluginId === action.pluginId
                && identityToResolve.localId === action.id
                ? action
                : null;
        },
    });
}

function resolveDaemonAction(identity: Readonly<{ pluginId: string; localId: string }>): PluginProjectedActionV2 | null {
    return identity.pluginId === DAEMON_ACTION.pluginId && identity.localId === DAEMON_ACTION.id
        ? DAEMON_ACTION
        : null;
}

describe('AppShell plugin UI invocation host', () => {
    it('routes a once-registered client Action from Voice through the incumbent navigation binding', async () => {
        const binding = normalizePluginUiDestinationBindingV1({
            pluginId: 'acme.destination', destinationId: 'issue-details',
            rendererId: 'issue-details-renderer', container: 'appPage', target: { kind: 'app' },
        });
        if (!binding) throw new Error('Expected an admitted app destination fixture.');
        const placement = {
            id: 'surfacePlacement:acme.destination:appPage:issue-details',
            pluginId: 'acme.destination', occurrenceId: 'destination-occurrence-12',
            contributionKind: 'surfacePlacement', descriptorId: 'issue-details',
            binding, target: binding.target,
            renderer: { kind: 'reactNative', contributionId: 'issue-details-renderer' },
            display: { developerFallback: 'Issue details' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
            headerActions: [],
            hostOrigin: {
                machineId: 'machine-1', serverId: CLIENT_ACTION_ORIGIN.serverIdentityId,
                phase: 'current', interactionEnabled: true,
                executionOrigin: {
                    ...CLIENT_ACTION_ORIGIN,
                    materializationRef: { ...CLIENT_ACTION_ORIGIN.materializationRef, pluginId: 'acme.destination' },
                },
            },
        } satisfies PluginUiSurfacePlacementProjection;
        const navigation = createPluginSurfaceDestinationNavigationBinding({ placements: [placement], targetKind: 'app' });
        const navigated: PluginSurfaceOpenRequest[] = [];
        const unregister = navigation.registerOwner({ container: 'appPage', handler: ({ request }) => {
            navigated.push(request);
            return { ok: true };
        } });
        const fixture = createClientActionFixture();
        const invocation = {
            pluginId: CLIENT_ACTION_PLUGIN_ID,
            contributionId: 'conversation',
            occurrenceId: fixture.action.occurrenceId,
            machineId: 'machine-1',
            serverId: 'srv_voice_client_action',
            signal: new AbortController().signal,
            isCurrent: () => true,
            resolveContributedAction: fixture.resolve,
            // The AppShell-owned binding remains the navigation owner. This
            // host only reads it at client Action invocation time.
            readNavigationBinding: () => navigation,
        };
        await fixture.composition.unload();
        try {
            const attempts = await fixture.composition.reconcile([fixture.activation]);
            expect(attempts.map((attempt) => attempt.result)).toEqual([{ ok: true }]);
            await fixture.composition.reconcile([fixture.activation]);
            const ui = createAppShellPluginUiInvocationHost(invocation);

            await expect(ui.executeAction(CLIENT_ACTION_LOCAL_ID, { source: 'voice' })).resolves.toEqual({
                navigated: true,
                activations: 1,
                invocations: 1,
            });
            expect(resolvePluginUiClientActionRegistration({
                action: fixture.action,
                platform: CLIENT_ACTION_TARGET.platform,
                reader: fixture.composition,
            })).not.toBeNull();
            expect(navigated).toEqual([{
                destination: {
                    pluginId: 'acme.destination',
                    localId: 'issue-details',
                },
                input: { issue: 'UCX-EXTERNAL-VOICE' },
            }]);
        } finally {
            unregister();
            await fixture.composition.unload();
        }
    });

    it('fails client Action navigation closed for a missing binding, stale generation, or caller abort', async () => {
        const fixture = createClientActionFixture();
        await fixture.composition.unload();
        try {
            const attempts = await fixture.composition.reconcile([fixture.activation]);
            expect(attempts.map((attempt) => attempt.result)).toEqual([{ ok: true }]);
            const base = {
                pluginId: CLIENT_ACTION_PLUGIN_ID,
                occurrenceId: fixture.action.occurrenceId,
                contributionId: 'conversation',
                machineId: 'machine-1',
                serverId: 'srv_voice_client_action',
                signal: new AbortController().signal,
                resolveContributedAction: fixture.resolve,
            };
            const noBinding = createAppShellPluginUiInvocationHost({
                ...base,
                isCurrent: () => true,
            });
            await expect(noBinding.executeAction(CLIENT_ACTION_LOCAL_ID, null)).rejects.toMatchObject({
                code: 'plugin_surface_open_unavailable',
            });

            const stale = createAppShellPluginUiInvocationHost({
                ...base,
                isCurrent: () => false,
            });
            await expect(stale.executeAction(CLIENT_ACTION_LOCAL_ID, null)).rejects.toMatchObject({
                code: 'plugin_ui_generation_retired',
            });

            const caller = new AbortController();
            caller.abort();
            const aborted = createAppShellPluginUiInvocationHost({
                ...base,
                isCurrent: () => true,
            });
            await expect(aborted.executeAction(CLIENT_ACTION_LOCAL_ID, null, { signal: caller.signal }))
                .rejects.toMatchObject({ code: 'plugin_ui_invocation_aborted' });
        } finally {
            await fixture.composition.unload();
        }
    });

    it('qualifies a local Voice action with truthful non-mounted provenance', async () => {
        const signal = new AbortController().signal;
        answerDaemonAction(daemonSuccess({ token: 'bounded-artifact' }));
        const ui = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice',
            contributionId: 'conversation',
            occurrenceId: 'acme-voice-occurrence-12',
            machineId: 'machine-1',
            serverId: 'server-1',
            signal,
            timeoutMs: 5_000,
            isCurrent: () => true,
            resolveContributedAction: resolveDaemonAction,
        });

        await expect(ui.executeAction('mint-session', { voice: 'alloy' }))
            .resolves.toEqual({ token: 'bounded-artifact' });
        expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            payload: {
                machineId: 'machine-1',
                expectedContributorOccurrenceId: 'acme-voice-occurrence-12',
                qualifiedActionId: 'acme.voice/mint-session',
                input: { voice: 'alloy' },
                executionSurface: 'voice',
            },
            timeoutMs: 5_000,
            signal,
        }));
        expect(machineRpc.mock.calls[0]?.[0].payload).not.toHaveProperty('invocation');
    });

    it('fails before dispatch when the generation is stale or the caller is aborted', async () => {
        const stale = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            occurrenceId: 'acme-voice-occurrence-12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => false,
        });
        await expect(stale.executeAction('mint-session', null)).rejects.toMatchObject({
            code: 'plugin_ui_generation_retired',
        });

        const caller = new AbortController();
        caller.abort();
        const aborted = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            occurrenceId: 'acme-voice-occurrence-12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => true,
        });
        await expect(aborted.executeAction('mint-session', null, { signal: caller.signal })).rejects.toMatchObject({
            code: 'plugin_ui_invocation_aborted',
        });
        expect(machineRpc).not.toHaveBeenCalled();
    });

    it('preserves a settled daemon success when caller cancellation races result delivery', async () => {
        const caller = new AbortController();
        answerDaemonAction(daemonSuccess({ token: 'known-success' }), () => caller.abort(new Error('caller stopped')));
        const cancelledAfterSettlement = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            occurrenceId: 'acme-voice-occurrence-12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => true,
            resolveContributedAction: resolveDaemonAction,
        });
        await expect(cancelledAfterSettlement.executeAction('mint-session', null, { signal: caller.signal }))
            .resolves.toEqual({ token: 'known-success' });
    });

    it('preserves a settled daemon success when generation retirement races result delivery', async () => {
        let current = true;
        answerDaemonAction(daemonSuccess({ token: 'known-success' }), () => { current = false; });
        const retiredInFlight = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            occurrenceId: 'acme-voice-occurrence-12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => current,
            resolveContributedAction: resolveDaemonAction,
        });
        await expect(retiredInFlight.executeAction('mint-session', null))
            .resolves.toEqual({ token: 'known-success' });
    });

    it('normalizes daemon unavailability and action errors', async () => {
        answerDaemonAction({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        const unavailable = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            occurrenceId: 'acme-voice-occurrence-12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => true,
            resolveContributedAction: resolveDaemonAction,
        });
        await expect(unavailable.executeAction('mint-session', null)).rejects.toMatchObject({
            code: 'plugin_ui_action_host_unavailable',
        });

        answerDaemonAction(DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
            ok: false, code: 'plugin_action_grant_missing',
        }));
        const denied = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            occurrenceId: 'acme-voice-occurrence-12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => true,
            resolveContributedAction: resolveDaemonAction,
        });
        await expect(denied.executeAction('mint-session', null)).rejects.toMatchObject({
            code: 'plugin_action_grant_missing',
        });
    });

    it('does not require a mounted UI materialization for a global Voice action', async () => {
        answerDaemonAction(daemonSuccess({ token: 'global-voice-success' }));
        const ui = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            occurrenceId: 'acme-voice-occurrence-12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => true,
            resolveContributedAction: resolveDaemonAction,
        });

        await expect(ui.executeAction('mint-session', null)).resolves.toEqual({
            token: 'global-voice-success',
        });
        expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            payload: {
                machineId: 'machine-1',
                expectedContributorOccurrenceId: 'acme-voice-occurrence-12',
                qualifiedActionId: 'acme.voice/mint-session',
                input: null,
                executionSurface: 'voice',
            },
            timeoutMs: PLUGIN_PRESENT_USER_INTERACTION_DEADLINE_MS,
            signal: expect.any(AbortSignal),
        }));
        expect(machineRpc.mock.calls[0]?.[0].payload).not.toHaveProperty('invocation');
    });

    it('keeps the complete UI host API present while unsupported mounted-only methods fail closed', async () => {
        const ui = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            occurrenceId: 'acme-voice-occurrence-12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => true,
        });

        await expect(ui.statOpenableContent({ kind: 'workspaceFile', handle: 'viewer-file-1' }))
            .rejects.toMatchObject({ code: 'plugin_ui_method_unavailable' });
        await expect(ui.readOpenableContent({
            ref: { kind: 'workspaceFile', handle: 'viewer-file-1' },
            expectedRevision: 'revision-1',
            maxBytes: 1_024,
        })).rejects.toMatchObject({ code: 'plugin_ui_method_unavailable' });
        await expect(ui.settleEphemeralInput({ kind: 'cancelled' }))
            .rejects.toMatchObject({ code: 'plugin_ui_method_unavailable' });
        expect(ui.version().methods).toEqual(['executeAction']);
    });
});
