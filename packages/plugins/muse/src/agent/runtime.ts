import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { canonicalAbsolutePathsEqual } from '@happier-dev/plugin-sdk/fs';
import { classifyJsonRpcSubmissionFailure } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import type { AgentRuntime, AgentSessionCatalogControl, AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeContext,
  AgentSessionHostServices, AgentSessionCompactResult, AgentExecutionRunOpenRequest, AgentExecutionRunRuntimeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentRuntimeJsonValueSchema, createExecutionRunHostBackendFromConversationRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { ACTIVITY_SESSION_SYSTEM_RECORD_KINDS, SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
  buildWorkflowRunSystemRecordLocalId, createWorkflowActivityPublisher, SessionWorkflowRunSnapshotV1Schema,
  type SessionWorkflowRunSnapshotV1 } from '@happier-dev/plugin-sdk/sessions/work-state';
import { createMuseCatalog, type MuseCatalog } from './catalog.js';
import { MUSE_AGENT } from './definition.js';
import { createMuseEventProjection, readMuseRecord } from './events.js';
import { openMuseMsp, type MuseMsp } from './msp.js';
import { createMuseInteractions } from './interactions.js';
import { museNativeSkillCatalogItem, readMuseNativeSkills, resolveMuseTurnInput } from './inputs.js';
import { readMuseHistoryItems, replayMusePagedHistory } from './externalSessions.js';

async function openMuseConversation<SessionId extends string | undefined>(
  request: AgentSessionOpenRequest | AgentExecutionRunOpenRequest,
  context: AgentSessionRuntimeContext | AgentExecutionRunRuntimeContextV1,
  sessionId: SessionId,
) {
  const sessionServices = 'executionRun' in context ? undefined : context.session.services;
  const scopeServices = 'executionRun' in context ? context.executionRun.services : context.session.services;
  const resumeId = request.kind === 'resume'
    ? 'checkpointId' in request ? request.checkpointId : request.providerSessionId : undefined;
  if (request.kind === 'fork' && !('source' in request)) throw new PluginError({ code: 'unsupported', message: 'Native Muse Run fork is unavailable on this launch path.' });
  if (request.kind === 'fork' && 'source' in request
    && !canonicalAbsolutePathsEqual(request.cwd, request.source.cwd)) {
    throw new PluginError({ code: 'unsupported', message: 'Native Muse fork requires the source workspace directory.' });
  }
  if ('startupInstructions' in request && request.startupInstructions) throw new PluginError({ code: 'agent_session_startup_instructions_unsupported', retryable: false });
  if ('modelSelection' in request && request.modelSelection?.providerConnectionId !== undefined
    && request.modelSelection.providerConnectionId !== null) {
    throw new PluginError({ code: 'unsupported', message: 'This native Muse model binding is unavailable.' });
  }
  const requestedModelId = request.configuration?.model.value
    ?? ('modelSelection' in request ? request.modelSelection?.modelId : undefined);
  if (request.skills?.items.length) {
    throw new PluginError({ code: 'unsupported', message: 'The selected native Muse skill delivery is unavailable on this launch path.' });
  }
  const selectedMcp = Object.entries(request.mcpServers ?? {});
  if (request.kind === 'fork' && selectedMcp.length) throw new PluginError({ code: 'unsupported',
    message: 'Native Muse fork cannot apply the selected MCP startup configuration.' });
  // MSP has no tool-filter or per-tool policy field. Preserve the host's
  // selection by refusing shapes that cannot be represented before any effect.
  if (selectedMcp.some(([, server]) => server.enabledTools !== undefined)
    || Object.keys(request.mcpToolPolicy ?? {}).length) {
    throw new PluginError({ code: 'unsupported', message: 'Native Muse cannot enforce the selected MCP tool filter or policy.' });
  }
  const nativeMcpServers = Object.fromEntries(selectedMcp.map(([name, server]) => [name, {
    transport: 'stdio', command: server.command,
    ...(server.args === undefined ? {} : { args: [...server.args] }),
    ...(server.env === undefined ? {} : { env: { ...server.env } }),
    mode: request.mcpServersStrictMode === false ? 'optional' : 'required',
  }]));
  const nativeMcpConfig: Readonly<Record<string, JsonValue>> = selectedMcp.length ? { config: { mcpServers: nativeMcpServers } } : {};
  const intent = request.configuration?.permissionIntent.value;
  if ((intent && intent !== 'default') || request.configuration?.workspaceWrites === 'deny') {
    throw new PluginError({ code: 'unsupported', message: 'The requested permission intent has no characterized native Muse mapping.' });
  }
  if (request.configuration?.mode.value) throw new PluginError({ code: 'unsupported', message: 'Native Muse behavior modes are unavailable.' });
  const workflowSnapshots = new Map<string, SessionWorkflowRunSnapshotV1>();
  const workflowAddress = (runId: string) => ({ owner: 'host' as const,
    namespace: SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE, kind: ACTIVITY_SESSION_SYSTEM_RECORD_KINDS[0],
    localId: buildWorkflowRunSystemRecordLocalId({ runId }) });
  const workflowPublisher = sessionServices ? createWorkflowActivityPublisher({ backendId: MUSE_AGENT.id, agentId: MUSE_AGENT.id,
    async readCommittedRunSnapshot(runId) {
      const record = await context.services.sessions.current?.readSystemRecord({ address: workflowAddress(runId) });
      return record ? SessionWorkflowRunSnapshotV1Schema.parse(record.content) : null;
    },
    async commitRecord(snapshot) {
      const current = context.services.sessions.current;
      if (!current) throw new PluginError({ code: 'unsupported', message: 'Session workflow records are unavailable.' });
      await current.upsertSystemRecord({ address: workflowAddress(snapshot.runId), content: AgentRuntimeJsonValueSchema.parse(snapshot) });
    },
    async writeHeadlines(bundle) { await sessionServices.workflowActivity.publishHeadlines(AgentRuntimeJsonValueSchema.parse(bundle)); },
  }) : undefined;
  let activity: 'active' | 'idle' | 'unknown' = 'unknown';
  const readiness = new Set<Readonly<{ resolve(): void; reject(error: unknown): void }>>();
  const retireReadiness = () => {
    const error = new PluginError({ code: 'PLUGIN_EXEC_FAILED', message: 'Native Muse input is unavailable because the runtime ended.' });
    for (const waiter of readiness) waiter.reject(error);
    readiness.clear();
  };
  const projection = createMuseEventProjection({ sessionId,
    onActivity(state) {
      activity = state;
      if (state === 'idle') {
        for (const waiter of readiness) waiter.resolve();
        readiness.clear();
      }
    },
    async onChild(observation) { await sessionServices?.subagents.observe(observation); },
    async onWorkflow(snapshot) {
      workflowSnapshots.set(snapshot.runId, snapshot);
      await workflowPublisher?.publish({ snapshots: workflowSnapshots, changedRunIds: [snapshot.runId] });
    },
  });
  let closing = false;
  let ended = false;
  const end = (cause: 'processExited' | 'connectionLost' | 'protocolError') => {
    if (closing || ended) return;
    ended = true;
    retireReadiness();
    projection.publish({ kind: 'runtime-ended', cause, retryable: true });
  };
  const interactions = createMuseInteractions({ context,
    ...('executionRun' in context ? { permissions: context.executionRun.services.permissions } : {}),
    command: (method, params, options) => msp.command(method, params, options),
    readNativeChildOrigin: projection.readNativeChildOrigin,
    onError(error, params) {
      if (params) projection.presentNativeInteraction(params, { nativeInteraction: 'unavailable',
        code: error instanceof PluginError ? error.code : 'unavailable' });
    },
    onNativeQuestionSettlement(params) {
      projection.presentNativeInteraction(params, { nativeQuestionSettlement: {
        outcome: params.outcome ?? 'unknown', ...(params.answers === undefined ? {} : { answers: params.answers }),
        ...(params.clarification === undefined ? {} : { clarification: params.clarification }),
        ...(params.reason === undefined ? {} : { reason: params.reason }),
      } });
    },
  });
  let catalogSource: MuseCatalog | undefined;
  let catalogSessionId: string | undefined;
  const msp: MuseMsp = await openMuseMsp({ exec: context.services.exec,
    launch: { executable: { kind: 'systemTool', id: 'muse-cli' }, cwd: request.cwd, env: request.launchEnvironment?.values },
    signal: context.signal, nativeLaunch: scopeServices.nativeLaunch,
    initialize: { capabilities: { experimentalApi: true,
      ...(selectedMcp.length ? { requestedCapabilities: ['sessionMcp'] } : {}) } },
    onRequest: interactions.onRequest,
    async onNotification(message) {
      if (!interactions.observe(message)) await projection.observe(message);
      if (catalogSessionId) catalogSource?.observeConfiguration(message, catalogSessionId);
      if (message.method === 'session/closed') end('connectionLost');
    },
  }).catch(error => { interactions.dispose(); projection.dispose(); throw error; });
  const catalog = catalogSource = createMuseCatalog(msp.client);
  let modelsBinding: ReturnType<AgentSessionHostServices['models']['bind']> | undefined;
  let inputBinding: ReturnType<AgentSessionHostServices['activeInput']['bind']> | undefined;
  void msp.wait().then(() => end('processExited'), () => end('protocolError'));
  try {
    const grantedCapabilities = readMuseRecord(msp.initializeResult).grantedCapabilities;
    if (selectedMcp.length && (!Array.isArray(grantedCapabilities) || !grantedCapabilities.includes('sessionMcp'))) {
      throw new PluginError({ code: 'unsupported', message: 'Native Muse did not grant session MCP configuration.' });
    }
    modelsBinding = sessionServices?.models.bind(catalog);
    const selectedId = request.kind === 'create' ? requestedModelId : undefined;
    let selected: ReturnType<typeof catalog.resolveModelSelection> = { status: 'nativeDefault' };
    if (selectedId) {
      await catalog.refresh({ signal: context.signal });
      selected = catalog.resolveModelSelection(selectedId);
      if (selected.status === 'unavailable') throw new PluginError({ code: 'model_selection_required', retryable: false,
        message: 'The selected Muse model is unavailable in the native catalog.' });
    }
    const opened = readMuseRecord(await (request.kind === 'fork' && 'source' in request
      ? msp.command('session/fork', { sessionId: request.source.providerSessionId,
        ...(request.source.target ? { cutPoint: request.source.target.providerCheckpoint } : {}),
        excludeItems: false }, { signal: context.signal })
      : request.kind === 'resume'
      ? msp.command('session/resume', { sessionId: resumeId!, excludeItems: false, ...nativeMcpConfig }, { signal: context.signal })
      : msp.command('session/start', { workspaceRoot: request.cwd,
        approvalMode: 'promptUnmatched', permissionProfile: ':ask-me',
        ...nativeMcpConfig,
        ...(selected.status === 'selected' ? { providerId: selected.providerId, modelId: selected.modelId } : {}),
      }, { signal: context.signal })));
    const native = readMuseRecord(opened.session);
    if (typeof native.sessionId !== 'string') throw new PluginError({ code: 'PLUGIN_EXEC_PROTOCOL_ERROR', message: 'Muse did not return a native Session identity.' });
    if (request.kind === 'resume' && native.sessionId !== resumeId) {
      throw new PluginError({ code: 'PLUGIN_EXEC_PROTOCOL_ERROR', message: 'Muse returned a different native Session identity during resume.' });
    }
    const nativeSessionId = native.sessionId;
    catalogSessionId = nativeSessionId;
    projection.observeSession(opened.session);
    inputBinding = sessionServices?.activeInput.bind({
      isTurnInFlight: () => activity === 'active',
      waitForInputReady() {
        if (closing || ended) return Promise.reject(new PluginError({ code: 'PLUGIN_EXEC_FAILED' }));
        if (activity === 'idle') return Promise.resolve();
        return new Promise<void>((resolve, reject) => readiness.add({ resolve, reject }));
      },
      canSteer: () => projection.readOwningTurn() !== undefined,
      onPromptQueued() {},
      applyPermissionIntentDuringTurn: () => ({ status: 'unsupported' }),
      clearTerminalComposer: () => ({ ok: false, status: 'unsupported' }),
      interruptPendingInputAndRun() { throw new PluginError({ code: 'unsupported' }); },
    });
    if (typeof native.providerId === 'string' && typeof native.modelId === 'string') {
      catalog.applyCurrentModel({ providerId: native.providerId, modelId: native.modelId });
    }
    if (request.kind === 'resume' || request.kind === 'fork') {
      const items = readMuseHistoryItems(opened.history);
      if (items) await projection.replayItems(items);
      else await replayMusePagedHistory(msp.client, { sessionId: nativeSessionId, signal: context.signal,
        replay: projection.replayHistoryEvent });
    }
    if (request.kind === 'resume') {
      let pending: ReturnType<typeof readMuseRecord>;
      try {
        pending = readMuseRecord(await msp.client.request('approval/listPending', { sessionId: nativeSessionId }, { signal: context.signal }));
      } catch {
        throw new PluginError({ code: 'PLUGIN_EXEC_FAILED', message: 'Native Muse pending interaction recovery is unavailable.' });
      }
      if (!Array.isArray(pending.approvals) || !Array.isArray(pending.userInputs)) {
        throw new PluginError({ code: 'PLUGIN_EXEC_PROTOCOL_ERROR', message: 'Muse did not return pending interaction recovery state.' });
      }
      for (const params of pending.approvals) interactions.observe({ method: 'approval/requested', params });
      for (const params of pending.userInputs) interactions.observe({ method: 'userInput/requested', params });
    }
    const applyModelConfiguration = async (modelId: string | undefined, effort: string | undefined,
      options?: { signal?: AbortSignal }): Promise<Awaited<ReturnType<NonNullable<AgentSessionRuntime['updateConfiguration']>>>> => {
      const unsupported = { status: 'unsupported' as const,
        diagnostic: { code: 'unsupported', severity: 'error' as const } };
      if (!modelId && effort === undefined) return { status: 'applied', changed: [] };
      let method = 'model/list';
      try {
        if (catalog.read().models === null) await catalog.refresh({ sessionId: nativeSessionId,
          signal: options?.signal ?? context.signal });
        const selected = catalog.resolveModelSelection(modelId ?? catalog.read().currentModelId ?? undefined);
        if (selected.status !== 'selected') return { status: 'rejected',
          diagnostic: { code: 'model_selection_required', severity: 'error' } };
        const offered = catalog.read().models?.find(model => model.id === selected.id)?.modelOptions
          ?.find(option => option.id === 'reasoning_effort');
        if (effort !== undefined && !offered?.options?.some(option => option.value === effort)) return unsupported;
        const changed: string[] = [];
        if (selected.id !== catalog.read().currentModelId) {
          method = 'session/setModel';
          const result = readMuseRecord(await msp.command(method, { sessionId: nativeSessionId,
            model: { providerId: selected.providerId, modelId: selected.modelId } },
          { signal: options?.signal ?? context.signal }));
          if (result.status !== 'accepted') return { status: 'unavailable',
            diagnostic: { code: 'PLUGIN_EXEC_PROTOCOL_ERROR', severity: 'error' } };
          catalog.applyCurrentModel(selected);
          changed.push('model');
        }
        if (effort !== undefined && catalog.readCurrentReasoningEffort() !== effort) {
          method = 'session/setReasoningEffort';
          const result = readMuseRecord(await msp.command(method, { sessionId: nativeSessionId, reasoningEffort: effort },
            { signal: options?.signal ?? context.signal }));
          if (result.status !== 'accepted') return { status: 'unavailable',
            diagnostic: { code: 'PLUGIN_EXEC_PROTOCOL_ERROR', severity: 'error' } };
          catalog.applyCurrentReasoningEffort(effort);
          changed.push('options.reasoning_effort');
        }
        return { status: 'applied', changed };
      } catch (error) {
        const failure = classifyJsonRpcSubmissionFailure(error, { method, effectObserved: false });
        return { status: failure.kind === 'rejected_before_effect' ? 'rejected' : 'unavailable',
          diagnostic: { code: failure.kind === 'rejected_before_effect' ? 'provider_request_rejected' : 'PLUGIN_EXEC_FAILED',
            severity: 'error', ...(failure.kind === 'rejected_before_effect' ? { details: { ...failure.details } } : {}) } };
      }
    };
    const updateConfiguration: NonNullable<AgentSessionRuntime['updateConfiguration']> = async (configuration, options) => {
      const unsupported = { status: 'unsupported' as const,
        diagnostic: { code: 'unsupported', severity: 'error' as const } };
      if (configuration.mode.value || (configuration.permissionIntent.value && configuration.permissionIntent.value !== 'default')
        || configuration.workspaceWrites === 'deny' || configuration.allowedTools !== undefined
        || configuration.unlistedTools !== undefined || configuration.providerBinding !== undefined
        || configuration.mcpToolPolicy !== undefined
        || Object.keys(configuration.options).some(id => id !== 'reasoning_effort')) return unsupported;
      const effort = configuration.options.reasoning_effort?.value;
      if (effort !== undefined && typeof effort !== 'string') return unsupported;
      return applyModelConfiguration(configuration.model.value ?? undefined, effort, options);
    };
    if (request.configuration?.options.reasoning_effort || ((request.kind === 'resume' || request.kind === 'fork') && requestedModelId)) {
      const result = request.configuration
        ? await updateConfiguration({ ...request.configuration,
          model: { ...request.configuration.model, value: requestedModelId ?? request.configuration.model.value } },
        { signal: context.signal })
        : await applyModelConfiguration(requestedModelId, undefined, { signal: context.signal });
      if (result.status !== 'applied') throw new PluginError({
        code: 'diagnostic' in result ? result.diagnostic.code : 'unsupported', retryable: false,
        message: 'The selected native Muse launch configuration could not be applied.',
      });
    }
    return {
      runtimeCapabilities: { sessionCapabilities: MUSE_AGENT.core.sessionCapabilities },
      runtimeDescriptorV1: { v: 1, agentId: MUSE_AGENT.id, agent: { providerSessionId: nativeSessionId,
        ...(typeof native.path === 'string' ? { sessionFile: native.path } : {}),
        ...(request.kind === 'fork' && native.forkedFrom ? { forkedFrom: native.forkedFrom } : {}) } },
      watch: projection.watch,
      updateConfiguration,
      async send(input, options) {
        let nativeInput: Awaited<ReturnType<typeof resolveMuseTurnInput>>;
        try {
          nativeInput = await resolveMuseTurnInput(input.input, { msp, nativeSessionId,
            inputFiles: scopeServices.inputFiles, signal: options?.signal });
        } catch {
          return { status: 'unavailable', retryable: true,
            diagnostic: { code: 'PLUGIN_EXEC_FAILED', severity: 'error' } };
        }
        if (!nativeInput) return { status: 'unsupported', retryable: false,
          diagnostic: { code: 'unsupported', severity: 'error', message: 'This native Muse input shape is unavailable.' } };
        const method = input.delivery.kind === 'steer' ? 'turn/steer' : 'turn/start';
        const expectedTurnId = input.delivery.kind === 'steer' ? projection.readOwningTurn(input.delivery.turnId) : undefined;
        if (input.delivery.kind === 'steer' && !expectedTurnId) return { status: 'rejected', retryable: false,
          diagnostic: { code: 'unsupported', severity: 'error', message: 'The native Muse turn is no longer running.' } };
        let commandId: string | undefined;
        try {
          const result = await msp.command(method, { sessionId: nativeSessionId,
            ...(expectedTurnId ? { expectedTurnId } : {}),
            input: nativeInput }, { signal: options?.signal,
            onCommandId(id) { commandId = id; projection.admit(input, id); },
          });
          if (commandId) projection.accept(commandId, result);
          return { status: 'admitted' };
        } catch (error) {
          // A correlated native start already established custody, even when
          // its JSON-RPC acknowledgement is subsequently refused or lost.
          const accepted = commandId === undefined ? false : projection.retireCommand(commandId);
          if (accepted) return { status: 'admitted' };
          const failure = classifyJsonRpcSubmissionFailure(error, { method, effectObserved: false });
          if (failure.kind === 'rejected_before_effect') {
            const diagnostic = { code: 'provider_request_rejected', severity: 'error' as const,
              details: { ...failure.details } };
            projection.publish({ kind: 'input-rejected', inputIds: input.inputIds, diagnostic, retryable: false });
            return { status: 'rejected', diagnostic, retryable: false };
          }
          const diagnostic = { code: 'native_send_outcome_unknown', severity: 'error' as const };
          if (accepted !== undefined) projection.publish({ kind: 'input-custody-unknown', inputIds: input.inputIds, issue: diagnostic });
          return { status: 'unavailable', diagnostic, retryable: true };
        }
      },
      async cancel(request, options) {
        const turnId = projection.readOwningTurn(request.turnId);
        if (!turnId) return { status: 'notRunning' };
        try {
          const result = readMuseRecord(await msp.command('turn/interrupt', { sessionId: nativeSessionId, turnId },
            { signal: options?.signal }));
          if (result.status === 'accepted') return { status: 'requested', turnId: request.turnId };
          return { status: 'unavailable', diagnostic: { code: 'PLUGIN_EXEC_PROTOCOL_ERROR', severity: 'error' } };
        } catch (error) {
          const failure = classifyJsonRpcSubmissionFailure(error, { method: 'turn/interrupt', effectObserved: false });
          return { status: 'unavailable', diagnostic: {
            code: failure.kind === 'rejected_before_effect' ? 'provider_request_rejected' : 'PLUGIN_EXEC_FAILED',
            severity: 'error', ...(failure.kind === 'rejected_before_effect' ? { details: { ...failure.details } } : {}),
          } };
        }
      },
      async compact(request, options): Promise<AgentSessionCompactResult> {
        if (request.trigger !== 'manual' || request.instructions) return { status: 'unsupported', retryable: false,
          diagnostic: { code: 'unsupported', severity: 'error' } };
        const expected = projection.expectCompaction(request);
        if (!expected) return { status: 'unavailable', retryable: true,
          diagnostic: { code: 'PLUGIN_EXEC_FAILED', severity: 'error', message: 'Native Muse compaction is already pending.' } };
        try {
          const result = readMuseRecord(await msp.command('session/compact', { sessionId: nativeSessionId }, { signal: options?.signal }));
          if (result.status === 'accepted') return { status: 'admitted' };
          const effectObserved = expected.retire();
          if (effectObserved) return { status: 'admitted' };
          return { status: result.status === 'noop' ? 'rejected' : 'unavailable', retryable: false,
            diagnostic: { code: result.status === 'noop' ? 'provider_request_rejected' : 'PLUGIN_EXEC_PROTOCOL_ERROR',
              severity: 'error', details: { method: 'session/compact', nativeStatus: result.status ?? null } } };
        } catch (error) {
          const effectObserved = expected.retire();
          if (effectObserved) return { status: 'admitted' };
          const failure = classifyJsonRpcSubmissionFailure(error, { method: 'session/compact', effectObserved });
          return failure.kind === 'rejected_before_effect'
            ? { status: 'rejected', retryable: false, diagnostic: { code: 'provider_request_rejected', severity: 'error', details: { ...failure.details } } }
            : { status: 'unavailable', retryable: true, diagnostic: { code: 'PLUGIN_EXEC_FAILED', severity: 'error' } };
        }
      },
      async dispose() {
        if (closing) return;
        closing = true;
        retireReadiness();
        interactions.dispose();
        try { await msp.dispose(); }
        finally { await inputBinding?.dispose(); await modelsBinding?.dispose(); projection.dispose(); }
      },
    } satisfies Omit<AgentSessionRuntime, 'watch'> & { watch: typeof projection.watch };
  } catch (error) {
    closing = true;
    retireReadiness();
    interactions.dispose();
    try { await msp.dispose(); }
    finally { await inputBinding?.dispose(); await modelsBinding?.dispose(); projection.dispose(); }
    throw error;
  }
}

export function createMuseAgentRuntime(): AgentRuntime & { sessions: NonNullable<AgentRuntime['sessions']> } {
  const catalog: AgentSessionCatalogControl = {
    async list(request, context, options) {
      if (request.kind !== 'models' && request.kind !== 'skills') return { status: 'unsupported', diagnostic: { code: 'unsupported', severity: 'error' } };
      if (request.kind === 'skills' && !context.session.providerSessionId) return { status: 'unavailable', retryable: false,
        diagnostic: { code: 'provider_session_unavailable', severity: 'error' } };
      const msp = await openMuseMsp({ exec: context.services.exec,
        launch: { executable: { kind: 'systemTool', id: 'muse-cli' }, cwd: context.session.cwd,
          env: context.session.launchEnvironment?.values }, signal: options?.signal ?? context.signal,
        nativeLaunch: context.session.nativeLaunch });
      try {
        if (request.kind === 'skills') {
          const skills = readMuseNativeSkills(await msp.client.request('skill/list',
            { sessionId: context.session.providerSessionId! }, { signal: options?.signal ?? context.signal }));
          return { status: 'ok', kind: 'skills', items: skills.map(museNativeSkillCatalogItem) };
        }
        const source = createMuseCatalog(msp.client);
        const snapshot = await source.refresh({ signal: options?.signal ?? context.signal,
          sessionId: context.session.providerSessionId });
        const selected = source.resolveModelSelection('default');
        return { status: 'ok', kind: 'models', items: snapshot.models ?? [],
          currentModelId: snapshot.currentModelId,
          ...(selected.status === 'selected' ? { defaultModelId: selected.id } : {}) };
      } finally { await msp.dispose(); }
    },
  };
  return { sessions: {
    open: (request, context) => openMuseConversation(request, context, request.sessionId),
    catalog,
    executionRunContextV1: {
      async open(request, context) {
        if (request.kind === 'fork') throw new PluginError({ code: 'unsupported', message: 'Native Muse Run fork is unavailable.' });
        return await createExecutionRunHostBackendFromConversationRuntime({ request,
          openConversation: () => openMuseConversation(request, context, undefined) });
      },
      openConversation: (request, context) => openMuseConversation(request, context, undefined),
    },
  } };
}
export { museExternalSessionsContribution } from './externalSessions.js';
