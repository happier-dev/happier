import fastify from 'fastify';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema, buildApprovalRequestArtifactHeaderV1, buildHomeHubArtifactIdV1, encodePlainArtifactStoredContent, decodePlainArtifactStoredContent, projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { createRegistryInputTypeDeps } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import * as daemonControl from '@/daemon/controlClient';
import { createCounterWidgetFixture, registerAccountHomeHttp, registerPlainArtifactRoutes } from './widgetApproval.testkit';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';

it('replays approved installed Board inputs on the hosting Session without an ambient CLI Session', async () => {
    const app = fastify();
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://widget-approval.test' });
    const accountId = 'widget-owner';
    const serverId = 'srv_widget_approval';
    const machineId = 'counter-machine';
    const sessionId = 'c000000000000000000000066';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const { pluginId, projection, registry, readUiResource } = createCounterWidgetFixture();
    // Only Home HTTP, Machine RPC and the plugin Resource transport are replaced.
    // The CLI composition, approval claim/replay, catalog and input owners stay real.
    vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async request => {
        expect(request.machineId).toBe(machineId);
        return { protocolVersion: 1, projection };
    });
    const features = registerAccountHomeHttp(app, { accountId, serverId });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(features));
    app.get(`/v2/sessions/${sessionId}`, async () => ({ session: { id: sessionId, seq: 1, createdAt: 1, updatedAt: 1,
        active: false, activeAt: 1, encryptionMode: 'plain', metadata: JSON.stringify({ machineId }), metadataVersion: 1,
        dataEncryptionKey: null, agentState: null, agentStateVersion: 0, responsibleAccountId: null, responsibleAccount: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
    } }));
    app.get(`/v2/sessions/${sessionId}/system-records/record`, async () => ({ record: null }));
    app.get(`/v2/sessions/${sessionId}/system-records`, async () => ({ records: [], hasNext: false, nextCursor: null }));
    const surface = { serverId, accountId, owner: { kind: 'sessionBoard' as const, sessionId } };
    const actionArgs = { surface, instance: { v: 1, id: 'approved-counter', definition: { kind: 'installed', surface: { pluginId, localId: 'counter' } },
        bindings: { filter: { kind: 'value', value: 'files' } } }, placement: { tabId: 'counts', tabTitle: 'Counts', width: 'wide' } };
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli', sessionId }, requestedSurface: 'cli', approval: { flow: 'deferred', result: 'required' },
        actionId: 'widgets.item.add', actionArgs, summary: 'Add count',
        executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
            serverId, serverIdentityId: serverId, accountId, sessionId, machineId, target: { kind: 'machine', machineId },
            actionId: 'widgets.item.add', requestId: 'approved-counter' },
    });
    const artifacts = registerPlainArtifactRoutes(app, accountId);
    artifacts.seed('counter-approval', encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
        encodePlainArtifactStoredContent({ body: JSON.stringify(request) }));
    let writes = 0;
    // The outer writer is deliberately refused at HTTP after admission, making
    // this test independent of Board layout semantics covered by its own suite.
    app.put(`/v2/sessions/${sessionId}/board`, async (_request, reply) => {
        writes++;
        return reply.code(403).send({ error: 'session_board_forbidden' });
    });
    try {
        const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials, machineId, serverId,
            serverApiUrl: 'http://widget-approval.test', resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId }) });
        // The contributed-plugin endpoint does not own built-in Actions. The
        // deciding CLI has declarations but no in-process plugin registry.
        vi.spyOn(daemonControl, 'requestDaemonPluginActionExecution').mockResolvedValue({ matched: false });
        const daemon = createCliActionExecutorHarness({ token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId, serverIdentityId: serverId, serverHttpBaseUrl: 'http://widget-approval.test' }, {
            ...createRegistryInputTypeDeps({ contributes: registry, readUiResource }),
        });
        const { executor } = createCliActionExecutorHarness({ token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId, serverIdentityId: serverId, serverHttpBaseUrl: 'http://widget-approval.test',
            // The authenticated built-in Action transport is a genuine process
            // boundary. Its receiving options owner and Resource path stay real.
            readAdmittedInputTypeOptions: async ({ input, context }) => {
                const result = await daemon.executor.execute('action.options.resolve', input, context);
                return result.ok ? result.result : result;
            },
        }, {
            isApprovalExecutionOriginCurrent: currentness,
        });
        const result = await runWithServerHttpBaseUrl('http://widget-approval.test', () => executor.execute('approval.request.decide',
            { artifactId: 'counter-approval', decision: 'approve' }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId, serverIdentityId: serverId, runtimeAccountId: accountId, actionRequestId: 'decide-counter' }));
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'session_board_forbidden' } } });
        expect(writes).toBe(1);
        const stored = decodePlainArtifactStoredContent(artifacts.read('counter-approval')!.body);
        expect(stored).toHaveProperty('body');
    } finally { restore(); vi.restoreAllMocks(); await app.close(); }
});

