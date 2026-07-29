import { describe, expect, it, vi } from 'vitest';

import {
  decideRuntimeIdleAdmission,
  isSessionRuntimeActivityProjectionIdleForPendingDrain,
  mergeSessionRuntimeActivityProjection,
  parseSessionRuntimeActivityProjectionFields,
  SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX,
  SessionRuntimeActivityProjectionSchema,
  SessionRuntimeActivitySnapshotSchema,
  SessionRuntimeActivityStateSchema,
} from './sessionRuntimeActivity.js';
import {
  SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT,
  SessionRuntimeActivityCloseAckSchema,
  SessionRuntimeActivityCloseRequestSchema,
} from './transport.js';

describe('Session Runtime Activity', () => {
  it('freezes the cross-repository coarse vocabulary and bound', () => {
    expect(SessionRuntimeActivityStateSchema.options).toEqual(['active', 'idle', 'unknown']);
    expect(SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX).toBe(2_147_483_647);
  });

  it('defines a strict exact-session clean-close transport', () => {
    expect(SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT).toBe('session-runtime-activity-close');
    expect(SessionRuntimeActivityCloseRequestSchema.parse({ sessionId: 's1' })).toEqual({ sessionId: 's1' });
    expect(SessionRuntimeActivityCloseRequestSchema.safeParse({ sessionId: 's1', sid: 'legacy' }).success).toBe(false);
    expect(SessionRuntimeActivityCloseAckSchema.parse({ status: 'closed', sessionId: 's1' })).toEqual({
      status: 'closed',
      sessionId: 's1',
    });
    expect(SessionRuntimeActivityCloseAckSchema.safeParse({ status: 'closed', sessionId: 's2', extra: true }).success).toBe(false);
  });

  it.each([
    { state: 'active', activeCount: 1 },
    { state: 'active', activeCount: SESSION_RUNTIME_ACTIVITY_ACTIVE_COUNT_MAX },
    { state: 'idle', activeCount: 0 },
    { state: 'unknown', activeCount: 0 },
  ])('accepts complete producer snapshot %#', (snapshot) => {
    expect(SessionRuntimeActivitySnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it.each([
    { state: 'active', activeCount: 0 },
    { state: 'idle', activeCount: 1 },
    { state: 'unknown', activeCount: 1 },
  ])('rejects contradictory or retired producer snapshot %#', (snapshot) => {
    expect(SessionRuntimeActivitySnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it.each(['observedAt', 'revision', 'expiresAt', 'expiresAtMs', 'v', 'lease']) (
    'rejects producer-owned %s',
    (field) => {
      expect(SessionRuntimeActivitySnapshotSchema.safeParse({
        state: 'idle',
        activeCount: 0,
        [field]: field === 'lease' ? 'lease-1' : 1,
      }).success).toBe(false);
    },
  );

  it('accepts exactly the four server-owned projection fields and baseline rules', () => {
    expect(SessionRuntimeActivityProjectionSchema.parse({
      state: 'active',
      activeCount: 2,
      observedAt: 1_000,
      revision: 7,
    })).toEqual({
      state: 'active',
      activeCount: 2,
      observedAt: 1_000,
      revision: 7,
    });
    expect(SessionRuntimeActivityProjectionSchema.safeParse({
      state: 'idle',
      activeCount: 0,
      observedAt: null,
      revision: 0,
      expiresAt: 2_000,
    }).success).toBe(false);
    expect(SessionRuntimeActivityProjectionSchema.safeParse({
      state: 'idle',
      activeCount: 0,
      observedAt: 1,
      revision: 0,
    }).success).toBe(false);
    expect(SessionRuntimeActivityProjectionSchema.safeParse({
      state: 'unknown',
      activeCount: 0,
      observedAt: null,
      revision: 7,
    }).success).toBe(true);
    expect(SessionRuntimeActivityProjectionSchema.safeParse({
      state: 'idle',
      activeCount: 0,
      observedAt: null,
      revision: 7,
    }).success).toBe(false);
  });

  it('parses flat fields atomically and merges only by revision', () => {
    const current = { state: 'active' as const, activeCount: 2, observedAt: 500, revision: 7 };
    expect(parseSessionRuntimeActivityProjectionFields({
      runtimeActivityState: 'idle',
      runtimeActivityActiveCount: 0,
      runtimeActivityObservedAt: 400,
      runtimeActivityRevision: 8,
    })).toEqual({
      kind: 'valid',
      projection: { state: 'idle', activeCount: 0, observedAt: 400, revision: 8 },
    });
    expect(parseSessionRuntimeActivityProjectionFields({
      runtimeActivityState: 'idle',
      runtimeActivityRevision: 8,
    })).toEqual({ kind: 'invalid' });
    expect(parseSessionRuntimeActivityProjectionFields({
      runtimeActivityState: 'idle',
      runtimeActivityActiveCount: 0,
      runtimeActivityObservedAt: 400,
      runtimeActivityRevision: 8,
      runtimeActivitySourceClass: null,
    })).toEqual({ kind: 'invalid' });
    expect(mergeSessionRuntimeActivityProjection(current, {
      state: 'idle',
      activeCount: 0,
      observedAt: 400,
      revision: 8,
    }).decision).toBe('replace');
    expect(mergeSessionRuntimeActivityProjection(current, {
      state: 'idle',
      activeCount: 0,
      observedAt: 900,
      revision: 6,
    }).decision).toBe('ignore_stale');
    expect(mergeSessionRuntimeActivityProjection(current, current).decision).toBe('ignore_identical');
    expect(mergeSessionRuntimeActivityProjection(current, {
      state: 'idle',
      activeCount: 0,
      observedAt: 900,
      revision: 7,
    }).decision).toBe('resync_conflict');
  });

  it('decides Pending admission from state and exact revision, never clocks', () => {
    expect(isSessionRuntimeActivityProjectionIdleForPendingDrain).toHaveLength(1);
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const unknown = SessionRuntimeActivityProjectionSchema.parse({
      state: 'unknown',
      activeCount: 0,
      observedAt: 10,
      revision: 9,
    });
    expect(decideRuntimeIdleAdmission(unknown)).toEqual({
      decision: 'defer',
      reason: 'unknown',
      revision: 9,
    });
    vi.setSystemTime(10_000_000);
    expect(decideRuntimeIdleAdmission(unknown)).toEqual({
      decision: 'defer',
      reason: 'unknown',
      revision: 9,
    });
    expect(decideRuntimeIdleAdmission({
      ...unknown,
      state: 'idle',
    })).toEqual({ decision: 'allow', revision: 9 });
    vi.useRealTimers();
  });
});
