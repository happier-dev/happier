import type { SessionId } from '@/agent/core';

import { asError, normalizePiThinkingEffort } from './rpcSupport';
import type { PiRpcCommandWithoutId, PiRpcResponse, PiRpcStateData } from './types';

export type PiRpcPromptBarrier = Readonly<{
  settle: (error?: Error) => void;
}>;

export type PiRpcResponseFlowContext = Readonly<{
  getSessionId: () => string | null;
  assertSession: (sessionId: SessionId) => void;
  beginPromptBarrier: () => PiRpcPromptBarrier;
  createPendingTurn: (timeoutMs: number) => Promise<void>;
  rejectPendingTurn: (error: Error) => void;
  resolvePendingTurn: () => void;
  ensureProcess: () => Promise<void>;
  maybeRestartForUpdatedAuthJson: () => Promise<void> | void;
  restartAndContinue: () => Promise<void>;
  sendCommand: (command: PiRpcCommandWithoutId, timeoutMs?: number) => Promise<PiRpcResponse>;
  getState: () => Promise<PiRpcStateData>;
  publishRuntimeState: (state: PiRpcStateData) => Promise<void>;
  resolveModelSelection: (modelIdRaw: string) => Promise<{ provider: string; modelId: string }>;
  rememberCurrentModelProvider: (provider: string) => void;
  emitIdleStatus: () => void;
}>;

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
      const turn = context.createPendingTurn(240_000);
      try {
        await context.sendCommand({ type: 'prompt', message });
        await turn;
        return;
      } catch (error) {
        const promptError = asError(error);
        const normalizedError = promptError.message.toLowerCase();
        const canFallbackToSteer =
          normalizedError.includes('already processing') || normalizedError.includes('streamingbehavior');

        if (canFallbackToSteer) {
          try {
            await context.sendCommand({ type: 'steer', message });
            await turn;
            return;
          } catch (steerError) {
            const resolvedSteerError = asError(steerError);
            context.rejectPendingTurn(resolvedSteerError);
            await turn.catch(() => undefined);
            throw resolvedSteerError;
          }
        }

        context.rejectPendingTurn(promptError);
        await turn.catch(() => undefined);

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
