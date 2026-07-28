import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId, StartSessionResult } from '@/agent/core';
import type { PermissionMode } from '@/api/types';
import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import { createCodexAppServerRuntime } from '@/backends/codex/appServer/runtime';
import { createExecutionRunTimeoutError } from '@/agent/executionRuns/runtime/executionRunErrors';
import type {
  CodexAppServerReviewStartRequest,
  CodexAppServerReviewStartResult,
} from '@/backends/codex/appServer/reviews/codexAppServerReviewTypes';
import { resolveCodexAppServerNativeReviewRequest } from '@/backends/codex/appServer/reviews/resolveCodexAppServerNativeReviewRequest';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';

function isCodexProvider(provider: ACPProvider): boolean {
  return String(provider ?? '').trim().toLowerCase() === 'codex';
}

function isCodexToolMessage(body: unknown): body is Readonly<{
  type: 'tool-call' | 'tool-call-result';
  name?: string;
  callId?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
}> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const type = (body as { type?: unknown }).type;
  return type === 'tool-call' || type === 'tool-call-result';
}

export type CodexAppServerExecutionRunTurnLiveness = Readonly<{
  active: boolean;
  activeProviderTurn: boolean;
  promptInFlight: boolean;
  source: 'codex-app-server-runtime';
  turnInFlight: boolean;
}>;

export type CodexAppServerExecutionRunBackend = AgentBackend & Readonly<{
  probeTurnLiveness: () => Promise<CodexAppServerExecutionRunTurnLiveness>;
}>;

type PromptTurnState = {
  promise: Promise<void>;
  settled: boolean;
};

function isPositiveFiniteTimeoutMs(timeoutMs: number | null | undefined): timeoutMs is number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0;
}

async function waitForCodexAppServerPrompt(
  promptTurn: PromptTurnState,
  timeoutMs: number | null | undefined,
  readLiveness: () => CodexAppServerExecutionRunTurnLiveness,
): Promise<void> {
  if (!isPositiveFiniteTimeoutMs(timeoutMs)) {
    await promptTurn.promise;
    return;
  }

  while (true) {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const outcome = await Promise.race([
        promptTurn.promise.then(() => ({ type: 'resolved' as const })),
        new Promise<{ type: 'timeout' }>((resolve) => {
          timeout = setTimeout(() => {
            resolve({ type: 'timeout' });
          }, timeoutMs);
          timeout.unref?.();
        }),
      ]);
      if (outcome.type === 'resolved') return;
    } finally {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
    }

    const livenessProbe = readLiveness();
    if (!livenessProbe.active) {
      throw createExecutionRunTimeoutError({
        timeoutMs,
        errorCode: 'provider_inactivity_timeout',
        livenessProbe,
      });
    }
  }
}

