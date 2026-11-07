import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { configuration } from '@/configuration';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { artifactReadResponse } from '@/testkit/http/artifactHome';
import { createCliApprovalsArtifactStore } from './approvals/artifactStore';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

afterEach(() => vi.restoreAllMocks());

it('lets the authenticated RPC Account reject its plugin approval while refusing a different Account', async () => {
  await withConfiguredDaemonTestHome({ prefix: 'workflow-rpc-approval-' }, async () => {
    const home = 'http://rpc-approval.test';
    const serverIdentityId = 'srv_rpc-approval';
    const serverId = configuration.activeServerId;
    const credentialsFor = (accountId: string) => ({ token: `header.${Buffer.from(JSON.stringify({ sub: accountId,
      tokenEpoch: 0, provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const });
    const alice = credentialsFor('alice');
    const bob = credentialsFor('bob');
    const rows = new Map<string, { id: string } & Record<string, unknown>>();
    const writePaths: string[] = [];
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId } } });
    // Home HTTP persistence is the only substituted boundary. The real CLI
    // executor, Artifact codec, approval transition and Account binding run.
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const path = new URL(String(url)).pathname;
      const token = String(config?.headers?.Authorization ?? '');
      const accountId = token.includes(bob.token) ? 'bob' : 'alice';
      if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (path.startsWith('/v1/artifacts/')) {
        const row = rows.get(path.split('/').at(-1)!);
        return { status: row ? 200 : 404, data: row };
      }
      throw new Error(`Unexpected approval HTTP read ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      const path = new URL(String(url)).pathname;
      writePaths.push(path);
      if (path === '/v1/artifacts/read') return artifactReadResponse(body, id => rows.get(id) ?? null);
      if (!body || typeof body !== 'object') throw new Error('Expected Artifact body');
      const request = body as Record<string, unknown>;
      if (path === '/v1/artifacts' && typeof request.id === 'string') {
        rows.set(request.id, { ...request, id: request.id, ownerAccountId: 'alice', access: 'owner', encryptionMode: 'plain',
          headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        return { status: 200, data: { id: request.id, headerVersion: 1, bodyVersion: 1 } };
      }
      const id = path.split('/').at(-1)!;
      const row = rows.get(id);
      if (!row) throw new Error('Missing Artifact');
      if (request.expectedHeaderVersion !== undefined && request.expectedHeaderVersion !== row.headerVersion
        || request.expectedBodyVersion !== undefined && request.expectedBodyVersion !== row.bodyVersion) {
        return { status: 200, data: { success: false, error: 'version-mismatch' } };
      }
      const headerVersion = Number(row.headerVersion) + (request.header === undefined ? 0 : 1);
      const bodyVersion = Number(row.bodyVersion) + (request.body === undefined ? 0 : 1);
      rows.set(id, { ...row, ...(request.header === undefined ? {} : { header: request.header }),
        ...(request.body === undefined ? {} : { body: request.body }), headerVersion, bodyVersion });
      return { status: 200, data: { success: true, headerVersion, bodyVersion } };
    });
    await runWithServerHttpBaseUrl(home, async () => {
      const store = createCliApprovalsArtifactStore({ credentials: alice, serverId, serverHttpBaseUrl: home,
        getAccountEncryptionMode: async () => 'plain' });
      const created = await store.targetActionApprovalsCreate({ request: TargetActionApprovalRequestV1Schema.parse({
        v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'agent', sessionId: 'requester-session' }, requestedSurface: 'agent', qualifiedActionId: 'acme.approval/actions/write',
        input: {}, secretInputPaths: [], approvalInputCustody: 'live_only',
        sourceCustody: { kind: 'development', registeredRootId: 'approval-root' },
        policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Review Account write',
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
          caller: { kind: 'session', sessionId: 'requester-session', starterDepth: 0, turnDepth: 0 },
          accountId: 'alice', serverId, serverIdentityId, actionId: 'action.invoke', requestId: 'proposal' },
      }) });
      const executor = (credentials: typeof alice) => createCliActionExecutorFromCredentials({ credentials, serverId,
        serverApiUrl: home, serverIdentityId, readCredentials: async () => credentials,
        admittedAccountEncryptionMode: 'plain',
        resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated', features }) });
      const context = { surface: 'rpc' as const, authority: 'present_user' as const,
        actionCaller: { kind: 'host' as const } };
      const denied = await executor(bob).execute('approval.request.decide', { artifactId: created.artifactId, decision: 'reject' }, context);
      expect.soft(denied).toMatchObject({ ok: false, errorCode: 'approval_stale' });
      expect(await store.targetActionApprovalsGet({ artifactId: created.artifactId })).toMatchObject({ status: 'open' });
      const decided = await executor(alice).execute('approval.request.decide', { artifactId: created.artifactId, decision: 'reject' }, context);
      expect(decided, JSON.stringify({ decided, writePaths })).toMatchObject({ ok: true, result: { status: 'rejected' } });
      expect(await store.targetActionApprovalsGet({ artifactId: created.artifactId })).toMatchObject({ status: 'rejected' });
    });
  });
});
