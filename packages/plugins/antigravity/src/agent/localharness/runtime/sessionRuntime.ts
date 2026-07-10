import type {
  CreateExecutionRunBackendParamsV1,
  CreateSessionRuntimeParamsV1,
  ExecManagedInstallableLaunchInputV1,
  ExecRuntimeServiceV1,
  LoopbackWebSocketJsonClientV1,
  RuntimeCancelResultV1,
  RuntimeDisposeReasonV1,
  RuntimeEventV1,
  RuntimeInputPayloadV1,
  RuntimePromptAcceptedCallbackV1,
  RuntimePromptAcceptedInfoV1,
  RuntimeSendOptionsV1,
  RuntimeSendResultV1,
  SessionRuntimeV1,
} from '@happier-dev/plugin-sdk';
import { composeSessionIsolationEnvironment } from '@happier-dev/plugin-sdk/experimental/runtime/session';
import { createExecutionRunHostBackendFromSessionRuntime } from '@happier-dev/plugin-sdk';
import type { ResolvedMcpServerSpecV1 } from '@happier-dev/plugin-sdk/mcp';
import type {
  ExecutionRunBackendCreateResultV1,
  SessionRuntimeIssueV1,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';

import {
  antigravityLocalharnessEndpointCodec,
  encodeInputConfigFrame,
  LOCALHARNESS_PROTOCOL_FINGERPRINT,
} from '../client/handshake.js';
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
} from './mcp.js';
import {
  buildPermissionDecisionRequest,
  defaultDenyDecisionFor,
  permissionRequestKey,
  questionRequestKey,
  type AntigravityLocalharnessPermissionRequester,
} from './permissions.js';
import {
  ANTIGRAVITY_LOCALHARNESS_COMMAND,
  ANTIGRAVITY_LOCALHARNESS_INSTALLABLE_KEY,
} from '../installable.js';
import {
  ANTIGRAVITY_DEFAULT_MODEL_ID,
  mapAntigravityModelIdToSdkModel,
} from '../../models.js';
import { buildAntigravityPromptAcceptedInfo } from '../../runtime/promptAcceptance.js';

const LOCALHARNESS_EXECUTION_RUN_COMPLETION_POLL_INTERVAL_MS = 10;

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
  spawnClient: ExecRuntimeServiceV1['spawnClient'];
  encodeInputConfig?: AntigravityLocalharnessInputConfigEncoder;
  requestPermission: AntigravityLocalharnessPermissionRequester;
  elicit: AntigravityLocalharnessElicitation;
  resolveCredentials: AntigravityLocalharnessCredentialResolver;
  resolveMcpServers: () => Promise<readonly ResolvedMcpServerSpecV1[]>;
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

