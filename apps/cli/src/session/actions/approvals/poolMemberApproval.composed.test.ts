import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { accountSettingsParse, decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createCliActionExecutorFromCredentials } from '../createCliActionExecutorFromCredentials';
import { registerAccountHomeHttp, registerPlainArtifactRoutes } from '../widgetApproval.testkit';

it.each([200, 502])('keeps Account pool consent recoverable across an Artifact read response of %s', async readStatus => {
    const base = 'https://pool-approval.test';
    const accountId = 'pool-approval-account';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
        encryption: null, credentialProvenance: 'stored_session' as const };
    const app = Fastify();
    const features = registerAccountHomeHttp(app, { accountId, serverId: 'srv_pool_home',
        settings: accountSettingsParse({}) });
    const artifacts = registerPlainArtifactRoutes(app, accountId);
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const group = { v: 1, ref: { service, groupId: 'codex-pool' }, incarnation: 'pool-life', displayName: 'Codex',
        policy: {}, activeConnectedAccountId: null, generation: 88, runtimeStateRevision: 0,
        state: {}, createdAt: 0, updatedAt: 0,
        members: [{ v: 1, createdAt: 0, updatedAt: 0, connectedAccountId: 'imported-account', priority: 500, enabled: true, state: {} }] };
    const mutations: unknown[] = [];
    let artifactReadsUnavailable = false;
    app.addHook('onRequest', async (request, reply) => {
        if (artifactReadsUnavailable && request.url.startsWith('/v1/artifacts/')) return reply.code(502).send({ error: 'upstream_unavailable' });
    });
    app.post('/v4/connect/qualified/group/members', async request => { mutations.push(request.body); return { group }; });
    const restore = installAxiosFastifyAdapter({ app, origin: base });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path !== '/v1/features' && path !== '/v1/features/authenticated') throw new Error(`Unexpected fetch ${path}`);
        if (path.endsWith('/authenticated')) expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${credentials.token}`);
        return new Response(JSON.stringify(features), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
        const factory = () => createCliActionExecutorFromCredentials({ credentials, serverId: 'pool-profile',
            serverApiUrl: base, machineId: 'contextual-machine' });
        const context = { surface: 'cli' as const, authority: 'present_user' as const,
            actionCaller: { kind: 'host' as const }, actionRequestId: 'pool-proposal' };
        const input = { group: group.ref, connectedAccountId: 'imported-account', priority: 500, enabled: true,
            expectedGeneration: 87, expectedIncarnation: 'pool-life' };
        const proposed = await factory().execute('connectedServices.pools.members.add', input, context);
        expect(proposed).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        if (!proposed.ok || !proposed.result || typeof proposed.result !== 'object' || !('artifactId' in proposed.result)
            || typeof proposed.result.artifactId !== 'string') throw new Error('Expected durable approval');
        const artifactId = proposed.result.artifactId;
        expect(mutations).toEqual([]);
        const approve = () => runWithServerHttpBaseUrl(base, () => createCliActionExecutorFromCredentials({ credentials,
            externalActionClient: true, readCredentials: async () => credentials }).execute('approval.request.decide',
                { artifactId, decision: 'approve' }, { surface: 'cli', actionRequestId: 'pool-decision' }));
        if (readStatus === 502) {
            artifactReadsUnavailable = true;
            expect(await approve()).toMatchObject({ ok: false, errorCode: 'approval_context_unavailable' });
            expect(mutations).toEqual([]);
            const content = decodePlainArtifactStoredContent(artifacts.read(artifactId)!.body);
            if (!content || typeof content !== 'object' || !('body' in content) || typeof content.body !== 'string') throw new Error('Missing Artifact body');
            expect(ApprovalRequestV2Schema.parse(JSON.parse(content.body)).status).toBe('open');
            artifactReadsUnavailable = false;
        }
        const decided = await approve();
        expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(mutations).toEqual([input]);
        const content = decodePlainArtifactStoredContent(artifacts.read(artifactId)!.body);
        if (!content || typeof content !== 'object' || !('body' in content) || typeof content.body !== 'string') throw new Error('Missing Artifact body');
        expect(ApprovalRequestV2Schema.parse(JSON.parse(content.body))).toMatchObject({ status: 'executed',
            executionOriginV1: { accountId, machineId: 'contextual-machine', serverId: 'pool-profile' } });
    } finally { vi.unstubAllGlobals(); resetInMemoryAccountSettingsContextForTests(); restore(); await app.close(); }
});
