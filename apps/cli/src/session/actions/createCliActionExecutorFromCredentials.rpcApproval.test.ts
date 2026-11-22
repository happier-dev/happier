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

type ApprovalHome = Readonly<{ home: string; serverId: string; serverIdentityId: string;
  alice: ReturnType<typeof credentialsFor>; bob: ReturnType<typeof credentialsFor>; artifactId: string;
  features: ReturnType<typeof FeaturesResponseSchema.parse>; writePaths: string[];
  store: ReturnType<typeof createCliApprovalsArtifactStore> }>;
const credentialsFor = (accountId: string) => ({ token: `header.${Buffer.from(JSON.stringify({ sub: accountId,
  tokenEpoch: 0, provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`,
  encryption: null, credentialProvenance: 'stored_session' as const });

/** Alice's open plugin approval on a Home whose HTTP persistence is the only substituted boundary. */
async function withApprovalHome(prefix: string, run: (approvalHome: ApprovalHome) => Promise<void>) {
  await withConfiguredDaemonTestHome({ prefix }, async () => {
    const home = 'http://rpc-approval.test';
    const serverIdentityId = 'srv_rpc-approval';
    const serverId = configuration.activeServerId;
    const alice = credentialsFor('alice');
    const bob = credentialsFor('bob');
    const rows = new Map<string, { id: string } & Record<string, unknown>>();
    const writePaths: string[] = [];
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId } } });
    // Home HTTP persistence is the only substituted boundary. The real CLI
    // executor, Artifact codec and approval transition run. As on Home, an
    // Account without a grant cannot read another Account's Artifact.
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
        return row?.ownerAccountId === accountId
          ? { status: 200, data: row } : { status: 404, data: { error: 'Artifact not found' } };
      }
      throw new Error(`Unexpected approval HTTP read ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown, config) => {
      const path = new URL(String(url)).pathname;
      const accountId = String(config?.headers?.Authorization ?? '').includes(bob.token) ? 'bob' : 'alice';
      writePaths.push(path);
      if (path === '/v1/artifacts/read') return artifactReadResponse(body, id => {
        const row = rows.get(id);
        return row?.ownerAccountId === accountId ? row : null;
      });
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
      await run({ home, serverId, serverIdentityId, alice, bob, artifactId: created.artifactId, features, writePaths, store });
    });
  });
}

it('lets the authenticated RPC Account reject its plugin approval while refusing a different Account', async () => {
  await withApprovalHome('workflow-rpc-approval-', async ({ home, serverId, serverIdentityId, alice, bob, artifactId, features, writePaths, store }) => {
    const created = { artifactId };
    const executor = (credentials: typeof alice) => createCliActionExecutorFromCredentials({ credentials, serverId,
      serverApiUrl: home, serverIdentityId, readCredentials: async () => credentials,
      admittedAccountEncryptionMode: 'plain',
      resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated', features }) });
    const context = { surface: 'rpc' as const, authority: 'present_user' as const,
      actionCaller: { kind: 'host' as const } };
    const denied = await executor(bob).execute('approval.request.decide', { artifactId: created.artifactId, decision: 'reject' }, context);
    expect.soft(denied).toMatchObject({ ok: false, errorCode: 'approval_not_found' });
    expect(await store.targetActionApprovalsGet({ artifactId: created.artifactId })).toMatchObject({ status: 'open' });
    const decided = await executor(alice).execute('approval.request.decide', { artifactId: created.artifactId, decision: 'reject' }, context);
    expect(decided, JSON.stringify({ decided, writePaths })).toMatchObject({ ok: true, result: { status: 'rejected' } });
    expect(await store.targetActionApprovalsGet({ artifactId: created.artifactId })).toMatchObject({ status: 'rejected' });
  });
});

it('reads an Account approval through an external CLI client without a daemon, as decide does', async () => {
  await withApprovalHome('cli-approval-read-no-daemon-', async ({ home, serverId, serverIdentityId, alice, bob, artifactId, features }) => {
    const executor = (credentials: typeof alice) => createCliActionExecutorFromCredentials({ credentials, serverId,
      serverApiUrl: home, serverIdentityId, readCredentials: async () => credentials, externalActionClient: true,
      admittedAccountEncryptionMode: 'plain',
      resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated', features }) });
    const context = { surface: 'cli' as const, authority: 'present_user' as const, actionRequestId: 'read-approval' };
    // This configured Home has no daemon for either Account.
    expect(await executor(alice).execute('approval.request.get', { artifactId }, context))
      .toMatchObject({ ok: true, result: { artifactId, request: { status: 'open' } } });
    expect(await executor(bob).execute('approval.request.get', { artifactId }, context))
      .toMatchObject({ ok: false, errorCode: 'approval_not_found' });
  });
});