function normalizeTurnId(value: string | undefined, fallback: string): string {
  return readString(value) ?? fallback;
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

function runtimeIssue(code: string, preview: string, now: number): SessionRuntimeIssueV1 {
  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code,
    source: code === 'permission_blocked' ? 'permission_blocked' : 'agent_status_error',
    occurredAt: now,
    sanitizedPreview: preview,
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

function createLocalharnessLaunch(cwd: string): ExecManagedInstallableLaunchInputV1 {
  return {
    kind: 'managed-installable',
    installableId: ANTIGRAVITY_LOCALHARNESS_INSTALLABLE_KEY,
    executableName: ANTIGRAVITY_LOCALHARNESS_COMMAND,
    cwd,
    sourcePreference: 'managed-first',
  };
}

function createBaseEvent(
  deps: AntigravityLocalharnessRuntimeDeps,
  kind: RuntimeEventV1['kind'],
): Readonly<{ kind: RuntimeEventV1['kind']; sessionId: string; emittedAtMs: number }> {
  return { kind, sessionId: deps.sessionId, emittedAtMs: deps.now?.() ?? Date.now() };
}

function publishTo(subscribers: Set<(event: RuntimeEventV1) => void>, event: RuntimeEventV1): void {
  for (const subscriber of Array.from(subscribers)) {
    subscriber(event);
  }
}

export function createAntigravityLocalharnessSessionRuntime(
  deps: AntigravityLocalharnessRuntimeDeps,
): SessionRuntimeV1 {
  const subscribers = new Set<(event: RuntimeEventV1) => void>();
  const permissionOutcomes = new Map<string, Promise<void>>();
  const questionOutcomes = new Map<string, Promise<void>>();
  let providerSessionId: string | null = null;
  let activeTurnId: string | null = null;
  let activeProviderTurnId: string | null = null;
  let activePromptAccepted = false;
  let activePromptAcceptedInfo: RuntimePromptAcceptedInfoV1 | null = null;
  let activeTurnHasOutputEvidence = false;
  let promptAcceptedCallback: RuntimePromptAcceptedCallbackV1 | null = null;
  let handle: Awaited<ReturnType<ExecRuntimeServiceV1['spawnClient']>> | null = null;
  let unsubscribeClient: (() => void) | null = null;
  let unsubscribeExit: (() => void) | null = null;
  let disposed = false;
  let turnOrdinal = 0;

  const publish = (event: RuntimeEventV1): void => publishTo(subscribers, event);

  const clearActiveTurnState = (): void => {
    activeTurnId = null;
    activeProviderTurnId = null;
    activePromptAccepted = false;
    activePromptAcceptedInfo = null;
    activeTurnHasOutputEvidence = false;
  };

  const confirmActivePromptAcceptedByProvider = (): void => {
    if (!activeTurnId || activePromptAccepted) return;
    activePromptAccepted = true;
    promptAcceptedCallback?.(activePromptAcceptedInfo ?? { userMessageSeq: null });
  };

  const markActiveTurnOutputEvidence = (): void => {
    activeTurnHasOutputEvidence = true;
    confirmActivePromptAcceptedByProvider();
  };

  const sendToHarness = async (message: AntigravityLocalharnessClientMessage): Promise<void> => {
    const client = handle?.client as LoopbackWebSocketJsonClientV1 | undefined;
    await client?.sendJson(message);
  };

  const completeTurn = (event: Extract<AntigravityLocalharnessEvent, { type: 'trajectory_state_update' }>): void => {
    if (event.state !== 'STATE_IDLE' || !activeTurnId) return;
    confirmActivePromptAcceptedByProvider();
    if (!activeTurnHasOutputEvidence) {
      failTurn(
        'antigravity_localharness_empty_response',
        'Antigravity localharness completed without assistant, tool, or error output.',
      );
      return;
    }
    publish({
      ...createBaseEvent(deps, 'turn-complete'),
      kind: 'turn-complete',
      turnId: activeTurnId,
      ...(activeProviderTurnId ? { agentTurnId: activeProviderTurnId } : {}),
    });
    clearActiveTurnState();
  };

  const failTurn = (code: string, preview: string): void => {
    if (!activeTurnId) return;
    publish({
      ...createBaseEvent(deps, 'turn-failed'),
      kind: 'turn-failed',
      turnId: activeTurnId,
      issue: runtimeIssue(code, preview, deps.now?.() ?? Date.now()),
    });
    clearActiveTurnState();
  };

  const handlePermissionRequest = (event: Extract<AntigravityLocalharnessEvent, { type: 'tool_confirmation_request' }>): void => {
    confirmActivePromptAcceptedByProvider();
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
    confirmActivePromptAcceptedByProvider();
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
        ...createBaseEvent(deps, 'tool-result'),
        kind: 'tool-result',
        turnId: activeTurnId,
        toolCallId,
        output: {
          error: 'unsupported_client_tool',
          toolName,
        },
        isError: true,
      });
    }
    return true;
  };

  const handleEvent = (event: AntigravityLocalharnessEvent): void => {
    if (event.type === 'conversation_id') {
      providerSessionId = readString(event.conversationId);
      if (!providerSessionId) return;
      publish({
        ...createBaseEvent(deps, 'session-id-publish'),
        kind: 'session-id-publish',
        publishedSessionId: deps.sessionId,
        source: 'runtime',
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
        ...createBaseEvent(deps, 'message-delta'),
        kind: 'message-delta',
        turnId: activeTurnId,
        delta: {
          text,
          ...((event.type === 'thinking' || event.type === 'thinking_delta') ? { thinking: true } : {}),
        },
      });
      return;
    }
    if (event.type === 'tool_call') {
      if (!activeTurnId) return;
      const toolCallId = readString(event.toolCallId) ?? `tool:${Date.now()}`;
      const toolName = readString(event.toolName) ?? 'unknown';
      if (!readString(event.toolCallId)) {
        confirmActivePromptAcceptedByProvider();
        failTurn('unsupported_client_tool', 'Antigravity localharness emitted a client tool call without an id.');
        return;
      }
      if (handleCustomToolCall(toolCallId, toolName)) return;
      markActiveTurnOutputEvidence();
      publish({
        ...createBaseEvent(deps, 'tool-call'),
        kind: 'tool-call',
        turnId: activeTurnId,
        toolCallId,
        toolName,
        toolInput: event.input ?? {},
      });
      return;
    }
    if (event.type === 'tool_result') {
      if (!activeTurnId) return;
      const toolCallId = readString(event.toolCallId);
      if (!toolCallId) return;
      markActiveTurnOutputEvidence();
      publish({
        ...createBaseEvent(deps, 'tool-result'),
        kind: 'tool-result',
        turnId: activeTurnId,
        toolCallId,
        output: event.output ?? {},
        ...(event.isError === true ? { isError: true } : {}),
      });
      return;
    }
    if (event.type === 'usage_metadata') {
      confirmActivePromptAcceptedByProvider();
      const total = readNumber(event.totalTokens);
      if (total === null) return;
      publish({
        ...createBaseEvent(deps, 'token-count'),
        kind: 'token-count',
        source: 'provider',
        scope: 'turn',
        totals: {
          total,
          ...(readNumber(event.inputTokens) !== null ? { input: readNumber(event.inputTokens)! } : {}),
          ...(readNumber(event.outputTokens) !== null ? { output: readNumber(event.outputTokens)! } : {}),
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
    handle = await deps.spawnClient({
      launch: createLocalharnessLaunch(deps.cwd),
      transport: {
        kind: 'spawned-loopback-websocket',
        handshake: {
          byteOrder: 'little-endian',
          requestFrames: [requestFrame],
          response: {
            byteOrder: 'little-endian',
            maxFrameBytes: 64 * 1024,
            timeoutMs: 10_000,
          },
        },
        connect: {
          timeoutMs: 10_000,
          retryInitialDelayMs: 20,
          retryMaxDelayMs: 250,
        },
        shutdown: { kind: 'close-stdin', graceMs: 1_000 },
        limits: {
          maxMessageBytes: 1024 * 1024,
          maxPendingMessages: 256,
          maxBufferedBytes: 4 * 1024 * 1024,
        },
      },
      protocol: {
        kind: 'json-websocket',
        endpoint: antigravityLocalharnessEndpointCodec,
      },
      lifecycle: {
        maxStderrBytes: 16 * 1024,
        diagnostics: {
          sanitizer: {
            sensitiveKeys: ['apiKey', 'api_key', 'x-goog-api-key', 'authorization'],
          },
        },
      },
    });
    unsubscribeClient = (handle.client as LoopbackWebSocketJsonClientV1).subscribe(handleMessage);
    unsubscribeExit = handle.onExit(handleSidecarExit);
    await sendToHarness(buildInitializeConversationEvent(harnessConfig));
  };

  return {
    identity: {
      read: () => ({ providerSessionId }),
    },
    events: {
      subscribe(handler) {
        subscribers.add(handler);
        return () => {
          subscribers.delete(handler);
        };
      },
    },
    async send(input: RuntimeInputPayloadV1, options?: RuntimeSendOptionsV1): Promise<RuntimeSendResultV1> {
      if (disposed) return { status: 'unavailable', diagnostic: 'Antigravity localharness runtime is disposed.' };
      const text = readString(input.text);
      if (!text) return { status: 'rejected', diagnostic: 'Antigravity localharness input did not include text.' };
      try {
        await ensureClient();
      } catch (error) {
        return { status: 'rejected', diagnostic: error instanceof Error ? error.message : String(error) };
      }
      const turnId = normalizeTurnId(options?.turnId, `antigravity-turn-${++turnOrdinal}`);
      activeTurnId = turnId;
      activeProviderTurnId = null;
      activePromptAccepted = false;
      activePromptAcceptedInfo = buildAntigravityPromptAcceptedInfo(options);
      activeTurnHasOutputEvidence = false;
      publish({
        ...createBaseEvent(deps, 'turn-start'),
        kind: 'turn-start',
        turnId,
        startedBy: 'user',
      });
      await sendToHarness(buildStartTurnEvent(text));
      return { status: 'accepted', turnId };
    },
    async cancel(request): Promise<RuntimeCancelResultV1> {
      if (!activeTurnId) return { status: 'not_running' };
      const turnId = activeTurnId;
      try {
        await sendToHarness(buildCancelEvent());
      } finally {
        failTurn('cancel_unverified', 'Antigravity localharness cancel acknowledgement is not source-real; sidecar was torn down.');
        await handle?.dispose({ code: 'antigravity.localharness.cancel_unverified' });
        releaseClientHandle();
        clearActiveTurnState();
      }
      return {
        status: 'unavailable',
        diagnostic: 'Antigravity localharness cancel acknowledgement is not source-real; sidecar was torn down.',
      };
    },
    permissions: {
      capability: 'inline',
    },
    setOnPromptAcceptedByProvider(handler) {
      promptAcceptedCallback = handler;
    },
    async dispose(_reason?: RuntimeDisposeReasonV1): Promise<void> {
      if (disposed) return;
      disposed = true;
      subscribers.clear();
      promptAcceptedCallback = null;
      await handle?.dispose({ code: 'antigravity.localharness.dispose' });
      releaseClientHandle();
    },
  };
}

function readEnv(params: CreateSessionRuntimeParamsV1 | CreateExecutionRunBackendParamsV1): Readonly<Record<string, string>> {
  return composeSessionIsolationEnvironment({
    isolationEnvironment: params.isolation?.env,
    environment: params.env,
    unsetEnvKeys: params.isolation?.unsetEnvKeys,
  });
}

function createCredentialResolver(params: Readonly<{
  env: Readonly<Record<string, string>>;
  materializeAuthEnv?: () => Promise<Readonly<Record<string, string>> | null>;
}>): AntigravityLocalharnessCredentialResolver {
  return async () => {
    const materializedEnv = await params.materializeAuthEnv?.().catch(() => null) ?? {};
    const env = { ...params.env, ...materializedEnv };
    const explicitMode = readString(env.ANTIGRAVITY_AUTH_MODE);
    if (explicitMode === 'vertex') {
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

type AntigravityCreateSessionRuntimeParams = CreateSessionRuntimeParamsV1 & Readonly<{
  modelId?: string | null;
}>;

export function createAntigravityLocalharnessRuntimeFromContext(params: Readonly<{
  ctx: Readonly<{
    agentRuntime: Readonly<{
      exec: Pick<ExecRuntimeServiceV1, 'spawnClient'>;
    }>;
    auth?: Readonly<{
      services: Readonly<{
        materialize(request: Readonly<{
          serviceId: string;
          profileId?: string | null;
          reason?: string | null;
        }>): Promise<Readonly<{ env?: Readonly<Record<string, string>> }> | null>;
      }>;
    }>;
    sessions: Readonly<{
      current: Readonly<{
        sessionId?: string;
        permissions: Readonly<{ requestDecision: AntigravityLocalharnessPermissionRequester }>;
        mcp: Readonly<{
          elicit(request: Readonly<{
            requestId?: string;
            toolName: string;
            input?: unknown;
            prompt?: string;
          }>): Promise<Readonly<{ status: string; answers?: unknown }>>;
        }>;
      }>;
    }>;
    mcp: Readonly<{
      resolveForSession(input: Readonly<{
        sessionId: string;
        directory?: string | null;
      }>): Promise<readonly ResolvedMcpServerSpecV1[]>;
    }>;
  }>;
  sessionParams: AntigravityCreateSessionRuntimeParams;
  encodeInputConfig?: AntigravityLocalharnessInputConfigEncoder;
}>): SessionRuntimeV1 {
  const env = readEnv(params.sessionParams);
  const sessionId = readString(params.sessionParams.sessionId) ?? readString(params.ctx.sessions.current.sessionId) ?? 'antigravity-localharness-session';
  const cwd = readString(params.sessionParams.cwd) ?? readString(params.sessionParams.directory) ?? '.';
  return createAntigravityLocalharnessSessionRuntime({
    sessionId,
    cwd,
    modelId: readModelId(params.sessionParams.modelId),
    spawnClient: params.ctx.agentRuntime.exec.spawnClient,
    encodeInputConfig: params.encodeInputConfig,
    requestPermission: params.ctx.sessions.current.permissions.requestDecision,
    elicit: async (request) => {
      const prompt = request.questions
        .map((question) => readString(question.prompt) ?? readString(question.label) ?? readString(question.id))
        .filter((value): value is string => value !== null)
        .join('\n');
      return await params.ctx.sessions.current.mcp.elicit({
        requestId: request.requestId,
        toolName: 'antigravity.user_questions',
        prompt,
        input: { questions: request.questions },
      });
    },
    resolveCredentials: createCredentialResolver({
      env,
      materializeAuthEnv: async () => {
        const materialized = await params.ctx.auth?.services.materialize({
          serviceId: 'gemini',
          reason: 'antigravity-localharness',
        });
        return materialized?.env ?? null;
      },
    }),
    resolveMcpServers: () => params.ctx.mcp.resolveForSession({ sessionId, directory: cwd }),
  });
}

export function createAntigravityLocalharnessExecutionRunBackend(params: Readonly<{
  ctx: Parameters<typeof createAntigravityLocalharnessRuntimeFromContext>[0]['ctx'];
  executionRunParams: CreateExecutionRunBackendParamsV1;
  encodeInputConfig?: AntigravityLocalharnessInputConfigEncoder;
}>): ExecutionRunBackendCreateResultV1 {
  const directory = readString(params.executionRunParams.cwd)
    ?? readString(params.executionRunParams.directory)
    ?? '.';
  return createExecutionRunHostBackendFromSessionRuntime({
    createSessionRuntime: (factoryParams) => createAntigravityLocalharnessRuntimeFromContext({
      ctx: params.ctx,
      sessionParams: {
        ...params.executionRunParams,
        cwd: directory,
        sessionId: readString(factoryParams?.resumeSessionId) ?? readString(params.executionRunParams.runId) ?? undefined,
      },
      encodeInputConfig: params.encodeInputConfig,
    }),
    waitForTurnCompletion: {
      mode: 'untilIdle',
      pollIntervalMs: LOCALHARNESS_EXECUTION_RUN_COMPLETION_POLL_INTERVAL_MS,
    },
    diagnostics: {
      source: 'antigravity-localharness-runtime',
    },
  });
}
