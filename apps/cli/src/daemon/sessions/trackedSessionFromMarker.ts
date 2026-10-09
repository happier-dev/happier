import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

import type { DaemonSessionMarker } from '../sessionRegistry';
import type { TrackedSession } from '../types';

export function resolveReattachedRunnerAgentInvocationContext(
  marker: Pick<
    DaemonSessionMarker,
    | 'startedBy'
    | 'cwd'
    | 'agentRuntimeDaemonServiceAuthorityFilePath'
    | 'runnerManagedDependencyRetentionV1'
  >,
): TrackedSession['runnerAgentInvocationContext'] {
  if (
    marker.startedBy !== 'daemon'
    || !marker.agentRuntimeDaemonServiceAuthorityFilePath
    || typeof marker.cwd !== 'string'
    || !marker.cwd.trim()
  ) return undefined;

  return Object.freeze({
    cwd: marker.cwd,
    environment: Object.freeze({}),
    providerBindingActive: Boolean(
      marker.runnerManagedDependencyRetentionV1
        ?.adoptedManagedProviderAuthority,
    ),
  });
}

export function buildTrackedSessionFromMarker(params: Readonly<{
  marker: DaemonSessionMarker;
  startedByFallback: string;
  spawnOptions?: SpawnSessionOptions;
  vendorResumeId?: string;
  processCommandHash?: string;
  processStartTimeMs?: number;
  processCommand?: string;
  reattachedFromDiskMarker?: boolean;
}>): TrackedSession {
  const { marker } = params;
  const processCommandHash = params.processCommandHash ?? marker.processCommandHash;
  const processStartTimeMs = params.processStartTimeMs ?? marker.processStartTimeMs;
  const processCommand = params.processCommand ?? marker.processCommand;
  const runnerAgentInvocationContext =
    resolveReattachedRunnerAgentInvocationContext(marker);

  return {
    startedBy: marker.startedBy ?? params.startedByFallback,
    happySessionId: marker.happySessionId,
    ...(marker.requesterWorkAttributionV1
      ? { requesterWorkAttributionV1: marker.requesterWorkAttributionV1 } : {}),
    ...(marker.activeTurnId
      ? { reattachedInterruptedTurnId: marker.activeTurnId }
      : {}),
    ...(marker.agentSessionStartupInstructionsMarkerV1
      ? {
          agentSessionStartupInstructionsMarkerV1:
            marker.agentSessionStartupInstructionsMarkerV1,
        }
      : {}),
    happySessionMetadataFromLocalWebhook: marker.metadata,
    ...(params.spawnOptions ? { spawnOptions: {
      ...params.spawnOptions,
      ...(marker.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: marker.requesterWorkAttributionV1 } : {}),
    } } : {}),
    ...(params.vendorResumeId ? { vendorResumeId: params.vendorResumeId } : {}),
    ...(marker.agentRuntimeDaemonServiceAuthorityFilePath
      ? {
          agentRuntimeDaemonServiceAuthorityFilePath:
            marker.agentRuntimeDaemonServiceAuthorityFilePath,
        }
      : {}),
    ...(runnerAgentInvocationContext
      ? { runnerAgentInvocationContext }
      : {}),
    ...(marker.runnerManagedDependencyRetentionV1
      ? {
          runnerManagedDependencyRetentionV1:
            marker.runnerManagedDependencyRetentionV1,
        }
      : {}),
    ...(marker.runnerAgentSourceCustodyV1
      ? {
          runnerAgentSourceCustodyV1:
            marker.runnerAgentSourceCustodyV1,
        }
      : {}),
    ...(marker.agentRuntimeDaemonServiceActiveAdmission
      ? {
          agentRuntimeDaemonServiceAdmittedTurnId:
            marker.agentRuntimeDaemonServiceActiveAdmission
              .turnId,
          agentRuntimeDaemonServiceAdmittedInputId:
            marker.agentRuntimeDaemonServiceActiveAdmission
              .inputId,
          agentRuntimeDaemonServiceAdmittedUserMessageSeq:
            marker.agentRuntimeDaemonServiceActiveAdmission
              .userMessageSeq,
          agentRuntimeDaemonServiceAdmittedUserMessageSeqs: [
            ...marker.agentRuntimeDaemonServiceActiveAdmission
              .userMessageSeqs,
          ],
        }
      : {}),
    ...(marker.agentRuntimeDaemonServiceSessionOpenAttestation
      ? {
          agentRuntimeDaemonServiceSessionOpenAttestation:
            marker.agentRuntimeDaemonServiceSessionOpenAttestation,
        }
      : {}),
    pid: marker.pid,
    ...(processCommandHash ? { processCommandHash } : {}),
    ...(processStartTimeMs !== undefined ? { processStartTimeMs } : {}),
    ...(processCommand ? { processCommand } : {}),
    ...(params.reattachedFromDiskMarker ? { reattachedFromDiskMarker: true } : {}),
  };
}
