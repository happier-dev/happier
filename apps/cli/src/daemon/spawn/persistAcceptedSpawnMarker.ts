import {
  AgentSessionStartupInstructionsMarkerV1Schema,
} from '@happier-dev/protocol';

import { readProcessIdentityByPid } from '../processIdentity';
import { buildSessionRunnerRespawnDescriptorV1FromSpawnOptions } from '../processSupervision/sessionRunnerRespawnDescriptor';
import {
  hashProcessCommand,
  writeSessionMarker,
} from '../sessionRegistry';
import type { TrackedSession } from '../types';
import type { DeviceLocalSecretStorage } from '../deviceLocalSecretStorage';

function readTrackedProcessCommand(trackedSession: TrackedSession): string | undefined {
  const observed = typeof trackedSession.processCommand === 'string'
    ? trackedSession.processCommand.trim()
    : '';
  if (observed) return observed;

  const spawnArgs = trackedSession.childProcess?.spawnargs;
  if (!Array.isArray(spawnArgs)) return undefined;
  const command = spawnArgs
    .filter((arg): arg is string => typeof arg === 'string' && arg.trim().length > 0)
    .join(' ')
    .trim();
  return command || undefined;
}

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
  const observedProcessCommand = processIdentity?.command?.trim() ?? '';
  const observedProcessCommandHash =
    observedProcessCommand
      ? hashProcessCommand(observedProcessCommand)
      : null;
  if (
    params.expectedProcessIdentity
    && (
      processIdentity?.processStartTimeMs
        !== params.expectedProcessIdentity.processStartTimeMs
      || observedProcessCommandHash
        !== params.expectedProcessIdentity.processCommandHash
    )
  ) {
    throw new Error(
      'Accepted spawn process identity changed before marker persistence',
    );
  }
  const processCommand = observedProcessCommand || readTrackedProcessCommand(trackedSession);
  if (processIdentity?.processStartTimeMs !== undefined) {
    trackedSession.processStartTimeMs = processIdentity.processStartTimeMs;
  }
  if (processCommand) {
    trackedSession.processCommand = processCommand;
    trackedSession.processCommandHash =
      observedProcessCommandHash
      ?? hashProcessCommand(processCommand);
  }
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
    ...(processCommand
      ? {
          processCommand,
          processCommandHash: hashProcessCommand(processCommand),
          ...(processIdentity?.processStartTimeMs !== undefined
            ? { processStartTimeMs: processIdentity.processStartTimeMs }
            : {}),
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
    ...(trackedSession.runnerAgentImmutableGenerationId
      ? {
          runnerAgentImmutableGenerationId:
            trackedSession.runnerAgentImmutableGenerationId,
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
