import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { AgentMessage, SessionId } from '@/agent/core';
import type { SurfacePrimarySessionRuntimeIssueInput } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';

import type { PendingRpcRequest } from './rpcSupport';
import type { PiRpcStreamReader } from './streamReaders';
import type { PiRpcCommandWithoutId, PiRpcResponse, PiRpcStateData } from './types';
import type { PiRpcEventHandlerContext } from './eventHandlers';
import type { PiRpcProcessLifecycleContext } from './processLifecycle';
import type { PiRpcPromptBarrier, PiRpcResponseFlowContext } from './responseFlow';
import { createPiRpcSessionStateContext } from './sessionStateContext';
import {
  createPiRpcEventHandlerContext,
  createPiRpcProcessLifecycleContext,
  createPiRpcResponseFlowContext,
} from './backendContexts';

export function rejectAllPiRpcPendingRequests(
  pendingRequests: Map<string, PendingRpcRequest>,
  error: Error,
): void {
  for (const [id, pending] of pendingRequests.entries()) {
    clearTimeout(pending.timeout);
    pending.reject(error);
    pendingRequests.delete(id);
  }
}

export function createPiRpcSessionStateContextForBackend(params: Readonly<{
  options: Readonly<{
    cwd: string;
    command: string;
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
}>){
  return createPiRpcSessionStateContext(params);
}

export function createPiRpcResponseFlowContextForBackend(params: Readonly<{
  getSessionId: () => string | null;
  assertSession: (sessionId: SessionId) => void;
  beginPromptBarrier: () => PiRpcPromptBarrier;
  createPendingTurn: (timeoutMs: number) => Promise<void>;
  getPendingTurnStallTimeoutMs: () => number;
  hasPendingTurn: () => boolean;
  waitForPromptCollisionToBecomeIdle: () => Promise<void>;
  rejectPendingTurn: (error: Error) => void;
  resolvePendingTurn: () => void;
  hasProcess: () => boolean;
  ensureProcess: () => Promise<void>;
  maybeRestartForUpdatedAuthJson: () => Promise<void> | void;
  restartAndContinue: () => Promise<void>;
  sendCommand: (command: PiRpcCommandWithoutId, timeoutMs?: number) => Promise<PiRpcResponse>;
  getState: () => Promise<PiRpcStateData>;
  publishRuntimeState: (state: PiRpcStateData) => Promise<void>;
  resolveModelSelection: (modelIdRaw: string) => Promise<{ provider: string; modelId: string }>;
  rememberCurrentModelProvider: (provider: string) => void;
  emitIdleStatus: () => void;
}>): PiRpcResponseFlowContext {
  return createPiRpcResponseFlowContext(params);
}

export function createPiRpcEventHandlerContextForBackend(params: Readonly<{
  disposed: boolean;
  messageHandlers: ReadonlySet<(message: AgentMessage) => void>;
  pendingRequests: Map<string, PendingRpcRequest>;
  openPromptRequestIds: Set<string>;
  runtimeTurnState: PiRpcEventHandlerContext['runtimeTurnState'];
  resolvePendingTurn: () => void;
  rejectPendingTurn: (error: Error) => void;
  notePendingTurnActivity: (event: Record<string, unknown>) => void;
  normalizeEvent?: (event: Record<string, unknown>) => Record<string, unknown>;
  keepPendingTurnAliveAfterRetryingAgentEnd: () => boolean;
  keepPendingTurnAliveAfterRecoverableAssistantError: () => boolean;
  schedulePendingTurnCompletion: () => boolean;
  surfacePrimarySessionRuntimeIssue?: (input: SurfacePrimarySessionRuntimeIssueInput) => void | Promise<void>;
  publishUsageStatsBestEffort: () => Promise<void>;
  happierSessionId?: string | null;
  activeSessionId?: string | null;
  currentModelProvider?: string | null;
  classifyRuntimeAuthFailure?: (error: unknown) => ConnectedServiceRuntimeFailureClassification | null;
  reportRuntimeAuthFailureForPendingTurn?: (classification: ConnectedServiceRuntimeFailureClassification) => boolean;
  onRuntimeAuthFailure?: (input: Readonly<{
    happierSessionId: string | null;
    activeSessionId: string | null;
    classification: ConnectedServiceRuntimeFailureClassification;
  }>) => void | Promise<void>;
}>): PiRpcEventHandlerContext {
  return createPiRpcEventHandlerContext(params);
}

export function createPiRpcProcessLifecycleContextForBackend(params: Readonly<{
  options: Readonly<{
    cwd: string;
    command: string;
    args: string[];
    env: Record<string, string>;
  }>;
  getProcess: () => ChildProcessWithoutNullStreams | null;
  setProcess: (process: ChildProcessWithoutNullStreams | null) => void;
  getStdoutLineReader: () => PiRpcStreamReader | null;
  setStdoutLineReader: (reader: PiRpcStreamReader | null) => void;
  getStderrLineReader: () => PiRpcStreamReader | null;
  setStderrLineReader: (reader: PiRpcStreamReader | null) => void;
  getSessionId: () => string | null;
  setSessionId: (sessionId: string | null) => void;
  getSessionFile: () => string | null;
  setSessionFile: (sessionFile: string | null) => void;
  isDisposed: () => boolean;
  hasPendingTurn: () => boolean;
  hasPendingTurnCompletionScheduled: () => boolean;
  hasPendingCompactionResumeScheduled: () => boolean;
  getLastAuthJsonMtimeMs: () => number | null;
  setLastAuthJsonMtimeMs: (mtimeMs: number | null) => void;
  getAuthRestartPendingMtimeMs: () => number | null;
  setAuthRestartPendingMtimeMs: (mtimeMs: number | null) => void;
  getAuthRestartInFlight: () => Promise<void> | null;
  setAuthRestartInFlight: (restart: Promise<void> | null) => void;
  emitMessage: (message: AgentMessage) => void;
  rejectAllPending: (error: Error) => void;
  rejectPendingTurn: (error: Error) => void;
  resolvePendingTurn: () => void;
  resolvePendingTurnAsCompactionPaused: () => void;
  surfacePrimarySessionRuntimeIssue?: (input: SurfacePrimarySessionRuntimeIssueInput) => void | Promise<void>;
  handleStdoutLine: (line: string) => void;
  handleStderrLine: (line: string) => void;
  getState: () => Promise<PiRpcStateData>;
  publishRuntimeState: (state: PiRpcStateData) => Promise<void>;
}>): PiRpcProcessLifecycleContext {
  return createPiRpcProcessLifecycleContext(params);
}
