import { randomUUID } from 'node:crypto';

import type {
  AgentSessionRuntime,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginDiagnosticData } from '@happier-dev/plugin-sdk';

import { buildAntigravityCliPrintLaunchArgs } from './launchArgs.js';
import {
  AntigravityCliPrintOneShotError,
  type AntigravityCliPrintOneShotResult,
} from './oneShot.js';
import type { AntigravityConversationDiscovery } from './conversationStore.js';
import { mapAntigravityTranscriptStepsToRuntimeEvents } from './transcript/mapper.js';
import type { AntigravityStep } from '../normalize/index.js';

type NativeSessionEventInput = AgentSessionRuntimeEvent extends infer Event
  ? Event extends AgentSessionRuntimeEvent
    ? Omit<Event, 'sequence' | 'sessionId' | 'emittedAtMs'>
    : never
  : never;

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

function diagnostic(code: string, message: string): PluginDiagnosticData {
  return { code, severity: 'error', message };
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

export function createAntigravityCliPrintSessionRuntime(
  deps: AntigravityCliPrintSessionRuntimeDeps,
): AgentSessionRuntime {
  const subscribers = new Set<(event: AgentSessionRuntimeEvent) => void>();
  let providerSessionId = deps.conversationId?.trim() || null;
  let sequence = 0;
  let activeTurnId: string | null = null;
  let activeAbortController: AbortController | null = null;

  const publish = (event: NativeSessionEventInput): void => {
    const value = Object.freeze({
      ...event,
      sequence: ++sequence,
      sessionId: deps.sessionId,
      emittedAtMs: deps.now?.() ?? Date.now(),
    }) as AgentSessionRuntimeEvent;
    for (const subscriber of subscribers) subscriber(value);
  };

  const reject = (
    request: Parameters<AgentSessionRuntime['send']>[0],
    code: string,
    message: string,
    status: 'rejected' | 'unavailable' | 'unsupported',
    retryable = false,
  ) => {
    const issue = diagnostic(code, message);
    publish({ kind: 'input-rejected', inputIds: request.inputIds, diagnostic: issue, retryable });
    return { status, diagnostic: issue, retryable } as const;
  };

  return {
    async send(request) {
      if (request.delivery.kind === 'steer') {
        return reject(
          request,
          'antigravity_cliprint_steer_unsupported',
          'Antigravity CLI print mode cannot steer an in-flight turn.',
          'unsupported',
        );
      }
      if (activeTurnId) {
        return reject(
          request,
          'antigravity_cliprint_turn_active',
          'Antigravity CLI print mode already has an active one-shot turn.',
          'unavailable',
          true,
        );
      }

      const turnId = request.delivery.turnId || deps.createTurnId?.() || createDefaultTurnId();
      if (request.input.text.trim().length === 0) {
        return reject(
          request,
          'antigravity_cliprint_input_missing_text',
          'Antigravity CLI print mode requires a non-empty prompt.',
          'rejected',
        );
      }

      const staged: NativeSessionEventInput[] = [{
        kind: 'turn-start',
        turnId,
        ...(providerSessionId ? { agentTurnId: providerSessionId } : {}),
        startedBy: 'host',
      }];
      activeTurnId = turnId;
      activeAbortController = new AbortController();
      try {
        const args = buildAntigravityCliPrintLaunchArgs({
          cwd: deps.cwd,
          prompt: request.input.text,
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
          prompt: request.input.text,
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
        let transcriptFailure = false;
        if (transcriptSteps.length > 0) {
          for (const event of mapAntigravityTranscriptStepsToRuntimeEvents({
            sessionId: deps.sessionId,
            turnId,
            emittedAtMs: deps.now?.() ?? Date.now(),
            steps: transcriptSteps,
          })) {
            staged.push(event);
            if (event.kind === 'turn-failed') transcriptFailure = true;
            if (['message-delta', 'transcript-message-committed', 'tool-call', 'tool-result', 'turn-failed'].includes(event.kind)) {
              hasOutputEvidence = true;
            }
          }
        } else if (result.stdout.trim()) {
          staged.push({ kind: 'message-delta', turnId, channel: 'assistant', text: result.stdout });
          hasOutputEvidence = true;
        }
        if (!hasOutputEvidence) {
          staged.push({
            kind: 'turn-failed',
            turnId,
            diagnostic: diagnostic(
              'antigravity_cliprint_empty_response',
              'Antigravity CLI print mode completed without assistant, tool, or error output.',
            ),
          });
        } else if (!transcriptFailure) {
          if (!providerSessionId) {
            const discovery = await deps.discoverConversationId?.().catch(() => null);
            if (discovery?.status === 'found') {
              providerSessionId = discovery.conversationId;
              staged.push({ kind: 'provider-session-id', providerSessionId });
            }
          }
          staged.push({
            kind: 'turn-complete',
            turnId,
            ...(providerSessionId ? { agentTurnId: providerSessionId } : {}),
          });
        }
        publish({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
        for (const event of staged) publish(event);
        return { status: 'admitted' };
      } catch (error) {
        if (activeAbortController.signal.aborted || readErrorCode(error) === 'antigravity_cliprint_cancelled') {
          const issue = diagnostic(
            'antigravity_cliprint_cancelled',
            readErrorMessage(error, 'Antigravity CLI print run was cancelled.'),
          );
          publish({ kind: 'input-custody-unknown', inputIds: request.inputIds, issue });
          return { status: 'unavailable', retryable: true, diagnostic: issue };
        }
        const issue = diagnostic(
          readErrorCode(error) ?? (
            error instanceof AntigravityCliPrintOneShotError
              ? 'antigravity_cliprint_failed'
              : 'antigravity_cliprint_launch_failed'
          ),
          readErrorMessage(error, 'Antigravity CLI print failed before provider launch.'),
        );
        publish({ kind: 'input-custody-unknown', inputIds: request.inputIds, issue });
        return { status: 'unavailable', retryable: true, diagnostic: issue };
      } finally {
        activeTurnId = null;
        activeAbortController = null;
      }
    },
    async cancel(request) {
      if (!activeAbortController) return { status: 'notRunning' };
      if (activeTurnId !== request.turnId) return { status: 'notRunning' };
      activeAbortController.abort();
      publish({
        kind: 'turn-cancelled',
        turnId: activeTurnId ?? request.turnId,
        cause: 'user',
      });
      return { status: 'requested', turnId: request.turnId };
    },
    watch(listener) {
      subscribers.add(listener);
      return { dispose: () => { subscribers.delete(listener); } };
    },
    async dispose() {
      activeAbortController?.abort();
      subscribers.clear();
    },
  };
}
