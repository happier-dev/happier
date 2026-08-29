import {
  AgentRuntimeJsonValueSchema,
  type AgentSessionOpenRequest,
  type AgentSessionRuntime,
  type AgentSessionRuntimeContext,
  type AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  AgentSessionRealtimeConversation,
  AgentSessionRealtimeRuntime as ExperimentalAgentSessionRealtimeRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { JsonValue, PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import {
  createAgentSessionPreAdmissionBuffer,
  type AgentSessionPreAdmissionBuffer,
  type AgentSessionPreAdmissionBufferResult,
} from '@happier-dev/plugin-sdk/agents/runtime';

import type {
  CodexAppServerEvent,
  CodexAppServerSendResult,
  CodexAppServerSession,
} from './core.js';
import { forkCodexNativeAppServerConversation } from '../../surfaces/sessions/fork/native.js';
import { OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDITS_URL } from '../../auth/services/quota/rateLimitResetCreditsClient.js';
import { resolveCodexTerminalPermissionPolicy } from '../terminal/permissionPolicy.js';
import { createCodexNativeAppServerClient } from './client.js';
import {
  createCodexAppServerRuntime,
  startCodexAppServerRuntime,
  type CodexAppServerRuntimeHost,
} from './runtime.js';
import { sanitizeCodexAppServerRuntimeAuthClassification } from './turns/failure.js';
import { parseCodexProviderBindingEngineConfigV1 } from '../../providerBinding/runtimeConfig.js';

type NativeSessionEventInput = AgentSessionRuntimeEvent extends infer Event
  ? Event extends AgentSessionRuntimeEvent
    ? Omit<Event, 'sequence' | 'sessionId' | 'emittedAtMs'>
    : never
  : never;

type NativeCurrentSession = NonNullable<AgentSessionRuntimeContext['services']['sessions']['current']>;
type NativeMediaSourceRoot = Awaited<ReturnType<
  NativeCurrentSession['media']['registerSourceRoot']
>>;

type CodexAccountUsageService =
  AgentSessionRuntimeContext['session']['services']['accountUsage'];
type CodexAccountUsageSourceContext = Awaited<
  ReturnType<CodexAccountUsageService['resolveSourceContext']>
>;

function readLaunchEnvironment(request: AgentSessionOpenRequest): Record<string, string> {
  const values = { ...(request.launchEnvironment?.values ?? {}) };
  const unsetNames = new Set((request.launchEnvironment?.unset ?? []).map((name) => name.toUpperCase()));
  for (const key of Object.keys(values)) {
    if (unsetNames.has(key.toUpperCase())) delete values[key];
  }
  return values;
}

function readPermissionMode(request: AgentSessionOpenRequest): string {
  return request.configuration?.permissionIntent.value ?? 'default';
}

function readInitialModelId(request: AgentSessionOpenRequest): string | null {
  const providerModelId = request.providerBinding?.model.id.trim();
  if (providerModelId) return providerModelId;
  const modelId = request.configuration?.model.value?.trim();
  return modelId && modelId !== 'default' ? modelId : null;
}

export function createCodexNativeAppServerRuntimeHost(params: Readonly<{
  request: AgentSessionOpenRequest;
  context: AgentSessionRuntimeContext;
  processEnv: Readonly<Record<string, string>>;
}>): CodexAppServerRuntimeHost {
  const accountUsage: CodexAccountUsageService = {
    resolveSourceContext: async (input, options) =>
      await params.context.session.services.accountUsage.resolveSourceContext(input, options),
    recordSnapshot: async (input, options) =>
      await params.context.session.services.accountUsage.recordSnapshot(input, options),
    adoptProvisionalRecord: async (input, options) =>
      await params.context.session.services.accountUsage.adoptProvisionalRecord(input, options),
  };
  const currentSession = params.context.services.sessions.current;
  const mediaSourceRoots = new Map<string, Promise<NativeMediaSourceRoot>>();
  let mediaDisposed = false;
  const acquireMediaSourceRoot = (
    session: NativeCurrentSession,
    rootPath: string,
  ): Promise<NativeMediaSourceRoot> => {
    const existing = mediaSourceRoots.get(rootPath);
    if (existing) return existing;
    const created = session.media.registerSourceRoot({ rootPath });
    mediaSourceRoots.set(rootPath, created);
    void created.catch(() => {
      if (mediaSourceRoots.get(rootPath) === created) mediaSourceRoots.delete(rootPath);
    });
    return created;
  };
  return {
    baseProcessEnv: params.processEnv,
    ...(params.context.session.services.nativeHome
      ? { nativeHome: params.context.session.services.nativeHome }
      : {}),
    logger: params.context.services.logger,
    ui: params.context.services.interactions,
    ...(params.context.services.sessions.current?.mcp
      ? { mcp: params.context.services.sessions.current.mcp }
      : {}),
    createClient: async (request) => await createCodexNativeAppServerClient({
      exec: params.context.services.exec,
      cwd: request.cwd,
      processEnv: request.processEnv,
      configOverrides: request.configOverrides,
      disableUserMcpServers: request.disableUserMcpServers,
      signal: params.context.signal,
    }),
    fetchRateLimitResetCredits: async ({ accessToken, accountId }) => {
      const response = await params.context.services.http.request({
        url: OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDITS_URL,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
          Accept: 'application/json',
        },
        redirect: 'error',
      }, { signal: params.context.signal });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`OpenAI reset-credit fetch failed (${response.status})`);
      }
      return JSON.parse(new TextDecoder().decode(response.body)) as unknown;
    },
    accountUsage,
    ...(currentSession ? {
      setTitle: async (title) => {
        await currentSession.setDisplayTitle(title, { signal: params.context.signal });
      },
    } : {}),
    refreshRuntimeAuth: async (request) => {
      const refreshRuntimeAuth = params.context.services.sessions.current?.auth.services.refreshRuntimeAuth;
      if (!refreshRuntimeAuth) throw new Error('Codex Session-handle runtime authentication is unavailable.');
      return await refreshRuntimeAuth(
        request,
        { signal: params.context.signal },
      );
    },
    reportCapacityFailure: async (classification: Readonly<Record<string, JsonValue>>) => {
      const refreshRuntimeAuth = params.context.services.sessions.current?.auth.services.refreshRuntimeAuth;
      if (!refreshRuntimeAuth) throw new Error('Codex Session-handle runtime authentication is unavailable.');
      await refreshRuntimeAuth({
        serviceId: 'openai-codex',
        targetId: params.request.sessionId,
        classification,
        reason: 'provider_session_capacity_failure',
      }, { signal: params.context.signal });
    },
    ...(currentSession ? { publishGeneratedMedia: async (candidate) => {
      if (mediaDisposed) throw new Error('Codex generated-media publication is disposed.');
      const source = await acquireMediaSourceRoot(currentSession, candidate.source.restrictedRoot);
      if (mediaDisposed) throw new Error('Codex generated-media publication is disposed.');
      await source.publishGenerated({
        localId: candidate.itemId,
        path: candidate.source.path,
        description: 'Generated by Codex',
        toolCallId: candidate.itemId,
      });
    } } : {}),
    dispose: async () => {
      if (mediaDisposed) return;
      mediaDisposed = true;
      const sources = await Promise.allSettled(mediaSourceRoots.values());
      mediaSourceRoots.clear();
      for (const source of sources) {
        if (source.status === 'fulfilled') source.value.dispose();
      }
    },
  };
}

