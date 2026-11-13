import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionOperationGetV1ResponseSchema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ActionCompletionOperation } from '@happier-dev/protocol/actions/actionCompletion';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import type { ActionOperationRpcContext } from '@/daemon/actionOperations/actionOperationRpcHandlers';
import { createSpawnedSession, type DirectSpawnedSessionTransport } from '@/session/services/createSpawnedSession';
import { classifyWorkflowAbort, WorkflowRuntimeInterruption } from './coordinator';
import type { WorkflowSessionStartup } from './sessionStepExecutor';
import { WorkflowSessionCompositionError } from './workflowConversation';
export { deriveWorkflowSessionCreationTag } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { prepareRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { readRetainedWorkflowSessionStartupFailure, readWorkflowSessionStartupError, readWorkflowSessionStartupRefusal, rethrowWorkflowSessionStartupFailure } from './workflowSessionStartupFailure';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { enrichCliActionApprovalContext } from '@/session/actions/enrichCliActionApprovalContext';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { prepareSessionCreationTarget } from '@/session/creation/prepareSessionCreationTarget';
import { prepareSessionAgentReadiness } from '@/session/creation/prepareSessionAgentReadiness';
import { resolveSessionCreationAgentTarget } from '@/session/creation/resolveSessionCreationAgentTarget';
import type { MachineActionDirectTargetTransport } from '@/session/actions/createCliActionDeps';
import type { CurrentMachineInstallation } from '@/daemon/identity/currentMachineInstallation';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';

/** The original startup operation, rather than its Workflow observer, owns launch custody. */
export async function prepareWorkflowSessionRequester(
  input: Omit<Parameters<typeof prepareRequesterSessionBootstrap>[0], 'homeServerIdentityId' | 'boundary'> & Readonly<{
    savedSecretOperationContext?: Pick<SavedSecretOperationContextV1, 'machineAdmission'>;
    boundary: Parameters<typeof prepareRequesterSessionBootstrap>[0]['boundary'] & Readonly<{
      getObservedServerIdentityId(): string | null | Promise<string | null>;
    }>;
  }>,
): ReturnType<typeof prepareRequesterSessionBootstrap> {
  const { signal, savedSecretOperationContext, ...requester } = input;
  signal?.throwIfAborted();
  // This signal observes the Workflow claim. Once startup is accepted, its
  // existing Action operation supplies cancellation to the launch transport.
  // Keep the bootstrap's own disposal/currentness lifetime for that handoff.
  const prepared = await prepareRequesterSessionBootstrap({ ...requester,
    machineAdmission: savedSecretOperationContext?.machineAdmission ?? requester.machineAdmission });
  if (signal?.aborted) {
    await prepared?.cleanupOnFailure();
    signal.throwIfAborted();
  }
  return prepared;
}

/** The installed Workflow caller supplies its actual admitted host, not Account defaults. */
export type WorkflowSessionStartupHost = Readonly<{
  serverId: string;
  machineId: string;
  observeExecution: HostActionOperationRuntime['observeExecution'];
  rpcContext: ActionOperationRpcContext;
  machineActionDirectTargetTransport?: MachineActionDirectTargetTransport;
  sessionCreationInstallation?: Pick<CurrentMachineInstallation['identity'], 'installationId' | 'privateKey'>;
  transport(operation: Parameters<Parameters<HostActionOperationRuntime['observeExecution']>[0]['execute']>[0]): DirectSpawnedSessionTransport;
  observeOperation(operation: ActionCompletionOperation, options: Readonly<{
    waitForTerminal: boolean; includeSetupReview: boolean; signal?: AbortSignal;
  }>): Promise<unknown>;
  cancelOperation(operation: ActionCompletionOperation): Promise<unknown>;
  cleanupOnFailure(): Promise<void>;
}>;

/** The original spawn operation's completion admits the Session for Workflow input. */
export async function runObservedWorkflowSessionStartup(
  input: Parameters<WorkflowSessionStartup>[0],
  host: WorkflowSessionStartupHost,
): ReturnType<WorkflowSessionStartup> {
  const signal = input.request.signal;
  const observation = new AbortController();
  const serverHttpBaseUrl = resolveServerHttpBaseUrl();
  let address = input.retainedOperation;
  const read = async (waitForTerminal: boolean, includeSetupReview: boolean, readSignal = observation.signal) => {
    const parsed = ActionOperationGetV1ResponseSchema.parse(await host.observeOperation(address!, {
      waitForTerminal, includeSetupReview, ...(readSignal ? { signal: readSignal } : {}),
    }));
    const operation = parsed.kind === 'found' ? parsed.operation
      : readRetainedWorkflowSessionStartupFailure(input.retainedOperationSnapshot, address!, input.creationKey);
    if (!operation || address!.serverId !== host.serverId || address!.machineId !== host.machineId
      || operation.operationId !== address!.operationId || operation.requestId !== input.creationKey
      || operation.actionId !== 'session.spawn_new' || operation.scope.machineId !== host.machineId) {
      throw new Error('workflow_invocation_fact_conflict');
    }
    return operation;
  };
  const rejectFromOriginalOperation = async (error: unknown): Promise<never> => {
    if (!address || signal?.aborted) throw error;
    const operation = await read(false, false);
    if (operation.state !== 'failed') throw error;
    // The original operation proves failure even when creation rejects before
    // returning an acceptance reply. Preserve its terminal fact for recovery.
    await input.onObservation?.(operation);
    throw readWorkflowSessionStartupError(operation);
  };
  const abort = () => {
    if (address && classifyWorkflowAbort(signal) !== 'interrupted') void host.cancelOperation(address).catch(() => undefined);
    observation.abort();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) {
      if (classifyWorkflowAbort(signal) === 'interrupted') throw new WorkflowRuntimeInterruption();
      if (address) await host.cancelOperation(address);
      signal.throwIfAborted();
    }
    let initialOperation: ActionOperationSnapshotV1 | undefined;
    if (address) {
      initialOperation = await read(false, false);
      await input.onObservation?.(initialOperation);
    }
    let launch: ReturnType<WorkflowSessionStartupHost['observeExecution']> | undefined;
    if (!initialOperation || initialOperation.state === 'running' || initialOperation.state === 'accepted') {
      const retainedAddress = address;
      let retained!: () => void;
      let refused!: (error: unknown) => void;
      const admission = new Promise<void>((resolve, reject) => { retained = resolve; refused = reject; });
      let rejoinedRetention: Promise<void> | undefined;
      launch = host.observeExecution({ actionId: 'session.spawn_new',
        input: { creationKey: input.creationKey, directory: { kind: 'path', path: input.request.directory },
          executionTarget: { serverId: host.serverId, machineId: host.machineId },
          agentTarget: input.request.agentTarget, observeSessionCommit: true },
        actionRequestId: input.creationKey, rpcContext: { ...host.rpcContext, signal: observation.signal },
        onOperation: operation => {
          if (retainedAddress && retainedAddress.operationId !== operation.operationId) {
            throw new Error('workflow_invocation_fact_conflict');
          }
          address = { key: 'startup', serverId: host.serverId, machineId: host.machineId, operationId: operation.operationId };
          if (signal?.aborted) abort();
          if (operation.state === 'running') {
            // An active same-key launch skips this caller's execute callback.
            // Retain its exact correspondence before observing it independently.
            rejoinedRetention = read(false, false).then(snapshot => input.onObservation?.(snapshot));
            void rejoinedRetention.then(retained, refused);
          }
        },
        execute: async operation => {
          // A retained observer may join its original launch, never replace it.
          if (retainedAddress) return { ok: false, errorCode: 'workflow_session_startup_observation_unavailable',
            error: 'workflow_session_startup_observation_unavailable' };
          const operationId = operation.operationAcceptance?.operationId;
          if (!operationId) return { ok: false, errorCode: 'workflow_session_startup_observation_unavailable', error: 'workflow_session_startup_observation_unavailable' };
          address = { key: 'startup', serverId: host.serverId, machineId: host.machineId, operationId };
          if (signal?.aborted && classifyWorkflowAbort(signal) !== 'interrupted') {
            await host.cancelOperation(address);
            return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
          }
          try {
            // Retain the original operation before launch. A direct refusal
            // can settle observeExecution without returning an accepted reply.
            // Recovery still needs this exact owner, including after Cancel.
            await (rejoinedRetention ?? input.onObservation?.(await read(false, false, operation.signal)));
            // Retaining correspondence can outlast a claim. Only explicit
            // Workflow stop authority, or the operation's own cancellation,
            // may stop the admitted launch after that durable handoff.
            if (signal?.aborted && classifyWorkflowAbort(signal) !== 'interrupted') {
              await host.cancelOperation(address);
              signal.throwIfAborted();
            }
            operation.signal.throwIfAborted();
            retained();
            // The original operation controls execution. A lost Workflow claim
            // ends observation but cannot cancel or replace admitted startup.
            const create = () => runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createSpawnedSession({
              ...input.request, signal: operation.signal, directTransport: host.transport(operation) }));
            if (!input.actionAdmission) throw new WorkflowSessionCompositionError('approval_context_unavailable');
            const { input: actionInput } = input.actionAdmission;
            const context = await enrichCliActionApprovalContext({ context: input.actionAdmission.context,
              fixedServerId: host.serverId, machineId: host.machineId,
              resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: serverHttpBaseUrl,
                token: input.request.credentials.token, signal: operation.signal }),
            });
            const { executor } = createCliActionExecutorHarness({ credentials: input.request.credentials,
              token: input.request.credentials.token, sessionId: context.defaultSessionId ?? 'cli',
              serverId: host.serverId, ...(context.serverIdentityId ? { serverIdentityId: context.serverIdentityId } : {}),
              serverHttpBaseUrl, mode: 'plain', ctx: null,
              ...(host.machineActionDirectTargetTransport
                ? { machineActionDirectTargetTransport: host.machineActionDirectTargetTransport } : {}),
              ...(host.sessionCreationInstallation ? {
                externalActionMachineInstallationId: host.sessionCreationInstallation.installationId,
                externalActionMachineRequestPrivateKey: host.sessionCreationInstallation.privateKey,
              } : {}),
              actionsSettingsProvider: createActionSettingsProvider({
                scopeKey: resolveAccountSettingsScopeKey(input.request.credentials), allowEnvironmentOverride: false,
              }),
              sessionSpawnDirectTargetTransport: {
                machineId: host.machineId,
                spawnedSession: host.transport(operation),
                prepare: (request, options) => prepareSessionCreationTarget({ request,
                  signal: options?.signal ?? operation.signal }),
              },
            }, {
              hostActionApprovalLifetime: { operationId, signal: operation.signal },
              sessionSpawnNew: async args => {
                const selectedAgent = resolveSessionCreationAgentTarget(args.agentTarget);
                if (!selectedAgent) return { type: 'error', code: 'target_unavailable', retryable: false,
                  failureCause: projectActionFailureCauseV1(
                    { name: 'Error', code: 'agent_contribution_unavailable' }, 'session.agent_target') };
                const readiness = await prepareSessionAgentReadiness({
                  machineId: host.machineId, serverId: host.serverId, agentId: selectedAgent.agentId,
                  ...(args.agentTarget.definitionId === undefined ? {} : { definitionId: args.agentTarget.definitionId }),
                  ...(args.agentInstallConsent === undefined ? {} : { consent: args.agentInstallConsent }),
                  ...(args.actionRequestId ? { requestId: args.actionRequestId } : {}),
                  invoke: args.invokeAgentReadinessAction, signal: operation.signal,
                });
                if (readiness && 'result' in readiness) return readiness.result;
                try {
                  const created = await create();
                  return { type: 'success', disposition: created.disposition, sessionId: created.sessionId,
                    executionTarget: { serverId: host.serverId, machineId: host.machineId },
                    organizationPlacement: created.organizationPlacement, initialInput: created.initialInput,
                    ...(readiness ? { agentUpdate: readiness.agentUpdate } : {}) };
                } catch (error) {
                  const refusal = readWorkflowSessionStartupRefusal(error);
                  if (refusal) return refusal;
                  throw error;
                }
              },
            });
            const prepared = await executor.prepare('session.spawn_new', actionInput, {
              ...context, ...operation, actionRequestId: input.creationKey,
              agentStartWorkDepth: input.request.workDepth,
              // This private admission reviews the immutable native birth recipe.
              // Interception cannot replace it; ordinary approval policy still applies.
              bypassActionInterception: true,
            });
            const result = prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
            if (!result.ok) throw new WorkflowSessionCompositionError(result.errorCode);
            const created = SessionSpawnNewActionResultV1Schema.safeParse(result.result);
            if (created.success && created.data.type === 'error') {
              try { await host.cleanupOnFailure(); } catch { /* Preserve the original startup refusal. */ }
              return { ok: true, result: created.data };
            }
            if (!created.success || created.data.type !== 'success') {
              throw new WorkflowSessionCompositionError('workflow_session_startup_unavailable');
            }
            return { ok: true, result: { sessionId: created.data.sessionId,
              ...(created.data.agentUpdate ? { agentUpdate: created.data.agentUpdate } : {}) } };
          } catch (error) {
            try { await host.cleanupOnFailure(); } catch { /* Preserve the original startup refusal. */ }
            if (operation.signal.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
            const refusal = readWorkflowSessionStartupRefusal(error);
            if (refusal) return { ok: true, result: refusal };
            rethrowWorkflowSessionStartupFailure(error, input.request.spawnNonce);
          }
        } });
      // Start observing as soon as correspondence is retained, even when the
      // keyed launch caller waits for native completion. The race also handles
      // a later launch rejection after this observer has left its claim.
      const response = await Promise.race([admission, launch]).catch(rejectFromOriginalOperation);
      if (response && !response.ok) await rejectFromOriginalOperation(Object.assign(new Error(response.error), { code: response.errorCode }));
    }
    if (!address || address.serverId !== host.serverId || address.machineId !== host.machineId) {
      throw new Error('workflow_invocation_fact_conflict');
    }
    const completion = (async () => {
      let operation = initialOperation ?? await read(false, false);
      if (!initialOperation) await input.onObservation?.(operation);
      if (operation.state === 'running' || operation.state === 'accepted') {
        operation = await read(true, true);
        await input.onObservation?.(operation);
        if (operation.setupReview || operation.progress?.kind === 'phase' && operation.progress.phase === 'waiting_for_approval') {
          // The explicit review read publishes the hold. Its original operation
          // then owns consent and birth while this terminal-only read waits.
          operation = await read(true, false);
        }
      }
      if (operation.state === 'cancelled') throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      if (operation.state === 'failed') throw readWorkflowSessionStartupError(operation);
      if (operation.state !== 'succeeded') throw Object.assign(new Error(operation.error?.error ?? 'workflow_session_startup_unavailable'), {
        code: operation.error?.errorCode ?? 'workflow_session_startup_unavailable',
      });
      const result = operation.result;
      if (!result || typeof result !== 'object' || Array.isArray(result) || !('sessionId' in result)
        || typeof result.sessionId !== 'string' || !result.sessionId) throw new Error('workflow_invocation_fact_conflict');
      return { sessionId: result.sessionId };
    })();
    if (!launch) return await completion;
    const settled = await Promise.race([
      completion.then(created => ({ kind: 'completed' as const, created })),
      launch.then(response => ({ kind: 'launch' as const, response })).catch(rejectFromOriginalOperation),
    ]);
    if (settled.kind === 'completed') return settled.created;
    if (!settled.response.ok) await rejectFromOriginalOperation(Object.assign(new Error(settled.response.error), {
      code: settled.response.errorCode,
    }));
    // Acceptance can name the Session before the spawn owner finishes its birth
    // and startup work. Only that same operation's terminal result admits input.
    return await completion;
  } catch (error) {
    if (!address) {
      try { await host.cleanupOnFailure(); } catch { /* Preserve the original startup refusal. */ }
    }
    if (signal?.aborted && classifyWorkflowAbort(signal) === 'interrupted') throw new WorkflowRuntimeInterruption();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    observation.abort();
  }
}
