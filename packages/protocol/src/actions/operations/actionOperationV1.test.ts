import { describe, expect, it } from 'vitest';

import {
  ACTION_OPERATION_RPC_METHODS_V1,
  ActionOperationCancelV1RequestSchema,
  ActionOperationCancelV1ResponseSchema,
  ActionOperationGetV1RequestSchema,
  ActionOperationGetV1ResponseSchema,
  ActionOperationDomainRefV1Schema,
  ActionOperationListV1RequestSchema,
  ActionOperationListV1ResponseSchema,
  ActionOperationProgressV1Schema,
  ActionOperationSnapshotV1Schema,
  ActionOperationRevisionEphemeralV1Schema,
} from './actionOperationV1.js';

const acceptedSnapshot = {
  version: 1,
  operationId: 'operation-1',
  revision: 1,
  actionId: 'session.spawn_new',
  state: 'accepted',
  scope: {
    accountId: 'account-1',
    machineId: 'machine-1',
    sessionId: 'session-1',
  },
  title: 'Create session',
  createdAt: 1_000,
  progress: { kind: 'indeterminate', label: 'Waiting to start' },
  cancellation: 'unsupported',
} as const;

describe('Action operation v1 protocol', () => {
  it('owns the exact additive machine RPC method names', () => {
    expect(ACTION_OPERATION_RPC_METHODS_V1).toEqual({
      list: 'actionOperation.list.v1',
      get: 'actionOperation.get.v1',
      cancel: 'actionOperation.cancel.v1',
    });
    expect(Object.isFrozen(ACTION_OPERATION_RPC_METHODS_V1)).toBe(true);
  });

  it('accepts truthful progress and rejects invalid determinate or unbounded values', () => {
    expect(ActionOperationProgressV1Schema.parse({
      kind: 'phase',
      phase: 'creating',
      label: 'Creating session',
    })).toEqual({ kind: 'phase', phase: 'creating', label: 'Creating session' });
    expect(ActionOperationProgressV1Schema.parse({
      kind: 'determinate',
      current: 2,
      total: 5,
    })).toEqual({ kind: 'determinate', current: 2, total: 5 });

    for (const invalid of [
      { kind: 'determinate', current: -1, total: 5 },
      { kind: 'determinate', current: 6, total: 5 },
      { kind: 'determinate', current: 1, total: 0 },
      { kind: 'determinate', current: Number.NaN, total: 5 },
      { kind: 'determinate', current: 1, total: Number.POSITIVE_INFINITY },
      { kind: 'phase', phase: '', label: 'Creating session' },
      { kind: 'phase', phase: 'x'.repeat(201), label: 'Creating session' },
      { kind: 'indeterminate', label: 'x'.repeat(1_001) },
    ]) {
      expect(ActionOperationProgressV1Schema.safeParse(invalid).success).toBe(false);
    }
  });

  it('pins the common v1 bounds consumed by the dev successor', () => {
    // Golden boundary vectors consumed by dev's successor schema. Provenance is this predecessor
    // file at HEAD 70bddc6bef333b74430417e870aad61be251a0a8 plus its untracked operation-schema worktree bytes.
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...acceptedSnapshot,
      requestId: 'r'.repeat(2_000),
    }).success).toBe(true);
    expect(ActionOperationProgressV1Schema.safeParse({
      kind: 'phase',
      phase: 'p'.repeat(200),
      label: 'l'.repeat(1_000),
    }).success).toBe(true);
  });

  it('carries bounded request correlation and an opaque encrypted account event', () => {
    expect(ActionOperationSnapshotV1Schema.parse({
      ...acceptedSnapshot,
      requestId: 'request-1',
    }).requestId).toBe('request-1');
    expect(ActionOperationRevisionEphemeralV1Schema.parse({
      type: 'action-operation-updated',
      machineId: 'machine-1',
      content: { t: 'encrypted', c: 'ciphertext' },
    })).toEqual({
      type: 'action-operation-updated',
      machineId: 'machine-1',
      content: { t: 'encrypted', c: 'ciphertext' },
    });
    expect(ActionOperationRevisionEphemeralV1Schema.safeParse({
      type: 'action-operation-updated',
      machineId: 'machine-1',
      content: { t: 'plain', v: acceptedSnapshot },
    }).success).toBe(false);
  });

  it('preserves the canonical fork strategy only on fork request references', () => {
    expect(ActionOperationDomainRefV1Schema.parse({
      kind: 'forkRequest', id: 'fork-request-1', strategy: 'replay',
    })).toEqual({ kind: 'forkRequest', id: 'fork-request-1', strategy: 'replay' });
    expect(ActionOperationDomainRefV1Schema.safeParse({
      kind: 'spawnAttempt', id: 'spawn-1', strategy: 'replay',
    }).success).toBe(false);
  });

  it('accepts the optional common-v1 handoff target without widening other references', () => {
    expect(ActionOperationDomainRefV1Schema.parse({
      kind: 'handoff', id: 'handoff-1',
    })).toEqual({ kind: 'handoff', id: 'handoff-1' });
    expect(ActionOperationDomainRefV1Schema.parse({
      kind: 'handoff', id: 'handoff-1', targetMachineId: 'machine-target',
    })).toEqual({ kind: 'handoff', id: 'handoff-1', targetMachineId: 'machine-target' });
    expect(ActionOperationDomainRefV1Schema.safeParse({
      kind: 'forkRequest', id: 'fork-1', targetMachineId: 'machine-target',
    }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({
      kind: 'handoff', id: 'handoff-1', targetMachineId: '',
    }).success).toBe(false);
  });

  it('accepts only the dev successor common redacted failure projection', () => {
    const failedSnapshot = {
      ...acceptedSnapshot,
      state: 'failed',
      revision: 2,
      startedAt: 1_100,
      settledAt: 1_200,
      error: { errorCode: 'spawn_failed', error: 'Session creation failed.' },
    } as const;

    expect(ActionOperationSnapshotV1Schema.safeParse(failedSnapshot).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...failedSnapshot,
      error: {
        ...failedSnapshot.error,
        details: { token: 'must-not-cross-the-public-operation-wire' },
      },
    }).success).toBe(false);
  });

  it('enforces monotonic timestamps and state-specific terminal fields', () => {
    expect(ActionOperationSnapshotV1Schema.parse(acceptedSnapshot)).toEqual(acceptedSnapshot);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...acceptedSnapshot,
      state: 'running',
      revision: 2,
      startedAt: 1_100,
      progress: { kind: 'phase', phase: 'creating', label: 'Creating session' },
    }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...acceptedSnapshot,
      state: 'succeeded',
      revision: 3,
      startedAt: 1_100,
      settledAt: 1_200,
      result: { sessionId: 'new-session' },
    }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...acceptedSnapshot,
      state: 'failed',
      revision: 3,
      startedAt: 1_100,
      settledAt: 1_200,
      error: { errorCode: 'spawn_failed', error: 'Session creation failed.' },
    }).success).toBe(true);

    for (const invalid of [
      { ...acceptedSnapshot, revision: 0 },
      { ...acceptedSnapshot, state: 'running', revision: 2 },
      { ...acceptedSnapshot, state: 'accepted', startedAt: 1_100 },
      { ...acceptedSnapshot, state: 'succeeded', revision: 2, startedAt: 1_100, settledAt: 1_050 },
      { ...acceptedSnapshot, state: 'succeeded', revision: 2, startedAt: 1_100 },
      { ...acceptedSnapshot, state: 'running', revision: 2, startedAt: 1_100, result: {} },
      { ...acceptedSnapshot, state: 'failed', revision: 2, startedAt: 1_100, settledAt: 1_200 },
      { ...acceptedSnapshot, state: 'failed', revision: 2, startedAt: 1_100, settledAt: 1_200, result: {}, error: { errorCode: 'failed', error: 'Failed.' } },
      { ...acceptedSnapshot, state: 'cancelled', revision: 2, startedAt: 1_100, settledAt: 1_200, error: { errorCode: 'cancelled', error: 'Cancelled.' } },
      { ...acceptedSnapshot, input: { token: 'must-not-be-stored' } },
    ]) {
      expect(ActionOperationSnapshotV1Schema.safeParse(invalid).success).toBe(false);
    }
  });

  it('validates every observation/control RPC payload without changing legacy execution results', () => {
    expect(ActionOperationListV1RequestSchema.safeParse({
      states: ['accepted', 'running'],
      sessionId: 'session-1',
      cursor: 'cursor-1',
    }).success).toBe(true);
    expect(ActionOperationListV1ResponseSchema.safeParse({
      items: [acceptedSnapshot],
      nextCursor: null,
    }).success).toBe(true);

    expect(ActionOperationGetV1RequestSchema.safeParse({ operationId: 'operation-1' }).success).toBe(true);
    expect(ActionOperationGetV1ResponseSchema.safeParse({ kind: 'found', operation: acceptedSnapshot }).success).toBe(true);
    expect(ActionOperationGetV1ResponseSchema.safeParse({ kind: 'not_found' }).success).toBe(true);

    expect(ActionOperationCancelV1RequestSchema.safeParse({ operationId: 'operation-1' }).success).toBe(true);
    for (const kind of ['unsupported', 'requested', 'already_settled', 'not_found'] as const) {
      expect(ActionOperationCancelV1ResponseSchema.safeParse({ kind }).success).toBe(true);
    }

  });
});
