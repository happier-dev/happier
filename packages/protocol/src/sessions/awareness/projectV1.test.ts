import { describe, expect, it } from 'vitest';
import { SessionUsageLimitRecoveryV1Schema, projectSessionUsageLimitRecoveryDisplayV1, readSessionUsageLimitRecoveryFromMetadata } from '../state/valueSchemas/usageLimitRecovery.js';

import {
  SESSION_AWARENESS_OPTIMISTIC_PENDING_INPUT_MS,
  SESSION_AWARENESS_RUNTIME_STALE_SIGNAL_MS,
  SessionAwarenessProjectionV1Schema,
  SessionAwarenessLineageV1Schema,
  projectSessionAwarenessV1,
  readSessionAwarenessPresentationV1,
  type ProjectSessionAwarenessV1Input,
} from './index.js';

const NOW = 1_700_000_000_000;

function input(
  overrides: Partial<ProjectSessionAwarenessV1Input> = {},
): ProjectSessionAwarenessV1Input {
  return {
    nowMs: NOW,
    sessionId: 'session-1',
    lifecycle: {},
    runtime: { presence: 'online', active: true },
    pending: {},
    content: { mode: 'plain' },
    currentness: { lifecycle: 'observed', runtime: 'observed', pending: 'observed' },
    ...overrides,
  };
}