it.each([
    { kind: 'declarative', usesResources: false },
    { kind: 'html', usesResources: false },
    { kind: 'html', usesResources: true },
] as const)('replays an approved $kind Board definition with Resource use $usesResources', async ({ kind, usesResources }) => {
    const app = fastify();
    const home = 'http://widget-approval.test';
    const restore = installAxiosFastifyAdapter({ app, origin: home });
    const accountId = 'widget-owner';
    const serverId = 'srv_widget_approval';
    const machineId = 'counter-machine';
    const sessionId = 'c000000000000000000000066';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    // Refuse ambient Machine discovery at the network boundary: self-contained
    // definitions still execute, while actual Resource consumers retain denial.
    const registryRpc = vi.spyOn(machineRpc, 'callMachineRpc').mockRejectedValue(new RpcError('Forbidden', 'RPC_FORBIDDEN'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(registerAccountHomeHttp(app, { accountId, serverId })));
    app.get(`/v2/sessions/${sessionId}`, async () => ({ session: { id: sessionId, seq: 1, createdAt: 1, updatedAt: 1,
        active: false, activeAt: 1, encryptionMode: 'plain', metadata: JSON.stringify({ machineId }), metadataVersion: 1,
        dataEncryptionKey: null, agentState: null, agentStateVersion: 0, responsibleAccountId: null, responsibleAccount: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
    } }));
    app.get(`/v2/sessions/${sessionId}/system-records/record`, async () => ({ record: null }));
    app.get(`/v2/sessions/${sessionId}/system-records`, async () => ({ records: [], hasNext: false, nextCursor: null }));
    const body = kind === 'declarative' ? { kind, document: { version: 1, root: { kind: 'markdown', text: 'Restored chart' } } }
        : { kind, source: { v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html', contentBase64: 'PGgxPkNvcHk8L2gxPg==' } } },
            ...(usesResources ? { requestedCapabilities: { resources: [{ pluginId: 'example.widgets', localId: 'count' }],
                actions: [], network: 'none', networkOrigins: [] } } : {}) };
    const instance = { v: 1, id: 'restored-copy', definition: { kind: 'inline', definition: {
        v: 1, id: '80101031-0000-4000-8000-000000000080', name: 'Restored copy', body,
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
        inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
    } }, bindings: {}, displayName: 'Restored copy' };
    const surface = { serverId, accountId, owner: { kind: 'sessionBoard', sessionId } };
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli', sessionId }, requestedSurface: 'cli', approval: { flow: 'deferred', result: 'required' },
        actionId: 'widgets.item.add', actionArgs: { surface, instance, placement: { tabId: 'restored', tabTitle: 'Restored' } }, summary: 'Restore copy',
        executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
            serverId, serverIdentityId: serverId, accountId, sessionId, machineId, target: { kind: 'machine', machineId },
            actionId: 'widgets.item.add', requestId: 'restored-copy' },
    });
    const artifacts = registerPlainArtifactRoutes(app, accountId);
    artifacts.seed('restored-approval', encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
        encodePlainArtifactStoredContent({ body: JSON.stringify(request) }));
    const writes: unknown[] = [];
    app.put(`/v2/sessions/${sessionId}/board`, async request => {
        writes.push(request.body);
        return { operation: 'upsert_item', itemId: instance.id, outcome: 'created',
            itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', layoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' };
    });
    try {
        const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials, machineId, serverId,
            serverApiUrl: home, resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId }) });
        const { executor } = createCliActionExecutorHarness({ token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId, serverIdentityId: serverId, serverHttpBaseUrl: home }, { isApprovalExecutionOriginCurrent: currentness });
        const result = await runWithServerHttpBaseUrl(home, () => executor.execute('approval.request.decide',
            { artifactId: 'restored-approval', decision: 'approve' }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId, serverIdentityId: serverId, runtimeAccountId: accountId, actionRequestId: 'decide-restored' }));
        if (usesResources) {
            expect(result).toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'RPC_FORBIDDEN' } } });
            expect(writes).toEqual([]);
            expect(registryRpc).toHaveBeenCalled();
            return;
        }
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
        expect(writes).toEqual([expect.objectContaining({ operation: 'upsert_item', itemId: instance.id,
            itemContent: { t: 'plain', v: expect.objectContaining({ source: { kind: 'widget', instance: expect.objectContaining(instance) } }) },
            placement: expect.objectContaining({ layoutContent: { t: 'plain', v: { v: 1, tabs: [expect.objectContaining({ id: 'restored', items: [expect.objectContaining({ itemId: instance.id })] })] } } }),
        })]);
        expect(registryRpc).not.toHaveBeenCalled();
    } finally { restore(); vi.restoreAllMocks(); await app.close(); }
});

