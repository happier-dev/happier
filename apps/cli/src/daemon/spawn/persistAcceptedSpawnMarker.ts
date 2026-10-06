import { AgentSessionStartupInstructionsMarkerV1Schema } from '@happier-dev/protocol/runtime/agentSessionStartupInstructionsV1';
import { processIdentityMatches } from '@happier-dev/cli-common/processInstance';

import { readProcessIdentityByPid } from '../processIdentity';
import { buildSessionRunnerRespawnDescriptorV1FromSpawnOptions } from '../processSupervision/sessionRunnerRespawnDescriptor';
import {
  hashProcessCommand,
  writeSessionMarker,
} from '../sessionRegistry';
import type { TrackedSession } from '../types';
import type { DeviceLocalSecretStorage } from '../deviceLocalSecretStorage';

export async function persistAcceptedSpawnMarker(params: Readonly<{
  trackedSession: TrackedSession;
  deviceLocalSecretStorage: DeviceLocalSecretStorage;
  readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
  processPid?: number;
  expectedProcessIdentity?: Readonly<{
    processStartTimeMs: number;
    processCommandHash: string;
  }>;
}>): Promise<void> {
  const { trackedSession } = params;
  const processPid = params.processPid ?? trackedSession.pid;
  if (!Number.isInteger(processPid) || processPid <= 0) {
    throw new Error('Accepted spawn custody requires a valid process PID');
  }
  if (trackedSession.startedBy !== 'daemon' || !trackedSession.spawnOptions) {
    throw new Error(`Cannot persist non-daemon accepted spawn custody for PID ${trackedSession.pid}`);
  }

  const respawn = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(
    trackedSession.spawnOptions,
    { deviceLocalSecretStorage: params.deviceLocalSecretStorage },
  );
  if (!respawn) {
    throw new Error(`Could not persist accepted spawn custody for PID ${trackedSession.pid}`);
  }

  const canonicalSessionId = typeof trackedSession.happySessionId === 'string'
    && trackedSession.happySessionId.trim().length > 0
    ? trackedSession.happySessionId.trim()
    : null;
  const processIdentity = await (
    params.readProcessIdentityByPidFn ?? readProcessIdentityByPid
  )(processPid);
  if (
    processIdentity?.pid !== processPid
    || !Number.isInteger(processIdentity.processStartTimeMs)
    || (processIdentity.processStartTimeMs ?? -1) < 0
  ) {
    throw new Error('Accepted spawn process start witness is unavailable');
  }
  const observedProcessCommand = processIdentity?.command?.trim() ?? '';
  const observedProcessCommandHash =
    observedProcessCommand
      ? hashProcessCommand(observedProcessCommand)
      : null;
  if (
    params.expectedProcessIdentity
    && !processIdentityMatches({
      pid: processPid,
      ...params.expectedProcessIdentity,
    }, {
      pid: processIdentity?.pid ?? -1,
      processStartTimeMs: processIdentity?.processStartTimeMs,
      processCommandHash: observedProcessCommandHash ?? undefined,
    })
  ) {
    throw new Error(
      'Accepted spawn process identity changed before marker persistence',
    );
  }
  trackedSession.processStartTimeMs = processIdentity.processStartTimeMs;
  trackedSession.processCommand = observedProcessCommand || undefined;
  trackedSession.processCommandHash = observedProcessCommandHash ?? undefined;
  const startupInstructions =
    trackedSession.spawnOptions.agentSessionStartupInstructionsV1;
  const startupInstructionsMarker = startupInstructions
    ? AgentSessionStartupInstructionsMarkerV1Schema.parse({
        v: startupInstructions.v,
        id: startupInstructions.id,
        revision: startupInstructions.revision,
      })
    : undefined;

  const marker: Parameters<typeof writeSessionMarker>[0] = {
    pid: processPid,
    happySessionId: canonicalSessionId ?? `PID-${processPid}`,
    startedBy: 'daemon',
    cwd: trackedSession.spawnOptions.directory,
    processStartTimeMs: processIdentity.processStartTimeMs,
    ...(observedProcessCommand
      ? {
          processCommand: observedProcessCommand,
          processCommandHash: observedProcessCommandHash!,
        }
      : {}),
    respawn,
    ...(trackedSession.agentRuntimeDaemonServiceAuthorityFilePath
      ? {
          agentRuntimeDaemonServiceAuthorityFilePath:
            trackedSession.agentRuntimeDaemonServiceAuthorityFilePath,
        }
      : {}),
    ...(trackedSession.runnerManagedDependencyRetentionV1
      ? {
          runnerManagedDependencyRetentionV1:
            trackedSession.runnerManagedDependencyRetentionV1,
        }
      : {}),
    ...(trackedSession.runnerAgentSourceCustodyV1
      ? {
          runnerAgentSourceCustodyV1:
            trackedSession.runnerAgentSourceCustodyV1,
        }
      : {}),
    ...(startupInstructionsMarker
      ? {
          agentSessionStartupInstructionsMarkerV1:
            startupInstructionsMarker,
        }
      : {}),
  };
  await writeSessionMarker(marker);
  if (startupInstructionsMarker) {
    trackedSession.agentSessionStartupInstructionsMarkerV1 =
      startupInstructionsMarker;
  }
}
