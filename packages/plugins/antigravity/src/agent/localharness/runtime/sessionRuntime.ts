import type {
  AgentSessionRuntime,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentRuntimeJsonValueSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginDiagnosticData } from '@happier-dev/plugin-sdk';

import { encodeInputConfigFrame, LOCALHARNESS_PROTOCOL_FINGERPRINT } from '../client/handshake.js';
import type { AntigravityLocalharnessClient } from '../client/nativeClient.js';
import type {
  AntigravityLocalharnessClientMessage,
  AntigravityLocalharnessEvent,
  AntigravityLocalharnessGeminiConfig,
  AntigravityLocalharnessHarnessConfig,
  AntigravityLocalharnessInputConfig,
  AntigravityLocalharnessModelConfig,
} from '../client/protocol.js';
import {
  buildCancelEvent,
  buildInitializeConversationEvent,
  buildQuestionResponseEvent,
  buildStartTurnEvent,
  buildToolConfirmationEvent,
  buildUnsupportedToolResponseEvent,
  isHarnessSideTool,
  parseLocalharnessOutputEvent,
} from '../client/protocol.js';
import {
  formatUnsupportedMcpServersDiagnostic,
  mapMcpServersToLocalharnessConfig,
  type AntigravityLocalharnessMcpServer,
} from './mcp.js';
import {
  buildPermissionDecisionRequest,
  defaultDenyDecisionFor,
  permissionRequestKey,
  questionRequestKey,
  type AntigravityLocalharnessPermissionRequester,
} from './permissions.js';
import {
  ANTIGRAVITY_DEFAULT_MODEL_ID,
  mapAntigravityModelIdToSdkModel,
} from '../../models.js';

type NativeSessionEventInput = AgentSessionRuntimeEvent extends infer Event
  ? Event extends AgentSessionRuntimeEvent
    ? Omit<Event, 'sequence' | 'sessionId' | 'emittedAtMs'>
    : never
  : never;

export type AntigravityLocalharnessCredentialResolver = () => Promise<AntigravityLocalharnessGeminiConfig>;
export type AntigravityLocalharnessElicitation = (
  request: Readonly<{ requestId: string; questions: readonly Readonly<{ id?: string; prompt?: string; label?: string }>[] }>,
) => Promise<Readonly<{ status: string; answers?: unknown }>>;
export type AntigravityLocalharnessInputConfigEncoder = (
  config: AntigravityLocalharnessInputConfig,
) => Uint8Array;

export type AntigravityLocalharnessRuntimeDeps = Readonly<{
  sessionId: string;
  cwd: string;
  modelId?: string | null;
  openClient(input: Readonly<{ cwd: string; requestFrame: Uint8Array }>): Promise<AntigravityLocalharnessClient>;
  encodeInputConfig?: AntigravityLocalharnessInputConfigEncoder;
  requestPermission: AntigravityLocalharnessPermissionRequester;
  elicit: AntigravityLocalharnessElicitation;
  resolveCredentials: AntigravityLocalharnessCredentialResolver;
  resolveMcpServers: () => Promise<readonly AntigravityLocalharnessMcpServer[]>;
  now?: () => number;
}>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readModelId(value: unknown): string | null {
  const modelId = readString(value);
  return modelId && modelId !== 'default' ? modelId : null;
}

function validateCredentials(credentials: AntigravityLocalharnessGeminiConfig): string | null {
  if (credentials.mode === 'api_key') {
    return readString(credentials.apiKey) ? null : 'Antigravity localharness requires a Gemini API key before launch.';
  }
  if (!readString(credentials.project) || !readString(credentials.location)) {
    return 'Antigravity localharness Vertex mode requires project and location before launch.';
  }
  return null;
}

function diagnostic(code: string, message: string): PluginDiagnosticData {
  return {
    code,
    severity: 'error',
    message,
  };
}