/** One approved Home add replayed by a standalone CLI that knows the Account's Machine inventory and nothing else. */
async function replayApprovedHomeCounter(input: Readonly<{
    machines: readonly Readonly<{ id: string; connected: boolean; hasPlugin?: boolean }>[];
    explicitMachineId?: string;
    expectUnavailable?: boolean;
}>) {
    const app = fastify();
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://widget-approval.test' });
    const accountId = 'widget-owner';
    const serverId = 'srv_widget_approval';
    const machineId = 'counter-machine';
    const reached: string[] = [];
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const { pluginId, definition, projection, registry, readUiResource } = createCounterWidgetFixture();
    // Only Home HTTP, Machine RPC and the plugin Resource transport are replaced.
    vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async request => {
        reached.push(request.machineId);
        // The server answers `target_unavailable` for a Machine row whose daemon is connected to another server.
        if (!input.machines.find(machine => machine.id === request.machineId)?.connected) {
            throw new RpcError('RPC target unavailable', 'target_unavailable');
        }
        return { protocolVersion: 1, projection: input.machines.find(machine => machine.id === request.machineId)?.hasPlugin === false
            ? PluginProjectionV2Schema.parse({ v: 2, generation: 1 }) : projection };
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(registerAccountHomeHttp(app, { accountId, serverId })));
    const artifacts = registerPlainArtifactRoutes(app, accountId);
    // Every Machine looks present in the shared Account inventory; only some daemons are connected to this server.
    app.get('/v1/machines', async () => input.machines.map(machine => ({ id: machine.id, kind: 'persistent', active: true,
        activeAt: Date.now(), revokedAt: null, replacedByMachineId: null })));
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'], async () =>
        PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 1, inventoryComplete: true, releases: [],
            snapshots: input.machines.map(machine => ({ serverIdentityId: serverId, machineId: machine.id,
                materializations: machine.hasPlugin === false ? [] : [{ serverIdentityId: serverId, machineId: machine.id,
                    materializationId: `materialization-${machine.id}`, pluginId, version: '1.0.0', sourceClass: 'localPath',
                    portableRelease: false, enabled: true, trustState: 'trusted', uiArtifacts: [], observedAt: 1 }] })) }));
    const surface = { serverId, accountId, owner: { kind: 'home' as const } };
    const instance = { v: 1, id: 'home-counter', definition, bindings: { filter: { kind: 'value', value: 'files' } } };
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli' }, requestedSurface: 'cli', approval: { flow: 'deferred', result: 'required' },
        actionId: 'widgets.item.add', actionArgs: { surface, instance }, summary: 'Add count',
        executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
            serverId, serverIdentityId: serverId, accountId, machineId, target: { kind: 'machine', machineId },
            actionId: 'widgets.item.add', requestId: 'approved-home-counter' },
    });
    artifacts.seed('home-approval', encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
        encodePlainArtifactStoredContent({ body: JSON.stringify(request) }));
    try {
        const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials, machineId, serverId,
            serverApiUrl: 'http://widget-approval.test', resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId }) });
        vi.spyOn(daemonControl, 'requestDaemonPluginActionExecution').mockResolvedValue({ matched: false });
        const daemon = createCliActionExecutorHarness({ token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId, serverIdentityId: serverId, serverHttpBaseUrl: 'http://widget-approval.test',
            ...(input.explicitMachineId ? { explicitMachineId: input.explicitMachineId } : {}) }, {
            ...createRegistryInputTypeDeps({ contributes: registry, readUiResource }),
        });
        const { executor } = createCliActionExecutorHarness({ token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId, serverIdentityId: serverId, serverHttpBaseUrl: 'http://widget-approval.test',
            ...(input.explicitMachineId ? { explicitMachineId: input.explicitMachineId } : {}),
            readAdmittedInputTypeOptions: async ({ input, context }) => {
                const result = await daemon.executor.execute('action.options.resolve', input, context);
                return result.ok ? result.result : result;
            },
        }, { isApprovalExecutionOriginCurrent: currentness });
        if (!input.expectUnavailable) {
            // Discovery can warm the generic projection on an unrelated daemon.
            // Exact-type admission must still select the plugin's own supply.
            const catalog = await runWithServerHttpBaseUrl('http://widget-approval.test', () => executor.execute('widgets.catalog.list', { surface },
                { surface: 'cli', authority: 'present_user', serverId, serverIdentityId: serverId, runtimeAccountId: accountId, bypassApprovals: true }));
            expect(catalog, JSON.stringify(catalog)).toMatchObject({ ok: true });
        }
        const result = await runWithServerHttpBaseUrl('http://widget-approval.test', () => executor.execute('approval.request.decide',
            { artifactId: 'home-approval', decision: 'approve' }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId, serverIdentityId: serverId, runtimeAccountId: accountId, actionRequestId: 'decide-home-counter' }));
        if (input.expectUnavailable) {
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'failed', execution: {
                ok: false, errorCode: 'widget_type_unavailable', error: expect.stringContaining('No Machine'),
            } } });
            expect(artifacts.read(buildHomeHubArtifactIdV1(accountId))).toBeUndefined();
            return reached;
        }
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
        const home = artifacts.read(buildHomeHubArtifactIdV1(accountId));
        expect(decodePlainArtifactStoredContent(home!.body)).toMatchObject({ body: expect.stringContaining('home-counter') });
        const ref = { surface, instanceId: instance.id };
        const context = { surface: 'cli' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
            serverId, serverIdentityId: serverId, runtimeAccountId: accountId, bypassApprovals: true };
        expect(await runWithServerHttpBaseUrl('http://widget-approval.test', () => executor.execute('widgets.item.inputs.validate', { ref, bindings: instance.bindings }, context)))
            .toMatchObject({ ok: true, result: { status: 'ready', input: { filter: 'files' } } });
        expect(await runWithServerHttpBaseUrl('http://widget-approval.test', () => executor.execute('widgets.item.size.set', { ref, size: 'medium' }, context))).toMatchObject({ ok: true });
        expect(await runWithServerHttpBaseUrl('http://widget-approval.test', () => executor.execute('widgets.item.inputs.set', { ref, bindings: { filter: { kind: 'value', value: 'folders' } } }, context)))
            .toMatchObject({ ok: true });
        expect(decodePlainArtifactStoredContent(artifacts.read(buildHomeHubArtifactIdV1(accountId))!.body))
            .toMatchObject({ body: expect.stringContaining('folders') });
        // Removal reads the same Account projection; an unreachable first Machine must not surface as a layout read failure.
        const removal = await runWithServerHttpBaseUrl('http://widget-approval.test', () => executor.execute('home.hub.layout.update',
            { intent: { kind: 'widget_remove', instanceId: 'home-counter' } }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId, serverIdentityId: serverId, runtimeAccountId: accountId, actionRequestId: 'remove-home-counter', bypassApprovals: true }));
        expect(removal, JSON.stringify(removal)).toMatchObject({ ok: true });
        expect(decodePlainArtifactStoredContent(artifacts.read(buildHomeHubArtifactIdV1(accountId))!.body)).not.toMatchObject({ body: expect.stringContaining('home-counter') });
        return reached;
    } finally { restore(); vi.restoreAllMocks(); await app.close(); }
}

