import type {
  DaemonExecutionRunBrokerAuthorityRequestV1,
  DaemonExecutionRunBrokerAuthorityResponseV1,
  ExecutionRunIntent,
  SessionExecutionRunBrokerAuthorityResponseV1,
} from '@happier-dev/protocol';

type AuthorityMarker = Readonly<{
  runId: string;
  happySessionId: string | null;
  intent: ExecutionRunIntent;
  status: string;
  pid: number;
  executionRunBrokerAuthorityV1?: Readonly<{
    occurrenceId: string;
    turnState: 'active_turn' | 'idle';
  }>;
}>;

export async function resolveDaemonExecutionRunBrokerAuthority(
  request: DaemonExecutionRunBrokerAuthorityRequestV1,
  deps: Readonly<{
    currentIdentity: Readonly<{ serverIdentityId: string; accountId: string; machineId: string }> | null;
    listMarkers: () => Promise<readonly AuthorityMarker[]>;
    isPidAlive: (pid: number) => boolean | Promise<boolean>;
    resolveDetachedWorkflowRequesterAccountId?: (runId: string) => string | undefined;
    resolveLiveAuthority: (input: Readonly<{
      sessionId: string | null;
      requestingAccountId: string;
      executionRunId: string;
      expectedIntent?: ExecutionRunIntent;
      expectedOccurrenceId: string | null;
      expectedDirectMaterialUse?: import('@happier-dev/protocol/teams').TeamCredentialDirectMaterialUseV1;
    }>) => Promise<SessionExecutionRunBrokerAuthorityResponseV1>;
  }>,
): Promise<DaemonExecutionRunBrokerAuthorityResponseV1> {
  const deny = (reason: Extract<DaemonExecutionRunBrokerAuthorityResponseV1, { status: 'not_current' }>['reason']) => ({
    status: 'not_current' as const,
    requestNonce: request.requestNonce,
    reason,
  });
  if (!deps.currentIdentity
    || deps.currentIdentity.serverIdentityId !== request.serverIdentityId
    || deps.currentIdentity.machineId !== request.workerMachineId) {
    return deny('identity_mismatch');
  }
  const marker = (await deps.listMarkers()).find(candidate => candidate.runId === request.executionRunId);
  if (!marker) return deny('not_found');
  // A detached Workflow reviewer keeps the admitted starter even when the
  // Machine belongs to another Account. Ordinary detached Runs use the daemon.
  if (marker.happySessionId === null
    && (deps.resolveDetachedWorkflowRequesterAccountId?.(marker.runId) ?? deps.currentIdentity.accountId)
      !== request.requestingAccountId) {
    return deny('identity_mismatch');
  }
  if (marker.status !== 'running') return deny('terminal');
  if (!await deps.isPidAlive(marker.pid)) return deny('runtime_unavailable');

  let live: SessionExecutionRunBrokerAuthorityResponseV1;
  try {
    live = await deps.resolveLiveAuthority({
      sessionId: marker.happySessionId,
      requestingAccountId: request.requestingAccountId,
      executionRunId: request.executionRunId,
      ...(request.expectedIntent !== undefined ? { expectedIntent: request.expectedIntent } : {}),
      expectedOccurrenceId: request.expectedOccurrenceId,
      ...(request.expectedDirectMaterialUse
        ? { expectedDirectMaterialUse: request.expectedDirectMaterialUse }
        : {}),
    });
  } catch {
    return deny('runtime_unavailable');
  }
  if (live.status === 'not_current') return deny(live.reason);
  if (live.executionRunId !== request.executionRunId || live.parentSessionId !== marker.happySessionId) {
    return deny('identity_mismatch');
  }
  if (request.expectedIntent !== undefined && live.intent !== request.expectedIntent) {
    return deny('identity_mismatch');
  }
  if (request.expectedOccurrenceId !== null && live.occurrenceId !== request.expectedOccurrenceId) {
    return deny('occurrence_mismatch');
  }
  return {
    status: 'current',
    requestNonce: request.requestNonce,
    serverIdentityId: request.serverIdentityId,
    requestingAccountId: request.requestingAccountId,
    workerMachineId: request.workerMachineId,
    executionRunId: request.executionRunId,
    occurrenceId: live.occurrenceId,
    parentSessionId: live.parentSessionId,
    ...(live.parentSessionId === null && live.workflowRunId ? { workflowRunId: live.workflowRunId } : {}),
    intent: live.intent,
    runtimeState: live.runtimeState,
    activeTurnId: live.activeTurnId ?? null,
    teamCredentialProviderModel: live.teamCredentialProviderModel,
  };
}
