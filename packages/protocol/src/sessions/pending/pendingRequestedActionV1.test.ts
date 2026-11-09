import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PENDING_REQUESTED_ACTION_V1,
  PendingRequestedActionV1Schema,
  normalizePendingRequestedActionV1,
} from './pendingRequestedActionV1';

describe('PendingRequestedActionV1', () => {
  it('preserves explicit recovery in its new epoch while retained ordinary V1 remains readable', () => {
    const recovery = { v: 2, kind: 'recover_execution_run' };
    expect(PendingRequestedActionV1Schema.parse(recovery)).toEqual(recovery);
    expect(normalizePendingRequestedActionV1(recovery, 'stored')).toEqual(recovery);
    expect(normalizePendingRequestedActionV1({ v: 1, kind: 'enqueue' }, 'stored')).toEqual({ v: 1, kind: 'enqueue' });
    for (const invalid of [
      { ...recovery, v: 1 }, { ...recovery, extra: true }, { v: 2, kind: 'enqueue' },
    ]) expect(PendingRequestedActionV1Schema.safeParse(invalid).success).toBe(false);
  });

  it.each(['enqueue', 'steer_if_active', 'steer_now', 'send_now'] as const)(
    'accepts the canonical %s action',
    (kind) => {
      expect(PendingRequestedActionV1Schema.parse({ v: 1, kind })).toEqual({ v: 1, kind });
    },
  );

  it('defaults only omitted legacy actions and rejects malformed non-null actions', () => {
    expect(normalizePendingRequestedActionV1(undefined)).toEqual(DEFAULT_PENDING_REQUESTED_ACTION_V1);
    expect(normalizePendingRequestedActionV1(null)).toEqual(DEFAULT_PENDING_REQUESTED_ACTION_V1);
    expect(() => normalizePendingRequestedActionV1({ v: 1, kind: 'interrupt_and_send' }))
      .toThrow('Malformed non-null Pending requested action');
  });

  it('projects annotated retained actions while keeping fresh input and known reset identity strict', () => {
    const reset = { source: { bindingKind: 'account', ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai' }, accountId: 'account' } },
      recordId: 'paug_v1_abcdefgh', meterId: 'weekly', witness: { id: 'accepted-history-entry', observedAtMs: 1000 } };
    const annotated = { v: 1, kind: 'reset_start', retired: true, reset: { ...reset, retired: true,
      source: { ...reset.source, retired: true, ref: { ...reset.source.ref, retired: true,
        service: { ...reset.source.ref.service, retired: true } } }, witness: { ...reset.witness, retired: true } } };
    expect(normalizePendingRequestedActionV1(annotated, 'stored')).toEqual({ v: 1, kind: 'reset_start', reset });
    expect(normalizePendingRequestedActionV1({ v: 1, kind: 'enqueue', retired: true }, 'stored')).toEqual({ v: 1, kind: 'enqueue' });
    expect(normalizePendingRequestedActionV1(undefined, 'stored')).toEqual(DEFAULT_PENDING_REQUESTED_ACTION_V1);
    expect(normalizePendingRequestedActionV1(null, 'stored')).toEqual(DEFAULT_PENDING_REQUESTED_ACTION_V1);
    expect(() => normalizePendingRequestedActionV1(annotated)).toThrow('Malformed non-null Pending requested action');
    for (const invalid of [{ v: 1, kind: 'future_action' }, { ...annotated, reset: { ...annotated.reset,
      source: { ...reset.source, ref: { ...reset.source.ref, service: { ...reset.source.ref.service, pluginId: ' ' } } } } }]) {
      expect(() => normalizePendingRequestedActionV1(invalid, 'stored')).toThrow('Malformed non-null Pending requested action');
    }
  });

  it('binds reset start to an accepted B witness without admitting copied protected schedule fields', () => {
    const reset = { source: { bindingKind: 'account', ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai' }, accountId: 'account' } },
      recordId: 'paug_v1_abcdefgh', meterId: 'weekly', witness: { id: 'accepted-history-entry', observedAtMs: 1000 } };
    const requestedAction = { v: 1, kind: 'reset_start', reset };
    expect(PendingRequestedActionV1Schema.parse(requestedAction)).toEqual(requestedAction);
    expect(PendingRequestedActionV1Schema.safeParse({ ...requestedAction, reset: { ...reset, resetAtMs: 2000 } }).success).toBe(false);
    expect(PendingRequestedActionV1Schema.safeParse({ ...requestedAction, reset: { ...reset, witness: { ...reset.witness, latest: true } } }).success).toBe(false);
    expect(PendingRequestedActionV1Schema.safeParse({ v: 1, kind: 'reset_start' }).success).toBe(false);
  });
});
