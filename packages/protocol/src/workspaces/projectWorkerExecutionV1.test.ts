import { describe, expect, it } from 'vitest';
import { FiniteAdmissionV1Schema, WorkerLoadObservationV1Schema } from './index.js';

describe('finite worker execution public protocol', () => {
  it('keeps acceptance exact and refuses unknown authority fields or invented refusal variants', () => {
    const accepted = { kind: 'accepted', operationId: 'op', machineId: 'machine', workspaceRefId: 'workspace' };
    expect(FiniteAdmissionV1Schema.parse(accepted)).toEqual(accepted);
    expect(FiniteAdmissionV1Schema.safeParse({ ...accepted, actorAccountId: 'forged' }).success).toBe(false);
    expect(FiniteAdmissionV1Schema.safeParse({ kind: 'not_accepted', reason: 'policy_unavailable' }).success).toBe(false);
    expect(FiniteAdmissionV1Schema.parse({ kind: 'not_accepted', reason: 'memory_insufficient' }))
      .toEqual({ kind: 'not_accepted', reason: 'memory_insufficient' });
  });
  it('keeps unknown load distinct from zero and applies the canonical positive-or-null ceiling', () => {
    expect(WorkerLoadObservationV1Schema.parse({ kind: 'unknown' })).toEqual({ kind: 'unknown' });
    const known = { kind: 'known', running: 2, queued: 3, accepting: false, runAtMost: null };
    expect(WorkerLoadObservationV1Schema.parse(known)).toEqual(known);
    expect(WorkerLoadObservationV1Schema.safeParse({ ...known, runAtMost: 0 }).success).toBe(false);
    expect(WorkerLoadObservationV1Schema.safeParse({ ...known, running: -1 }).success).toBe(false);
    expect(WorkerLoadObservationV1Schema.safeParse({ ...known, queued: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(WorkerLoadObservationV1Schema.safeParse({ kind: 'unknown', running: 0 }).success).toBe(false);
  });
});
