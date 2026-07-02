import type { SessionId } from '@/agent/core';

import { asError, isPromptResponseTimeoutError, normalizePiThinkingEffort } from './rpcSupport';
import type { PiRpcCommandWithoutId, PiRpcResponse, PiRpcStateData } from './types';

export type PiRpcPromptBarrier = Readonly<{
  settle: (error?: Error) => void;
}>;

export type PiRpcResponseFlowContext = Readonly<{
  getSessionId: () => string | null;
  assertSession: (sessionId: SessionId) => void;
  beginPromptBarrier: () => PiRpcPromptBarrier;
  createPendingTurn: (timeoutMs: number) => Promise<void>;
  getPendingTurnStallTimeoutMs: () => number;
  hasPendingTurn: () => boolean;
  waitForPromptCollisionToBecomeIdle: () => Promise<void>;
  rejectPendingTurn: (error: Error) => void;
  resolvePendingTurn: () => void;
  ensureProcess: () => Promise<void>;
  hasProcess: () => boolean;
  maybeRestartForUpdatedAuthJson: () => Promise<void> | void;
  restartAndContinue: () => Promise<void>;
  sendCommand: (command: PiRpcCommandWithoutId, timeoutMs?: number) => Promise<PiRpcResponse>;
  getState: () => Promise<PiRpcStateData>;
  publishRuntimeState: (state: PiRpcStateData) => Promise<void>;
  resolveModelSelection: (modelIdRaw: string) => Promise<{ provider: string; modelId: string }>;
  rememberCurrentModelProvider: (provider: string) => void;
  emitIdleStatus: () => void;
}>;

function parseCompactInstructions(command: string): string | undefined {
  const trimmed = command.trim();
  if (trimmed === '/compact') return undefined;
  if (!trimmed.startsWith('/compact ')) return undefined;
  const instructions = trimmed.slice('/compact'.length).trim();
  return instructions.length > 0 ? instructions : undefined;
}

export async function sendPiRpcPrompt(
  context: PiRpcResponseFlowContext,
  sessionId: SessionId,
  prompt: string,
): Promise<void> {
  context.assertSession(sessionId);

  const promptBarrier = context.beginPromptBarrier();

  const maybeRestart = context.maybeRestartForUpdatedAuthJson();
  try {
    if (maybeRestart) {
      await maybeRestart;
    }
    const message = prompt.trim();
    if (!message) {
      promptBarrier.settle();
      return;
    }

    await context.ensureProcess();
    promptBarrier.settle();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let turn: Promise<void> | null = null;
      try {
        if (context.hasPendingTurn()) {
          if (attempt === 0) {
            await context.waitForPromptCollisionToBecomeIdle();
            continue;
          }
          throw new Error('Pi is already processing another prompt');
        }
        turn = context.createPendingTurn(context.getPendingTurnStallTimeoutMs());
        await context.sendCommand({ type: 'prompt', message });
        await turn;
        return;
      } catch (error) {
        const promptError = asError(error);
        const normalizedError = promptError.message.toLowerCase();
        const isPromptCollisionError =
          normalizedError.includes('already processing') || normalizedError.includes('streamingbehavior');

        if (isPromptCollisionError && attempt === 0) {
          if (turn) {
            context.rejectPendingTurn(promptError);
            await turn.catch(() => undefined);
          }
          await context.waitForPromptCollisionToBecomeIdle();
          continue;
        }

        if (turn && isPromptResponseTimeoutError(promptError)) {
          // The prompt write succeeded, but Pi did not acknowledge the prompt before entering a
          // long provider phase (for example threshold compaction). At this point the turn stream
          // is the source of truth: keep the pending turn alive so later compaction/tool/agent_end
          // events can complete it instead of surfacing a false transport timeout to the user.
          await turn;
          return;
        }

        if (turn) {
          context.rejectPendingTurn(promptError);
          await turn.catch(() => undefined);
        }

        const canRecoverFromProcessExit =
          attempt === 0 &&
          !!context.getSessionId() &&
          (normalizedError.includes('pi process exited') ||
            normalizedError.includes('pi process terminated') ||
            normalizedError.includes('failed to write pi rpc command') ||
            normalizedError.includes('epipe'));

        if (!canRecoverFromProcessExit) {
          throw promptError;
        }

        try {
          await context.restartAndContinue();
        } catch (restartError) {
          throw asError(restartError);
        }
      }
    }
  } catch (error) {
    promptBarrier.settle(asError(error));
    throw error;
  }
}

export async function compactPiRpcContext(
  context: PiRpcResponseFlowContext,
  sessionId: SessionId,
  command: string,
): Promise<void> {
  context.assertSession(sessionId);
  const maybeRestart = context.maybeRestartForUpdatedAuthJson();
  if (maybeRestart) {
    await maybeRestart;
  }
  const customInstructions = parseCompactInstructions(command);
  await context.sendCommand({
    type: 'compact',
    ...(customInstructions ? { customInstructions } : {}),
  }, 240_000);
}

export async function sendPiRpcSteerPrompt(
  context: PiRpcResponseFlowContext,
  sessionId: SessionId,
  prompt: string,
): Promise<void> {
  context.assertSession(sessionId);
  const maybeRestart = context.maybeRestartForUpdatedAuthJson();
  if (maybeRestart) {
    await maybeRestart;
  }
  const message = prompt.trim();
  if (!message) {
    return;
  }
  if (!context.hasProcess()) {
    throw new Error('Pi process is not running');
  }
  await context.sendCommand({ type: 'steer', message });
}

export async function setPiRpcSessionModel(
  context: PiRpcResponseFlowContext,
  sessionId: SessionId,
  modelId: string,
): Promise<void> {
  context.assertSession(sessionId);
  const maybeRestart = context.maybeRestartForUpdatedAuthJson();
  if (maybeRestart) {
    await maybeRestart;
  }
  const normalized = modelId.trim();
  if (!normalized) {
    return;
  }

  const selection = await context.resolveModelSelection(normalized);
  await context.sendCommand({ type: 'set_model', provider: selection.provider, modelId: selection.modelId }, 60_000);
  context.rememberCurrentModelProvider(selection.provider);
  await context.publishRuntimeState(await context.getState());
}

export async function setPiRpcSessionConfigOption(
  context: PiRpcResponseFlowContext,
  sessionId: SessionId,
  configId: string,
  value: string | number | boolean | null,
): Promise<void> {
  context.assertSession(sessionId);
  const maybeRestart = context.maybeRestartForUpdatedAuthJson();
  if (maybeRestart) {
    await maybeRestart;
  }

  const normalizedId = typeof configId === 'string' ? configId.trim().toLowerCase() : '';
  if (!normalizedId || normalizedId !== 'reasoning_effort') {
    return;
  }

  const level = normalizePiThinkingEffort(value);
  if (!level) {
    return;
  }

  await context.sendCommand({ type: 'set_thinking_level', level }, 30_000);
  await context.publishRuntimeState(await context.getState());
}

export async function cancelPiRpcTurn(
  context: PiRpcResponseFlowContext,
  sessionId: SessionId,
): Promise<void> {
  context.assertSession(sessionId);
  await context.sendCommand({ type: 'abort' });
  context.resolvePendingTurn();
  context.emitIdleStatus();
}