function buildHandshakeInputConfig(): AntigravityLocalharnessInputConfig {
  return {
    storageDirectory: '',
    clientInfo: {
      language: 'happier',
      version: '0.0.0',
      languageVersion: 'typescript',
    },
  };
}

function buildHarnessConfig(params: Readonly<{
  credentials: AntigravityLocalharnessGeminiConfig;
  cwd: string;
  modelId?: string | null;
  mcpServers: readonly AntigravityLocalharnessHarnessConfig['mcpServers'][number][];
}>): AntigravityLocalharnessHarnessConfig {
  const model = buildLocalharnessModelConfig({
    credentials: params.credentials,
    modelId: params.modelId,
  });
  return {
    clientInfo: {
      name: 'happier',
      protocolFingerprint: LOCALHARNESS_PROTOCOL_FINGERPRINT,
    },
    models: [model],
    workspaces: [params.cwd],
    permissionPolicy: {
      enforceWorkspaceValidation: true,
      runCommandDefault: 'deny',
    },
    mcpServers: params.mcpServers,
  };
}

function buildLocalharnessModelConfig(params: Readonly<{
  credentials: AntigravityLocalharnessGeminiConfig;
  modelId?: string | null;
}>): AntigravityLocalharnessModelConfig {
  const selectedModel = mapAntigravityModelIdToSdkModel(params.modelId ?? ANTIGRAVITY_DEFAULT_MODEL_ID);
  const options = selectedModel.thinkingLevel
    ? { options: { thinkingLevel: selectedModel.thinkingLevel } }
    : {};
  if (params.credentials.mode === 'api_key') {
    return {
      name: selectedModel.rawModelId,
      types: ['text'],
      geminiApiEndpoint: {
        apiKey: params.credentials.apiKey ?? '',
        ...options,
      },
    };
  }
  return {
    name: selectedModel.rawModelId,
    types: ['text'],
    vertexEndpoint: {
      project: params.credentials.project ?? '',
      location: params.credentials.location ?? '',
      ...options,
    },
  };
}

function toJsonValue(value: unknown) {
  const parsed = AgentRuntimeJsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : { unavailable: true };
}

