import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';

type AutomationEventAdmitItemResultV1 = PluginActionResultById['automation.event.admit']['results'][number];

/**
 * Maps one canonical Automation admission outcome to the source-health
 * counters shared by GitHub's pull and webhook transports. Rejoining an
 * already admitted occurrence is terminal but must not count it again.
 */
export function githubAutomationAdmissionCounterDeltas(
  result: AutomationEventAdmitItemResultV1 | null | undefined,
): Readonly<{ admittedDelta: 0 | 1; skippedDelta: 0 | 1 }> {
  if (result?.checkpointSafe !== true) {
    return { admittedDelta: 0, skippedDelta: 0 };
  }
  if (result.kind === 'admitted') {
    return { admittedDelta: 1, skippedDelta: 0 };
  }
  if (result.kind === 'skipped') {
    return { admittedDelta: 0, skippedDelta: 1 };
  }
  return { admittedDelta: 0, skippedDelta: 0 };
}
