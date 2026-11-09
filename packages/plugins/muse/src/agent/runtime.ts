import { PluginError } from '@happier-dev/plugin-sdk';
import type { AgentRuntime, AgentSessionCatalogControl, AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentRuntimeJsonValueSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import { ACTIVITY_SESSION_SYSTEM_RECORD_KINDS, SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
  buildWorkflowRunSystemRecordLocalId, createWorkflowActivityPublisher, SessionWorkflowRunSnapshotV1Schema,
  type SessionWorkflowRunSnapshotV1 } from '@happier-dev/plugin-sdk/sessions/work-state';
import { createMuseCatalog } from './catalog.js';
import { MUSE_AGENT } from './definition.js';
import { createMuseEventProjection, readMuseRecord } from './events.js';
import { openMuseMsp, type MuseMsp } from './msp.js';
import { createMuseInteractions } from './interactions.js';

async function openMuseConversation(request: AgentSessionOpenRequest, context: AgentSessionRuntimeContext): Promise<AgentSessionRuntime> {
  if (request.kind !== 'create') throw new PluginError({ code: 'unsupported', message: 'Native Muse continuation is unavailable on this launch path.' });
  if (request.startupInstructions) throw new PluginError({ code: 'agent_session_startup_instructions_unsupported', retryable: false });
  if (request.skills?.items.length || Object.keys(request.mcpServers ?? {}).length) {
    throw new PluginError({ code: 'unsupported', message: 'The selected native Muse skills or MCP input shape is unavailable on this launch path.' });
  }
  const intent = request.configuration?.permissionIntent.value;
  if ((intent && intent !== 'default') || request.configuration?.workspaceWrites === 'deny') {
    throw new PluginError({ code: 'unsupported', message: 'The requested permission intent has no characterized native Muse mapping.' });
  }
  if (request.configuration?.mode.value) throw new PluginError({ code: 'unsupported', message: 'Native Muse behavior modes are unavailable.' });
  const workflowSnapshots = new Map<string, SessionWorkflowRunSnapshotV1>();
  const workflowAddress = (runId: string) => ({ owner: 'host' as const,
    namespace: SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE, kind: ACTIVITY_SESSION_SYSTEM_RECORD_KINDS[0],
    localId: buildWorkflowRunSystemRecordLocalId(runId) });
  const workflowPublisher = createWorkflowActivityPublisher({ backendId: MUSE_AGENT.id, agentId: MUSE_AGENT.id,
    async readCommittedRunSnapshot(runId) {
      const record = await context.services.sessions.current?.readSystemRecord({ address: workflowAddress(runId) });
      return record ? SessionWorkflowRunSnapshotV1Schema.parse(record.content) : null;
    },
    async commitRecord(snapshot) {
      const current = context.services.sessions.current;
      if (!current) throw new PluginError({ code: 'unsupported', message: 'Session workflow records are unavailable.' });
      await current.upsertSystemRecord({ address: workflowAddress(snapshot.runId), content: AgentRuntimeJsonValueSchema.parse(snapshot) });
    },
    async writeHeadlines(bundle) { await context.session.services.workflowActivity.publishHeadlines(AgentRuntimeJsonValueSchema.parse(bundle)); },
  });
  const projection = createMuseEventProjection({ sessionId: request.sessionId,
    async onChild(observation) { await context.session.services.subagents.observe(observation); },
    async onWorkflow(snapshot) {
      workflowSnapshots.set(snapshot.runId, snapshot);
      await workflowPublisher.publish({ snapshots: workflowSnapshots, changedRunIds: [snapshot.runId] });
    },
  });
  let closing = false;
  let ended = false;
  const end = (cause: 'processExited' | 'connectionLost' | 'protocolError') => {
    if (closing || ended) return;
    ended = true;
    projection.publish({ kind: 'runtime-ended', cause, retryable: true });
  };
  const interactions = createMuseInteractions({ context,
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
  const msp: MuseMsp = await openMuseMsp({ exec: context.services.exec,
    launch: { executable: { kind: 'systemTool', id: 'muse-cli' }, cwd: request.cwd, env: request.launchEnvironment?.values },
    signal: context.signal, nativeLaunch: context.session.services.nativeLaunch,
    initialize: { capabilities: { experimentalApi: true } },
    onRequest: interactions.onRequest,
    async onNotification(message) {
      if (!interactions.observe(message)) await projection.observe(message);
      if (message.method === 'session/closed') end('connectionLost');
    },
  }).catch(error => { interactions.dispose(); projection.dispose(); throw error; });
  const catalog = createMuseCatalog(msp.client);
  let modelsBinding: ReturnType<typeof context.session.services.models.bind> | undefined;
  void msp.wait().then(() => end('processExited'), () => end('protocolError'));
  try {
    modelsBinding = context.session.services.models.bind(catalog);
    const selectedId = request.configuration?.model.value;
    let selected: ReturnType<typeof catalog.resolveModelSelection> = { status: 'nativeDefault' };
    if (selectedId) {
      await catalog.refresh({ signal: context.signal });
      selected = catalog.resolveModelSelection(selectedId);
      if (selected.status === 'unavailable') throw new PluginError({ code: 'model_selection_required', retryable: false,
        message: 'The selected Muse model is unavailable in the native catalog.' });
    }
    const opened = readMuseRecord(await msp.command('session/start', { workspaceRoot: request.cwd,
      approvalMode: 'promptUnmatched', permissionProfile: ':ask-me',
      ...(selected.status === 'selected' ? { providerId: selected.providerId, modelId: selected.modelId } : {}),
    }, { signal: context.signal }));
    const native = readMuseRecord(opened.session);
    if (typeof native.sessionId !== 'string') throw new PluginError({ code: 'PLUGIN_EXEC_PROTOCOL_ERROR', message: 'Muse did not return a native Session identity.' });
    const nativeSessionId = native.sessionId;
    projection.observeSession(opened.session);
    if (typeof native.providerId === 'string' && typeof native.modelId === 'string') {
      catalog.applyCurrentModel({ providerId: native.providerId, modelId: native.modelId });
    }
    return {
      runtimeDescriptorV1: { v: 1, agentId: MUSE_AGENT.id, agent: { providerSessionId: nativeSessionId,
        ...(typeof native.path === 'string' ? { sessionFile: native.path } : {}) } },
      watch: projection.watch,
      async send(input, options) {
        if (input.input.structuredInput) return { status: 'unsupported', retryable: false,
          diagnostic: { code: 'unsupported', severity: 'error', message: 'This native Muse input shape is unavailable.' } };
        if (input.delivery.kind === 'steer') return { status: 'unsupported', retryable: false,
          diagnostic: { code: 'unsupported', severity: 'error', message: 'Native steering is unavailable on this launch path.' } };
        let commandId: string | undefined;
        try {
          const result = await msp.command('turn/start', { sessionId: nativeSessionId,
            input: [{ type: 'text', text: input.input.text }] }, { signal: options?.signal,
            onCommandId(id) { commandId = id; projection.admit(input, id); },
          });
          if (commandId) projection.accept(commandId, result);
          return { status: 'admitted' };
        } catch (error) {
          projection.publish({ kind: 'input-custody-unknown', inputIds: input.inputIds,
            issue: { code: error instanceof PluginError ? error.code : 'PLUGIN_EXEC_FAILED', severity: 'error' } });
          throw error;
        }
      },
      async dispose() {
        if (closing) return;
        closing = true;
        interactions.dispose();
        try { await msp.dispose(); }
        finally { await modelsBinding?.dispose(); projection.dispose(); }
      },
    };
  } catch (error) {
    closing = true;
    interactions.dispose();
    try { await msp.dispose(); }
    finally { await modelsBinding?.dispose(); projection.dispose(); }
    throw error;
  }
}

export function createMuseAgentRuntime(): AgentRuntime & { sessions: NonNullable<AgentRuntime['sessions']> } {
  const catalog: AgentSessionCatalogControl = {
    async list(request, context, options) {
      if (request.kind !== 'models') return { status: 'unsupported', diagnostic: { code: 'unsupported', severity: 'error' } };
      const msp = await openMuseMsp({ exec: context.services.exec,
        launch: { executable: { kind: 'systemTool', id: 'muse-cli' }, cwd: context.session.cwd,
          env: context.session.launchEnvironment?.values }, signal: options?.signal ?? context.signal,
        nativeLaunch: context.session.nativeLaunch });
      try {
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
  return { sessions: { open: openMuseConversation, catalog } };
}
