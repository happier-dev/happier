import {
  listSessionMarkers,
  type DaemonSessionMarker,
} from '@/daemon/sessionRegistry';
import {
  verifySessionMarkerProcessLiveness,
} from '@/daemon/processLivenessVerifier';
import {
  mergeRunnerManagedDependencyRetentionV1,
  type RunnerManagedDependencyRetentionV1,
} from '@/plugins/runtime/runner/runnerManagedDependencyRetention';

export async function readExactLiveRunnerManagedDependencyRetention(
  dependencies?: Readonly<{
    listSessionMarkers?: () => Promise<
      readonly DaemonSessionMarker[]
    >;
    verifySessionMarkerProcessLiveness?:
      typeof verifySessionMarkerProcessLiveness;
  }>,
): Promise<RunnerManagedDependencyRetentionV1> {
  // This projection can block destructive dependency cleanup only. Ambiguous
  // process evidence must retain artifacts, but it never authorizes effects.
  const retained: RunnerManagedDependencyRetentionV1[] = [];
  for (
    const marker of await (
      dependencies?.listSessionMarkers ?? listSessionMarkers
    )()
  ) {
    if (
      !marker.runnerManagedDependencyRetentionV1
    ) {
      continue;
    }
    const liveness = await (
      dependencies?.verifySessionMarkerProcessLiveness
      ?? verifySessionMarkerProcessLiveness
    )(marker);
    if (
      marker.processCommandHash
      && marker.processStartTimeMs !== undefined
      && liveness.status === 'verified_stopped'
      && liveness.pid === marker.pid
      && liveness.processStartTimeMs
        === marker.processStartTimeMs
    ) {
      continue;
    }
    retained.push(
      Object.freeze({
        v: 1,
        sourceGenerationIds:
          marker.runnerManagedDependencyRetentionV1
            .sourceGenerationIds,
        qualifiedDependencyIds:
          marker.runnerManagedDependencyRetentionV1
            .qualifiedDependencyIds,
        ...(marker.runnerManagedDependencyRetentionV1
          .sourceCandidates
          ? {
              sourceCandidates:
                marker.runnerManagedDependencyRetentionV1
                  .sourceCandidates,
            }
          : {}),
      }),
    );
  }
  return mergeRunnerManagedDependencyRetentionV1(
    ...retained,
  );
}
