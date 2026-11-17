import { describe, expect, it } from 'vitest';

import type { Update } from '@/api/types';
import { isAuthoritativeAutomationRunCancellation } from './automationRunCancellation';
import {
  getAutomationRunInvalidationAction,
  invalidateActiveAutomationRun,
} from './automationRunInvalidation';

describe('getAutomationRunInvalidationAction', () => {
  const active = { runId: 'run-active', attempt: 3 };
  const updateIdentity = { id: 'update-1', seq: 1, createdAt: 123 };

  it('refreshes review holds only for the exact live claim without aborting it', () => {
    let refreshed = 0;
    const controller = new AbortController();
    const execution = { ...active, controller, refreshReviewHolds: () => { refreshed += 1; } };
    const body = { t: 'automation-run-updated' as const, runId: active.runId, automationId: null,
      state: 'running' as const, machineId: 'machine-1', targetMachineId: 'machine-1', attempt: active.attempt,
      scheduledAt: 123, updatedAt: 123,
      workflowControl: 'review_resolved' as const };
    expect(invalidateActiveAutomationRun({ update: { ...updateIdentity, body } satisfies Update, active: execution, machineId: 'machine-1' })).toBe('review-resolved');
    expect(refreshed).toBe(1);
    expect(controller.signal.aborted).toBe(false);
    expect(invalidateActiveAutomationRun({ update: { ...updateIdentity, body: { ...body, attempt: 2 } } satisfies Update, active: execution, machineId: 'machine-1' })).toBe('none');
    expect(invalidateActiveAutomationRun({ update: { ...updateIdentity, body: { ...body, targetMachineId: 'machine-2' } } satisfies Update, active: execution, machineId: 'machine-1' })).toBe('none');
    expect(refreshed).toBe(1);
  });

  it('delivers an exact targeted Cancel hint without invalidating a draining Pause lease', () => {
    const body = { t: 'automation-run-updated' as const, runId: active.runId, automationId: null,
      state: 'running' as const, machineId: 'machine-1', targetMachineId: 'machine-1', attempt: active.attempt,
      scheduledAt: 123, updatedAt: 123 };
    expect(getAutomationRunInvalidationAction({ update: { ...updateIdentity, body: { ...body, workflowControl: 'cancel_requested' } } satisfies Update,
      active, machineId: 'machine-1' })).toBe('authoritative-cancellation');
    // The server projects a draining pause as running on this bounded hint.
    expect(getAutomationRunInvalidationAction({ update: { ...updateIdentity, body } satisfies Update,
      active, machineId: 'machine-1' })).toBe('none');
    expect(getAutomationRunInvalidationAction({ update: { ...updateIdentity, body: { ...body, attempt: 2, workflowControl: 'cancel_requested' } } satisfies Update,
      active, machineId: 'machine-1' })).toBe('none');
    expect(getAutomationRunInvalidationAction({ update: { ...updateIdentity, body: { ...body, targetMachineId: 'machine-2', workflowControl: 'cancel_requested' } } satisfies Update,
      active, machineId: 'machine-1' })).toBe('none');
    const controller = new AbortController();
    expect(invalidateActiveAutomationRun({ update: { ...updateIdentity, body } satisfies Update, active: { ...active, controller }, machineId: 'machine-1' })).toBe('none');
    expect(controller.signal.aborted).toBe(false);
    expect(invalidateActiveAutomationRun({ update: { ...updateIdentity, body: { ...body, workflowControl: 'cancel_requested' } } satisfies Update,
      active: { ...active, controller }, machineId: 'machine-1' })).toBe('authoritative-cancellation');
    expect(isAuthoritativeAutomationRunCancellation(controller.signal)).toBe(true);
  });

  it.each([
    [
      'machine-scoped cancellation for the active Run',
      {
        t: 'automation-run-state-changed',
        runId: 'run-active',
        automationId: 'automation-1',
        runCause: { kind: 'manual', invokedAt: 123 },
        previousState: 'running',
        currentState: 'cancelled',
        transitionedAt: 123,
        claimedByMachineId: null,
      },
      'authoritative-cancellation',
    ],
    [
      'a cancellation that landed after dispatch permission and can only be reported as uncertain',
      {
        t: 'automation-run-state-changed',
        runId: 'run-active',
        automationId: 'automation-1',
        runCause: { kind: 'manual', invokedAt: 123 },
        previousState: 'running',
        currentState: 'outcome_uncertain',
        transitionedAt: 123,
        claimedByMachineId: 'machine-1',
        transitionCause: 'cancelledAfterDispatchPermitted',
      },
      'authoritative-cancellation',
    ],
    [
      'an uncertain lifecycle transition with no cancellation cause',
      {
        t: 'automation-run-state-changed',
        runId: 'run-active',
        automationId: 'automation-1',
        runCause: { kind: 'manual', invokedAt: 123 },
        previousState: 'running',
        currentState: 'outcome_uncertain',
        transitionedAt: 123,
        claimedByMachineId: 'machine-1',
      },
      'abort',
    ],
    [
      // The carrier deliberately types `cause` as a bounded string so a newer
      // producer cause degrades instead of invalidating the whole observation.
      // Degrading means the generic abort, never borrowed cancellation authority.
      'an uncertain lifecycle transition naming a cause this daemon does not know',
      {
        t: 'automation-run-state-changed',
        runId: 'run-active',
        automationId: 'automation-1',
        runCause: { kind: 'manual', invokedAt: 123 },
        previousState: 'running',
        currentState: 'outcome_uncertain',
        transitionedAt: 123,
        claimedByMachineId: 'machine-1',
        transitionCause: 'someFutureCauseThisDaemonHasNeverSeen',
      },
      'abort',
    ],
    [
      // Session targets keep no dispatch vocabulary at all, so their running
      // cancellation can only be published as uncertain with its own cause.
      // Without acting on it the claiming machine would abandon a stale
      // attempt and leave the exact deterministic Automation input pending.
      'a Session-target cancellation that landed while the Run was running',
      {
        t: 'automation-run-state-changed',
        runId: 'run-active',
        automationId: 'automation-1',
        runCause: { kind: 'manual', invokedAt: 123 },
        previousState: 'running',
        currentState: 'outcome_uncertain',
        transitionedAt: 123,
        claimedByMachineId: 'machine-1',
        transitionCause: 'cancelledWhileRunning',
      },
      'authoritative-cancellation',
    ],
    [
      'machine-scoped cancellation for another Run',
      {
        t: 'automation-run-state-changed',
        runId: 'run-other',
        automationId: 'automation-other',
        runCause: { kind: 'manual', invokedAt: 123 },
        previousState: 'running',
        currentState: 'cancelled',
        transitionedAt: 123,
        claimedByMachineId: null,
      },
      'none',
    ],
    [
      'a lifecycle transition that re-claimed the active Run on another machine',
      {
        t: 'automation-run-state-changed',
        runId: 'run-active',
        automationId: 'automation-1',
        runCause: {
          kind: 'trigger',
          triggerId: 'trigger-plugin-event-1',
          triggerRevision: 2,
          triggerKind: 'pluginEvent',
          occurrenceKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          occurredAt: 123,
          evidence: {
            eventRef: {
              pluginId: 'com.example.automation-events',
              localId: 'issue-opened-v1',
            },
            sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
          },
        },
        previousState: 'claimed',
        currentState: 'running',
        transitionedAt: 123,
        claimedByMachineId: 'machine-2',
      },
      'abort',
    ],
    [
      'a current legacy Run update for the active machine and attempt',
      {
        t: 'automation-run-updated',
        runId: 'run-active',
        automationId: 'automation-1',
        state: 'running',
        scheduledAt: 100,
        startedAt: 110,
        finishedAt: null,
        updatedAt: 123,
        machineId: 'machine-1',
        attempt: 3,
      },
      'none',
    ],
  ] as const)('returns %s', (_description, body, expected) => {
    const action = getAutomationRunInvalidationAction({
      update: { id: 'update-1', seq: 1, createdAt: 123, body } as Update,
      active,
      machineId: 'machine-1',
    });

    expect(action).toBe(expected);
  });

  it('distinguishes authoritative machine-scoped cancellation from a generic currentness abort', () => {
    const generic = new AbortController();
    generic.abort();
    expect(isAuthoritativeAutomationRunCancellation(generic.signal)).toBe(false);
    const controller = new AbortController();

    const action = invalidateActiveAutomationRun({
      update: {
        id: 'update-cancelled',
        seq: 2,
        createdAt: 123,
        body: {
          t: 'automation-run-state-changed',
          runId: 'run-active',
          automationId: 'automation-1',
          runCause: { kind: 'manual', invokedAt: 123 },
          previousState: 'running',
          currentState: 'cancelled',
          transitionedAt: 123,
          claimedByMachineId: null,
        },
      } as Update,
      active: { ...active, controller },
      machineId: 'machine-1',
    });

    expect(action).toBe('authoritative-cancellation');
    expect(isAuthoritativeAutomationRunCancellation(controller.signal)).toBe(true);
  });
});
