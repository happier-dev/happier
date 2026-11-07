import { describe, expect, it } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1 } from '../../auth/apiTokenGrant.js';
import {
  SessionExecutionRunPendingEnqueueRequestV1Schema,
  SessionPendingExecutionRunEnqueueByMachineRequestV2Schema,
  SessionPendingExecutionRunEnqueueByMachineResponseV2Schema,
  SessionPendingExecutionRunMaterializeNextRequestV2Schema,
  SessionPendingExecutionRunAcceptedRequestV2Schema,
  SessionPendingExecutionRunMaterializeNextResponseV2Schema,
} from './sessionPendingExecutionRunMachineAdmissionV2.js';

import {
  SessionPendingEnqueueByMachineRequestV1Schema,
  SessionPendingEnqueueByMachineResponseV1Schema,
  SessionPendingTemplateOnboardingRequestV1Schema,
} from './sessionPendingMachineAdmissionV1.js';
import { SessionPendingAdmissionSettlementResponseV1Schema } from './sessionPendingAdmissionSettlementV1.js';

describe('Session Pending machine admission V1', () => {
  it('admits owner onboarding without an Action root while keeping its input narrower than general Pending', () => {
    const body = { request: { v: 1, sessionId: 'session-1', targetMachineId: 'machine-1', localId: 'initial-input',
        content: { t: 'encrypted', c: 'input-cipher' }, requestedAction: { v: 1, kind: 'send_now' },
        requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'A'.repeat(43) } } };
    expect(SessionPendingTemplateOnboardingRequestV1Schema.safeParse(body).success).toBe(true);
    expect(SessionPendingTemplateOnboardingRequestV1Schema.safeParse({ ...body, authorization: { token: 'root' } }).success).toBe(false);
    for (const field of ['reply', 'followSources', 'followRelations', 'followDeliveryV1', 'nextTurnNote', 'externalAction']) {
      expect(SessionPendingTemplateOnboardingRequestV1Schema.safeParse({ ...body, request: { ...body.request, [field]: {} } }).success).toBe(false);
    }
  });
  it('admits only the existing signed execution proof, never caller-authored constraint claims', () => {
    const request = { v: 1, sessionId: 'session-1', targetMachineId: 'machine-1', localId: 'input-1',
      content: { t: 'encrypted', c: 'cipher' }, requestedAction: { v: 1, kind: 'enqueue' } };
    const externalAction = { v: 1, authorization: { v: 1, token: 'proof', binding: {
      serverIdentityId: 'home', accountId: 'owner', custodianAccountId: 'owner', installationId: 'installation-1',
      principalId: 'token-1', credentialId: 'token-1',
      grant: API_TOKEN_FULL_GRANT_V1, machineId: 'machine-1', actionId: 'session.message.send',
      requestId: 'request-1', requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'session', sessionId: 'session-1' },
    } }, effectActionId: 'session.message.send', target: { kind: 'session', sessionId: 'session-1' },
      installationId: 'installation-1', machineSignature: 'A'.repeat(86) };
    expect(SessionPendingEnqueueByMachineRequestV1Schema.safeParse({ ...request, externalAction }).success).toBe(true);
    for (const field of ['custodianAccountId', 'installationId'] as const) {
      const { [field]: _requiredFact, ...binding } = externalAction.authorization.binding;
      expect(SessionPendingEnqueueByMachineRequestV1Schema.safeParse({ ...request,
        externalAction: { ...externalAction, authorization: { ...externalAction.authorization, binding } },
      }).success).toBe(false);
    }
    expect(SessionPendingEnqueueByMachineRequestV1Schema.safeParse({ ...request, callerInputConstraints: { models: null, permissionModes: null } }).success).toBe(false);
  });
  it('exposes a separate closed Account target resource instead of widening main admission', () => {
    const targetSchema = SessionExecutionRunPendingEnqueueRequestV1Schema;
    const input = { v: 1, localId: 'target-input', targetMachineId: 'machine-1', content: { t: 'encrypted', c: 'cipher' } };
    expect(targetSchema.safeParse(input).success).toBe(true);
    expect(targetSchema.safeParse({ ...input, requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'A'.repeat(43) } }).success).toBe(false);
    expect(targetSchema.safeParse({ ...input, content: { ...input.content, recipient: { kind: 'execution_run', runId: 'other' } } }).success).toBe(false);
  });

  it('keeps target Machine identity and settlement closed and separate from V1', () => {
    const recipient = { kind: 'execution_run', runId: 'run-1' } as const;
    const request = {
      v: 2, sessionId: 'session-1', targetMachineId: 'machine-1', recipient,
      localId: 'target-input', content: { t: 'encrypted', c: 'cipher' },
      requestedAction: { v: 1, kind: 'enqueue' },
      requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'A'.repeat(43) },
    };
    expect(SessionPendingExecutionRunEnqueueByMachineRequestV2Schema.safeParse(request).success).toBe(true);
    expect(SessionPendingExecutionRunEnqueueByMachineRequestV2Schema.safeParse({ ...request, recipient: { ...recipient, label: 'display' } }).success).toBe(false);
    expect(SessionPendingExecutionRunEnqueueByMachineRequestV2Schema.safeParse({ ...request, content: { t: 'plain', v: {} } }).success).toBe(false);
    expect(SessionPendingEnqueueByMachineRequestV1Schema.safeParse({ ...request, v: 1 }).success).toBe(false);
    const materialize = { v: 2, sessionId: 'session-1', recipient, sidechainId: 'sidechain-1', deliveryTiming: 'after_runtime_idle', foregroundState: 'ready' };
    expect(SessionPendingExecutionRunMaterializeNextRequestV2Schema.safeParse(materialize).success).toBe(true);
    expect(SessionPendingExecutionRunMaterializeNextRequestV2Schema.safeParse({ ...materialize, authorAccountId: 'spoofed' }).success).toBe(false);
    expect(SessionPendingExecutionRunAcceptedRequestV2Schema.safeParse({ v: 2, sessionId: 'session-1', recipient, localId: 'target-input' }).success).toBe(false);
  });

  it('requires exact target and authenticated author evidence on materialized input', () => {
    const ack = {
      v: 2, ok: true, didMaterialize: true, didWrite: false,
      recipient: { kind: 'execution_run', runId: 'run-1' }, sidechainId: 'sidechain-1',
      authorAccountId: 'collaborator-1', pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 4,
      deliveryState: { mode: 'provider', unresolved: true },
      message: {
        id: null, seq: null, localId: 'input-1', content: { t: 'encrypted', c: 'cipher' },
        requestedAction: { v: 1, kind: 'enqueue' }, providerAction: 'send',
        inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: 'collaborator-1', sessionRelationship: 'sharedEditor' },
        createdAt: 1, updatedAt: 1,
      },
    };
    expect(SessionPendingExecutionRunMaterializeNextResponseV2Schema.safeParse(ack).success).toBe(true);
    expect(SessionPendingExecutionRunMaterializeNextResponseV2Schema.safeParse({ ...ack, authorAccountId: null }).success).toBe(false);
    expect(SessionPendingExecutionRunMaterializeNextResponseV2Schema.safeParse({
      ...ack, authorAccountId: null,
      message: { ...ack.message, inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' } },
    }).success).toBe(true);
    expect(SessionPendingExecutionRunMaterializeNextResponseV2Schema.safeParse({ ...ack, authorAccountId: 'custodian' }).success).toBe(false);
    expect(SessionPendingExecutionRunMaterializeNextResponseV2Schema.safeParse({ ...ack, sidechainId: undefined }).success).toBe(false);
    expect(SessionPendingExecutionRunMaterializeNextResponseV2Schema.safeParse({ ...ack, recipient: { ...ack.recipient, label: 'Run title' } }).success).toBe(false);
  });
  it('accepts the strict stored request envelope without a machine identity', () => {
    expect(SessionPendingEnqueueByMachineRequestV1Schema.parse({
      v: 1,
      sessionId: 'session-1',
      targetMachineId: 'machine-target',
      localId: 'machine-input-1',
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
      requestedAction: { v: 1, kind: 'enqueue' },
    })).not.toHaveProperty('machineId');
  });

  it('rejects caller-supplied receipt, machine identity, and plain equality evidence', () => {
    const base = {
      v: 1 as const,
      sessionId: 'session-1',
      targetMachineId: 'machine-target',
      localId: 'machine-input-1',
      content: { t: 'plain' as const, v: { role: 'user' } },
      requestedAction: { v: 1 as const, kind: 'enqueue' as const },
    };
    expect(SessionPendingEnqueueByMachineRequestV1Schema.safeParse({ ...base, machineId: 'machine-1' }).success).toBe(false);
    expect(SessionPendingEnqueueByMachineRequestV1Schema.safeParse({
      ...base,
      inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
    }).success).toBe(false);
    expect(SessionPendingEnqueueByMachineRequestV1Schema.safeParse({
      ...base,
      requestEqualityEvidenceV1: { kind: 'plainDigest', digest: 'A'.repeat(43) },
    }).success).toBe(false);
  });

  it('requires one exact target Machine only as live routing input', () => {
    const base = {
      v: 1 as const,
      sessionId: 'session-1',
      localId: 'machine-input-1',
      content: { t: 'plain' as const, v: { role: 'user' } },
      requestedAction: { v: 1 as const, kind: 'enqueue' as const },
    };
    expect(SessionPendingEnqueueByMachineRequestV1Schema.safeParse(base).success).toBe(false);
    expect(SessionPendingEnqueueByMachineRequestV1Schema.safeParse({
      ...base,
      targetMachineId: ' ',
    }).success).toBe(false);

    const parsed = SessionPendingEnqueueByMachineRequestV1Schema.parse({
      ...base,
      targetMachineId: 'machine-target',
    });
    expect(parsed.targetMachineId).toBe('machine-target');
    expect(parsed).not.toHaveProperty('machineId');
    expect(parsed).not.toHaveProperty('inputAdmissionReceipt');
  });

  it('returns only durable admission truth and typed rejection', () => {
    for (const result of [
      { status: 'accepted', localId: 'machine-input-1' },
      { status: 'alreadyAccepted', localId: 'machine-input-1' },
      { status: 'rejected', code: 'session_input_target_update_required' },
      { status: 'outcomeUnknown', localId: 'machine-input-1', code: 'session_input_admission_outcome_unknown' },
    ]) {
      expect(SessionPendingEnqueueByMachineResponseV1Schema.parse({ v: 1, result })).toEqual({ v: 1, result });
      expect(SessionPendingExecutionRunEnqueueByMachineResponseV2Schema.parse({ v: 2, result })).toEqual({ v: 2, result });
    }
  });

  it('keeps receiver holds at settlement rather than initial enqueue acknowledgements', () => {
    const result = { status: 'held', localId: 'machine-input-1', code: 'autonomous_check_in' };
    expect(SessionPendingEnqueueByMachineResponseV1Schema.safeParse({ v: 1, result }).success).toBe(false);
    expect(SessionPendingExecutionRunEnqueueByMachineResponseV2Schema.safeParse({ v: 2, result }).success).toBe(false);
    expect(SessionPendingAdmissionSettlementResponseV1Schema.parse({ v: 1, result })).toEqual({ v: 1, result });
  });
});