it('replays an approved installed widget add on Home, an Account surface with no hosting Session or ambient CLI Machine', async () => {
    await replayApprovedHomeCounter({ machines: [{ id: 'counter-machine', connected: true }] });
});

it('reads the Account widget projection from a Machine this server reaches, not the first Account Machine present', async () => {
    const reached = await replayApprovedHomeCounter({ machines: [
        { id: 'other-server-daemon', connected: false }, { id: 'counter-machine', connected: true }] });
    expect(reached).toContain('counter-machine');
});

it('reads the Account widget projection from the Machine the CLI names with its explicit selector', async () => {
    const reached = await replayApprovedHomeCounter({ explicitMachineId: 'counter-machine', machines: [
        { id: 'other-server-daemon', connected: true }, { id: 'counter-machine', connected: true }] });
    expect(new Set(reached)).toEqual(new Set(['counter-machine']));
});

it('replays an approved Home widget through a Machine carrying its plugin even when the first reachable daemon lacks it', async () => {
    await replayApprovedHomeCounter({ machines: [
        { id: 'unrelated-daemon', connected: true, hasPlugin: false }, { id: 'counter-machine', connected: true },
    ] });
});

it('refuses an approved Home add without a write when no Machine carries its plugin', async () => {
    await replayApprovedHomeCounter({ expectUnavailable: true, machines: [
        { id: 'unrelated-daemon', connected: true, hasPlugin: false },
    ] });
});
