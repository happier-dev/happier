import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { API_TOKEN_FULL_GRANT_V1, AutomationV3RunMutationResponseSchema } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createHarness, resetFilesystemApprovalSocketBoundary } from './executeExternalAction.filesystemApprovals.testkit';

afterEach(() => { vi.restoreAllMocks(); resetFilesystemApprovalSocketBoundary(); resetServerFeaturesClientForTests(); });

describe('installed API-token approval HTTP custody', () => {
  it.each([
    { name: 'request identity', key: undefined, revoked: false },
    { name: 'signed retry key', key: 'signed-manual-key', revoked: false },
    { name: 'revoked requester', key: 'signed-manual-key', revoked: true },
  ])('reacquires the original signed requester after Artifact decoding: $name', async ({ key, revoked }) => {
    resetServerFeaturesClientForTests();
    let h: Awaited<ReturnType<typeof createHarness>>;
    let effects = 0;
    let requesterCurrent = true;
    const receipt = AutomationV3RunMutationResponseSchema.parse({ run: {
      id: 'run-1', automationId: 'automation-1', revision: 1, triggerId: null, triggerRetired: false,
      state: 'queued', cause: { kind: 'manual', invokedAt: 1 }, dueAt: 1, claimedAt: null, startedAt: null,
      finishedAt: null, claimedByMachineId: null, leaseExpiresAt: null, attempt: 0, errorCode: null,
      producedSessionId: null, executionDispatchState: null, executionAttempt: 0, replyHandoffState: 'none',
      replyHandoffAttempt: 0, replyHandoffDueAt: null, createdAt: 1, updatedAt: 1,
    } });
    const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['workflow.trigger.run_now'] }, automationIds: ['automation-1'] };
    h = await createHarness('workflow.trigger.run_now', 'ask', false, 'srv_portableHome', {
      token: `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 1,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`,
      mintAuthorization: async (actionId, envelope) => ExternalActionExecutionAuthorizationV1Schema.parse({
        v: 1, token: 'synthetic-home-root', binding: {
          accountId: 'account', custodianAccountId: 'account',
          ...(actionId === 'workflow.trigger.run_now'
            ? { principalId: 'account', credentialId: 'limited-token', grant, automationId: 'automation-1',
                ...(envelope.idempotencyKey === undefined ? {} : { idempotencyKey: envelope.idempotencyKey }) }
            : { authentication: { kind: 'account', tokenEpoch: 1 } }),
          accountEncryptionMode: 'plain', serverIdentityId: 'srv_portableHome', machineId: 'machine',
          installationId: h.installation.installationId, actionId, requestId: envelope.requestId,
          target: envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        },
      }),
      request: request => {
        // Artifact persistence is the existing Home boundary in this harness;
        // only the Action effect and currentness are supplied by this case.
        if (request.path.startsWith('/v1/artifacts')) return null;
        if (request.path.endsWith('/verify')) return Promise.resolve({ status: 200,
          data: { ok: request.path.includes('/workflow.trigger.run_now/') ? requesterCurrent : true } });
        expect(request.path).toBe('/v3/automations/automation-1/run-now');
        expect(request.headers).not.toHaveProperty('Authorization');
        expect(request.headers['Idempotency-Key']).toBe(key);
        expect(verifyExternalActionMachineRequestV1({ authorizationToken: request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]!,
          effectActionId: 'workflow.trigger.run_now', target: { kind: 'machine', machineId: 'machine' },
          installationId: h.installation.installationId, requestId: 'original-request', method: request.method, path: request.path,
          ...(request.headers['Idempotency-Key'] === undefined ? {} : { idempotencyKey: request.headers['Idempotency-Key'] }),
          signature: request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]!,
          publicKey: Buffer.from(h.installation.publicKey, 'base64url') })).toBe(true);
        effects++;
        return Promise.resolve({ status: 200, data: receipt });
      },
    });
    const originalPost = vi.mocked(axios.post).getMockImplementation();
    const originalGet = vi.mocked(axios.get).getMockImplementation();
    if (!originalPost || !originalGet) throw new Error('Missing Home HTTP boundary');
    const approvalWrites: Array<Record<string, string>> = [];
    const approvalReads: Array<Record<string, string>> = [];
    const effectWrites: Array<Record<string, string>> = [];
    vi.mocked(axios.get).mockImplementation(async (...args) => {
      if (new URL(String(args[0])).pathname.startsWith('/v1/artifacts/')) {
        approvalReads.push({ ...args[1]?.headers } as Record<string, string>);
      }
      return originalGet(...args);
    });
    vi.mocked(axios.post).mockImplementation(async (...args) => {
      const path = new URL(String(args[0])).pathname;
      if (path.startsWith('/v1/artifacts')) {
        approvalWrites.push({ ...args[2]?.headers } as Record<string, string>);
      }
      if (path === '/v3/automations/automation-1/run-now') effectWrites.push({ ...args[2]?.headers } as Record<string, string>);
      return originalPost(...args);
    });
    try {
      const created = await h.run({ automationId: 'automation-1', ...(key === undefined ? {} : { idempotencyKey: key }) }, 'cli');
      expect(created, JSON.stringify(created)).toMatchObject({ ok: true,
        result: { kind: 'approval_request_created' } });
      expect(effects).toBe(0);
      expect(approvalWrites).toEqual([expect.objectContaining({
        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'synthetic-home-root',
      })]);
      expect(approvalWrites[0]?.Authorization).toBeUndefined();
      const stored = await h.approval();
      expect(stored.executionOriginV1.externalActionExecutionAuthorization).not.toHaveProperty('requesterHttpProjection');
      const readsBeforeDecision = approvalReads.length;
      requesterCurrent = !revoked;
      const decision = await h.decide('approve');
      expect(approvalReads.slice(readsBeforeDecision).some(headers =>
        headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === 'synthetic-home-root' && !headers.Authorization),
      ).toBe(true);
      expect(approvalWrites.at(-1), JSON.stringify(approvalWrites)).toMatchObject({
        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'synthetic-home-root',
      });
      expect(approvalWrites.at(-1)?.Authorization).toBeUndefined();
      if (!revoked) {
        expect(effectWrites, JSON.stringify(effectWrites)).toEqual([expect.objectContaining({
          [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'synthetic-home-root',
        })]);
        expect(effectWrites[0]?.Authorization).toBeUndefined();
      }
      const settled = await h.approval();
      if (revoked) {
        expect(settled, JSON.stringify({ decision, status: settled.status, execution: settled.execution })).toMatchObject({
          execution: { ok: false, errorCode: 'approval_stale' },
        });
        expect(effects).toBe(0);
        return;
      }
      expect(settled, JSON.stringify({ status: settled.status, execution: settled.execution,
        networkPaths: h.networkPaths, effects, effectWrites })).toMatchObject({
        status: 'executed', execution: { ok: true, result: receipt },
      });
      expect(effects).toBe(1);
    } finally { await h.close(); }
  });
});
