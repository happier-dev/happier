import { PluginError } from '@happier-dev/plugin-sdk';
import {
  SessionAgentIsolationRefusalRemedyV1Schema,
  SessionSpawnLaunchErrorV1Schema,
  type SessionSpawnLaunchErrorV1,
} from '@happier-dev/protocol/sessions/creation/sessionSpawnLaunchErrorV1';
import { MachineAgentIsolationProbeFailureV1Schema } from '@happier-dev/protocol/machines/agentIsolationV1';

/**
 * The one projection of a requester's native isolation refusal into its closed
 * launch diagnostic, for Session spawn and the creation directory preflight.
 * Selects the producer's closed causes and remedy; arbitrary PluginError prose
 * and details stay local. Any other error is not an isolation refusal.
 */
export function projectAgentIsolationLaunchRefusal(
  error: unknown,
): SessionSpawnLaunchErrorV1 | null {
  if (
    !(error instanceof PluginError) ||
    error.code !== 'agent_isolation_unavailable'
  )
    return null;
  const detail =
    error.details &&
    typeof error.details === 'object' &&
    !Array.isArray(error.details)
      ? error.details
      : undefined;
  const launchError = {
    kind: 'launch_error' as const,
    code: 'agent_isolation_unavailable',
    message:
      detail && Reflect.get(detail, 'readinessCode')
        ? 'Member execution launch qualification failed.'
        : 'Member execution setup is unavailable.',
  };
  const nativeFailure = detail
    ? Reflect.get(detail, 'nativeFailure')
    : undefined;
  const probeFailure = MachineAgentIsolationProbeFailureV1Schema.safeParse(
    detail ? Reflect.get(detail, 'probeFailure') : undefined,
  );
  const remedy = SessionAgentIsolationRefusalRemedyV1Schema.safeParse(
    detail ? Reflect.get(detail, 'remedy') : undefined,
  );
  const diagnostic = SessionSpawnLaunchErrorV1Schema.safeParse({
    ...launchError,
    ...(detail
      ? {
          agentIsolationRefusal: {
            reason: Reflect.get(detail, 'reason'),
            phase: Reflect.get(detail, 'phase'),
            reasonCode: Reflect.get(detail, 'reasonCode'),
            operationErrorCode: Reflect.get(detail, 'operationErrorCode'),
            readinessCode: Reflect.get(detail, 'readinessCode'),
            ...(probeFailure.success
              ? { probeFailure: probeFailure.data }
              : {}),
            ...(remedy.success ? { remedy: remedy.data } : {}),
            ...(nativeFailure &&
            typeof nativeFailure === 'object' &&
            !Array.isArray(nativeFailure)
              ? {
                  nativeFailure: {
                    kind: Reflect.get(nativeFailure, 'kind'),
                    reason: Reflect.get(nativeFailure, 'reason'),
                    phase: Reflect.get(nativeFailure, 'phase'),
                  },
                }
              : {}),
          },
        }
      : {}),
  });
  return diagnostic.success ? diagnostic.data : launchError;
}
