import fastify from 'fastify';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { deriveApprovalRequestSourceIdFromIdentityV1 } from '@happier-dev/protocol/approvals/creation';
import { deriveAccountScopedArtifactIdV1 } from '@happier-dev/protocol/artifacts/idScope';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliApprovalsArtifactStore } from './artifactStore';
import { executeOriginalAccountCliApprovalRequest } from './originalAccountRequest';

it.each(['deferred', 'blocking'] as const)('presents original Account approval only through its %s flow owner', async flow => {
  const socket = await createRequesterCurrentnessSocketHarness();
  onTestFinished(() => socket.close());
  const app = fastify();
  onTestFinished(() => app.close());
  const actionId = 'usage.sources.consent.set';
  const target = { kind: 'machine' as const, machineId: 'machine' };
  const accountId = 'owner';
  const homeId = 'srv_home';
  const requestId = 'source-consent-request';
  const artifactId = deriveAccountScopedArtifactIdV1(accountId, deriveApprovalRequestSourceIdFromIdentityV1({
    homeId, accountId, requesterId: accountId, requestId, actionId, target,
  }));
  const request = ApprovalRequestV2Schema.parse({ v: 2, createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId,
    actionArgs: { serverId: homeId, machineId: target.machineId, sourceId: 'source' },
    summary: 'Stop usage collection', status: 'open', approval: { flow, result: 'required' },
    executionOriginV1: { v: 1, serverId: 'local-home', serverIdentityId: homeId, accountId,
      machineId: target.machineId, target, actionId, requestId, surface: 'cli',
      authority: flow === 'deferred' ? 'account_automation' : 'present_user', caller: { kind: 'host' } },
  });
  let observed!: () => void;
  const observationFinished = new Promise<void>(resolve => { observed = resolve; });
  socket.server.on('connection', peer => { peer.once('disconnect', observed); });
  app.get('/v1/artifacts/:id', async () => {
    return { id: artifactId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
      header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
      seq: 1, createdAt: 1, updatedAt: 1 };
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing Home fixture address');
  const serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;
  const store = createCliApprovalsArtifactStore({ credentials: { token: 'token', encryption: null },
    getAccountEncryptionMode: async () => 'plain', serverHttpBaseUrl });
  const executor = createActionExecutor({ approvalsGet: store.approvalsGet });
  const presented = vi.fn();
  const proposal = { ok: true as const, result: { kind: 'approval_request_created' as const, artifactId, actionId } };
  const lifetime = new AbortController();
  onTestFinished(() => lifetime.abort());
  const pending = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => executeOriginalAccountCliApprovalRequest({
    actionId, requestId, homeId, accountId, target, token: 'token', serverHttpBaseUrl,
    context: { surface: 'cli', authority: 'account_automation', runtimeAccountId: accountId, signal: lifetime.signal },
    execute: executor.execute,
    // Terminal presentation and the original Home HTTP response are the system
    // boundaries. The observer, Action read and Artifact decoder remain real.
    onApprovalRequested: presented,
    run: async () => {
      // Hold Home's response until the observer has consumed the open request.
      // Its actual socket retirement makes this ordering deterministic.
      await observationFinished;
      return proposal;
    },
  }));
  await expect(pending).resolves.toEqual(proposal);
  expect(presented).toHaveBeenCalledTimes(flow === 'blocking' ? 1 : 0);
  expect(socket.clients.every(client => !client.active)).toBe(true);
});