describe('projectSessionAwarenessV1 — operational semantics', () => {
  it('presents startup-lock waiting without overriding requests or retaining it after disconnect', () => {
    const waiting = input({ runtime: { presence: 'online', active: true, workStatus: 'waiting_for_startup_lock' },
      pending: { queuedInputCount: 1 } });
    const projection = projectSessionAwarenessV1(waiting);
    expect(projection).toMatchObject({ runtime: 'waiting', workStatus: 'waiting_for_startup_lock' });
    expect(SessionAwarenessProjectionV1Schema.safeParse(projection).success).toBe(true);
    expect(readSessionAwarenessPresentationV1(projection)).toBe('waiting_for_startup_lock');
    expect(readSessionAwarenessPresentationV1(projectSessionAwarenessV1({ ...waiting,
      runtime: { ...waiting.runtime, resumingAtMs: NOW } }))).toBe('waiting_for_startup_lock');
    expect(readSessionAwarenessPresentationV1(projectSessionAwarenessV1({ ...waiting,
      pending: { hasPendingPermissionRequests: true } }))).toBe('permission_required');
    for (const unavailable of [
      { ...waiting, runtime: { ...waiting.runtime, presence: 'offline' as const, active: false } },
      { ...waiting, lifecycle: { processTerminalState: 'stopped' as const } },
      { ...waiting, lifecycle: { archivedAtMs: NOW } },
      { ...waiting, content: { mode: 'e2ee' as const, keyState: 'locked' as const } },
    ]) {
      expect(projectSessionAwarenessV1(unavailable)).not.toHaveProperty('workStatus');
    }
  });
  it('presents a blocking usage issue specifically even after its turn failed, without automatic recovery', () => {
    const projection = projectSessionAwarenessV1(input({
      lifecycle: { latestTurnStatus: 'failed' },
      runtimeIssue: { v: 1, scope: 'primary_session', status: 'failed', source: 'usage_limit', code: 'usage_limit', occurredAt: NOW },
    }));
    expect(projection.operational).toMatchObject({ primary: 'usage_limited' });
    expect(projection.operational.reasons).not.toContain('failed');
    expect(readSessionAwarenessPresentationV1({ ...projection, viewer: { attention: { reasons: ['failed'] } } })).toBe('usage_limited');
    expect(SessionAwarenessProjectionV1Schema.safeParse(projection).success).toBe(true);
    expect(projectSessionAwarenessV1(input({
      lifecycle: { latestTurnStatus: 'in_progress', latestTurnStatusObservedAtMs: NOW + 1, meaningfulActivityAtMs: NOW + 1 },
      runtimeIssue: { v: 1, scope: 'primary_session', status: 'failed', source: 'usage_limit', code: 'usage_limit', occurredAt: NOW },
    })).operational.primary).toBe('working');
  });
  it('binds cancellation to the current issue and never treats reset time or a control acknowledgement as recovery', () => {
    const issue = { v: 1, scope: 'primary_session', status: 'failed', source: 'usage_limit', code: 'usage_limit', occurredAt: NOW } as const;
    const recovery = SessionUsageLimitRecoveryV1Schema.parse({ v: 1, status: 'waiting',
      issueFingerprint: `usage-limit:unknown-agent:unknown-turn:${NOW}:no-reset`, armedAtMs: NOW,
      resetAtMs: NOW - 1, nextCheckAtMs: null, attemptCount: 1, maxAttempts: 3, lastProbeError: null,
      selectedAuth: { kind: 'native' } });
    const base = input({ runtimeIssue: issue, usageLimitRecovery: recovery, lifecycle: { latestTurnStatus: 'failed' } });
    const display = projectSessionUsageLimitRecoveryDisplayV1(recovery);
    expect(projectSessionAwarenessV1({ ...base, usageLimitRecovery: display })).toEqual(projectSessionAwarenessV1(base));
    expect(projectSessionUsageLimitRecoveryDisplayV1(display)).toBe(display);
    expect(readSessionUsageLimitRecoveryFromMetadata({ sessionUsageLimitRecoveryV1: display })).toBeNull();
    for (const status of ['waiting', 'checking', 'paused', 'exhausted'] as const) {
      expect(projectSessionAwarenessV1({ ...base, usageLimitRecovery: { ...recovery, status } }).operational.primary).toBe('usage_limited');
    }
    expect(projectSessionAwarenessV1({ ...base, lifecycle: { latestTurnStatus: 'in_progress' } }).operational.primary).toBe('usage_limited');
    for (const runtime of [{ ...base.runtime, resumingAtMs: NOW }, { ...base.runtime, controlServiceability: 'recoverable_unservable' as const }]) {
      expect(readSessionAwarenessPresentationV1(projectSessionAwarenessV1({ ...base, runtime }))).toBe('usage_limited');
    }
    expect(projectSessionAwarenessV1({ ...base, usageLimitRecovery: { ...recovery, status: 'cancelled' } }).operational.primary).toBe('failed');
    expect(projectSessionAwarenessV1({ ...base, usageLimitRecovery: { ...recovery, status: 'cancelled', issueFingerprint: 'other' } }).operational.primary).toBe('usage_limited');
    expect(projectSessionAwarenessV1({ ...base, runtimeIssue: null }).operational.primary).toBe('failed');
    expect(projectSessionAwarenessV1({ ...base, runtimeIssue: { ...issue, source: 'agent_status_error', code: 'provider_temporary_throttle',
      temporaryThrottle: { v: 1, retryAfterMs: 1_000, recoverability: 'retry' } } }).operational.primary).toBe('failed');
  });
  it('keeps a yielded question waiting without private request counts or a ready signal', () => {
    const projection = projectSessionAwarenessV1(input({
      lifecycle: { latestTurnStatus: 'waiting', latestReadyEventSeq: 9 },
      runtime: { presence: 'online', active: true, thinking: true, thinkingAtMs: NOW },
      currentness: { lifecycle: 'observed', runtime: 'observed', pending: 'unavailable' },
      content: { mode: 'e2ee', keyState: 'missing' },
    }));
    expect(projection).toMatchObject({ lifecycle: 'active', runtime: 'waiting',
      operational: { primary: 'action_required', reasons: ['action_required', 'content_locked'] } });
    expect(projectSessionAwarenessV1(input({ lifecycle: { latestTurnStatus: 'in_progress' } })))
      .toMatchObject({ runtime: 'working', operational: { primary: 'working' } });
  });
  it('carries an explanation only with readable content without changing operational facts', () => {
    const baseline = input();
    const ordinary = projectSessionAwarenessV1(baseline);
    expect(projectSessionAwarenessV1({ ...baseline, statusReason: 'Waiting for the build' }))
      .toEqual({ ...ordinary, statusReason: 'Waiting for the build' });
    const locked = { ...baseline, content: { mode: 'e2ee' as const, keyState: 'missing' as const } };
    expect(projectSessionAwarenessV1({ ...locked, statusReason: 'Private explanation' }))
      .toEqual(projectSessionAwarenessV1(locked));
  });
  it('preserves server-visible origin independently of private fork lineage', () => {
    const origin = { kind: 'run_step' as const, runId: 'workflow-run' };
    const projection = projectSessionAwarenessV1(input({
      origin,
      content: { mode: 'e2ee', keyState: 'missing' },
      lineage: { relation: 'fork', sourceSessionId: 'private-parent' },
    }));
    expect(projection).toMatchObject({ origin });
    expect(projection.lineage).toBeUndefined();
    expect(SessionAwarenessProjectionV1Schema.safeParse(projection).success).toBe(true);
    expect(SessionAwarenessProjectionV1Schema.safeParse({
      ...projection, origin: { ...origin, instructions: 'untrusted' },
    }).success).toBe(false);
  });

  it('accepts fork/replay lineage and rejects retired subagent/message provenance lineage', () => {
    for (const relation of ['fork', 'replay']) {
      expect(SessionAwarenessLineageV1Schema.safeParse({ relation, sourceSessionId: 'source' }).success).toBe(true);
    }
    for (const relation of ['subagent', 'message_provenance']) {
      expect(SessionAwarenessLineageV1Schema.safeParse({ relation, sourceSessionId: 'source' }).success).toBe(false);
    }
  });
  it('preserves authorized relation ids and counts even when encrypted content is locked', () => {
    const manager = { sessionId: 'lead' };
    const managedSessions = { total: 3, working: 1, needsYou: 1, stalled: 1, finished: 0, attentionPrimary: 'permission_required' as const };
    const projection = projectSessionAwarenessV1(input({
      content: { mode: 'e2ee', keyState: 'missing' },
      manager,
      managedSessions,
    }));
    expect(projection).toMatchObject({ manager, managedSessions });
    expect(SessionAwarenessProjectionV1Schema.safeParse(projection).success).toBe(true);
    expect(SessionAwarenessProjectionV1Schema.safeParse({ ...projection, managedSessions: { ...managedSessions, total: -1 } }).success).toBe(false);
    expect(SessionAwarenessProjectionV1Schema.safeParse({ ...projection, manager: { ...manager, permission: 'admin' } }).success).toBe(false);
  });
  it('keeps a terminal turn projection authoritative over stale thinking', () => {
    const projection = projectSessionAwarenessV1(input({
      lifecycle: { latestTurnStatus: 'completed', latestTurnStatusObservedAtMs: NOW - 5_000 },
      runtime: { presence: 'online', active: true, thinking: true, thinkingAtMs: NOW - 1_000 },
    }));

    expect(projection.runtime).toBe('idle');
    expect(projection.lifecycle).toBe('ready');
    expect(projection.operational.primary).toBe('ready');
    expect(projection.operational.reasons).not.toContain('working');
  });

  it('separates continuing background work from a completed foreground turn', () => {
    const background = projectSessionAwarenessV1(input({
      lifecycle: { latestTurnStatus: 'completed', latestReadyEventSeq: 9 },
      runtime: {
        presence: 'online',
        active: true,
        activityState: 'active',
        activityActiveCount: 2,
      },
    }));

    expect(background.runtime).toBe('background_active');
    expect(background.operational.primary).toBe('none');
    expect(background.operational.reasons).not.toContain('ready');
    const settled = projectSessionAwarenessV1(input({
      lifecycle: { latestTurnStatus: 'completed', latestReadyEventSeq: 9 },
      runtime: { presence: 'online', active: true, activityState: 'idle', activityActiveCount: 0 },
    }));
    expect(settled.operational.primary).toBe('ready');
    const disconnected = projectSessionAwarenessV1(input({
      lifecycle: { latestTurnStatus: 'completed', latestReadyEventSeq: 9 },
      runtime: { presence: 'offline', active: false, activityState: 'active', activityActiveCount: 2 },
    }));
    expect(disconnected.operational.reasons).not.toContain('ready');
    expect(background.operational.reasons).toContain('background_activity');

    const foreground = projectSessionAwarenessV1(input({
      lifecycle: { latestTurnStatus: 'in_progress' },
      runtime: {
        presence: 'online',
        active: true,
        activityState: 'active',
        activityActiveCount: 2,
      },
    }));

    expect(foreground.runtime).toBe('working');
    expect(foreground.operational.primary).toBe('working');
  });

  it('never reports idle for an offline or unknown runtime', () => {
    const offline = projectSessionAwarenessV1(input({
      runtime: {
        presence: 'offline',
        active: false,
        lastObservedAtMs: NOW - SESSION_AWARENESS_RUNTIME_STALE_SIGNAL_MS - 1_000,
      },
    }));
    expect(offline.runtime).toBe('offline');
    expect(offline.freshness).toBe('offline');
    expect(offline.operational.reasons).toContain('runtime_offline');

    const unknown = projectSessionAwarenessV1(input({
      runtime: { presence: 'unknown' },
      currentness: { lifecycle: 'observed', runtime: 'unavailable', pending: 'observed' },
    }));
    expect(unknown.runtime).toBe('unknown');
    expect(unknown.freshness).toBe('unknown');
    expect(unknown.availability).toBe('partial');
  });

  it('reads a durably detached runtime as offline when no device presence was observed', () => {
    // An HTTP-hydrated row carries the presence owner's durable `active: false` but no
    // device-observed presence. That is evidence the runtime is gone, not an unknown runtime.
    const detached = projectSessionAwarenessV1(input({
      runtime: {
        presence: 'unknown',
        active: false,
        lastObservedAtMs: NOW - SESSION_AWARENESS_RUNTIME_STALE_SIGNAL_MS - 1_000,
      },
    }));
    expect(detached.runtime).toBe('offline');
    expect(detached.freshness).toBe('offline');
    expect(detached.operational.reasons).toContain('runtime_offline');

    // Durable `active: true` still never manufactures reachability.
    const attachedElsewhere = projectSessionAwarenessV1(input({
      runtime: { presence: 'unknown', active: true },
    }));
    expect(attachedElsewhere.runtime).toBe('unknown');
    expect(attachedElsewhere.freshness).toBe('unknown');
  });

  it('reports a runtime that claims to be online but stopped reporting as stale', () => {
    const projection = projectSessionAwarenessV1(input({
      runtime: {
        presence: 'online',
        active: true,
        lastObservedAtMs: NOW - SESSION_AWARENESS_RUNTIME_STALE_SIGNAL_MS - 1,
      },
    }));

    expect(projection.freshness).toBe('stale');
    expect(projection.operational.reasons).toContain('runtime_stale');
  });

  it('treats an otherwise live delayed snapshot as stale at the canonical currentness boundary', () => {
    const projection = projectSessionAwarenessV1(input({
      runtime: { presence: 'online', active: true },
      currentness: {
        lifecycle: 'observed',
        runtime: 'observed',
        pending: 'observed',
        observedAtMs: NOW - SESSION_AWARENESS_RUNTIME_STALE_SIGNAL_MS - 1,
      },
    }));

    expect(projection.freshness).toBe('stale');
    expect(projection.operational.reasons).toContain('runtime_stale');
  });

  it('does not promote unavailable runtime evidence into operational activity', () => {
    const projection = projectSessionAwarenessV1(input({
      runtime: {
        presence: 'online', active: true, thinking: true, thinkingAtMs: NOW,
        activityState: 'active', activityActiveCount: 2, resumingAtMs: NOW,
      },
      pending: { hasPendingPermissionRequests: true },
      currentness: { lifecycle: 'observed', runtime: 'unavailable', pending: 'observed' },
    }));
    expect(projection).toMatchObject({
      runtime: 'unknown', freshness: 'unknown', availability: 'partial',
      operational: { primary: 'none', reasons: [] },
    });
  });

  it('keeps action evidence while the runtime is live, however long the request has waited', () => {
    // The observation instant is the request's creation time and is never refreshed while it
    // waits; the request ends through its durable settlement, not through elapsed time.
    const longWaiting = projectSessionAwarenessV1(input({
      pending: {
        hasPendingUserActionRequests: true,
        pendingRequestObservedAtMs: NOW - SESSION_AWARENESS_RUNTIME_STALE_SIGNAL_MS - 1,
      },
    }));
    expect(longWaiting.operational.primary).toBe('action_required');
  });

  it('projects permission-required while a pending request is reported and the runtime is live', () => {
    const current = projectSessionAwarenessV1(input({
      pending: {
        hasPendingPermissionRequests: true,
        pendingRequestObservedAtMs: NOW - 1_000,
      },
    }));
    expect(current.operational.primary).toBe('permission_required');

    const longWaiting = projectSessionAwarenessV1(input({
      pending: {
        hasPendingPermissionRequests: true,
        pendingRequestObservedAtMs: NOW - SESSION_AWARENESS_RUNTIME_STALE_SIGNAL_MS - 1,
      },
    }));
    expect(longWaiting.operational.primary).toBe('permission_required');

    const resolved = projectSessionAwarenessV1(input({
      pending: {
        hasPendingPermissionRequests: false,
        pendingRequestObservedAtMs: NOW - 1_000,
      },
    }));
    expect(resolved.operational.primary).toBe('none');

    const replaced = projectSessionAwarenessV1(input({
      pending: {
        hasPendingPermissionRequests: true,
        pendingRequestObservedAtMs: NOW - 500,
      },
    }));
    expect(replaced.operational.primary).toBe('permission_required');
  });

  it('keeps an unanswered permission actionable throughout its live turn', () => {
    const facts = input({
      lifecycle: { latestTurnStatus: 'in_progress' },
      pending: {
        hasPendingPermissionRequests: true,
        pendingRequestObservedAtMs: NOW - SESSION_AWARENESS_RUNTIME_STALE_SIGNAL_MS - 1,
      },
    });
    expect(projectSessionAwarenessV1(facts).operational.primary).toBe('permission_required');
    expect(projectSessionAwarenessV1({ ...facts, pending: {
      ...facts.pending, hasPendingPermissionRequests: false,
    } }).operational.primary).toBe('working');
  });

  it('drops permission and action evidence once the runtime is not live', () => {
    const projection = projectSessionAwarenessV1(input({
      runtime: { presence: 'offline', active: false, lastObservedAtMs: NOW - 1_000 },
      pending: {
        hasPendingPermissionRequests: true,
        hasPendingUserActionRequests: true,
        pendingRequestObservedAtMs: NOW - 1_000,
      },
    }));

    expect(projection.operational.primary).toBe('none');
    expect(projection.operational.reasons).not.toContain('permission_required');
  });

  it('retains observed pending work when reachability alone is unknown', () => {
    const projection = projectSessionAwarenessV1(input({
      runtime: { presence: 'unknown', active: true },
      pending: {
        hasPendingPermissionRequests: true,
        hasPendingUserActionRequests: true,
        pendingRequestObservedAtMs: NOW - 1_000,
      },
    }));

    expect(projection.runtime).toBe('unknown');
    expect(projection.freshness).toBe('unknown');
    expect(projection.operational.primary).toBe('permission_required');
    expect(projection.operational.reasons).toEqual(
      expect.arrayContaining(['action_required', 'permission_required']),
    );
  });

  it('applies the failure > permission > action > working > ready > pending precedence', () => {
    const cases: ReadonlyArray<readonly [ProjectSessionAwarenessV1Input, string]> = [
      [input({
        lifecycle: { latestTurnStatus: 'failed', latestTurnStatusObservedAtMs: NOW - 1_000 },
        pending: {
          hasPendingUserActionRequests: true,
          hasPendingPermissionRequests: true,
          pendingRequestObservedAtMs: NOW - 1_000,
          queuedInputCount: 2,
        },
      }), 'failed'],
      [input({
        pending: {
          hasPendingUserActionRequests: true,
          hasPendingPermissionRequests: true,
          pendingRequestObservedAtMs: NOW - 1_000,
        },
      }), 'permission_required'],
      [input({
        pending: {
          hasPendingPermissionRequests: true,
          pendingRequestObservedAtMs: NOW - 1_000,
        },
      }), 'permission_required'],
      [input({
        lifecycle: { latestTurnStatus: 'in_progress' },
        pending: { queuedInputCount: 3 },
      }), 'working'],
      [input({
        lifecycle: { latestReadyEventSeq: 12 },
        pending: { queuedInputCount: 3 },
      }), 'ready'],
      [input({ pending: { queuedInputCount: 3 } }), 'pending_input'],
      [input({}), 'none'],
    ];

    for (const [projectionInput, expected] of cases) {
      expect(projectSessionAwarenessV1(projectionInput).operational.primary).toBe(expected);
    }
  });

  it('treats blocked queued input as an action requirement', () => {
    const projection = projectSessionAwarenessV1(input({
      pending: { queuedInputCount: 2, blockedInputCount: 1 },
    }));

    expect(projection.operational.primary).toBe('action_required');
    expect(projection.operational.reasons).toContain('blocked_input');
  });

  it('does not treat an empty ready frontier or a superseded completion as current ready evidence', () => {
    expect(projectSessionAwarenessV1(input({
      lifecycle: { latestReadyEventSeq: 0 },
    })).operational.reasons).not.toContain('ready');
    expect(projectSessionAwarenessV1(input({
      lifecycle: { latestReadyEventSeq: 12, latestReadyEventAtMs: NOW - 10_000,
        latestTurnStatus: 'in_progress', latestTurnStatusObservedAtMs: NOW - 1_000 },
    })).operational.reasons).not.toContain('ready');
  });

  it('retains concurrent operational reasons beside the single primary', () => {
    const projection = projectSessionAwarenessV1(input({
      lifecycle: { latestTurnStatus: 'failed', latestTurnStatusObservedAtMs: NOW - 1_000 },
      runtime: { presence: 'online', active: true, activityState: 'active', activityActiveCount: 2 },
      pending: {
        hasPendingPermissionRequests: true,
        pendingRequestObservedAtMs: NOW - 1_000,
        queuedInputCount: 4,
      },
    }));

    expect(projection.operational.primary).toBe('failed');
    expect(projection.operational.reasons).toEqual(
      expect.arrayContaining(['failed', 'permission_required', 'pending_input', 'background_activity']),
    );
  });

  it('counts an optimistic pending user message as working only inside its own budget', () => {
    const fresh = projectSessionAwarenessV1(input({
      runtime: {
        presence: 'online',
        active: true,
        optimisticThinkingAtMs: NOW - 1_000,
      },
      pending: { queuedInputCount: 1 },
    }));
    expect(fresh.runtime).toBe('working');

    const expired = projectSessionAwarenessV1(input({
      runtime: {
        presence: 'online',
        active: true,
        optimisticThinkingAtMs: NOW - SESSION_AWARENESS_OPTIMISTIC_PENDING_INPUT_MS - 1,
      },
      pending: { queuedInputCount: 1 },
    }));
    expect(expired.runtime).not.toBe('working');
    expect(expired.operational.primary).toBe('pending_input');
  });

  it('reports a resuming runtime as working with its own reason', () => {
    const projection = projectSessionAwarenessV1(input({
      runtime: { presence: 'online', active: true, resumingAtMs: NOW - 500 },
    }));

    expect(projection.runtime).toBe('working');
    expect(projection.operational.reasons).toContain('resuming');
  });

  it('reports an unservable terminal control state without claiming liveness', () => {
    const projection = projectSessionAwarenessV1(input({
      runtime: {
        presence: 'online',
        active: true,
        controlServiceability: 'recoverable_unservable',
      },
    }));

    expect(projection.runtime).toBe('offline');
    expect(projection.operational.reasons).toContain('runtime_unservable');
  });

  it('reports an archived session without inventing runtime work', () => {
    const projection = projectSessionAwarenessV1(input({
      lifecycle: { archivedAtMs: NOW - 10_000, latestTurnStatus: 'in_progress' },
      runtime: { presence: 'online', active: true, thinking: true, thinkingAtMs: NOW - 1_000 },
    }));

    expect(projection.lifecycle).toBe('archived');
    expect(projection.runtime).not.toBe('working');
    expect(projection.operational.reasons).toContain('archived');
  });
});

