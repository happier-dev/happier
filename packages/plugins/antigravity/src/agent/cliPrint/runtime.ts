import { randomUUID } from 'node:crypto';

import type {
  RuntimeCancelResultV1,
  RuntimeEventV1,
  RuntimeInputPayloadV1,
  RuntimePromptAcceptedCallbackV1,
  RuntimePromptAcceptedInfoV1,
  RuntimeSendOptionsV1,
  RuntimeSendResultV1,
  SessionRuntimeV1,
} from '@happier-dev/plugin-sdk';

import { buildAntigravityCliPrintLaunchArgs } from './launchArgs.js';
import {
  AntigravityCliPrintOneShotError,
  type AntigravityCliPrintOneShotResult,
} from './oneShot.js';
import type { AntigravityConversationDiscovery } from './conversationStore.js';
import { mapAntigravityTranscriptStepsToRuntimeEvents } from './transcript/mapper.js';
import type { AntigravityStep } from '../normalize/index.js';
import { buildAntigravityPromptAcceptedInfo } from '../runtime/promptAcceptance.js';

export type AntigravityCliPrintRuntimeOneShotInput = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
  prompt: string;
  turnId: string;
  timeoutMs: number;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  conversationId?: string | null;
  readTranscriptSteps?: () => Promise<readonly AntigravityStep[]>;
}>;

export type AntigravityCliPrintSessionRuntimeDeps = Readonly<{
  sessionId: string;
  cwd: string;
  executable: string;
  env?: Readonly<Record<string, string>>;
  modelId?: string | null;
  sandbox?: boolean;
  includeWorkspaceScope?: boolean;
  conversationId?: string | null;
  promptTimeoutMs: number;
  now?: () => number;
  runOneShot: (input: AntigravityCliPrintRuntimeOneShotInput) => Promise<AntigravityCliPrintOneShotResult>;
  discoverConversationId?: () => Promise<AntigravityConversationDiscovery>;
  readTranscriptSteps?: (input: Readonly<{
    turnId: string;
    conversationId?: string | null;
  }>) => Promise<readonly AntigravityStep[]>;
  createTurnId?: () => string;
}>;

function createBaseEvent(deps: AntigravityCliPrintSessionRuntimeDeps, kind: RuntimeEventV1['kind']): Readonly<{
  kind: RuntimeEventV1['kind'];
  sessionId: string;
  emittedAtMs: number;
}> {
  return { kind, sessionId: deps.sessionId, emittedAtMs: deps.now?.() ?? Date.now() };
}

function createDescriptor(conversationId: string): RuntimeEventV1 {
  return {
    kind: 'descriptor-update',
    sessionId: 'placeholder',
    emittedAtMs: 0,
    descriptor: {
      v: 1,
      agentId: 'antigravity',
      agent: {
        runtimeMode: 'cliPrint',
        agyConversationId: conversationId,
      },
    },
  };
}

function publishTo(subscribers: Set<(event: RuntimeEventV1) => void>, event: RuntimeEventV1): void {
  for (const subscriber of Array.from(subscribers)) subscriber(event);
}

function readErrorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

function readErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function createDefaultTurnId(): string {
  return `antigravity-cliprint-turn-${randomUUID()}`;
}

function isOutputEvidenceEvent(event: RuntimeEventV1): boolean {
  return event.kind === 'message-delta'
    || event.kind === 'transcript-agent-message-committed'
    || event.kind === 'tool-call'
    || event.kind === 'tool-result'
    || event.kind === 'turn-failed';
}

