import type { SessionId } from '@/agent/core';
import type { SurfacePrimarySessionRuntimeIssueInput } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';

import type { PendingRpcRequest } from './rpcSupport';
import type { PiRpcStreamReader } from './streamReaders';
import type { PiRpcCommandWithoutId, PiRpcResponse, PiRpcStateData } from './types';
import type { PiRpcEventHandlerContext } from './eventHandlers';
import type { PiRpcProcessLifecycleContext } from './processLifecycle';
import type { PiRpcPromptBarrier, PiRpcResponseFlowContext } from './responseFlow';

export function createPiRpcResponseFlowContext(params: Readonly<{
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
  return {
    getSessionId: params.getSessionId,
    assertSession: params.assertSession,
    beginPromptBarrier: params.beginPromptBarrier,
    createPendingTurn: params.createPendingTurn,
    getPendingTurnStallTimeoutMs: params.getPendingTurnStallTimeoutMs,
    hasPendingTurn: params.hasPendingTurn,
    waitForPromptCollisionToBecomeIdle: params.waitForPromptCollisionToBecomeIdle,
    rejectPendingTurn: params.rejectPendingTurn,
    resolvePendingTurn: params.resolvePendingTurn,
    hasProcess: params.hasProcess,
    ensureProcess: params.ensureProcess,
    maybeRestartForUpdatedAuthJson: params.maybeRestartForUpdatedAuthJson,
    restartAndContinue: params.restartAndContinue,
    sendCommand: params.sendCommand,
    getState: params.getState,
    publishRuntimeState: params.publishRuntimeState,
    resolveModelSelection: params.resolveModelSelection,
    rememberCurrentModelProvider: params.rememberCurrentModelProvider,
    emitIdleStatus: params.emitIdleStatus,
  };
}

export function createPiRpcEventHandlerContext(params: Readonly<{
  disposed: boolean;
  messageHandlers: ReadonlySet<(message: import('@/agent/core').AgentMessage) => void>;
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
  return {
    disposed: params.disposed,
    messageHandlers: params.messageHandlers,
    pendingRequests: params.pendingRequests,
    openPromptRequestIds: params.openPromptRequestIds,
    runtimeTurnState: params.runtimeTurnState,
    resolvePendingTurn: params.resolvePendingTurn,
    rejectPendingTurn: params.rejectPendingTurn,
    notePendingTurnActivity: params.notePendingTurnActivity,
    normalizeEvent: params.normalizeEvent,
    keepPendingTurnAliveAfterRetryingAgentEnd: params.keepPendingTurnAliveAfterRetryingAgentEnd,
    keepPendingTurnAliveAfterRecoverableAssistantError: params.keepPendingTurnAliveAfterRecoverableAssistantError,
    schedulePendingTurnCompletion: params.schedulePendingTurnCompletion,
    surfacePrimarySessionRuntimeIssue: params.surfacePrimarySessionRuntimeIssue,
    publishUsageStatsBestEffort: params.publishUsageStatsBestEffort,
    happierSessionId: params.happierSessionId,
    activeSessionId: params.activeSessionId,
    currentModelProvider: params.currentModelProvider,
    classifyRuntimeAuthFailure: params.classifyRuntimeAuthFailure,
    reportRuntimeAuthFailureForPendingTurn: params.reportRuntimeAuthFailureForPendingTurn,
    onRuntimeAuthFailure: params.onRuntimeAuthFailure,
  };
}

export function createPiRpcProcessLifecycleContext(params: Readonly<{
  options: Readonly<{
    cwd: string;
    command: string;
    args: string[];
    env: Record<string, string>;
  }>;
  getProcess: () => import('node:child_process').ChildProcessWithoutNullStreams | null;
  setProcess: (process: import('node:child_process').ChildProcessWithoutNullStreams | null) => void;
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
  emitMessage: (message: import('@/agent/core').AgentMessage) => void;
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
  return {
    options: params.options,
    getProcess: params.getProcess,
    setProcess: params.setProcess,
    getStdoutLineReader: params.getStdoutLineReader,
    setStdoutLineReader: params.setStdoutLineReader,
    getStderrLineReader: params.getStderrLineReader,
    setStderrLineReader: params.setStderrLineReader,
    getSessionId: params.getSessionId,
    setSessionId: params.setSessionId,
    getSessionFile: params.getSessionFile,
    setSessionFile: params.setSessionFile,
    isDisposed: params.isDisposed,
    hasPendingTurn: params.hasPendingTurn,
    hasPendingTurnCompletionScheduled: params.hasPendingTurnCompletionScheduled,
    hasPendingCompactionResumeScheduled: params.hasPendingCompactionResumeScheduled,
    getLastAuthJsonMtimeMs: params.getLastAuthJsonMtimeMs,
    setLastAuthJsonMtimeMs: params.setLastAuthJsonMtimeMs,
    getAuthRestartPendingMtimeMs: params.getAuthRestartPendingMtimeMs,
    setAuthRestartPendingMtimeMs: params.setAuthRestartPendingMtimeMs,
    getAuthRestartInFlight: params.getAuthRestartInFlight,
    setAuthRestartInFlight: params.setAuthRestartInFlight,
    emitMessage: params.emitMessage,
    rejectAllPending: params.rejectAllPending,
    rejectPendingTurn: params.rejectPendingTurn,
    resolvePendingTurn: params.resolvePendingTurn,
    resolvePendingTurnAsCompactionPaused: params.resolvePendingTurnAsCompactionPaused,
    surfacePrimarySessionRuntimeIssue: params.surfacePrimarySessionRuntimeIssue,
    handleStdoutLine: params.handleStdoutLine,
    handleStderrLine: params.handleStderrLine,
    getState: params.getState,
    publishRuntimeState: params.publishRuntimeState,
  };
}
