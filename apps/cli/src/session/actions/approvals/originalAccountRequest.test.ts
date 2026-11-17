import fastify from 'fastify';
import { expect, it, onTestFinished, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliApprovalsArtifactStore } from './artifactStore';
import { executeOriginalAccountCliApprovalRequest } from './originalAccountRequest';

const accountId = 'owner';
const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId, session: 'terminal', tokenEpoch: 1,
  provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;

it.each(['deferred', 'blocking', 'root_invoke_blocking', 'target_durable', 'target_live_only'] as const)('presents original Account approval only through its %s flow owner', async flow => {
  const socket = await createRequesterCurrentnessSocketHarness();
  onTestFinished(() => socket.close());
  const app = fastify();
  onTestFinished(() => app.close());
  const targetFlow = flow === 'target_durable' || flow === 'target_live_only';
  const actionId = targetFlow || flow === 'root_invoke_blocking' ? 'action.invoke' : 'usage.sources.consent.set';
  const input = actionId === 'action.invoke' ? { action: { pluginId: 'acme.native', localId: 'write' }, input: { value: 'fixture' } }
    : { serverId: 'srv_home', machineId: 'machine', sourceId: 'source' };
  const target = { kind: 'machine' as const, machineId: 'machine' };
  const homeId = 'srv_home';
  const requestId = 'source-consent-request';
  const rows = new Map<string, Record<string, unknown>>();
  let published = false;
  let missedAfterPublication!: () => void;
  const missed = new Promise<void>(resolve => { missedAfterPublication = resolve; });
  const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: homeId } } });
  app.get('/v1/features', async () => features);
  app.get('/v1/features/authenticated', async () => features);
  app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
  app.get<{ Params: { id: string } }>('/v1/artifacts/:id', async (request, reply) => {
    const row = rows.get(request.params.id);
    if (row) return row;
    // A miss after the Ask exists means the observer read another identity.
    if (published) missedAfterPublication();
    return reply.code(404).send();
  });
  app.post<{ Body: { id: string; header: string; body: string; dataEncryptionKey: string } }>('/v1/artifacts', async request => {
    const row = { ...request.body, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    rows.set(row.id, row);
    return row;
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing Home fixture address');
  const serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;
  const store = createCliApprovalsArtifactStore({ credentials: { token, encryption: null },
    getAccountEncryptionMode: async () => 'plain', serverHttpBaseUrl });
  let artifactId: string;
  if (targetFlow) {
    // The target's real producer creates this Ask under the origin Home admitted
    // for the original invocation; the observer must find that exact identity.
    artifactId = (await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.targetActionApprovalsCreate({
      request: TargetActionApprovalRequestV1Schema.parse({ v: 1, kind: 'plugin_target_action', status: 'open',
        createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'cli' }, requestedSurface: 'cli',
        qualifiedActionId: 'acme.native/actions/write', input: { value: 'fixture' },
        ...(flow === 'target_live_only' ? { approvalInputCustody: 'live_only' } : {}),
        sourceCustody: { kind: 'development', registeredRootId: 'owned-root' },
        policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Write fixture',
        executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
          serverId: 'local-home', serverIdentityId: homeId, accountId, machineId: target.machineId, target,
          actionId, requestId } }),
    }))).artifactId;
  } else {
    // A root built-in Ask, including the host's own `action.invoke` review,
    // is created by the built-in producer under the same invocation origin.
    artifactId = (await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.approvalsCreate({ serverId: 'local-home',
      request: ApprovalRequestV2Schema.parse({ v: 2, createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId, actionArgs: input,
        summary: 'Stop usage collection', status: 'open',
        approval: { flow: flow === 'deferred' ? 'deferred' : 'blocking', result: 'required' },
        executionOriginV1: { v: 1, serverId: 'local-home', serverIdentityId: homeId, accountId,
          machineId: target.machineId, target, actionId, requestId, surface: 'cli',
          authority: flow === 'deferred' ? 'account_automation' : 'present_user', caller: { kind: 'host' } },
      }) }))).artifactId;
  }
  published = true;
  let observed!: () => void;
  const observationFinished = new Promise<void>(resolve => { observed = resolve; });
  socket.server.on('connection', peer => { peer.once('disconnect', observed); });
  const executor = createActionExecutor({ approvalsGet: store.approvalsGet });
  const presented = vi.fn();
  const proposal = { ok: true as const, result: { kind: 'approval_request_created' as const, artifactId, actionId } };
  const lifetime = new AbortController();
  onTestFinished(() => lifetime.abort());
  const pending = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => executeOriginalAccountCliApprovalRequest({
    actionId, requestId, homeId, accountId, target, token, serverHttpBaseUrl,
    context: { surface: 'cli', authority: 'account_automation', runtimeAccountId: accountId, signal: lifetime.signal },
    execute: executor.execute,
    // Terminal presentation and the original Home HTTP response are the system
    // boundaries. The producer, observer, Action read and Artifact decoder remain real.
    onApprovalRequested: presented,
    run: async signal => {
      // Hold Home's response until the observer has consumed the open request
      // (its actual socket retirement) or has read an identity that does not exist.
      await Promise.race([observationFinished, missed, new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })]);
      return proposal;
    },
  }));
  await expect(pending).resolves.toEqual(proposal);
  expect(presented).toHaveBeenCalledTimes(flow === 'deferred' || flow === 'target_durable' ? 0 : 1);
  if (flow !== 'deferred' && flow !== 'target_durable') expect(presented.mock.calls[0]?.[0]).toBe(artifactId);
  expect(socket.clients.every(client => !client.active)).toBe(true);
});
