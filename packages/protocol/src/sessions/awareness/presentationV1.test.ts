import { describe, expect, it } from 'vitest';

import { listSessionPresentationStatesForWorkStatusFilterV1, readSessionAwarenessPresentationV1, readSessionAwarenessWorkStatusV1, readSessionWorkStateGroupV1, readSessionManagedSessionsPresentationV1 } from './presentationV1.js';
import { projectSessionAwarenessV1 } from './projectV1.js';

describe('readSessionAwarenessWorkStatusV1', () => {
  it('preserves blocked-input recovery separately from real requests without changing Session attention', () => {
    const blocked = projectSessionAwarenessV1({
      sessionId: 'carrier', nowMs: 1_000_000, content: { mode: 'plain' },
      runtime: { presence: 'online', active: true, lastObservedAtMs: 1_000_000 },
      lifecycle: {}, pending: { queuedInputCount: 3, blockedInputCount: 3 },
      currentness: { lifecycle: 'observed', runtime: 'observed', pending: 'observed', work: 'observed' },
    });
    expect(readSessionAwarenessWorkStatusV1({ awareness: blocked })).toMatchObject({
      state: 'action_required', bucket: 'needs_you', tone: 'attention', actionRequiredReason: 'blocked_input',
    });
    expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'idle', operational: { primary: 'none' },
      viewer: { attention: { reasons: ['pending_blocked'] } } } })).toMatchObject({ actionRequiredReason: 'blocked_input' });
    for (const awareness of [
      { ...blocked, operational: { ...blocked.operational, reasons: [...blocked.operational.reasons, 'action_required' as const] } },
      { ...blocked, viewer: { attention: { reasons: ['user_action_required' as const, 'pending_blocked' as const] } } },
      { runtime: 'idle' as const, operational: { primary: 'action_required' as const } },
    ]) {
      expect(readSessionAwarenessWorkStatusV1({ awareness })).toMatchObject({
        state: 'action_required', bucket: 'needs_you', actionRequiredReason: 'request',
      });
    }
    expect(readSessionAwarenessWorkStatusV1({ awareness: { ...blocked, operational: {
      ...blocked.operational, reasons: [...blocked.operational.reasons, 'permission_required'],
    } } })).toMatchObject({ state: 'permission_required', bucket: 'needs_you' });
  });
  it('keeps a completed worker settled across runtime detach and observation expiry', () => {
    const nowMs = 1_000_000;
    for (const runtime of [
      { presence: 'online', active: true, lastObservedAtMs: nowMs },
      { presence: 'online', active: true, lastObservedAtMs: nowMs - 60_000 },
      { presence: 'offline', active: false, lastObservedAtMs: nowMs },
      { presence: 'offline', active: false, lastObservedAtMs: nowMs - 60_000 },
      { presence: 'unknown', active: false, lastObservedAtMs: nowMs - 60_000 },
    ] as const) {
      for (const processTerminalState of [null, 'stopped'] as const) {
        const awareness = projectSessionAwarenessV1({
          sessionId: 'worker', nowMs, content: { mode: 'plain' }, runtime, pending: {},
          lifecycle: { latestTurnStatus: 'completed', latestTurnStatusObservedAtMs: nowMs - 1_000,
            processTerminalState },
          currentness: { lifecycle: 'observed', runtime: 'observed', pending: 'observed', work: 'observed' },
        });
        expect(awareness.operational.primary).toBe('ready');
        expect(readSessionAwarenessWorkStatusV1({ awareness, settled: true }))
          .toMatchObject({ state: 'ready', bucket: 'finished', tone: 'neutral' });
        if (processTerminalState) expect(awareness.processTerminalState).toBe('stopped');
      }
    }
  });
  it('keeps cancellation, new work, and explicit resume distinct from a completed worker', () => {
    const base = {
      sessionId: 'worker', nowMs: 1_000_000, content: { mode: 'plain' }, pending: {},
      lifecycle: { latestTurnStatus: 'completed', processTerminalState: 'stopped' },
      runtime: { presence: 'online', active: true, lastObservedAtMs: 1_000_000 },
      currentness: { lifecycle: 'observed', runtime: 'observed', pending: 'observed', work: 'observed' },
    } as const;
    const state = (value: Parameters<typeof projectSessionAwarenessV1>[0]) =>
      readSessionAwarenessPresentationV1(projectSessionAwarenessV1(value));
    expect(state({ ...base, lifecycle: { ...base.lifecycle, latestTurnStatus: 'cancelled' } })).toBe('stopped');
    expect(state({ ...base, lifecycle: { ...base.lifecycle, latestTurnStatus: 'in_progress' } })).toBe('thinking');
    expect(state({ ...base, runtime: { ...base.runtime, resumingAtMs: base.nowMs } })).toBe('resuming');
    expect(state({ ...base, runtime: { ...base.runtime, controlServiceability: 'recoverable_unservable' } }))
      .toBe('recoverable_unservable');
    expect(state({ ...base, lifecycle: { latestTurnStatus: 'completed' }, runtime: {
      ...base.runtime, activityState: 'active', activityActiveCount: 1,
    } })).toBe('background_active');
  });
  it('keeps the admitted archive operation working without inventing runtime activity', () => {
    const awareness = { runtime: 'idle', encryption: 'plain', archiving: true, operational: { primary: 'none' } } as const;
    expect(readSessionAwarenessWorkStatusV1({ awareness })).toMatchObject({ state: 'archiving', bucket: 'working', tone: 'neutral' });
  });
  it('keeps unseen failure rose across disconnect and retains independent current request evidence', () => {
    const awareness = { runtime: 'offline', encryption: 'plain', operational: { primary: 'failed', reasons: ['failed', 'permission_required'] },
      viewer: { attention: { reasons: ['failed'] } } } as const;
    expect(readSessionAwarenessWorkStatusV1({ awareness })).toMatchObject({ state: 'failed', bucket: 'idle', tone: 'danger' });
    expect(readSessionAwarenessPresentationV1({ ...awareness, viewer: { attention: { reasons: [] } } })).toBe('permission_required');
  });
  it('admits stopped only from the process lifecycle fact and composes personal news quietly', () => {
    const awareness = { runtime: 'offline', encryption: 'plain', operational: { primary: 'none' } } as const;
    expect(readSessionAwarenessPresentationV1({ ...awareness, processTerminalState: 'stopped' })).toBe('stopped');
    expect(readSessionAwarenessPresentationV1(awareness)).toBe('disconnected');
    const idle = { ...awareness, runtime: 'idle' } as const;
    expect(readSessionAwarenessPresentationV1({ ...idle, viewer: { attention: { reasons: ['ready_after_read', 'unread'] } } })).toBe('finished_unseen');
    expect(readSessionAwarenessPresentationV1({ ...idle, viewer: { attention: { reasons: ['mentioned', 'unread'] } } })).toBe('mentioned');
  });

  it('keeps a quiet Session waiting when the viewer explicitly keeps it in Needs you', () => {
    const awareness = { runtime: 'idle', operational: { primary: 'none' } } as const;
    expect(readSessionAwarenessPresentationV1({ ...awareness, viewer: { attention: { reasons: ['manual'] } } })).toBe('waiting');
    expect(readSessionAwarenessPresentationV1({ ...awareness, viewer: { attention: { reasons: ['manual', 'unread'] } } })).toBe('unread');
  });
  it('keeps background activity in Working and its status filter until it settles', () => {
    const awareness = { runtime: 'background_active', encryption: 'plain', operational: { primary: 'none' } } as const;
    for (const freshness of ['live', 'stale'] as const) {
      const status = readSessionAwarenessWorkStatusV1({ awareness: { ...awareness, freshness }, settled: true });
      expect(status).toMatchObject({ state: 'background_active', bucket: 'working', tone: 'neutral' });
      expect(readSessionWorkStateGroupV1(status.bucket)).toBe('working');
    }
    expect(listSessionPresentationStatesForWorkStatusFilterV1('working')).toContain('background_active');
    expect(readSessionAwarenessWorkStatusV1({ awareness: { ...awareness, runtime: 'idle' }, settled: true }))
      .toMatchObject({ bucket: 'finished', tone: 'neutral' });
  });
  it('does not turn offline in-flight reports into working reports in a summary', () => {
    expect(readSessionManagedSessionsPresentationV1({ working: 0, needsYou: 0, stalled: 4, finished: 0, attentionPrimary: 'disconnected' }))
      .toMatchObject({ bucket: 'offline', count: 4 });
    expect(readSessionManagedSessionsPresentationV1({ working: 1, needsYou: 0, stalled: 3, finished: 0, attentionPrimary: 'thinking' }))
      .toMatchObject({ bucket: 'working', count: 1 });
    expect(readSessionManagedSessionsPresentationV1({ working: 1, needsYou: 2, stalled: 3, finished: 0, attentionPrimary: 'permission_required' }))
      .toMatchObject({ bucket: 'needs_you', count: 2 });
    expect(readSessionManagedSessionsPresentationV1({ working: 0, needsYou: 0, stalled: 0, finished: 0, attentionPrimary: null }))
      .toMatchObject({ bucket: 'idle', count: 0 });
  });

  it('preserves strongest report failure independently of request and finished progress counts', () => {
    for (const needsYou of [0, 1]) {
      expect(readSessionManagedSessionsPresentationV1({ working: 1, needsYou, stalled: 1, finished: 3, attentionPrimary: 'failed' }))
        .toEqual({ state: 'failed', bucket: 'idle', tone: 'danger', count: 0, finished: 3 });
    }
    expect(readSessionManagedSessionsPresentationV1({ working: 0, needsYou: 0, stalled: 0, finished: 3, attentionPrimary: 'finished_unseen' }))
      .toEqual({ state: 'finished_unseen', bucket: 'finished', tone: 'neutral', count: 3, finished: 3 });
  });
  it('preserves public offline status while content hydration is undecided', () => {
    const awareness = { runtime: 'offline', encryption: 'unknown', operational: { primary: 'working' } } as const;
    expect(readSessionAwarenessPresentationV1(awareness)).toBe('disconnected');
    expect(readSessionAwarenessWorkStatusV1({ awareness })).toMatchObject({ bucket: 'offline', tone: 'neutral' });
    // A settled content failure still explains its own recovery, rather than reading as hydrated.
    expect(readSessionAwarenessPresentationV1({ ...awareness, encryption: 'repair_needed' })).toBe('repair_needed');
  });

  it('keeps disconnected work quiet and in Recent, even with previous settlement', () => {
    for (const settled of [false, true]) {
      const status = readSessionAwarenessWorkStatusV1({
        awareness: { runtime: 'offline', operational: { primary: 'none' } }, settled,
      });
      expect(status).toMatchObject({ bucket: 'offline', tone: 'neutral' });
      expect(readSessionWorkStateGroupV1(status.bucket)).toBe('recent');
    }
  });

  it('retains the current request over disconnected presence', () => {
    for (const primary of ['permission_required', 'action_required'] as const) {
      expect(readSessionAwarenessWorkStatusV1({
        awareness: { runtime: 'offline', operational: { primary } }, settled: true,
      })).toMatchObject({ bucket: 'needs_you', tone: 'attention' });
    }
    expect(readSessionAwarenessPresentationV1({ runtime: 'offline', encryption: 'plain',
      operational: { primary: 'none' }, viewer: { attention: { reasons: ['permission_required'] } } })).toBe('permission_required');
  });

  it('withholds private state when unreadable and preserves admitted requests across presence loss', () => {
    for (const primary of ['failed', 'permission_required', 'action_required', 'working'] as const) {
      for (const encryption of ['locked', 'preparing', 'repair_needed', 'access_pending', 'setup_required', 'content_unavailable', 'unknown'] as const) {
        expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'working', encryption,
          operational: { primary } } })).toMatchObject({ bucket: 'idle', tone: 'neutral' });
      }
      expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'offline', encryption: 'ready',
        operational: { primary } } })).toMatchObject(primary === 'permission_required' || primary === 'action_required'
          ? { bucket: 'needs_you', tone: 'attention' } : { bucket: 'offline', tone: 'neutral' });
      expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'working', freshness: 'stale',
        encryption: 'plain', operational: { primary } } })).toMatchObject(primary === 'permission_required' || primary === 'action_required'
          ? { bucket: 'needs_you', tone: 'attention' } : { bucket: 'idle', tone: 'neutral' });
    }
  });

  it('preserves known operational facts without manufacturing runtime reachability', () => {
    for (const primary of ['failed', 'permission_required', 'action_required', 'working', 'ready', 'pending_input', 'none'] as const) {
      const awareness = { runtime: 'unknown', freshness: 'unknown', encryption: 'plain', operational: { primary } } as const;
      const status = readSessionAwarenessWorkStatusV1({ awareness });
      expect(readSessionAwarenessPresentationV1(awareness)).toBe(primary === 'working' ? 'thinking' : primary === 'none' || primary === 'failed' ? 'unknown' : primary);
      expect(status).toMatchObject(primary === 'working' ? { bucket: 'working', tone: 'neutral' }
        : primary === 'failed' ? { bucket: 'idle', tone: 'neutral' }
          : primary === 'permission_required' || primary === 'action_required' ? { bucket: 'needs_you', tone: 'attention' }
            : { bucket: 'idle', tone: 'neutral' });
      expect(readSessionAwarenessWorkStatusV1({ awareness: { ...awareness, freshness: 'stale' } }))
        .toMatchObject(primary === 'permission_required' || primary === 'action_required'
          ? { bucket: 'needs_you', tone: 'attention' } : { bucket: 'idle', tone: 'neutral' });
    }
    for (const reason of ['runtime_unservable', 'resuming'] as const) {
      expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'unknown', encryption: 'ready',
        operational: { primary: 'none', reasons: [reason] } } }))
        .toMatchObject({ bucket: reason === 'runtime_unservable' ? 'offline' : 'idle', tone: 'neutral' });
    }
  });

  it('preserves live actionable facts and quiet settlement', () => {
    for (const primary of ['permission_required', 'action_required'] as const) {
      expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'waiting', encryption: 'ready',
        operational: { primary } } })).toMatchObject({ bucket: 'needs_you', tone: 'attention' });
    }
    expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'idle', encryption: 'plain',
      operational: { primary: 'ready' } }, settled: true })).toMatchObject({ bucket: 'finished', tone: 'neutral' });
    expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'offline', lifecycle: 'archived',
      encryption: 'locked', operational: { primary: 'failed' } } })).toMatchObject({ bucket: 'idle', tone: 'neutral' });
    expect(readSessionAwarenessWorkStatusV1({ awareness: { runtime: 'offline', encryption: 'plain',
      operational: { primary: 'working', reasons: ['resuming'] } } })).toMatchObject({ bucket: 'idle', tone: 'neutral' });
  });
});