describe('projectSessionAwarenessV1 — content availability', () => {
  it('keeps plain, ready, preparing, repair and locked distinct', () => {
    expect(projectSessionAwarenessV1(input({ content: { mode: 'plain' } })).encryption).toBe('plain');
    expect(projectSessionAwarenessV1(input({
      content: { mode: 'e2ee', keyState: 'opened' },
    })).encryption).toBe('ready');
    expect(projectSessionAwarenessV1(input({
      content: { mode: 'e2ee', keyState: 'preparing' },
    })).encryption).toBe('preparing');
    expect(projectSessionAwarenessV1(input({
      content: { mode: 'e2ee', keyState: 'inconsistent' },
    })).encryption).toBe('repair_needed');
    expect(projectSessionAwarenessV1(input({
      content: { mode: 'e2ee', keyState: 'missing' },
    })).encryption).toBe('locked');
  });

  it.each(['missing', 'preparing', 'inconsistent', 'access_pending', 'setup_required', 'content_unavailable', 'unknown'] as const)('omits private content while %s', (keyState) => {
    const projection = projectSessionAwarenessV1(input({
      title: 'Release prep',
      content: { mode: 'e2ee', keyState },
      work: {
        v: 1,
        backendId: 'claude',
        updatedAt: NOW,
        items: [{
          id: 'task:1',
          kind: 'task',
          origin: 'happier',
          status: 'active',
          title: 'Update pagination',
          updatedAt: NOW,
        }],
      },
      lineage: { relation: 'fork', sourceSessionId: 'session-0' },
      workspace: { projectName: 'happier', path: '/home/alice/happier' },
    }));

    expect(projection.title).toBeUndefined();
    expect(projection.currentWork).toBeUndefined();
    expect(projection.lineage).toBeUndefined();
    expect(projection.workspace).toBeUndefined();
    expect(projection.availability).toBe('locked');
    expect(projection.operational.reasons).toContain('content_locked');
  });

  it('publishes authorized content facts when the caller opened the session', () => {
    const projection = projectSessionAwarenessV1(input({
      title: '  Release prep  ',
      content: { mode: 'e2ee', keyState: 'opened' },
      lineage: { relation: 'replay', sourceSessionId: 'session-0' },
      workspace: { projectName: 'happier', path: '/home/alice/happier', machineId: 'machine-1' },
    }));

    expect(projection.title).toBe('Release prep');
    expect(projection.lineage).toEqual({ relation: 'replay', sourceSessionId: 'session-0' });
    expect(projection.workspace).toEqual({
      machineId: 'machine-1',
      projectName: 'happier',
      path: '/home/alice/happier',
    });
    expect(projection.availability).toBe('complete');
  });

  it('reports partial availability when a component has no evidence', () => {
    const projection = projectSessionAwarenessV1(input({
      currentness: { lifecycle: 'unavailable', runtime: 'observed', pending: 'observed' },
      lifecycle: { latestTurnStatus: 'completed' },
    }));

    expect(projection.lifecycle).toBe('unknown');
    expect(projection.availability).toBe('partial');
    expect(projection.operational.primary).not.toBe('ready');
  });
});

