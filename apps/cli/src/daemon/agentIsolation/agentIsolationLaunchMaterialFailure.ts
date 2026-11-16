import { readAgentIsolationLaunchMaterialFailureCode, readSessionRuntimeFailureCause, readSessionStartupFailurePreview } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { SessionSpawnLaunchErrorV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnLaunchErrorV1';

/** Both failed creation and committed Session settlement consume this launch diagnostic. */
export function projectAgentIsolationLaunchMaterialFailure(error: unknown): SessionSpawnLaunchErrorV1 | undefined {
  const code = readAgentIsolationLaunchMaterialFailureCode(error);
  if (!code) return undefined;
  return { kind: 'launch_error', code, message: readSessionStartupFailurePreview(code)!,
    failureCause: readSessionRuntimeFailureCause(error),
  };
}