export function createCodexAppServerExecutionRunBackend(args: Readonly<{
  cwd: string;
  env?: NodeJS.ProcessEnv;
  permissionMode: PermissionMode;
  start?: ExecutionRunBackendStartContext | null;
  permissionHandler?: Readonly<{
    handleToolCall: (toolCallId: string, toolName: string, input: unknown) => Promise<{
      decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
      execPolicyAmendment?: Readonly<{ command: string[] }>;
      answers?: Readonly<Record<string, readonly string[]>>;
    }>;
  }> | null;
}>): CodexAppServerExecutionRunBackend {
  const handlers = new Set<AgentMessageHandler>();
  let sessionId: SessionId | null = null;
  let lastObservedMessageSeq = 0;
  let promptTurn: PromptTurnState | null = null;
  let nativeReviewStartAttempted = false;
  const assistantTextByLocalId = new Map<string, string>();
  const toolNameByCallId = new Map<string, string>();

  const emit = (message: AgentMessage): void => {
    for (const handler of handlers) {
      handler(message);
    }
  };

  const emitCommittedTranscriptBody = (provider: ACPProvider, body: ACPMessageData, localId?: string): void => {
    if (!isCodexProvider(provider)) return;
    if (body.type === 'message') {
      const assistantKey = String(localId ?? '').trim() || '__main__';
      const previousText = assistantTextByLocalId.get(assistantKey) ?? '';
      const nextFullText = body.message.startsWith(previousText)
        ? body.message
        : `${previousText}${body.message}`;
      if (nextFullText === previousText) {
        return;
      }
      assistantTextByLocalId.set(assistantKey, nextFullText);
      emit({ type: 'model-output', fullText: nextFullText });
      lastObservedMessageSeq += 1;
      return;
    }
    if (body.type === 'thinking') {
      lastObservedMessageSeq += 1;
      return;
    }
    if (!isCodexToolMessage(body)) return;
    if (body.type === 'tool-call') {
      const callId = String(body.callId ?? '');
      const toolName = body.name ?? 'CodexTool';
      if (callId) {
        toolNameByCallId.set(callId, toolName);
      }
      emit({
        type: 'tool-call',
        toolName,
        args: body.input && typeof body.input === 'object' && !Array.isArray(body.input)
          ? body.input as Record<string, unknown>
          : {},
        callId,
      });
      lastObservedMessageSeq += 1;
      return;
    }
    const callId = String(body.callId ?? '');
    emit({
      type: 'tool-result',
      toolName: body.name ?? toolNameByCallId.get(callId) ?? 'CodexTool',
      result: body.output ?? null,
      callId,
      isError: body.isError === true,
    });
    lastObservedMessageSeq += 1;
  };

  const sessionAdapter: Pick<ApiSessionClient,
    'sessionId' | 'getLastObservedMessageSeq' | 'updateMetadata' | 'sendAgentMessage' | 'sendAgentMessageCommitted' | 'sendCodexMessage'
  > = {
    sessionId: 'codex-app-server-execution-run',
    getLastObservedMessageSeq: () => lastObservedMessageSeq,
    updateMetadata: async () => undefined,
    sendAgentMessage: (provider, body) => {
      emitCommittedTranscriptBody(provider, body);
    },
    sendAgentMessageCommitted: async (provider, body, opts) => {
      emitCommittedTranscriptBody(provider, body, opts.localId);
    },
    sendCodexMessage: (body: unknown) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return;
      const message = body as Record<string, unknown>;
      const type = String(message.type ?? '').trim();
      if (type === 'tool-call') {
        const callId = String(message.callId ?? '');
        const toolName = typeof message.name === 'string' ? message.name : 'CodexTool';
        if (callId) {
          toolNameByCallId.set(callId, toolName);
        }
        emit({
          type: 'tool-call',
          toolName,
          args: message.input && typeof message.input === 'object' && !Array.isArray(message.input)
            ? message.input as Record<string, unknown>
            : {},
          callId,
        });
        lastObservedMessageSeq += 1;
        return;
      }
      if (type === 'tool-call-result') {
        const callId = String(message.callId ?? '');
        emit({
          type: 'tool-result',
          toolName: typeof message.name === 'string' ? message.name : toolNameByCallId.get(callId) ?? 'CodexTool',
          result: message.output ?? null,
          callId,
          isError: message.isError === true,
        });
        lastObservedMessageSeq += 1;
      }
    },
  };

  const runtime = createCodexAppServerRuntime({
    directory: args.cwd,
    activeServerDir: args.cwd,
    processEnv: args.env ?? process.env,
    session: sessionAdapter as ApiSessionClient,
    onThinkingChange: (thinking) => {
      emit({ type: 'status', status: thinking ? 'running' : 'idle' });
    },
    permissionHandler: args.permissionHandler ?? null,
    permissionMode: args.permissionMode,
  });

  const ensureStarted = async (requestedSessionId?: SessionId): Promise<SessionId> => {
    if (sessionId && (!requestedSessionId || requestedSessionId === sessionId)) {
      return sessionId;
    }
    await runtime.startOrLoad({
      ...(requestedSessionId ? { existingSessionId: requestedSessionId, importHistory: false } : {}),
    });
    const startedSessionId = runtime.getSessionId();
    if (!startedSessionId) {
      throw new Error('Codex app-server execution run did not return a thread id');
    }
    sessionId = startedSessionId as SessionId;
    return sessionId;
  };

  type ReviewCapableRuntime = typeof runtime & Readonly<{
    startReview?: (request: CodexAppServerReviewStartRequest) => Promise<CodexAppServerReviewStartResult>;
  }>;

  const startNativeReviewIfAvailable = async (): Promise<'started' | 'fallback'> => {
    if (nativeReviewStartAttempted) return 'fallback';
    nativeReviewStartAttempted = true;

    const resolution = resolveCodexAppServerNativeReviewRequest({ start: args.start ?? null });
    if (!resolution.ok) {
      if (resolution.reason === 'invalid_review_input') {
        throw new Error(resolution.error ?? 'Invalid review input');
      }
      return 'fallback';
    }

    const startReview = (runtime as ReviewCapableRuntime).startReview;
    if (typeof startReview !== 'function') return 'fallback';

    const result = await startReview(resolution.request);
    if (result && result.ok === false && result.errorCode === 'unsupported_session_runtime_method') {
      return 'fallback';
    }
    return 'started';
  };

  const sendRuntimePrompt = (prompt: string): Promise<void> => {
    const special = parseSpecialCommand(prompt);
    return special.type === 'compact'
      ? runtime.compactContext(special.originalMessage ?? prompt.trim())
      : runtime.sendPrompt(prompt);
  };

  const createPromptTurn = (promise: Promise<void>): PromptTurnState => {
    const turn: PromptTurnState = {
      promise,
      settled: false,
    };
    promise.then(
      () => {
        turn.settled = true;
      },
      () => {
        turn.settled = true;
      },
    );
    return turn;
  };

  const readTurnLiveness = (): CodexAppServerExecutionRunTurnLiveness => {
    const activeProviderTurn = runtime.hasActiveProviderTurn();
    const turnInFlight = runtime.isTurnInFlight();
    const promptInFlight = promptTurn !== null && !promptTurn.settled;
    return {
      active: activeProviderTurn,
      activeProviderTurn,
      promptInFlight,
      source: 'codex-app-server-runtime',
      turnInFlight,
    };
  };

  return {
    async startSession(initialPrompt?: string): Promise<StartSessionResult> {
      assistantTextByLocalId.clear();
      nativeReviewStartAttempted = false;
      const startedSessionId = await ensureStarted();
      if (typeof initialPrompt === 'string' && initialPrompt.trim()) {
        await this.sendPrompt(startedSessionId, initialPrompt);
        await this.waitForResponseComplete?.();
      }
      return { sessionId: startedSessionId };
    },
    async loadSession(existingSessionId: SessionId): Promise<StartSessionResult> {
      const startedSessionId = await ensureStarted(existingSessionId);
      return { sessionId: startedSessionId };
    },
    async sendPrompt(requestedSessionId: SessionId, prompt: string): Promise<void> {
      const activeSessionId = await ensureStarted(requestedSessionId);
      if (activeSessionId !== requestedSessionId) {
        sessionId = activeSessionId;
      }
      assistantTextByLocalId.clear();
      const promptWork = (async () => {
        const reviewStartResult = await startNativeReviewIfAvailable();
        if (reviewStartResult === 'started') return;
        await sendRuntimePrompt(prompt);
      })();
      promptTurn = createPromptTurn(promptWork);
      void promptWork.catch(() => undefined);
    },
    async probeTurnLiveness(): Promise<CodexAppServerExecutionRunTurnLiveness> {
      return readTurnLiveness();
    },
    async waitForResponseComplete(timeoutMs?: number | null): Promise<void> {
      const activePromptTurn = promptTurn;
      if (!activePromptTurn) return;
      try {
        await waitForCodexAppServerPrompt(activePromptTurn, timeoutMs, readTurnLiveness);
      } finally {
        if (promptTurn === activePromptTurn) {
          promptTurn = null;
        }
      }
    },
    async cancel(_sessionId: SessionId): Promise<void> {
      await runtime.cancel();
    },
    onMessage(handler: AgentMessageHandler): void {
      handlers.add(handler);
    },
    offMessage(handler: AgentMessageHandler): void {
      handlers.delete(handler);
    },
    async dispose(): Promise<void> {
      await runtime.reset();
      sessionId = null;
      promptTurn = null;
      nativeReviewStartAttempted = false;
      assistantTextByLocalId.clear();
    },
  };
}