describe('projectSessionAwarenessV1 — work headline', () => {
  it('selects the canonical primary work item, including paused work', () => {
    const projection = projectSessionAwarenessV1(input({
      work: {
        v: 1,
        backendId: 'claude',
        updatedAt: NOW,
        items: [
          {
            id: 'goal:1',
            kind: 'goal',
            origin: 'happier',
            status: 'complete',
            title: 'Ship release',
            updatedAt: NOW,
          },
          {
            id: 'task:1',
            kind: 'task',
            origin: 'happier',
            status: 'paused',
            title: 'Update pagination',
            updatedAt: NOW,
          },
        ],
      },
    }));

    expect(projection.currentWork).toEqual({
      itemId: 'task:1',
      kind: 'task',
      status: 'paused',
      title: 'Update pagination',
    });
  });

  it('honours a stored primary item id', () => {
    const projection = projectSessionAwarenessV1(input({
      work: {
        v: 1,
        backendId: 'claude',
        updatedAt: NOW,
        primaryItemId: 'goal:1',
        items: [
          {
            id: 'goal:1',
            kind: 'goal',
            origin: 'happier',
            status: 'active',
            title: 'Ship release',
            updatedAt: NOW,
          },
          {
            id: 'task:1',
            kind: 'task',
            origin: 'happier',
            status: 'active',
            title: 'Update pagination',
            updatedAt: NOW,
          },
        ],
      },
    }));

    expect(projection.currentWork?.itemId).toBe('goal:1');
  });

  it('falls back to the bounded workflow headline when no work item exists', () => {
    const projection = projectSessionAwarenessV1(input({
      workflowHeadline: {
        v: 1,
        backendId: 'claude',
        updatedAt: NOW,
        primaryRunId: 'run-2',
        activeRuns: [
          {
            runId: 'run-1',
            title: 'Lint sweep',
            status: 'active',
            updatedAt: NOW,
            recordRevision: 'r1',
            recordUpdatedAt: NOW,
            totalAgents: 2,
            completedAgents: 1,
          },
          {
            runId: 'run-2',
            title: 'Release checks',
            status: 'active',
            updatedAt: NOW,
            recordRevision: 'r1',
            recordUpdatedAt: NOW,
            totalAgents: 3,
            completedAgents: 0,
          },
        ],
      },
    }));

    expect(projection.currentWork?.title).toBe('Release checks');
    expect(projection.currentWork?.activeWorkflowRunCount).toBe(2);
    expect(projection.currentWork?.itemId).toBeUndefined();
  });
});

