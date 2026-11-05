import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sessionRpc from '@/session/transport/rpc/sessionRpc';
import { buildApprovalDecisionResult } from '@happier-dev/protocol/actions/executor/approvalResults';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { replayLiveCliApprovalOrigin } from './replayLiveOrigin';
import { createLiveCliApprovalOrigin } from './liveOrigin';

const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
  createdBy: { surface: 'cli' }, actionId: 'secrets.create', actionArgs: { name: 'fixture' }, summary: 'Review',
  approval: { flow: 'blocking', result: 'required' }, executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli',
    caller: { kind: 'host' }, serverId: 'home', serverIdentityId: 'srv_home', accountId: 'alice',
    actionId: 'secrets.create', requestId: 'request' } });
const account = { token: 'account-token', accountId: 'alice', serverUrl: 'https://home.test', isCurrent: async () => true };

describe('live CLI approval decision replay', () => {
  afterEach(() => vi.restoreAllMocks());
  it('publishes an admitted daemon CLI waiter without installing a standalone CLI relay', async () => {
    // Home authorization is the external boundary; the request schema and
    // publisher remain real. This test exercises transport selection, not signing.
    const target = { kind: 'machine' as const, machineId: 'machine-a' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
      accountId: 'alice', custodianAccountId: 'alice', authentication: { kind: 'terminal', tokenEpoch: 0 },
      serverIdentityId: 'srv_home', machineId: 'machine-a', installationId: 'installation-a',
      actionId: 'secrets.create', requestId: 'request', requestEnvelopeDigest: 'A'.repeat(43), target,
      accountEncryptionMode: 'plain',
    } });
    const signed = ApprovalRequestV2Schema.parse({ ...request, executionOriginV1: { ...request.executionOriginV1,
      target, machineId: target.machineId, externalActionExecutionAuthorization: authorization,
      externalActionInputSignature: 'A'.repeat(86) } });
    const origin = createLiveCliApprovalOrigin({ ...account, decide: async () => ({ ok: true, result: null }) });
    expect(await origin.publish({ request: signed }, async () => ({ artifactId: 'daemon-waiter' })))
      .toEqual({ artifactId: 'daemon-waiter' });
    expect(await replayLiveCliApprovalOrigin({ artifactId: 'daemon-waiter', request: signed, decision: 'approve',
      context: { surface: 'cli', authority: 'present_user' } }, account)).toBeNull();
  });

  it('does not use the CLI live-origin transport for an agent invocation', async () => {
    const agent = ApprovalRequestV2Schema.parse({ ...request, executionOriginV1: { ...request.executionOriginV1,
      surface: 'agent', caller: { kind: 'session', sessionId: 'session-a', starterDepth: 0, turnDepth: 0 },
      machineId: 'machine-a', sessionId: 'session-a' } });
    expect(await replayLiveCliApprovalOrigin({ artifactId: 'artifact', request: agent, decision: 'approve',
      context: { surface: 'cli', authority: 'present_user' } }, account)).toBeNull();
  });
  it('keeps the decision receipt when the effect completes before the caller aborts', async () => {
    const controller = new AbortController();
    const receipt = buildApprovalDecisionResult(ApprovalRequestV2Schema.parse({ ...request, status: 'approved', updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 } }));
    let effectCompleted = false;
    // The RPC transport is the boundary: its origin finishes the effect before
    // cancellation is observed by this caller and the decision reply arrives.
    vi.spyOn(sessionRpc, 'callSessionRpc').mockImplementationOnce(async () => {
      effectCompleted = true;
      controller.abort();
      return receipt;
    });
    const capturedAccount = { ...account, isCurrent: async () => !controller.signal.aborted };
    const result = await replayLiveCliApprovalOrigin({ artifactId: 'artifact', request, decision: 'approve',
      signal: controller.signal, context: { surface: 'cli', authority: 'present_user' } }, capturedAccount);
    expect(effectCompleted).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(result).toEqual(receipt);
  });
});
