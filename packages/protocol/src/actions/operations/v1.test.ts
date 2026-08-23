import { describe, expect, it } from 'vitest';

import {
  ACTION_OPERATION_RPC_METHODS_V1,
  ACTION_OPERATION_PROGRESS_LABEL_MAX_LENGTH_V1,
  ACTION_OPERATION_PROGRESS_PHASE_MAX_LENGTH_V1,
  ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1,
  ActionOperationDeclarationV1Schema,
  ActionOperationProgressV1Schema,
  ActionOperationDomainRefV1Schema,
  ActionOperationSnapshotV1Schema,
  ActionOperationCancelV1RequestSchema,
  ActionOperationCancelV1ResponseSchema,
  ActionOperationGetV1RequestSchema,
  ActionOperationGetV1ResponseSchema,
  ActionOperationListV1RequestSchema,
  ActionOperationListV1ResponseSchema,
  ActionOperationSnapshotPushV1Schema,
} from './v1.js';

const baseSnapshot = {
  version: 1,
  operationId: 'operation-1',
  revision: 1,
  actionId: 'session.spawn_new',
  state: 'accepted',
  scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
  title: 'Create session',
  createdAt: 100,
  cancellation: 'unsupported',
} as const;

describe('Action operation v1 contract', () => {
  it('owns the exact additive machine RPC method names', () => {
    expect(ACTION_OPERATION_RPC_METHODS_V1).toEqual({
      list: 'actionOperation.list.v1',
      get: 'actionOperation.get.v1',
      cancel: 'actionOperation.cancel.v1',
    });
  });

  it('accepts only the exact v1 Action declaration', () => {
    expect(ActionOperationDeclarationV1Schema.parse({
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    })).toEqual({
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    });
    for (const onStart of ['current', 'detail', 'activity'] as const) {
      expect(ActionOperationDeclarationV1Schema.safeParse({
        version: 1,
        visibility: 'activity',
        progress: 'reported',
        presentation: { onStart },
      }).success).toBe(true);
    }
    expect(ActionOperationDeclarationV1Schema.safeParse({
      version: 2,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    }).success).toBe(false);
    expect(ActionOperationDeclarationV1Schema.safeParse({
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      title: 'Duplicated presentation',
    }).success).toBe(false);
  });

  it('enforces bounded truthful progress', () => {
    expect(ActionOperationProgressV1Schema.parse({
      kind: 'determinate', current: 2, total: 4, label: 'Uploading',
    })).toEqual({ kind: 'determinate', current: 2, total: 4, label: 'Uploading' });

    for (const progress of [
      { kind: 'determinate', current: -1, total: 4 },
      { kind: 'determinate', current: 5, total: 4 },
      { kind: 'determinate', current: 1, total: 0 },
      { kind: 'determinate', current: Number.POSITIVE_INFINITY, total: 4 },
      { kind: 'phase', phase: '', label: 'Preparing' },
      { kind: 'phase', phase: 'p'.repeat(ACTION_OPERATION_PROGRESS_PHASE_MAX_LENGTH_V1 + 1), label: 'Preparing' },
      { kind: 'phase', phase: 'prepare', label: 'l'.repeat(ACTION_OPERATION_PROGRESS_LABEL_MAX_LENGTH_V1 + 1) },
    ]) {
      expect(ActionOperationProgressV1Schema.safeParse(progress).success).toBe(false);
    }
  });

  it('keeps the common v1 progress bounds', () => {
    expect(ActionOperationProgressV1Schema.safeParse({
      kind: 'phase',
      phase: 'p'.repeat(200),
      label: 'l'.repeat(1_000),
    }).success).toBe(true);
  });

  it('accepts the predecessor fork strategy projection without widening other references', () => {
    expect(ActionOperationDomainRefV1Schema.parse({
      kind: 'forkRequest', id: 'fork-request-1', strategy: 'replay',
    })).toEqual({ kind: 'forkRequest', id: 'fork-request-1', strategy: 'replay' });
    expect(ActionOperationDomainRefV1Schema.safeParse({
      kind: 'handoff', id: 'handoff-1', strategy: 'native',
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
      kind: 'spawnAttempt', id: 'spawn-1', targetMachineId: 'machine-target',
    }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({
      kind: 'handoff', id: 'handoff-1', targetMachineId: ' ',
    }).success).toBe(false);
  });

  it('keeps the remote-dev predecessor redacted failure shape as common v1', () => {
    // remote-dev's strict public failure projection has exactly errorCode + error.
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      state: 'failed',
      startedAt: 110,
      settledAt: 120,
      error: { errorCode: 'spawn_failed', error: 'Session creation failed' },
    }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      state: 'failed',
      startedAt: 110,
      settledAt: 120,
      error: {
        errorCode: 'spawn_failed',
        error: 'Session creation failed',
        details: { token: 'must-not-cross-the-public-operation-wire' },
      },
    }).success).toBe(false);
  });

  it('enforces the remote-dev predecessor common snapshot bounds', () => {
    const predecessorBoundarySnapshot = {
      ...baseSnapshot,
      operationId: 'o'.repeat(2_000),
      actionId: 'a'.repeat(2_000),
      scope: {
        accountId: 'c'.repeat(2_000),
        machineId: 'm'.repeat(2_000),
        sessionId: 's'.repeat(2_000),
      },
      title: 't'.repeat(10_000),
    } as const;
    expect(ActionOperationSnapshotV1Schema.safeParse(predecessorBoundarySnapshot).success).toBe(true);

    for (const incompatible of [
      { ...baseSnapshot, operationId: 'o'.repeat(2_001) },
      { ...baseSnapshot, actionId: 'a'.repeat(2_001) },
      { ...baseSnapshot, scope: { ...baseSnapshot.scope, accountId: 'c'.repeat(2_001) } },
      { ...baseSnapshot, title: 't'.repeat(10_001) },
      { ...baseSnapshot, createdAt: 100.5 },
      {
        ...baseSnapshot,
        state: 'failed',
        startedAt: 110,
        settledAt: 120,
        error: { errorCode: 'e'.repeat(201), error: 'Failed' },
      },
      {
        ...baseSnapshot,
        state: 'failed',
        startedAt: 110,
        settledAt: 120,
        error: { errorCode: 'failed', error: 'e'.repeat(10_001) },
      },
    ]) {
      expect(ActionOperationSnapshotV1Schema.safeParse(incompatible).success).toBe(false);
    }
  });

  it('requires a positive revision and state-consistent lifecycle payload', () => {
    expect(ActionOperationSnapshotV1Schema.parse(baseSnapshot)).toEqual(baseSnapshot);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...baseSnapshot, revision: 0 }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...baseSnapshot, startedAt: 110 }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot, state: 'running', startedAt: 110,
    }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      state: 'succeeded',
      startedAt: 110,
      settledAt: 120,
      result: { sessionId: 'new-session' },
    }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      state: 'failed',
      startedAt: 110,
      settledAt: 120,
      error: { errorCode: 'spawn_failed', error: 'Session creation failed' },
    }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot, state: 'failed', startedAt: 110, settledAt: 120,
    }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      state: 'cancelled',
      startedAt: 110,
      settledAt: 120,
      result: { shouldNotExist: true },
    }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot, state: 'succeeded', startedAt: 110, settledAt: 105,
    }).success).toBe(false);
  });

  it('keeps raw invocation input outside the strict snapshot wire shape', () => {
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      input: { token: 'secret' },
    }).success).toBe(false);
  });

  it('carries bounded request correlation without making it the operation identity', () => {
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      requestId: 'r'.repeat(ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1),
    }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      requestId: 'r'.repeat(ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1 + 1),
    }).success).toBe(false);
  });

  it('owns a strict encrypted machine push envelope', () => {
    const envelope = {
      v: 1,
      machineId: 'machine-1',
      ciphertext: 'ciphertext',
    } as const;
    expect(ActionOperationSnapshotPushV1Schema.parse(envelope)).toEqual(envelope);
    expect(ActionOperationSnapshotPushV1Schema.safeParse({ ...envelope, extra: true }).success).toBe(false);
  });

  it('validates every additive machine RPC payload', () => {
    expect(ActionOperationListV1RequestSchema.safeParse({
      states: ['accepted', 'running'], sessionId: 'session-1', cursor: 'cursor-1',
    }).success).toBe(true);
    expect(ActionOperationListV1ResponseSchema.safeParse({
      items: [baseSnapshot], nextCursor: null,
    }).success).toBe(true);
    expect(ActionOperationGetV1RequestSchema.safeParse({ operationId: 'operation-1' }).success).toBe(true);
    expect(ActionOperationGetV1ResponseSchema.safeParse({ kind: 'found', operation: baseSnapshot }).success).toBe(true);
    expect(ActionOperationGetV1ResponseSchema.safeParse({ kind: 'not_found' }).success).toBe(true);
    expect(ActionOperationCancelV1RequestSchema.safeParse({ operationId: 'operation-1' }).success).toBe(true);
    for (const kind of ['unsupported', 'requested', 'already_settled', 'not_found'] as const) {
      expect(ActionOperationCancelV1ResponseSchema.safeParse({ kind }).success).toBe(true);
    }

  });

});