function diagnostic(
  code: string,
  message: string,
  details?: PluginDiagnosticData['details'],
): PluginDiagnosticData {
  return {
    code,
    severity: 'error',
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function toJsonValue(value: unknown) {
  const parsed = AgentRuntimeJsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : { unavailable: true };
}

function readBoundedRuntimeAuthDiagnosticDetails(
  error: unknown,
): PluginDiagnosticData['details'] | undefined {
  if (!(error instanceof Error)) return undefined;
  const classification = sanitizeCodexAppServerRuntimeAuthClassification(
    (error as { runtimeAuthClassification?: unknown }).runtimeAuthClassification,
  );
  if (!classification) return undefined;
  const boundedClassification = {
    kind: classification.kind,
    source: classification.source,
    ...(classification.limitCategory ? { limitCategory: classification.limitCategory } : {}),
    ...(classification.planType ? { planType: classification.planType } : {}),
    ...(typeof classification.retryAfterMs === 'number'
      ? { retryAfterMs: classification.retryAfterMs }
      : {}),
    ...(typeof classification.resetsAtMs === 'number'
      ? { resetsAtMs: classification.resetsAtMs }
      : {}),
  };
  return toJsonValue({ runtimeAuthClassification: boundedClassification });
}

function createSanitizedNativeRuntimeError(message: string, error: unknown): Error {
  const sanitized = new Error(message);
  const classification = error instanceof Error
    ? sanitizeCodexAppServerRuntimeAuthClassification(
        (error as { runtimeAuthClassification?: unknown }).runtimeAuthClassification,
      )
    : null;
  if (classification) {
    Object.assign(sanitized, { runtimeAuthClassification: classification });
  }
  if (
    typeof error === 'object'
    && error !== null
    && (error as Readonly<{ happierNativeResumeIdentityMismatch?: unknown }>)
      .happierNativeResumeIdentityMismatch === true
  ) {
    Object.assign(sanitized, { happierNativeResumeIdentityMismatch: true });
  }
  return sanitized;
}

function readTextDelta(delta: unknown): Readonly<{
  text: string;
  channel: 'assistant' | 'reasoning';
}> | null {
  if (typeof delta === 'string') return { text: delta, channel: 'assistant' };
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return null;
  const record = delta as Readonly<Record<string, unknown>>;
  if (typeof record.text !== 'string') return null;
  return {
    text: record.text,
    channel: record.thinking === true ? 'reasoning' : 'assistant',
  };
}

function readCommittedMessage(
  event: Extract<CodexAppServerEvent, { kind: 'transcript-agent-message-committed' }>,
): Readonly<{ text: string; role: 'assistant' | 'reasoning' }> | null {
  if (!event.body || typeof event.body !== 'object' || Array.isArray(event.body)) return null;
  const body = event.body as Readonly<Record<string, unknown>>;
  const text = typeof body.message === 'string'
    ? body.message
    : typeof body.text === 'string'
      ? body.text
      : null;
  if (text === null) return null;
  return { text, role: body.thinking === true ? 'reasoning' : 'assistant' };
}

function mapCodexAppServerEvent(event: CodexAppServerEvent): NativeSessionEventInput | null {
  switch (event.kind) {
    case 'turn-start':
      return {
        kind: 'turn-start',
        turnId: event.turnId,
        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
        startedBy: event.startedBy === 'provider' ? 'provider' : 'host',
      };
    case 'turn-progress':
      return {
        kind: 'turn-progress',
        turnId: event.turnId,
        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
      };
    case 'turn-agent-id-observed':
      return { kind: 'turn-agent-id-observed', turnId: event.turnId, agentTurnId: event.agentTurnId };
    case 'turn-complete':
      return {
        kind: 'turn-complete',
        turnId: event.turnId,
        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
      };
    case 'turn-failed':
      return {
        kind: 'turn-failed',
        turnId: event.turnId,
        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
        diagnostic: diagnostic(event.issue.code, event.issue.sanitizedPreview ?? event.issue.code),
      };
    case 'turn-cancelled':
      return {
        kind: 'turn-cancelled',
        turnId: event.turnId,
        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
        cause: 'providerCancelled',
        ...(event.reason ? { diagnostic: diagnostic('codex_turn_cancelled', event.reason) } : {}),
      };
    case 'message-delta': {
      const delta = readTextDelta(event.delta);
      return delta
        ? { kind: 'message-delta', turnId: event.turnId, channel: delta.channel, text: delta.text }
        : null;
    }
    case 'tool-call':
      return {
        kind: 'tool-call',
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: toJsonValue(event.toolInput),
      };
    case 'tool-progress':
      return {
        kind: 'tool-progress',
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        progress: toJsonValue(event.progress),
      };
    case 'tool-result':
      return {
        kind: 'tool-result',
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        output: toJsonValue(event.output),
        ...(event.isError === true ? { isError: true } : {}),
      };
    case 'session-id-publish': {
      const providerSessionId = event.publishedSessionId.trim();
      return providerSessionId ? { kind: 'provider-session-id', providerSessionId } : null;
    }
    case 'transcript-agent-message-committed': {
      const message = readCommittedMessage(event);
      return message
        ? {
            kind: 'transcript-message-committed',
            messageId: event.localId,
            role: message.role,
            text: message.text,
          }
        : null;
    }
    case 'usage-observed':
      return {
        kind: event.kind,
        observationId: event.observationId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        source: event.source,
        scope: event.scope,
        ...(event.modelId ? { modelId: event.modelId } : {}),
        ...(event.tokens ? { tokens: event.tokens } : {}),
        ...(event.cost ? { cost: event.cost } : {}),
        ...(event.context ? { context: event.context } : {}),
      };
    case 'turn-rollback-boundary-observed':
      return {
        kind: 'turn-rollback-boundary',
        turnId: event.turnId,
        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
        ...(typeof event.agentRollbackOrdinal === 'number'
          ? { agentRollbackOrdinal: event.agentRollbackOrdinal }
          : {}),
        ...(event.providerCheckpoint !== undefined
          ? { providerCheckpoint: event.providerCheckpoint }
          : {}),
      };
    case 'session-ended':
      return {
        kind: 'runtime-ended',
        cause: 'providerEnded',
        retryable: false,
        ...(event.reason ? { diagnostic: diagnostic('codex_runtime_ended', event.reason) } : {}),
      };
    case 'backend-error':
      return {
        kind: 'runtime-ended',
        cause: 'protocolError',
        retryable: false,
        diagnostic: diagnostic(event.error.code ?? 'codex_backend_error', event.error.message),
      };
    default:
      return null;
  }
}

function toNativeSendFailure(
  status: 'rejected' | 'unavailable' | 'unsupported',
  message?: string,
): Exclude<Awaited<ReturnType<AgentSessionRuntime['send']>>, { status: 'admitted' }> {
  return {
    status,
    retryable: status === 'unavailable',
    diagnostic: diagnostic(`codex_send_${status}`, message ?? `Codex input was ${status}.`),
  };
}

export function createCodexNativeAppServerSessionRuntime(
  appServer: CodexAppServerSession,
  sessionId: string,
  realtimeConversation?: AgentSessionRealtimeConversation,
  onDispose?: () => void | Promise<void>,
): AgentSessionRuntime {
  const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
  let sequence = 0;
  let disposed = false;
  let activeTurnId: string | null = null;
  let bufferedEvents: AgentSessionPreAdmissionBuffer<Readonly<{
    event: NativeSessionEventInput;
    emittedAtMs: number;
  }>> | null = null;
  let bufferedEventFailure: Exclude<AgentSessionPreAdmissionBufferResult, { status: 'accepted' }> | null = null;
  const readBufferedEventFailure = () => bufferedEventFailure;
  let pendingProviderIdentity: Readonly<{
    event: Extract<NativeSessionEventInput, { kind: 'provider-session-id' }>;
    emittedAtMs: number;
  }> | null = null;

  const emit = (event: NativeSessionEventInput, emittedAtMs = Date.now()): void => {
    const published = Object.freeze({
      ...event,
      sequence: ++sequence,
      sessionId,
      emittedAtMs,
    }) as AgentSessionRuntimeEvent;
    for (const listener of listeners) listener(published);
    if ((event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled')
      && activeTurnId === event.turnId) activeTurnId = null;
  };

  const subscription = appServer.events.subscribe((event) => {
    const mapped = mapCodexAppServerEvent(event);
    if (!mapped) return;
    if (mapped.kind === 'provider-session-id' && listeners.size === 0) {
      pendingProviderIdentity = { event: mapped, emittedAtMs: event.emittedAtMs };
      return;
    }
    if (bufferedEvents) {
      const admission = bufferedEvents.admit({ event: mapped, emittedAtMs: event.emittedAtMs });
      if (admission.status !== 'accepted' && bufferedEventFailure === null) {
        bufferedEventFailure = admission;
        bufferedEvents.dispose();
      }
      return;
    }
    emit(mapped, event.emittedAtMs);
  });

  const initialProviderSessionId = appServer.identity.read().providerSessionId?.trim();
  if (initialProviderSessionId) {
    pendingProviderIdentity = {
      event: { kind: 'provider-session-id', providerSessionId: initialProviderSessionId },
      emittedAtMs: Date.now(),
    };
  }

  const nativeRuntime: AgentSessionRuntime & Partial<ExperimentalAgentSessionRealtimeRuntime> = {
    ...(realtimeConversation ? { realtimeConversation } : {}),
    ...(appServer.runtimeAuth ? { runtimeAuth: appServer.runtimeAuth } : {}),
    conversationRollback: {
      async rollback(request) {
        return await appServer.rollbackNativeConversation(request);
      },
      async reconcile(request) {
        return await appServer.reconcileNativeConversationRollback(request);
      },
    },
    async send(request, options) {
      if (disposed) {
        return {
          status: 'unavailable',
          retryable: false,
          diagnostic: diagnostic('codex_runtime_disposed', 'Codex runtime is disposed.'),
        };
      }
      const structuredInput = request.input.structuredInput === undefined
        ? null
        : AgentRuntimeJsonValueSchema.safeParse(request.input.structuredInput);
      if (structuredInput && !structuredInput.success) {
        const failure = toNativeSendFailure(
          'rejected',
          'Codex structured input did not match the supported input contract.',
        );
        emit({
          kind: 'input-rejected',
          inputIds: request.inputIds,
          diagnostic: failure.diagnostic,
          retryable: failure.retryable,
        });
        return failure;
      }
      const appServerInput = {
        text: request.input.text,
        ...(structuredInput?.success ? { structuredInput: structuredInput.data } : {}),
      };
      bufferedEvents = createAgentSessionPreAdmissionBuffer();
      bufferedEventFailure = null;
      let result: CodexAppServerSendResult;
      try {
        result = await appServer.send(appServerInput, {
          signal: options?.signal,
          turnId: request.delivery.turnId,
          localInputIds: request.inputIds,
          ...(request.delivery.kind === 'newTurn' ? {} : { deliverAs: request.delivery.kind }),
        });
      } catch (error) {
        const queued = bufferedEvents?.drain() ?? [];
        bufferedEvents?.dispose();
        bufferedEvents = null;
        bufferedEventFailure = null;
        const failure = diagnostic(
          'codex_send_outcome_unknown',
          'Codex send outcome is unknown.',
          readBoundedRuntimeAuthDiagnosticDetails(error),
        );
        emit({
          kind: 'input-custody-unknown',
          inputIds: request.inputIds,
          issue: failure,
        });
        for (const queuedEvent of queued) emit(queuedEvent.event, queuedEvent.emittedAtMs);
        return {
          status: 'unavailable',
          retryable: true,
          diagnostic: failure,
        };
      }
      const admissionFailure = readBufferedEventFailure();
      if (admissionFailure !== null) {
        bufferedEvents?.dispose();
        bufferedEvents = null;
        bufferedEventFailure = null;
        const failure = diagnostic(
          'codex_send_outcome_unknown',
          `Codex pre-admission event buffer rejected an event (${admissionFailure.status}${admissionFailure.status === 'overflow' ? `:${admissionFailure.reason}` : ''}).`,
        );
        emit({ kind: 'input-custody-unknown', inputIds: request.inputIds, issue: failure });
        return { status: 'unavailable', retryable: true, diagnostic: failure };
      }
      const queued = bufferedEvents?.drain() ?? [];
      bufferedEvents?.dispose();
      bufferedEvents = null;
      if (result.status === 'accepted') {
        activeTurnId = request.delivery.turnId;
        emit({
          kind: 'input-accepted',
          inputIds: request.inputIds,
          delivery: request.delivery.kind === 'followUp'
            ? { kind: 'followUp', turnId: request.delivery.turnId }
            : request.delivery,
        });
        for (const queuedEvent of queued) emit(queuedEvent.event, queuedEvent.emittedAtMs);
        return { status: 'admitted' };
      }
      const failure = toNativeSendFailure(result.status, result.diagnostic);
      emit({
        kind: 'input-rejected',
        inputIds: request.inputIds,
        diagnostic: failure.diagnostic,
        retryable: failure.retryable,
      });
      for (const queuedEvent of queued) emit(queuedEvent.event, queuedEvent.emittedAtMs);
      return failure;
    },
    async cancel(request) {
      if (!appServer.cancel) return { status: 'unsupported' };
      if (activeTurnId !== request.turnId) return { status: 'notRunning' };
      const result = await appServer.cancel(request.turnId);
      if (result.status === 'cancelled') return { status: 'requested', turnId: request.turnId };
      if (result.status === 'not_running') return { status: 'notRunning' };
      return {
        status: result.status,
        ...(result.diagnostic
          ? { diagnostic: diagnostic(`codex_cancel_${result.status}`, result.diagnostic) }
          : {}),
      };
    },
    async updateConfiguration(request) {
      if (!appServer.updateConfig) {
        return {
          status: 'unsupported',
          diagnostic: diagnostic('codex_configuration_unsupported', 'Codex configuration updates are unavailable.'),
        };
      }
      const changed: string[] = [];
      try {
        const permissionMode = request.permissionIntent.value;
        const modelId = request.model.value?.trim();
        if (permissionMode !== null || modelId) {
          await appServer.updateConfig({
            ...(permissionMode !== null ? { permissionMode } : {}),
            ...(modelId ? { modelId } : {}),
          });
          if (permissionMode !== null) changed.push('permissionIntent');
          if (modelId) changed.push('model');
        }
        for (const [id, option] of Object.entries(request.options)) {
          const value = typeof option.value === 'string' ? option.value.trim() : '';
          if (!value) continue;
          await appServer.updateConfig({ configOption: { id, value } });
          changed.push(`options.${id}`);
        }
      } catch {
        return {
          status: 'unavailable',
          diagnostic: diagnostic(
            'codex_configuration_update_failed',
            'Codex did not apply the requested configuration update.',
          ),
        };
      }
      return { status: 'applied', changed };
    },
    watch(listener) {
      listeners.add(listener);
      if (pendingProviderIdentity) {
        const pending = pendingProviderIdentity;
        pendingProviderIdentity = null;
        emit(pending.event, pending.emittedAtMs);
      }
      return { dispose: () => { listeners.delete(listener); } };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      bufferedEvents?.dispose();
      bufferedEvents = null;
      bufferedEventFailure = null;
      subscription();
      listeners.clear();
      await onDispose?.();
      await appServer.dispose('session_closed');
    },
  };
  return nativeRuntime;
}

export async function openCodexNativeAppServerSession(
  request: AgentSessionOpenRequest,
  context: AgentSessionRuntimeContext,
): Promise<AgentSessionRuntime> {
  const initialProviderBinding = parseCodexProviderBindingEngineConfigV1(
    Object.prototype.hasOwnProperty.call(request, 'providerBinding')
      ? (request as unknown as Readonly<Record<string, unknown>>).providerBinding
      : null,
  );
  const processEnv = readLaunchEnvironment(request);
  let providerSessionId = request.kind === 'resume' ? request.providerSessionId : null;
  if (request.kind === 'fork') {
    const forkClient = await createCodexNativeAppServerClient({
      exec: context.services.exec,
      cwd: request.cwd,
      processEnv,
      signal: context.signal,
      // This Session action owns cancellation. Let a slow-but-live Codex initialize instead of
      // converting the generic startup budget into a false native-fork failure.
      initializeRequestOptions: { signal: context.signal, timeoutMs: null },
    });
    try {
      const forked = await forkCodexNativeAppServerConversation({
        client: forkClient,
        parentCodexSessionId: request.source.providerSessionId,
        signal: context.signal,
      });
      if (!forked) throw new Error('Codex app-server could not fork the requested provider session.');
      providerSessionId = forked.providerSessionId;
    } finally {
      await forkClient.dispose().catch(() => undefined);
    }
  }

  const runtime = createCodexAppServerRuntime({
    host: createCodexNativeAppServerRuntimeHost({ request, context, processEnv }),
    directory: request.cwd,
    happierSessionId: request.sessionId,
    initialProviderSessionId: providerSessionId,
    initialModelId: readInitialModelId(request),
    ...(initialProviderBinding ? { initialProviderBinding } : {}),
    processEnv,
    ...(request.mcpServers ? { mcpServers: request.mcpServers } : {}),
    resolveCurrentPolicy: () => resolveCodexTerminalPermissionPolicy(readPermissionMode(request)),
  });
  if (providerSessionId || (request.kind !== 'fork' && request.startupInstructions)) {
    try {
      await startCodexAppServerRuntime(runtime, {
        ...(providerSessionId ? { resumeId: providerSessionId } : {}),
        preserveRequestedThreadId: Boolean(providerSessionId),
        ...(request.kind === 'resume' && request.strictNativeResumeIdentity === true
          ? { strictNativeResumeIdentity: true }
          : {}),
        ...(request.kind !== 'fork' && request.startupInstructions
          ? { developerInstructions: request.startupInstructions.instructions }
          : {}),
      });
    } catch (error) {
      throw createSanitizedNativeRuntimeError('Codex app-server startup failed.', error);
    }
  }
  return createCodexNativeAppServerSessionRuntime(
    runtime,
    request.sessionId,
    runtime.realtimeConversation,
  );
}
