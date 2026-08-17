import { describe, expect, it } from 'vitest';

import {
  SessionPendingEnqueueByMachineRequestV1Schema,
  SessionPendingEnqueueByMachineResponseV1Schema,
} from './sessionPendingMachineAdmissionV1.js';

describe('Session Pending machine admission V1', () => {
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
    expect(SessionPendingEnqueueByMachineResponseV1Schema.parse({
      v: 1,
      result: { status: 'accepted', localId: 'machine-input-1' },
    })).toEqual({ v: 1, result: { status: 'accepted', localId: 'machine-input-1' } });
    expect(SessionPendingEnqueueByMachineResponseV1Schema.parse({
      v: 1,
      result: { status: 'rejected', code: 'session_input_target_update_required' },
    })).toEqual({ v: 1, result: { status: 'rejected', code: 'session_input_target_update_required' } });
  });
});
