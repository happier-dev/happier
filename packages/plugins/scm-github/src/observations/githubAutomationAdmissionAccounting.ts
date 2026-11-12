import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';

type AutomationEventAdmitItemResultV1 = PluginActionResultById['automation.event.admit']['results'][number];

export type GithubAutomationAdmissionTelemetryV1 = Readonly<{
  kind: 'admitted' | 'skipped' | 'rejoined' | 'observed' | 'unsettled';
  admittedDelta: 0 | 1;
  skippedDelta: 0 | 1;
}>;

/**
 * Maps one canonical Automation admission result to the one source-health
 * telemetry vocabulary shared by GitHub's pull and webhook transports.
 * Rejoining is terminal but must not count as another admission.
 */
export function classifyGithubAutomationAdmissionTelemetry(
  result: AutomationEventAdmitItemResultV1 | null | undefined,
): GithubAutomationAdmissionTelemetryV1 {
  if (result?.checkpointSafe !== true) {
    return { kind: 'unsettled', admittedDelta: 0, skippedDelta: 0 };
  }
  if (result.kind === 'admitted') {
    return { kind: 'admitted', admittedDelta: 1, skippedDelta: 0 };
  }
  if (result.kind === 'skipped') {
    return { kind: 'skipped', admittedDelta: 0, skippedDelta: 1 };
  }
  if (result.kind === 'rejoined') {
    return { kind: 'rejoined', admittedDelta: 0, skippedDelta: 0 };
  }
  if (result.kind === 'observed') {
    return { kind: 'observed', admittedDelta: 0, skippedDelta: 0 };
  }
  return { kind: 'unsettled', admittedDelta: 0, skippedDelta: 0 };
}
