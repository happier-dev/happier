import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { createPluginDeclaredResourceStore } from './PluginContextualResourceStoreProvider';

vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

const rpc = vi.hoisted(() => ({ read: vi.fn<() => Promise<unknown>>(), action: vi.fn<(request: { method: string; payload: unknown }) => unknown>() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => (
    await import('@/dev/testkit/mocks/serverScopedRpc')
).createServerScopedMachineRpcBoundaryMock(async request => {
    const actionReply = rpc.action(request);
    if (actionReply !== undefined) return actionReply;
    if (request.method !== RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) throw new Error(`Unexpected RPC: ${request.method}`);
    return rpc.read();
}));

installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => { rpc.action.mockReset(); await connection?.dispose(); connection = undefined; });

it.each(['mounted', 'unmounted'] as const)('preserves the mounted Machine through Session admission for a %s Account Resource nested daemon read without sharing it with a Machine-less demand', async presentation => {
    const { parsePluginManifest } = await import('@happier-dev/plugin-sdk/manifest');
    const { PluginError } = await import('@happier-dev/plugin-sdk');
    const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
    const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
    const { PluginProjectionV2Schema, PluginProjectedActionV2Schema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
    const { loadDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    const { resolvePluginContextualResourceBinding } = await import('./pluginResourceBinding');
    const { SessionTargetV1ProtocolSchema } = await import('@happier-dev/protocol/actions/sessionTargetV1');
    const { registerCurrentUiContextActionPort } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
    const { createCurrentUiContextVoiceToolPort } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
    const { createSessionReadBatchFetchBoundary } = await import('@/dev/testkit/harness/sessionReadBatchHttpBoundary');
    const { createSessionFixture, createPlainSessionByIdResponseFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const pluginId = 'example.resource-machine';
    const accountId = 'resource-machine-account';
    const http = createHomeHubArtifactHttpBoundary(accountId);
    const sessionId = 'resource-session';
    let sessionReads = 0;
    const request = createSessionReadBatchFetchBoundary(async (url, init) => {
        if (new URL(String(url)).pathname === `/v2/sessions/${sessionId}`) {
            sessionReads++;
            return Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({ id: sessionId })));
        }
        return http.request(url, init);
    });
    connection = await restoreServerAccountForTest({ serverUrl: 'http://resource-machine.test', accountId, request });
    const accountLifetime = captureActiveServerAccountScopeLifetime()!;
    const execution = { target: 'account', account: { artifactId: 'resource-machine', exportName: 'activate' } };
    const sourceInputSchema = { type: 'object', properties: { sessionId: SessionTargetV1ProtocolSchema.jsonSchema },
        required: ['sessionId'], additionalProperties: false };
    const parsed = parsePluginManifest({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Resource Machine',
        runtime: { apiVersion: 1 }, contributes: {
            actions: [{ id: 'relay', title: 'Read', scopes: ['global'], surfaces: ['plugin'], execution,
                dangerLevel: 'safe', readOnly: true },
                { id: 'source', title: 'Read source', scopes: ['global'], surfaces: ['plugin'], execution: { target: 'daemon' },
                    dangerLevel: 'safe', readOnly: true, inputSchema: sourceInputSchema,
                    sessionTarget: { field: 'sessionId', cardinality: 'one' } }],
            resources: [{ id: 'status', source: 'dynamic', scope: 'session', kind: 'config', contentType: 'application/json', execution }],
        } });
    if (!parsed.ok) throw new Error(`Expected admitted Resource fixture: ${JSON.stringify(parsed)}`);
    const fixture = await installPortableAccountPluginReleaseForTest({ manifest: parsed.manifest, accountLifetime,
        activate(api) {
            api.actions.register('relay', async (_value, context) => {
                try { return await context.services.actions.execute({ pluginId, localId: 'source' }, { sessionId }); }
                catch (error) { if (error instanceof PluginError) return { code: error.code }; throw error; }
            });
            api.resources.registerDynamicResource('status', { async read(options) {
                const result = await options.readAction({ pluginId, localId: 'relay' }, {});
                if (!result.ok) throw new PluginError({ code: result.errorCode });
                return JSON.stringify(result.result);
            }, observe() { return { dispose() {} }; } });
        } });
    const unpublish = publishCommittedAppShellPluginUiProjection(() => fixture.projection);
    const unregister = presentation === 'mounted' ? registerCurrentUiContextActionPort((invocationSurface, hostAction) =>
        createCurrentUiContextVoiceToolPort({ invocationSurface, hostAction, readProjection: () => fixture.projection,
            readNavigationBinding: () => null,
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
        })) : () => {};
    const machineId = 'session-selected-machine';
    const occurrenceId = 'source-current';
    const source = PluginProjectedActionV2Schema.parse({ id: 'source', pluginId, title: 'Read source', scopes: ['global'],
        surfaces: ['plugin'], execution: { target: 'daemon' }, dangerLevel: 'safe', placementBindings: [], occurrenceId,
        sessionTarget: { field: 'sessionId', cardinality: 'one' },
        available: true, authorization: { generation: { targetGeneration: occurrenceId, desiredGeneration: occurrenceId, appliedGeneration: occurrenceId },
            resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] } });
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, actionsById: { [`${pluginId}/source`]: source } });
    let sourceReads = 0;
    rpc.action.mockImplementation(request => {
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection };
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) return { status: 'sourceDeclarations', pluginId, sourceDeclarations: [] };
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return { ok: true, inputSchema: sourceInputSchema };
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
            expect(request.payload).toMatchObject({ machineId, qualifiedActionId: `${pluginId}/source`, expectedContributorOccurrenceId: occurrenceId });
            sourceReads++;
            return { ok: true, result: { ready: true } };
        }
        return undefined;
    });
    // The exact Machine projection is acquired by the same owner as Session runtime/main Triage.
    await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId, serverId: accountLifetime.scope.serverId, accountLifetime });
    const declaration = fixture.projection.resourcesById[`${pluginId}/status`]!;
    const input = { accountLifetime, pluginId, machineId, serverId: accountLifetime.scope.serverId,
        expectedCallerOccurrenceId: declaration.occurrenceId!, resourcesById: fixture.projection.resourcesById,
        resourceDeclarationsComplete: true, sessionId };
    const binding = resolvePluginContextualResourceBinding({ ...input, projection: fixture.projection, isCurrent: accountLifetime.isCurrent },
        declaration, { kind: 'session', sessionId: input.sessionId });
    expect(binding?.machineId).toBeNull(); // Account Resource custody never becomes a daemon Resource.
    const selected = createPluginDeclaredResourceStore(input)!;
    const noMachine = createPluginDeclaredResourceStore({ ...input, machineId: null })!;
    try {
        const snapshot = await selected.getEntry('status').refresh();
        expect(snapshot.error).toBeUndefined();
        expect(JSON.parse(new TextDecoder().decode(snapshot.value!.bytes))).toEqual({ ready: true });
        expect(sourceReads).toBe(1);
        expect(sessionReads).toBeGreaterThan(0); // Generic Session operand admission ran, not only the source handler.
        const unavailable = await noMachine.getEntry('status').refresh();
        expect(JSON.parse(new TextDecoder().decode(unavailable.value!.bytes))).toEqual({ code: 'plugin_action_machine_required' });
        expect(sourceReads).toBe(1); // No ambient Machine borrowing or automatic re-poll.
    } finally { selected.dispose(); noMachine.dispose(); unregister(); unpublish(); await fixture.dispose(); }
});