describe('projectSessionAwarenessV1 — contract boundary', () => {
  it('produces a closed result that parses against the published schema', () => {
    const projection = projectSessionAwarenessV1(input({ title: 'Release prep' }));

    expect(SessionAwarenessProjectionV1Schema.parse(projection)).toEqual(projection);
    expect(projection.v).toBe(1);
    expect(projection.sessionId).toBe('session-1');
  });

  it('rejects viewer-personal fields smuggled into the projection result', () => {
    const projection = projectSessionAwarenessV1(input({}));

    expect(SessionAwarenessProjectionV1Schema.safeParse({
      ...projection,
      unread: true,
    }).success).toBe(false);
    expect(SessionAwarenessProjectionV1Schema.safeParse({
      ...projection,
      needsMyAttention: true,
    }).success).toBe(false);
    expect(Object.keys(projection)).not.toContain('lastViewedSessionSeq');
  });

  it('is pure: the same explicit facts and nowMs always produce the same result', () => {
    const projectionInput = input({
      lifecycle: { latestTurnStatus: 'in_progress' },
      runtime: { presence: 'online', active: true, thinking: true, thinkingAtMs: NOW - 1_000 },
    });

    expect(projectSessionAwarenessV1(projectionInput))
      .toEqual(projectSessionAwarenessV1(projectionInput));
  });
});
