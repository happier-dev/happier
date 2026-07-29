import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

import type { DaemonSessionMarker } from '../sessionRegistry';
import type { TrackedSession } from '../types';
import { toTrackedPluginLocalServicesBridgeAuthorizationFields } from '../local/services/pluginBridgeAuthorization';

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

  return {
    startedBy: marker.startedBy ?? params.startedByFallback,
    happySessionId: marker.happySessionId,
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
    ...(params.spawnOptions ? { spawnOptions: params.spawnOptions } : {}),
    ...(params.vendorResumeId ? { vendorResumeId: params.vendorResumeId } : {}),
    ...toTrackedPluginLocalServicesBridgeAuthorizationFields(marker.localServicesBridgeAuthorization),
    pid: marker.pid,
    ...(processCommandHash ? { processCommandHash } : {}),
    ...(processStartTimeMs !== undefined ? { processStartTimeMs } : {}),
    ...(processCommand ? { processCommand } : {}),
    ...(params.reattachedFromDiskMarker ? { reattachedFromDiskMarker: true } : {}),
  };
}