// Keep the focused admission regressions independent of unrelated screen imports.
// Only HTTP, Socket.IO and the daemon RPC are boundaries; declaration admission,
// contextual sharing, Resource ingress and author selection all remain real.
it.each(['withdrawn', 'disposed'] as const)('stops a %s declaration decoder while a healthy mount reads new private bytes', async withdrawal => {
    const accountId = 'resource-projection-account';
    const http = createHomeHubArtifactHttpBoundary(accountId);
    connection = await restoreServerAccountForTest({ serverUrl: 'http://resource-projection.test', accountId, request: http.request });
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) throw new Error('Expected captured Account lifetime');
    let text = 'allowed-before-withdrawal';
    let marker = 'a';
    rpc.read.mockImplementation(async () => ({ ok: true, resource: { pluginId: 'acme.composer', localId: 'status' },
        kind: 'config', contentType: 'text/plain', digest: `sha256:${marker.repeat(64)}`,
        bytesBase64: Buffer.from(text).toString('base64') }));
    let resourcesById: PluginUiProjectionModel['resourcesById'] = { state: {
        id: 'status', pluginId: 'acme.composer', resourceKind: 'config', scope: 'global',
    } };
    const base = { accountLifetime, pluginId: 'acme.composer', machineId: 'machine-1',
        serverId: accountLifetime.scope.serverId, expectedCallerOccurrenceId: 'occurrence-42', resourceDeclarationsComplete: true,
        get resourcesById() { return resourcesById; } };
    const store = createPluginDeclaredResourceStore(base)!;
    const other = createPluginDeclaredResourceStore({ ...base, resourcesById })!;
    const retained = store.getEntry('status');
    const shared = other.getEntry('status');
    const received: string[] = [];
    const selected = retained.select({ decode: content => {
        const value = new TextDecoder().decode(content.bytes);
        received.push(value);
        return value;
    } }, snapshot => snapshot);
    const peer = shared.select({ decode: content => new TextDecoder().decode(content.bytes) }, snapshot => snapshot.value);
    const release = selected.subscribe(() => { selected.getSnapshot(); }, false);
    const releaseOther = peer.subscribe(() => { peer.getSnapshot(); }, false);
    try {
        await vi.waitFor(() => expect(selected.getSnapshot().value).toBe(text));
        const admitted = selected.getSnapshot();
        expect(selected.getSnapshot()).toBe(admitted);
        if (withdrawal === 'disposed') store.dispose();
        else resourcesById = {};
        const unavailable = selected.getSnapshot();
        expect(unavailable).not.toBe(admitted);
        expect(unavailable.value).toBeUndefined();
        expect(unavailable.error?.code).toBe(withdrawal === 'disposed' ? 'plugin_surface_retired' : 'plugin_resource_not_found');
        expect(selected.getSnapshot()).toBe(unavailable);
        const lateDecode = vi.fn(() => 'not admitted');
        const late = retained.select({ decode: lateDecode }, snapshot => snapshot);
        expect(late.getSnapshot()).toBe(unavailable);
        text = 'private-after-withdrawal'; marker = 'b';
        await shared.refresh();
        expect(peer.getSnapshot()).toBe(text);
        expect(selected.getSnapshot()).toBe(unavailable);
        expect(late.getSnapshot()).toBe(unavailable);
        expect(received).toEqual(['allowed-before-withdrawal']);
        expect(lateDecode).not.toHaveBeenCalled();
        store.reconcile();
        expect(selected.getSnapshot()).toBe(unavailable);
    } finally { release(); releaseOther(); store.dispose(); other.dispose(); }
});
