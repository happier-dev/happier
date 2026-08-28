import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import { describe, expect, it, vi } from 'vitest';
import {
    DaemonPluginStructuredMessageActionExecuteRequestSchema,
    PluginContributesV2Schema,
    PluginProjectedActionV2Schema,
    type PluginContributionIdentityV1,
    type PluginMachineExecutionOriginV1,
    type PluginProjectedActionV2,
} from '@happier-dev/protocol';

import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import {
    getInstalledPluginUiClientExecutableComposition,
    resolvePluginUiClientActionRegistration,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import type {
    PluginReactNativeExecutableExport,
    PluginReactNativeLoaderBackend,
} from '@/components/plugins/reactNative/loader';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

import {
    createAppShellPluginUiInvocationHost,
    DEFAULT_INVOCATION_TIMEOUT_MS,
    type AppShellPluginUiActionExecute,
} from './pluginUiInvocationHost';

const DAEMON_ACTION: PluginProjectedActionV2 = {
    id: 'mint-session',
    pluginId: 'acme.voice',
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
    modulePath: './clientActionRuntime',
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

function createClientActionFixture(handler: PluginClientActionHandler) {
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
                modulePath: CLIENT_ACTION_TARGET.modulePath,
                exportName: CLIENT_ACTION_TARGET.exportName,
            },
            platforms: [CLIENT_ACTION_TARGET.platform],
        },
        dangerLevel: 'safe' as const,
    };
    const action = PluginProjectedActionV2Schema.parse({
        ...declaration,
        pluginId: CLIENT_ACTION_PLUGIN_ID,
        serverIdentityId: CLIENT_ACTION_ORIGIN.serverIdentityId,
        materializationRef: CLIENT_ACTION_ORIGIN.materializationRef,
        available: true,
        authorization: CLIENT_ACTION_AUTHORIZATION,
    });
    const identity: PluginReactNativeBundleCacheIdentity = Object.freeze({
        pluginId: CLIENT_ACTION_PLUGIN_ID,
        contributionId: CLIENT_ACTION_LOCAL_ID,
        artifactDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        hostAppVersion: '2.0.0',
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.83.4',
        platform: CLIENT_ACTION_TARGET.platform,
        channel: 'internal',
        nativeCapabilitiesDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        projectionGeneration: CLIENT_ACTION_GENERATION,
    });
    const cache = createPluginReactNativeBundleCache();
    cache.putInstalledArtifact({
        identity,
        bytes: new Uint8Array([47, 47, 32, 99, 108, 105, 101, 110, 116]),
        format: 'plainJs',
    });
    const activate = vi.fn((api: PluginClientApi) => {
        api.actions.register(CLIENT_ACTION_LOCAL_ID, handler);
    });
    const backend: PluginReactNativeLoaderBackend = Object.freeze({
        backendId: 'reactNativeWebModule',
        available: true,
        loadInstalledBundle: vi.fn(async () => activate as PluginReactNativeExecutableExport),
    });
    return Object.freeze({
        action,
        activate,
        activation: Object.freeze({
            pluginId: CLIENT_ACTION_PLUGIN_ID,
            pluginVersion: '1.2.3',
            contributes: PluginContributesV2Schema.parse({ actions: [declaration] }),
            target: CLIENT_ACTION_TARGET,
            executionOrigin: CLIENT_ACTION_ORIGIN,
            projectionGeneration: CLIENT_ACTION_GENERATION,
            cache,
            identity,
            moduleReference: {
                containerName: 'voice-client-action-runtime',
                modulePath: CLIENT_ACTION_TARGET.modulePath,
                exportName: CLIENT_ACTION_TARGET.exportName,
            },
            backend,
            authority: {
                serverId: 'srv_voice_client_action',
                machineId: 'machine-1',
                projectionGeneration: CLIENT_ACTION_GENERATION,
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
        const openSurface = vi.fn(async () => ({ ok: true as const }));
        const handler = vi.fn();
        const clientHandler: PluginClientActionHandler = async (_input, context) => {
            handler();
            await context.ui.openSurface({
                pluginId: 'acme.destination',
                localId: 'issue-details',
            }, { issue: 'UCX-EXTERNAL-VOICE' });
            return { navigated: true };
        };
        const fixture = createClientActionFixture(clientHandler);
        const invocation = {
            pluginId: CLIENT_ACTION_PLUGIN_ID,
            contributionId: 'conversation',
            generation: String(CLIENT_ACTION_GENERATION),
            machineId: 'machine-1',
            serverId: 'srv_voice_client_action',
            signal: new AbortController().signal,
            isCurrent: () => true,
            resolveContributedAction: fixture.resolve,
            // The AppShell-owned binding remains the navigation owner. This
            // host only reads it at client Action invocation time.
            readNavigationBinding: () => ({
                openSurface,
                targetKind: 'app' as const,
                registerOwner: () => () => {},
            }),
        };
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const ui = createAppShellPluginUiInvocationHost(invocation);

            await expect(ui.executeAction(CLIENT_ACTION_LOCAL_ID, { source: 'voice' })).resolves.toEqual({
                navigated: true,
            });
            expect(fixture.activate).toHaveBeenCalledTimes(1);
            expect(resolvePluginUiClientActionRegistration({
                action: fixture.action,
                projectionGeneration: CLIENT_ACTION_GENERATION,
                platform: CLIENT_ACTION_TARGET.platform,
                reader: fixture.composition,
            })).not.toBeNull();
            expect(handler).toHaveBeenCalledTimes(1);
            expect(openSurface).toHaveBeenCalledWith({
                destination: {
                    pluginId: 'acme.destination',
                    localId: 'issue-details',
                },
                input: { issue: 'UCX-EXTERNAL-VOICE' },
            });
        } finally {
            await fixture.composition.unload();
        }
    });

    it('fails client Action navigation closed for a missing binding, stale generation, or caller abort', async () => {
        const handler = vi.fn();
        const clientHandler: PluginClientActionHandler = async (_input, context) => {
            handler();
            await context.ui.openSurface({
                pluginId: 'acme.destination',
                localId: 'issue-details',
            });
            return { shouldNotSettle: true };
        };
        const fixture = createClientActionFixture(clientHandler);
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const base = {
                pluginId: CLIENT_ACTION_PLUGIN_ID,
                contributionId: 'conversation',
                generation: String(CLIENT_ACTION_GENERATION),
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
            expect(handler).toHaveBeenCalledTimes(1);

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
            expect(handler).toHaveBeenCalledTimes(1);
        } finally {
            await fixture.composition.unload();
        }
    });

    it('qualifies a local Voice action with truthful non-mounted provenance', async () => {
        const signal = new AbortController().signal;
        const execute = vi.fn<AppShellPluginUiActionExecute>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { token: 'bounded-artifact' } },
        }));
        const ui = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice',
            contributionId: 'conversation',
            generation: '12',
            machineId: 'machine-1',
            serverId: 'server-1',
            signal,
            timeoutMs: 5_000,
            isCurrent: () => true,
            resolveContributedAction: resolveDaemonAction,
            execute,
        });

        await expect(ui.executeAction('mint-session', { voice: 'alloy' }))
            .resolves.toEqual({ token: 'bounded-artifact' });
        expect(execute).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-1',
            expectedGeneration: '12',
            qualifiedActionId: 'acme.voice/mint-session',
            input: { voice: 'alloy' },
            executionSurface: 'voice',
            timeoutMs: 5_000,
            signal,
        });
        const request = execute.mock.calls[0]?.[1];
        expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
            machineId: 'machine-1',
            expectedGeneration: request?.expectedGeneration,
            qualifiedActionId: request?.qualifiedActionId,
            input: request?.input,
            executionSurface: request?.executionSurface,
            ...(request?.invocation ? { invocation: request.invocation } : {}),
        }).success).toBe(true);
    });

    it('fails before dispatch when the generation is stale or the caller is aborted', async () => {
        const execute = vi.fn();
        const stale = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            generation: '12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => false, execute,
        });
        await expect(stale.executeAction('mint-session', null)).rejects.toMatchObject({
            code: 'plugin_ui_generation_retired',
        });

        const caller = new AbortController();
        caller.abort();
        const aborted = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            generation: '12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => true, execute,
        });
        await expect(aborted.executeAction('mint-session', null, { signal: caller.signal })).rejects.toMatchObject({
            code: 'plugin_ui_invocation_aborted',
        });
        expect(execute).not.toHaveBeenCalled();
    });

    it('preserves a settled daemon success when caller cancellation races result delivery', async () => {
        const caller = new AbortController();
        const cancelledAfterSettlement = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            generation: '12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => true,
            resolveContributedAction: resolveDaemonAction,
            execute: async () => {
                const settled = { supported: true as const, result: { ok: true as const, result: { token: 'known-success' } } };
                caller.abort(new Error('caller stopped'));
                return settled;
            },
        });
        await expect(cancelledAfterSettlement.executeAction('mint-session', null, { signal: caller.signal }))
            .resolves.toEqual({ token: 'known-success' });
    });

    it('preserves a settled daemon success when generation retirement races result delivery', async () => {
        let current = true;
        const retiredInFlight = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            generation: '12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => current,
            resolveContributedAction: resolveDaemonAction,
            execute: async () => {
                const settled = { supported: true as const, result: { ok: true as const, result: { token: 'known-success' } } };
                current = false;
                return settled;
            },
        });
        await expect(retiredInFlight.executeAction('mint-session', null))
            .resolves.toEqual({ token: 'known-success' });
    });

    it('normalizes daemon unavailability and action errors', async () => {
        const unavailable = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            generation: '12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => true,
            resolveContributedAction: resolveDaemonAction,
            execute: async () => ({ supported: false, reason: 'not-supported' }),
        });
        await expect(unavailable.executeAction('mint-session', null)).rejects.toMatchObject({
            code: 'plugin_ui_action_host_unavailable',
        });

        const denied = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            generation: '12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => true,
            resolveContributedAction: resolveDaemonAction,
            execute: async () => ({ supported: true, result: { ok: false, code: 'plugin_action_grant_missing' } }),
        });
        await expect(denied.executeAction('mint-session', null)).rejects.toMatchObject({
            code: 'plugin_action_grant_missing',
        });
    });

    it('does not require a mounted UI materialization for a global Voice action', async () => {
        const execute = vi.fn(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { token: 'global-voice-success' } },
        }));
        const ui = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            generation: '12', machineId: 'machine-1', signal: new AbortController().signal,
            isCurrent: () => true,
            resolveContributedAction: resolveDaemonAction,
            execute,
        });

        await expect(ui.executeAction('mint-session', null)).resolves.toEqual({
            token: 'global-voice-success',
        });
        expect(execute).toHaveBeenCalledWith('machine-1', {
            serverId: null,
            expectedGeneration: '12',
            qualifiedActionId: 'acme.voice/mint-session',
            input: null,
            executionSurface: 'voice',
            timeoutMs: DEFAULT_INVOCATION_TIMEOUT_MS,
            signal: expect.any(AbortSignal),
        });
    });

    it('keeps the complete UI host API present while unsupported mounted-only methods fail closed', async () => {
        const ui = createAppShellPluginUiInvocationHost({
            pluginId: 'acme.voice', contributionId: 'conversation',
            generation: '12', machineId: 'machine-1', signal: new AbortController().signal,
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