export function createAntigravityCliPrintSessionRuntime(
  deps: AntigravityCliPrintSessionRuntimeDeps,
): SessionRuntimeV1 {
  const subscribers = new Set<(event: RuntimeEventV1) => void>();
  let providerSessionId = deps.conversationId?.trim() || null;
  let activeTurnId: string | null = null;
  let activeAbortController: AbortController | null = null;
  let activePromptAccepted = false;
  let activePromptAcceptedInfo: RuntimePromptAcceptedInfoV1 | null = null;
  let promptAcceptedCallback: RuntimePromptAcceptedCallbackV1 | null = null;

  const publish = (event: RuntimeEventV1): void => publishTo(subscribers, event);

  const confirmActivePromptAcceptedByProvider = (): void => {
    if (!activeTurnId || activePromptAccepted) return;
    activePromptAccepted = true;
    promptAcceptedCallback?.(activePromptAcceptedInfo ?? { userMessageSeq: null });
  };

  const publishEmptyResponseFailure = (turnId: string): void => {
    publish({
      ...createBaseEvent(deps, 'turn-failed'),
      kind: 'turn-failed',
      turnId,
      issue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'antigravity_cliprint_empty_response',
        source: 'agent_status_error',
        occurredAt: deps.now?.() ?? Date.now(),
        sanitizedPreview: 'Antigravity CLI print mode completed without assistant, tool, or error output.',
      },
    });
  };

  async function send(input: RuntimeInputPayloadV1, options: RuntimeSendOptionsV1 = {}): Promise<RuntimeSendResultV1> {
    if (options.deliverAs === 'steer') {
      return {
        status: 'unsupported',
        diagnostic: 'Antigravity CLI print mode cannot steer an in-flight turn.',
      };
    }
    if (activeTurnId) {
      return {
        status: 'unavailable',
        diagnostic: 'Antigravity CLI print mode already has an active one-shot turn.',
      };
    }

    const turnId = options.turnId ?? deps.createTurnId?.() ?? createDefaultTurnId();
    if (input.text.trim().length === 0) {
      return {
        status: 'rejected',
        turnId,
        diagnostic: 'Antigravity CLI print mode requires a non-empty prompt.',
      };
    }
    activeTurnId = turnId;
    activePromptAccepted = false;
    activePromptAcceptedInfo = buildAntigravityPromptAcceptedInfo(options);
    activeAbortController = new AbortController();
    publish({ ...createBaseEvent(deps, 'turn-start'), kind: 'turn-start', turnId, agentTurnId: providerSessionId ?? undefined });
    try {
      const args = buildAntigravityCliPrintLaunchArgs({
        cwd: deps.cwd,
        prompt: input.text,
        modelId: deps.modelId,
        sandbox: deps.sandbox,
        conversationId: providerSessionId,
        includeWorkspaceScope: deps.includeWorkspaceScope,
      });
      const readTranscriptSteps = deps.readTranscriptSteps;
      const result = await deps.runOneShot({
        executable: deps.executable,
        args,
        cwd: deps.cwd,
        prompt: input.text,
        turnId,
        timeoutMs: deps.promptTimeoutMs,
        env: deps.env,
        signal: activeAbortController.signal,
        conversationId: providerSessionId,
        readTranscriptSteps: readTranscriptSteps
          ? () => readTranscriptSteps({ turnId, conversationId: providerSessionId })
          : undefined,
      });
      const transcriptSteps = result.transcriptSteps ?? [];
      let hasOutputEvidence = false;
      if (transcriptSteps.length > 0) {
        const transcriptEvents = mapAntigravityTranscriptStepsToRuntimeEvents({
          sessionId: deps.sessionId,
          turnId,
          emittedAtMs: deps.now?.() ?? Date.now(),
          steps: transcriptSteps,
        });
        let failureDiagnostic: string | null = null;
        for (const event of transcriptEvents) {
          publish(event);
          if (isOutputEvidenceEvent(event)) hasOutputEvidence = true;
          if (event.kind === 'turn-failed') {
            failureDiagnostic = event.issue.sanitizedPreview ?? 'Antigravity CLI print transcript reported an error.';
          }
        }
        if (failureDiagnostic) {
          confirmActivePromptAcceptedByProvider();
          return {
            status: 'accepted',
            turnId,
          };
        }
      } else if (result.stdout.trim()) {
        const outputEvent: RuntimeEventV1 = {
          ...createBaseEvent(deps, 'message-delta'),
          kind: 'message-delta',
          turnId,
          delta: { text: result.stdout },
        };
        publish(outputEvent);
        hasOutputEvidence = true;
      }
      if (!hasOutputEvidence) {
        confirmActivePromptAcceptedByProvider();
        publishEmptyResponseFailure(turnId);
        return { status: 'accepted', turnId, agentTurnId: providerSessionId ?? undefined };
      }
      confirmActivePromptAcceptedByProvider();
      if (!providerSessionId) {
        const discovery = await deps.discoverConversationId?.().catch(() => null);
        if (discovery?.status === 'found') {
          providerSessionId = discovery.conversationId;
          const descriptor = createDescriptor(discovery.conversationId);
          publish({
            ...descriptor,
            sessionId: deps.sessionId,
            emittedAtMs: deps.now?.() ?? Date.now(),
          });
        }
      }
      publish({ ...createBaseEvent(deps, 'turn-complete'), kind: 'turn-complete', turnId, agentTurnId: providerSessionId ?? undefined });
      return { status: 'accepted', turnId, agentTurnId: providerSessionId ?? undefined };
    } catch (error) {
      if (activeAbortController.signal.aborted || readErrorCode(error) === 'antigravity_cliprint_cancelled') {
        throw error;
      }
      if (!(error instanceof AntigravityCliPrintOneShotError)) {
        const diagnostic = readErrorMessage(error, 'Antigravity CLI print failed before provider launch.');
        publish({
          ...createBaseEvent(deps, 'turn-failed'),
          kind: 'turn-failed',
          turnId,
          issue: {
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'antigravity_cliprint_launch_failed',
            source: 'agent_process_exit',
            occurredAt: deps.now?.() ?? Date.now(),
            sanitizedPreview: diagnostic,
          },
        });
        return { status: 'unavailable', turnId, diagnostic };
      }
      confirmActivePromptAcceptedByProvider();
      publish({
        ...createBaseEvent(deps, 'turn-failed'),
        kind: 'turn-failed',
        turnId,
        issue: {
          v: 1,
          scope: 'primary_session',
          status: 'failed',
          code: readErrorCode(error) ?? 'antigravity_cliprint_failed',
          source: 'agent_status_error',
          occurredAt: deps.now?.() ?? Date.now(),
          sanitizedPreview: error instanceof Error ? error.message : 'Antigravity CLI print run failed.',
        },
      });
      return { status: 'accepted', turnId, agentTurnId: providerSessionId ?? undefined };
    } finally {
      activeTurnId = null;
      activeAbortController = null;
      activePromptAccepted = false;
      activePromptAcceptedInfo = null;
    }
  }

  async function cancel(): Promise<RuntimeCancelResultV1> {
    if (!activeAbortController) return { status: 'not_running' };
    activeAbortController.abort();
    publish({
      ...createBaseEvent(deps, 'turn-cancelled'),
      kind: 'turn-cancelled',
      turnId: activeTurnId ?? 'antigravity-cliprint-unknown-turn',
      reason: 'user',
    });
    return { status: 'cancelled' };
  }

  return {
    identity: {
      read: () => ({ providerSessionId }),
    },
    events: {
      subscribe(handler) {
        subscribers.add(handler);
        return () => subscribers.delete(handler);
      },
    },
    send,
    cancel,
    setOnPromptAcceptedByProvider(handler) {
      promptAcceptedCallback = handler;
    },
    async updateConfig() {
      return {
        status: 'unsupported',
        diagnostic: 'Antigravity CLI print mode does not support live runtime config updates.',
      };
    },
    async dispose() {
      activeAbortController?.abort();
      promptAcceptedCallback = null;
      subscribers.clear();
    },
  };
}
