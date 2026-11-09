import fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { createActionExecutor, decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { buildHomeHubArtifactIdV1 } from '@happier-dev/protocol/home';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { WidgetDefinitionDraftV1 } from '@happier-dev/protocol/widgets';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createCliActionDeps } from './createCliActionDeps';
import { registerAccountHomeHttp, registerPlainArtifactRoutes } from './widgetApproval.testkit';

it.each(['declarative', 'html'] as const)('adds a just-created %s definition to Home and Board after a refused Artifact read', async kind => {
    const app = fastify();
    const home = 'http://widget-placement.test';
    const restore = installAxiosFastifyAdapter({ app, origin: home });
    const account = { serverId: 'srv_widget_placement', accountId: 'widget-owner' };
    const token = `header.${Buffer.from(JSON.stringify({ sub: account.accountId })).toString('base64url')}.signature`;
    const artifactId = '80101104-0000-4000-8000-000000000001';
    const boardId = '80101104-0000-4000-8000-000000000002';
    let refuseDefinitionRead = false;
    // Home HTTP and Machine RPC are system boundaries; Action preparation,
    // definition codecs, input admission and both layout writers remain real.
    app.addHook('onRequest', async (request, reply) => {
        if (refuseDefinitionRead && request.method === 'GET' && request.url === `/v1/artifacts/${artifactId}`) {
            return reply.code(503).send({ error: 'database_connection_unavailable' });
        }
    });
    registerAccountHomeHttp(app, account);
    const artifacts = registerPlainArtifactRoutes(app, account.accountId);
    vi.spyOn(machineRpc, 'callMachineRpc').mockResolvedValue({ protocolVersion: 1,
        projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1 }) });
    app.get('/v1/machines', async () => []);
    const definition: WidgetDefinitionDraftV1 = {
        name: 'QA placement', sizeDeclaration: { sizes: ['medium', 'full'], defaultSize: 'medium' },
        inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
        body: kind === 'declarative' ? { kind, document: { version: 1, root: {
            kind: 'chart', label: 'Rainfall', style: 'bar', rows: [], data: { kind: 'value', value: [{ day: 'Mon', station: 'North', rain: 4 }] },
            x: { path: ['day'], type: 'string' }, series: { path: ['station'], type: 'string' }, value: { path: ['rain'], type: 'number' },
        } } } : { kind, source: { v: 1, entrypoint: 'index.html', files: {
            'index.html': { mime: 'text/html', contentBase64: Buffer.from('<h1>QA HTML</h1>').toString('base64') },
        } } },
    };
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null },
        sessionId: '', mode: 'plain', ctx: null, serverId: account.serverId,
        serverIdentityId: account.serverId, serverHttpBaseUrl: home });
    const executor = createActionExecutor(deps);
    const context = { surface: 'cli', authority: 'present_user', serverId: account.serverId, bypassApprovals: true } as const;
    try {
        const created = await executor.execute('widgets.definition.create', { account, artifactId, definition }, context);
        expect(created, JSON.stringify(created)).toMatchObject({ ok: true, result: { definition: { id: artifactId, body: { kind } } } });
        const surface = { ...account, owner: { kind: 'home' as const } };
        const instance = { v: 1 as const, id: 'qa-copy', definition: { kind: 'artifact' as const, artifactId }, bindings: {} };
        refuseDefinitionRead = true;
        expect(await executor.execute('widgets.item.add', { surface, instance, size: 'full' }, context))
            .toMatchObject({ ok: false, errorCode: 'artifact_read_unavailable' });
        expect(artifacts.read(buildHomeHubArtifactIdV1(account.accountId))).toBeUndefined();
        refuseDefinitionRead = false;
        const added = await executor.execute('widgets.item.add', { surface, instance, size: 'full' }, context);
        expect(added, JSON.stringify(added)).toMatchObject({ ok: true, result: { instance } });
        const stored = artifacts.read(buildHomeHubArtifactIdV1(account.accountId));
        expect(decodePlainArtifactStoredContent(stored!.body)).toMatchObject({ body: expect.stringContaining(artifactId) });
        const board = await deps.workBoardArtifacts!.apply({ kind: 'create', board: { id: boardId, name: 'QA Board' } });
        expect(board).toBeDefined();
        const boardSurface = { ...account, owner: { kind: 'workBoard' as const, boardId } };
        const boardAdd = await executor.execute('widgets.item.add', { surface: boardSurface, instance, size: 'full' }, context);
        expect(boardAdd, JSON.stringify(boardAdd)).toMatchObject({ ok: true, result: { instance } });
        expect(await deps.workBoardArtifacts!.readBoard(boardId)).toMatchObject({ widgets: [{ instance }] });
    } finally { restore(); vi.restoreAllMocks(); await app.close(); }
});
