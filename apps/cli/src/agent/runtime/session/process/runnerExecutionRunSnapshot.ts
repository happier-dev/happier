import { PluginError } from '@happier-dev/plugin-sdk';
import { areSameAgentRoutingIdentity } from '@happier-dev/agents';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { configuration } from '@/configuration';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY,
  readCurrentRunnerAgentRuntimeDaemonServiceAuthority,
  type AgentRuntimeDaemonServiceAuthorityExpectedInput } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { resolveInvocationContributionPolicyFacts } from '@/plugins/runtime/policy/evaluate';
import type { ExecutionRunRpcHandlerContext } from '@/rpc/handlers/executionRuns/registerExecutionRunRpcHandlers';
import { createRunnerAgentSessionRuntimeSource } from './runnerAgentSessionRuntimeSource';
import { dispatchCurrentAgentRuntimeDaemonServiceRequest } from './agentRuntimeDaemonServiceAuthorityClient';
import type { AgentRuntimeDaemonServiceRequestV1, AgentRuntimeDaemonServiceResponseV1 } from './agentRuntimeDaemonServiceProtocol';
import type { RunnerExecutionRunSnapshotV1 } from './executionRunSnapshotProtocol';
import { ExecutionRunScmCommitMessageScopeV1Schema } from '@happier-dev/protocol/execution/runs/startRequest';
import type { ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { createExecutionRunCodedError } from '@/agent/runtime/bridges/executionRun/errors';
import type { ExecutionRunProviderLaunchServices } from '@/agent/runtime/bridges/executionRun/runtime/providerLaunch';
import type { ExecutionRunNativeOfferedModelReader } from '@/agent/runtime/bridges/executionRun/executionRunTypes';

type SnapshotServiceDispatch = (operation: AgentRuntimeDaemonServiceRequestV1['operation']) =>
  Promise<Extract<AgentRuntimeDaemonServiceResponseV1, { ok: true }>['result']>;

/** The runner's profile lifecycle stays local; preparation reads retain daemon custody. */
export function createRunnerExecutionRunProfileCatalog(input: Readonly<{
  snapshot: RunnerExecutionRunSnapshotV1;
  sessionId: string;
  machineId?: string;
  engineRegistry: Awaited<ReturnType<typeof resolveCliEngineRegistry>>;
  dispatch: SnapshotServiceDispatch;
}>) {
  return buildExecutionRunProfileCatalog(input.snapshot.profiles, {
    resolveAgentIdentity: agentId => input.engineRegistry.contributions.agentDefinitionsById.get(agentId)?.identity ?? null,
    resolvePolicyFacts: ({ agentId }) => resolveInvocationContributionPolicyFacts({ sessionId: input.sessionId,
      facts: { 'session.agentId': agentId, ...(input.machineId ? { 'machine.id': input.machineId } : {}) } }),
    resolveReviewScmScope: async params => {
      const result = await input.dispatch({ kind: 'execution_run.review_scm_scope.resolve_v1', ...params });
      if (result.kind !== 'execution_run.review_scm_scope') throw new PluginError({
        code: 'execution_run_contribution_snapshot_unavailable', message: 'Execution Run SCM preparation is unavailable' });
      return result.scope;
    },
    loadScmCommitMessageContext: async params => {
      const { scope, ...limits } = params;
      const result = await input.dispatch({ ...limits, kind: 'execution_run.commit_message_context.resolve_v1',
        ...(scope === undefined ? {} : { scope: ExecutionRunScmCommitMessageScopeV1Schema.parse(scope) }),
      });
      if (result.kind !== 'execution_run.commit_message_context') throw new PluginError({
        code: 'execution_run_contribution_snapshot_unavailable', message: 'Execution Run SCM preparation is unavailable' });
      return result.context;
    },
    captureScmCommitTarget: async cwd => {
      const result = await input.dispatch({ kind: 'execution_run.scm_commit_target.capture_v1', cwd });
      if (result.kind !== 'execution_run.scm_commit_target') throw new PluginError({
        code: 'execution_run_contribution_snapshot_unavailable', message: 'Execution Run SCM preparation is unavailable' });
      return result.capture;
    },
    resolvePromptAssetBlocks: async ({ promptAsset }) => {
      const result = await input.dispatch({ kind: 'turn_contributions.resolve', requestId: input.snapshot.snapshotId,
        request: { kind: 'prompt', selectedAsset: promptAsset,
          ...(input.machineId ? { machineId: input.machineId } : {}) } });
      if (result.kind !== 'turn_contributions' || result.contributions.kind !== 'prompt') throw new PluginError({
        code: 'execution_run_contribution_snapshot_unavailable', message: 'Execution Run prompt preparation is unavailable' });
      return result.contributions.promptAssetBlocks;
    },
  });
}

export function createRunnerExecutionRunSnapshotResolver(input: Readonly<{ sessionId: string; machineId?: string }>):
  NonNullable<ExecutionRunRpcHandlerContext['resolveExecutionRunProfileCatalog']> {
  const unavailable = () => { throw new PluginError({ code: 'execution_run_contribution_snapshot_unavailable',
    message: 'Execution Run executable snapshot is unavailable' }); };
  return async (backendTarget, runnerAgentTarget) => {
    const path = sessionProcessEnvironment()[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY];
    if (!path) return unavailable();
    const current = await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
      happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
      path, expectedSessionId: input.sessionId });
    if (!current) return unavailable();
    const authority: AgentRuntimeDaemonServiceAuthorityExpectedInput = {
      happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
      path, sessionId: input.sessionId, runner: current.runner, retainedAgent: current.retainedAgent,
    };
    const dispatch = async (operation: AgentRuntimeDaemonServiceRequestV1['operation'], executionRunSnapshotId?: string, signal?: AbortSignal) => {
      const response = await dispatchCurrentAgentRuntimeDaemonServiceRequest({ authority, timeoutMs: null, signal,
        createRequest: token => ({ v: 1, context: { token, sessionId: input.sessionId,
          ...(executionRunSnapshotId ? { executionRunSnapshotId } : {}) }, operation }) });
      if (!response.ok) {
        throw new PluginError({
          code: response.error.code,
          message: response.error.code,
          ...(response.error.retryable === undefined ? {} : { retryable: response.error.retryable }),
          ...(response.error.cause ? { details: { cause: response.error.cause } } : {}),
        }, response.error.cause ? { cause: response.error.cause } : undefined);
      }
      return response.result;
    };
    const snapshot = await dispatch({ kind: 'execution_run.snapshot.acquire_v1',
      ...(backendTarget ? { backendTarget: readBackendTargetRefV2(backendTarget) } : {}),
      ...(runnerAgentTarget ? { runnerAgentTarget } : {}) });
    if (snapshot.kind !== 'execution_run.snapshot') return unavailable();
    let source: Awaited<ReturnType<typeof createRunnerAgentSessionRuntimeSource>> = null;
    let runnerSource: Awaited<ReturnType<typeof createRunnerAgentSessionRuntimeSource>> = null;
    const releaseDaemon = async () => {
      const result = await dispatch({ kind: 'execution_run.snapshot.release_v1', snapshotId: snapshot.snapshotId });
      if (result.kind !== 'execution_run.snapshot.released') return unavailable();
    };
    try {
      const after = await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
        happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path, expectedSessionId: input.sessionId });
      if (!after || after.capability !== current.capability || after.httpPort !== current.httpPort) return unavailable();
      if (snapshot.agent) {
        source = await createRunnerAgentSessionRuntimeSource({
          happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
          authorityFilePath: path, expectedSessionId: input.sessionId,
          occurrenceId: snapshot.agent.descriptor.occurrenceId,
          runtimeAuthority: snapshot.agent.descriptor.runtimeAuthority,
          executionRunSnapshot: snapshot,
        });
        if (!source) return unavailable();
      } else if (backendTarget) return unavailable();
      // Both roles can select the same admitted Agent. Its existing source
      // serves both roles; registering it twice makes the catalog reject it.
      if (snapshot.runnerAgent && (!snapshot.agent || !areSameAgentRoutingIdentity(
        snapshot.agent.descriptor.agentId, snapshot.runnerAgent.descriptor.agentId,
      ))) {
        runnerSource = await createRunnerAgentSessionRuntimeSource({
          happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
          authorityFilePath: path, expectedSessionId: input.sessionId,
          occurrenceId: snapshot.runnerAgent.descriptor.occurrenceId,
          runtimeAuthority: snapshot.runnerAgent.descriptor.runtimeAuthority,
          executionRunSnapshot: { ...snapshot, agent: snapshot.runnerAgent },
        });
        if (!runnerSource) return unavailable();
      }
      const engineRegistry = await resolveCliEngineRegistry({
        contributes: createResolvedContributionRegistry({ agents: [...(source ? [source.agentContribution] : []), ...(runnerSource ? [runnerSource.agentContribution] : [])] }),
        ...(source ? { backendId: source.identity.backendId, runnerAgentSessionRuntimeSource: source,
          requireRunnerAgentSessionRuntimeSource: true,
          runnerAgentSessionRuntimeSources: runnerSource ? [runnerSource] : [] } : {}),
      });
      const profileCatalog = createRunnerExecutionRunProfileCatalog({ snapshot, engineRegistry, ...input,
        dispatch: operation => dispatch(operation, snapshot.snapshotId) });
      const providerRefusal = (refusal: Readonly<{ providerError: ProviderErrorV1; childChoiceRequired: boolean }>): never => {
        const code = refusal.childChoiceRequired ? 'execution_run_child_choice_required' : refusal.providerError.code;
        throw Object.assign(createExecutionRunCodedError(code, code), { code, details: { providerError: refusal.providerError } });
      };
      const providerLaunch: ExecutionRunProviderLaunchServices = {
        async prepareLaunch(request, signal) {
          const result = await dispatch({ kind: 'execution_run.provider.prepare_v1', ...request,
            backendTarget: readBackendTargetRefV2(request.backendTarget) }, snapshot.snapshotId, signal);
          if (result.kind !== 'execution_run.provider.prepared') return unavailable();
          if (!result.ok) return providerRefusal(result);
          const environment: Record<string, string> = {};
          const unsetEnvKeys: string[] = [];
          for (const entry of result.environmentOverlay) {
            if (entry.value === null) unsetEnvKeys.push(entry.name);
            else environment[entry.name] = entry.value;
          }
          const redaction = createProviderRedactionLease({ values: result.additionalRedactionValues });
          let closed = false;
          return Object.freeze({ environment: Object.freeze(environment), unsetEnvKeys: Object.freeze(unsetEnvKeys),
            ...(result.connectedServices !== undefined ? { connectedServices: result.connectedServices } : {}),
            providerBinding: result.providerBinding, additionalRedactionValues: result.additionalRedactionValues,
            sanitizeDiagnosticText: redaction.snapshotRedactor(),
            revalidateBeforeCommit: async (commitSignal?: AbortSignal) => {
              const current = await dispatch({ kind: 'execution_run.provider.revalidate_v1' }, snapshot.snapshotId,
                commitSignal && signal ? AbortSignal.any([signal, commitSignal]) : commitSignal ?? signal);
              if (current.kind !== 'execution_run.provider.revalidated') return unavailable();
              return current.result;
            },
            cleanupOnExit: async () => {
              if (closed) return;
              const result = await dispatch({ kind: 'execution_run.provider.release_v1' }, snapshot.snapshotId);
              if (result.kind !== 'execution_run.provider.released') return unavailable();
              closed = true;
              redaction.close();
            },
          });
        },
      };
      const ready = await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
        happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path, expectedSessionId: input.sessionId });
      if (!ready || ready.capability !== current.capability || ready.httpPort !== current.httpPort) return unavailable();
      let released = false;
      const readNativeOfferedModel: ExecutionRunNativeOfferedModelReader = async (request, signal) => {
        const result = await dispatch({ kind: 'execution_run.native_offered_model.read_v1', ...request,
          backendTarget: readBackendTargetRefV2(request.backendTarget) }, snapshot.snapshotId, signal);
        if (result.kind !== 'execution_run.native_offered_model') return unavailable();
        return result.model ?? undefined;
      };
      return { profileCatalog, engineRegistry, providerLaunch, readNativeOfferedModel,
        nativeModelRegistry: engineRegistry.contributions, release: async () => {
        if (released) return;
        try { await runnerSource?.retire?.(); } finally {
          try { await source?.retire?.(); } finally { await releaseDaemon(); }
        }
        released = true;
      } };
    } catch (error) {
      try { await runnerSource?.retire?.(); } finally {
        try { await source?.retire?.(); } finally { await releaseDaemon(); }
      }
      throw error;
    }
  };
}
