import { describe, expect, it } from 'vitest';

import type { Update } from '@/api/types';
import { isAuthoritativeAutomationRunCancellation } from './automationRunCancellation';
import {
  getAutomationRunInvalidationAction,
  invalidateActiveAutomationRun,
} from './automationRunInvalidation';

describe('getAutomationRunInvalidationAction', () => {
  const active = { runId: 'run-active', attempt: 3 };

  it.each([
    [
      'machine-scoped cancellation for the active Run',
      {
        t: 'automation-run-state-changed',
        runId: 'run-active',
        automationId: 'automation-1',
        originKind: 'manual',
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
        originKind: 'manual',
        previousState: 'running',
        currentState: 'outcome_uncertain',
        transitionedAt: 123,
        claimedByMachineId: 'machine-1',
        cause: 'cancelledAfterDispatchPermitted',
      },
      'authoritative-cancellation',
    ],
    [
      'an uncertain lifecycle transition with no cancellation cause',
      {
        t: 'automation-run-state-changed',
        runId: 'run-active',
        automationId: 'automation-1',
        originKind: 'manual',
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
        originKind: 'manual',
        previousState: 'running',
        currentState: 'outcome_uncertain',
        transitionedAt: 123,
        claimedByMachineId: 'machine-1',
        cause: 'someFutureCauseThisDaemonHasNeverSeen',
      },
      'abort',
    ],
    [
      'machine-scoped cancellation for another Run',
      {
        t: 'automation-run-state-changed',
        runId: 'run-other',
        automationId: 'automation-other',
        originKind: 'manual',
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
        originKind: 'pluginEvent',
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

  it('immediately aborts the matching active Run controller for a machine-scoped cancellation', () => {
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
          originKind: 'manual',
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