export function createAntigravityLocalharnessSessionRuntime(
  deps: AntigravityLocalharnessRuntimeDeps,
): AgentSessionRuntime {
  const subscribers = new Set<(event: AgentSessionRuntimeEvent) => void>();
  const permissionOutcomes = new Map<string, Promise<void>>();
  const questionOutcomes = new Map<string, Promise<void>>();
  let sequence = 0;
  let activeTurnId: string | null = null;
  let activeProviderTurnId: string | null = null;
  let activeTurnHasOutputEvidence = false;
  let handle: AntigravityLocalharnessClient | null = null;
  let unsubscribeClient: (() => void) | null = null;
  let unsubscribeExit: (() => void) | null = null;
  let disposed = false;
  let preAdmissionEvents: NativeSessionEventInput[] | null = null;

  const publish = (event: NativeSessionEventInput): void => {
    if (preAdmissionEvents) {
      preAdmissionEvents.push(event);
      return;
    }
    const published = Object.freeze({
      ...event,
      sequence: ++sequence,
      sessionId: deps.sessionId,
      emittedAtMs: deps.now?.() ?? Date.now(),
    }) as AgentSessionRuntimeEvent;
    for (const subscriber of subscribers) subscriber(published);
  };

  const clearActiveTurnState = (): void => {
    activeTurnId = null;
    activeProviderTurnId = null;
    activeTurnHasOutputEvidence = false;
  };

  const markActiveTurnOutputEvidence = (): void => {
    activeTurnHasOutputEvidence = true;
  };

  const sendToHarness = async (message: AntigravityLocalharnessClientMessage): Promise<void> => {
    await handle?.send(message);
  };

  const completeTurn = (event: Extract<AntigravityLocalharnessEvent, { type: 'trajectory_state_update' }>): void => {
    if (event.state !== 'STATE_IDLE' || !activeTurnId) return;
    if (!activeTurnHasOutputEvidence) {
      failTurn(
        'antigravity_localharness_empty_response',
        'Antigravity localharness completed without assistant, tool, or error output.',
      );
      return;
    }
    publish({
      kind: 'turn-complete',
      turnId: activeTurnId,
      ...(activeProviderTurnId ? { agentTurnId: activeProviderTurnId } : {}),
    });
    clearActiveTurnState();
  };

  const failTurn = (code: string, preview: string): void => {
    if (!activeTurnId) return;
    publish({
      kind: 'turn-failed',
      turnId: activeTurnId,
      diagnostic: diagnostic(code, preview),
    });
    clearActiveTurnState();
  };

  const handlePermissionRequest = (event: Extract<AntigravityLocalharnessEvent, { type: 'tool_confirmation_request' }>): void => {
    const key = permissionRequestKey(event);
    if (permissionOutcomes.has(key)) return;
    const promise = (async () => {
      const defaultDecision = defaultDenyDecisionFor(event);
      const decision = defaultDecision ?? await deps.requestPermission(buildPermissionDecisionRequest(event));
      const approved = decision.decision === 'approved';
      await sendToHarness(buildToolConfirmationEvent(event, approved));
    })().catch((error: unknown) => {
      failTurn('permission_blocked', error instanceof Error ? error.message : 'Permission request failed.');
    });
    permissionOutcomes.set(key, promise);
  };

  const handleQuestionRequest = (event: Extract<AntigravityLocalharnessEvent, { type: 'user_questions_request' }>): void => {
    const key = questionRequestKey(event);
    if (questionOutcomes.has(key)) return;
    const requestId = readString(event.requestId) ?? key;
    const promise = deps.elicit({ requestId, questions: event.questions ?? [] })
      .then(async (result) => {
        await sendToHarness(buildQuestionResponseEvent(event, result));
      })
      .catch((error: unknown) => {
        failTurn('provider_error', error instanceof Error ? error.message : 'User question request failed.');
      });
    questionOutcomes.set(key, promise);
  };

  const handleCustomToolCall = (toolCallId: string, toolName: string): boolean => {
    if (isHarnessSideTool(toolName)) return false;
    void sendToHarness(buildUnsupportedToolResponseEvent(toolCallId, toolName));
    if (activeTurnId) {
      markActiveTurnOutputEvidence();
      publish({
        kind: 'tool-result',
        turnId: activeTurnId,
        toolCallId,
        output: toJsonValue({
          error: 'unsupported_client_tool',
          toolName,
        }),
        isError: true,
      });
    }
    return true;
  };

  const handleEvent = (event: AntigravityLocalharnessEvent): void => {
    if (event.type === 'conversation_id') {
      const providerSessionId = readString(event.conversationId);
      if (!providerSessionId) return;
      publish({
        kind: 'provider-session-id',
        providerSessionId,
      });
      return;
    }
    if (event.type === 'step_update' || event.type === 'thinking' || event.type === 'thinking_delta') {
      if (!activeTurnId) return;
      const eventRecord = event as Readonly<Record<string, unknown>>;
      const text = readString(eventRecord.textDelta) ?? readString(eventRecord.text);
      if (!text) return;
      markActiveTurnOutputEvidence();
      publish({
        kind: 'message-delta',
        turnId: activeTurnId,
        channel: event.type === 'thinking' || event.type === 'thinking_delta' ? 'reasoning' : 'assistant',
        text,
      });
      return;
    }
    if (event.type === 'tool_call') {
      if (!activeTurnId) return;
      const toolCallId = readString(event.toolCallId) ?? `tool:${Date.now()}`;
      const toolName = readString(event.toolName) ?? 'unknown';
      if (!readString(event.toolCallId)) {
        failTurn('unsupported_client_tool', 'Antigravity localharness emitted a client tool call without an id.');
        return;
      }
      if (handleCustomToolCall(toolCallId, toolName)) return;
      markActiveTurnOutputEvidence();
      publish({
        kind: 'tool-call',
        turnId: activeTurnId,
        toolCallId,
        toolName,
        input: toJsonValue(event.input ?? {}),
      });
      return;
    }
    if (event.type === 'tool_result') {
      if (!activeTurnId) return;
      const toolCallId = readString(event.toolCallId);
      if (!toolCallId) return;
      markActiveTurnOutputEvidence();
      publish({
        kind: 'tool-result',
        turnId: activeTurnId,
        toolCallId,
        output: toJsonValue(event.output ?? {}),
        ...(event.isError === true ? { isError: true } : {}),
      });
      return;
    }
    if (event.type === 'usage_metadata') {
      const total = readNumber(event.totalTokens);
      if (total === null) return;
      publish({
        kind: 'usage-observed',
        observationId: `antigravity-usage-${sequence + 1}`,
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
        source: 'provider',
        scope: 'turn_delta',
        tokens: {
          total,
          input: readNumber(event.inputTokens) ?? 0,
          output: readNumber(event.outputTokens) ?? 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      });
      return;
    }
    if (event.type === 'trajectory_state_update') {
      completeTurn(event);
      return;
    }
    if (event.type === 'tool_confirmation_request') {
      handlePermissionRequest(event);
      return;
    }
    if (event.type === 'user_questions_request') {
      handleQuestionRequest(event);
    }
  };

  const handleMessage = (message: unknown): void => {
    for (const event of parseLocalharnessOutputEvent(message)) {
      handleEvent(event);
    }
  };

  const releaseClientHandle = (): void => {
    unsubscribeClient?.();
    unsubscribeClient = null;
    unsubscribeExit?.();
    unsubscribeExit = null;
    handle = null;
  };

  const describeExit = (exitCode: number | null, signal: string | null): string => {
    if (exitCode !== null) return `Antigravity localharness sidecar exited with exit code ${exitCode}.`;
    if (signal) return `Antigravity localharness sidecar exited after signal ${signal}.`;
    return 'Antigravity localharness sidecar exited before the active turn completed.';
  };

  const handleSidecarExit = (result: Readonly<{ exitCode: number | null; signal: string | null }>): void => {
    if (disposed) return;
    const preview = describeExit(result.exitCode, result.signal);
    failTurn('sidecar_exited', preview);
    releaseClientHandle();
  };

  const ensureClient = async (): Promise<void> => {
    if (handle) return;
    const credentials = await deps.resolveCredentials();
    const credentialError = validateCredentials(credentials);
    if (credentialError) throw new Error(credentialError);
    const mcpMapping = mapMcpServersToLocalharnessConfig(await deps.resolveMcpServers());
    const unsupportedMcpDiagnostic = formatUnsupportedMcpServersDiagnostic(mcpMapping.unsupported);
    if (unsupportedMcpDiagnostic) throw new Error(unsupportedMcpDiagnostic);
    const handshakeInputConfig = buildHandshakeInputConfig();
    const harnessConfig = buildHarnessConfig({
      credentials,
      cwd: deps.cwd,
      modelId: deps.modelId,
      mcpServers: mcpMapping.configs,
    });
    const requestFrame = (deps.encodeInputConfig ?? encodeInputConfigFrame)(handshakeInputConfig);
    handle = await deps.openClient({
      cwd: deps.cwd,
      requestFrame,
    });
    unsubscribeClient = handle.subscribe(handleMessage);
    unsubscribeExit = handle.onExit(handleSidecarExit);
    await sendToHarness(buildInitializeConversationEvent(harnessConfig));
  };

  return {
    async send(request) {
      if (disposed) {
        return {
          status: 'unavailable',
          retryable: false,
          diagnostic: diagnostic('antigravity_runtime_disposed', 'Antigravity localharness runtime is disposed.'),
        };
      }
      const text = readString(request.input.text);
      if (!text) {
        const issue = diagnostic('antigravity_input_missing_text', 'Antigravity localharness input did not include text.');
        publish({ kind: 'input-rejected', inputIds: request.inputIds, diagnostic: issue, retryable: false });
        return { status: 'rejected', retryable: false, diagnostic: issue };
      }
      try {
        await ensureClient();
      } catch (error) {
        const issue = diagnostic(
          'antigravity_session_start_failed',
          error instanceof Error ? error.message : String(error),
        );
        publish({ kind: 'input-rejected', inputIds: request.inputIds, diagnostic: issue, retryable: false });
        return { status: 'rejected', retryable: false, diagnostic: issue };
      }
      const turnId = request.delivery.turnId;
      activeTurnId = turnId;
      activeProviderTurnId = null;
      activeTurnHasOutputEvidence = false;
      preAdmissionEvents = [];
      try {
        await sendToHarness(buildStartTurnEvent(text));
      } catch (error) {
        preAdmissionEvents = null;
        clearActiveTurnState();
        const issue = diagnostic(
          'antigravity_send_outcome_unknown',
          error instanceof Error ? error.message : 'Antigravity send outcome is unknown.',
        );
        publish({ kind: 'input-custody-unknown', inputIds: request.inputIds, issue });
        return { status: 'unavailable', retryable: true, diagnostic: issue };
      }
      const queued = preAdmissionEvents;
      preAdmissionEvents = null;
      publish({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
      publish({ kind: 'turn-start', turnId, startedBy: 'host' });
      for (const event of queued) publish(event);
      return { status: 'admitted' };
    },
    async cancel(request) {
      if (!activeTurnId) return { status: 'notRunning' };
      if (activeTurnId !== request.turnId) return { status: 'notRunning' };
      const turnId = activeTurnId;
      try {
        await sendToHarness(buildCancelEvent());
      } finally {
        failTurn('cancel_unverified', 'Antigravity localharness cancel acknowledgement is not source-real; sidecar was torn down.');
        await handle?.dispose();
        releaseClientHandle();
        clearActiveTurnState();
      }
      return {
        status: 'unavailable',
        diagnostic: diagnostic(
          'antigravity_cancel_unverified',
          `Antigravity localharness cancel acknowledgement for '${turnId}' is not source-real; sidecar was torn down.`,
        ),
      };
    },
    watch(listener) {
      subscribers.add(listener);
      return { dispose: () => { subscribers.delete(listener); } };
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      preAdmissionEvents = null;
      subscribers.clear();
      await handle?.dispose();
      releaseClientHandle();
    },
  };
}

export function createAntigravityLocalharnessCredentialResolver(params: Readonly<{
  env: Readonly<Record<string, string>>;
  materializeAuthEnv?: () => Promise<Readonly<Record<string, string>> | null>;
}>): AntigravityLocalharnessCredentialResolver {
  return async () => {
    const materializedEnv = await params.materializeAuthEnv?.().catch(() => null) ?? {};
    const env = { ...params.env, ...materializedEnv };
    const explicitMode = readString(env.ANTIGRAVITY_AUTH_MODE);
    const publicVertexMode = readString(env.GOOGLE_GENAI_USE_VERTEXAI)?.toLowerCase();
    if (explicitMode === 'vertex' || publicVertexMode === '1' || publicVertexMode === 'true') {
      return {
        mode: 'vertex',
        project: readString(env.GOOGLE_CLOUD_PROJECT) ?? readString(env.VERTEX_PROJECT),
        location: readString(env.GOOGLE_CLOUD_LOCATION) ?? readString(env.VERTEX_LOCATION),
      };
    }
    return {
      mode: 'api_key',
      apiKey: readString(env.GEMINI_API_KEY) ?? readString(env.GOOGLE_API_KEY),
    };
  };
}
