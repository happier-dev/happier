import type {
  ExternalSessionDestructiveQuiescenceResultV1,
  ExternalSessionOperationRecordV1,
} from '@happier-dev/protocol';
import type { AgentExternalSessionsInvocation } from '@happier-dev/plugin-sdk/sessions/external';
import { createUnavailableAgentExternalSessionsManagedEndpointRead } from '@/session/external/agentExternalSessionsInvocation';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

/** OS/API boundaries fail closed; real file-store and accounting logic still runs. */
export function createExternalSessionsInvocationFixture(signal: AbortSignal): AgentExternalSessionsInvocation {
  return {
    signal,
    managedEndpointRead: createUnavailableAgentExternalSessionsManagedEndpointRead(),
    exec: createUnavailablePluginServices().exec,
    ripgrep: { async run() { throw new Error('Packaged ripgrep is unavailable in this fixture'); } },
  };
}

export function createStoppedTakeoverQuiescenceFixture(
  record: ExternalSessionOperationRecordV1,
): ExternalSessionDestructiveQuiescenceResultV1 {
  const sourceIdentity = {
    machineId: record.request.source.machineId,
    linkedSessionId: record.request.sessionId,
    remoteSessionId: record.request.source.remoteSessionId,
    linkGeneration: record.request.source.linkGeneration,
    sourceKey: 'fixture-source-key',
    qualifiedIdentity: record.request.source.qualifiedIdentity,
  };
  const processIdentity = { machineId: sourceIdentity.machineId, pid: 4242, startedAtMs: 1000 };
  return {
    status: 'verified_stopped', sourceIdentity, processIdentity,
    evidence: {
      kind: 'operating_system_process_state', processState: 'verified_stopped',
      observedAtMs: 2000, sourceIdentity, processIdentity,
    },
  };
}
