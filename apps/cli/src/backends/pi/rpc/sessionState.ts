import type { SessionId, StartSessionResult } from '@/agent/core';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  isBarePiSessionId,
  resolvePiSessionIdFromResumeReference,
} from '@happier-dev/plugins-pi/agent/sessionFiles';

import {
  createPiSessionNotMaterializedError,
  resolvePiSessionFileForSessionId,
} from './sessionRecovery';
import { asNonEmptyString } from './rpcSupport';
import type { PiRpcStateData } from './types';

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export type PiRpcSessionStateContext = Readonly<{
  options: Readonly<{
    args: string[];
    env: Record<string, string>;
  }>;
  isDisposed: () => boolean;
  getSessionId: () => string | null;
  setSessionId: (sessionId: string | null) => void;
  getSessionFile: () => string | null;
  setSessionFile: (sessionFile: string | null) => void;
  hasPendingTurn: () => boolean;
  emitStartingStatus: () => void;
  emitIdleStatus: () => void;
  ensureProcess: () => Promise<void>;
  stopRpcProcessForRestart: () => Promise<void>;
  spawnRpcProcess: (params: Readonly<{ args: string[] }>) => void;
  captureAuthJsonSnapshot: () => Promise<void>;
  createSession: () => Promise<void>;
  getState: () => Promise<PiRpcStateData>;
  publishRuntimeState: (state: PiRpcStateData) => Promise<void>;
}>;

export async function startPiRpcSession(
  context: PiRpcSessionStateContext,
): Promise<StartSessionResult> {
  await context.ensureProcess();
  context.emitStartingStatus();

  const stateBefore = await context.getState();
  const existingSessionId = asNonEmptyString(stateBefore.sessionId);
  const existingSessionFile = asNonEmptyString(stateBefore.sessionFile);
  if (existingSessionId) {
    context.setSessionId(existingSessionId);
    context.setSessionFile(existingSessionFile);
    await context.captureAuthJsonSnapshot();
    await context.publishRuntimeState(stateBefore);
    context.emitIdleStatus();
    return { sessionId: existingSessionId };
  }

  await context.createSession();
  const stateAfter = await context.getState();
  const nextSessionId = asNonEmptyString(stateAfter.sessionId);
  const nextSessionFile = asNonEmptyString(stateAfter.sessionFile);
  if (!nextSessionId) {
    throw new Error('Pi did not return a session id');
  }

  context.setSessionId(nextSessionId);
  context.setSessionFile(nextSessionFile);
  await context.captureAuthJsonSnapshot();
  await context.publishRuntimeState(stateAfter);
  context.emitIdleStatus();
  return { sessionId: nextSessionId };
}

export async function loadPiRpcSession(
  context: PiRpcSessionStateContext,
  sessionId: SessionId,
): Promise<StartSessionResult> {
  if (context.isDisposed()) {
    throw new Error('Pi backend is disposed');
  }

  const requestedResumeReference = String(sessionId ?? '').trim();
  if (!requestedResumeReference) {
    throw new Error('Pi loadSession requires a session id');
  }
  const requestedAbsoluteSessionFile = isAbsolute(requestedResumeReference) ? requestedResumeReference : null;
  if (!requestedAbsoluteSessionFile && !isBarePiSessionId(requestedResumeReference)) {
    throw new Error('Pi loadSession requires a bare Pi session id');
  }
  const expectedSessionId = resolvePiSessionIdFromResumeReference(requestedResumeReference);
  if (!expectedSessionId) {
    throw new Error('Pi loadSession requires a bare Pi session id');
  }

  const currentSessionId = context.getSessionId();
  if (currentSessionId) {
    if (currentSessionId !== expectedSessionId) {
      throw new Error(`Pi session mismatch (expected ${expectedSessionId}, got ${currentSessionId})`);
    }
    return { sessionId: currentSessionId };
  }

  if (context.hasPendingTurn()) {
    throw new Error('Cannot load Pi session while a turn is in-flight');
  }

  context.emitStartingStatus();
  try {
    await context.stopRpcProcessForRestart();
    const preferredSessionFile = requestedAbsoluteSessionFile && await pathIsFile(requestedAbsoluteSessionFile)
      ? requestedAbsoluteSessionFile
      : null;
    const sessionFile = preferredSessionFile ?? await resolvePiSessionFileForSessionId({
      expectedSessionId,
      env: context.options.env,
      sessionFile: context.getSessionFile(),
    });
    const sessionArg = sessionFile ?? expectedSessionId;
    context.spawnRpcProcess({ args: [...context.options.args, '--session', sessionArg] });

    const state = await context.getState();
    const resumedSessionId = asNonEmptyString(state.sessionId);
    if (!resumedSessionId) {
      throw createPiSessionNotMaterializedError(expectedSessionId);
    }
    if (resumedSessionId !== expectedSessionId) {
      throw new Error(`Pi session mismatch after --session (expected ${expectedSessionId}, got ${resumedSessionId})`);
    }

    context.setSessionId(resumedSessionId);
    context.setSessionFile(asNonEmptyString(state.sessionFile) ?? sessionFile);
    await context.captureAuthJsonSnapshot();
    await context.publishRuntimeState(state);
    context.emitIdleStatus();
    return { sessionId: resumedSessionId };
  } catch (error) {
    await context.stopRpcProcessForRestart();
    context.setSessionId(null);
    throw error;
  }
}

export function assertPiRpcSession(
  currentSessionId: string | null,
  sessionId: SessionId,
): void {
  if (!currentSessionId) {
    throw new Error('Pi session was not started');
  }
  if (currentSessionId !== sessionId) {
    throw new Error(`Pi session mismatch (expected ${currentSessionId}, got ${sessionId})`);
  }
}
