import { describe, expect, it } from 'vitest';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';

import { classifyGithubAutomationAdmissionTelemetry } from './githubAutomationAdmissionAccounting.js';

type AdmissionResult = PluginActionResultById['automation.event.admit']['results'][number];

describe('GitHub Automation admission telemetry', () => {
  it.each<readonly [AdmissionResult, unknown]>([
    [
      { kind: 'admitted', runId: 'run-1', checkpointSafe: true },
      { kind: 'admitted', admittedDelta: 1, skippedDelta: 0 },
    ],
    [
      { kind: 'skipped', reason: 'filtered', checkpointSafe: true },
      { kind: 'skipped', admittedDelta: 0, skippedDelta: 1 },
    ],
    [
      { kind: 'rejoined', runId: 'run-1', checkpointSafe: true },
      { kind: 'rejoined', admittedDelta: 0, skippedDelta: 0 },
    ],
    [
      { kind: 'observed', checkpointSafe: true },
      { kind: 'observed', admittedDelta: 0, skippedDelta: 0 },
    ],
    [
      { kind: 'blocked', reason: 'temporarilyUnavailable', checkpointSafe: false },
      { kind: 'unsettled', admittedDelta: 0, skippedDelta: 0 },
    ],
  ])('classifies %s without making a rejoin count as a second admission', (result, expected) => {
    expect(classifyGithubAutomationAdmissionTelemetry(result)).toEqual(expected);
  });
});
