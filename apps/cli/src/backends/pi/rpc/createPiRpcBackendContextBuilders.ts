import type { AgentMessage, SessionId } from '@/agent/core';
import type { SurfacePrimarySessionRuntimeIssueInput } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';

import type { PendingRpcRequest } from './rpcSupport';
import type {
  PiRpcCommandWithoutId,
  PiRpcResponse,
  PiRpcStateData,
} from './types';
import type { PiRpcPromptBarrier } from './responseFlow';
import type { PiRpcRuntimeTurnState } from './eventHandlers';
import {
  createPiRpcEventHandlerContextForBackend,
  createPiRpcProcessLifecycleContextForBackend,
  createPiRpcResponseFlowContextForBackend,
  createPiRpcSessionStateContextForBackend,
  rejectAllPiRpcPendingRequests,
} from './backendRuntimeContexts';
import type { PiRpcBackendMutableState } from './createPiRpcBackendMutableState';

export function createPiRpcBackendContextBuilders(params: Readonly<{
  options: Readonly<{
    cwd: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    happierSessionId?: string | null;
  }>;
  state: PiRpcBackendMutableState;
  isDisposed: () => boolean;
  hasPendingTurn: () => boolean;
  hasPendingTurnCompletionScheduled: () => boolean;
  hasPendingCompactionResumeScheduled: () => boolean;
  emitMessage: (message: AgentMessage) => void;
  ensureProcess: () => Promise<void>;
  stopRpcProcessForRestart: () => Promise<void>;
  spawnRpcProcess: (params: Readonly<{ args: string[] }>) => void;
  captureAuthJsonSnapshot: () => Promise<void>;
  getState: () => Promise<PiRpcStateData>;
  publishRuntimeState: (state: PiRpcStateData) => Promise<void>;
  assertSession: (sessionId: SessionId) => void;
  beginPromptBarrier: () => PiRpcPromptBarrier;
  createPendingTurn: (timeoutMs: number) => Promise<void>;
  getPendingTurnStallTimeoutMs: () => number;
  waitForPromptCollisionToBecomeIdle: () => Promise<void>;
  rejectPendingTurn: (error: Error) => void;
  resolvePendingTurn: () => void;
  resolvePendingTurnAsCompactionPaused: () => void;
  hasProcess: () => boolean;
  notePendingTurnActivity: (event: Record<string, unknown>) => void;
  normalizeEvent?: (event: Record<string, unknown>) => Record<string, unknown>;
  keepPendingTurnAliveAfterRetryingAgentEnd: () => boolean;
  keepPendingTurnAliveAfterRecoverableAssistantError: () => boolean;
  schedulePendingTurnCompletion: () => boolean;
  maybeRestartForUpdatedAuthJson: () => Promise<void> | void;
  restartAndContinue: () => Promise<void>;
  sendCommand: (
    command: PiRpcCommandWithoutId,
    timeoutMs?: number,
  ) => Promise<PiRpcResponse>;
  resolveModelSelection: (
    modelIdRaw: string,
  ) => Promise<{ provider: string; modelId: string }>;
  rememberCurrentModelProvider: (provider: string) => void;
  pendingRequests: Map<string, PendingRpcRequest>;
  messageHandlers: ReadonlySet<(message: AgentMessage) => void>;
  openPromptRequestIds: Set<string>;
  runtimeTurnState: PiRpcRuntimeTurnState;
  publishUsageStatsBestEffort: () => Promise<void>;
  surfacePrimarySessionRuntimeIssue?: (input: SurfacePrimarySessionRuntimeIssueInput) => void | Promise<void>;
  getCurrentModelProvider: () => string | null;
  classifyRuntimeAuthFailure?: (error: unknown) => ConnectedServiceRuntimeFailureClassification | null;
  reportRuntimeAuthFailureForPendingTurn?: (classification: ConnectedServiceRuntimeFailureClassification) => boolean;
  onRuntimeAuthFailure?: (input: Readonly<{
    happierSessionId: string | null;
    activeSessionId: string | null;
    classification: ConnectedServiceRuntimeFailureClassification;
  }>) => void | Promise<void>;
  handleStdoutLine: (line: string) => void;
  handleStderrLine: (line: string) => void;
}>): Readonly<{
  createSessionStateContext: (createSession: () => Promise<void>) => ReturnType<
    typeof createPiRpcSessionStateContextForBackend
  >;
  createResponseFlowContext: () => ReturnType<
    typeof createPiRpcResponseFlowContextForBackend
  >;
  createEventHandlerContext: () => ReturnType<
    typeof createPiRpcEventHandlerContextForBackend
  >;
  createProcessLifecycleContext: () => ReturnType<
    typeof createPiRpcProcessLifecycleContextForBackend
  >;
}> {
  return {
    createSessionStateContext: (createSession) =>
      createPiRpcSessionStateContextForBackend({
        options: params.options,
        isDisposed: params.isDisposed,
        getSessionId: params.state.getSessionId,
        setSessionId: params.state.setSessionId,
        getSessionFile: params.state.getSessionFile,
        setSessionFile: params.state.setSessionFile,
        hasPendingTurn: params.hasPendingTurn,
        emitStartingStatus: () => {
          params.emitMessage({ type: 'status', status: 'starting' });
        },
        emitIdleStatus: () => {
          params.emitMessage({ type: 'status', status: 'idle' });
        },
        ensureProcess: params.ensureProcess,
        stopRpcProcessForRestart: params.stopRpcProcessForRestart,
        spawnRpcProcess: params.spawnRpcProcess,
        captureAuthJsonSnapshot: params.captureAuthJsonSnapshot,
        createSession,
        getState: params.getState,
        publishRuntimeState: params.publishRuntimeState,
      }),
    createResponseFlowContext: () =>
      createPiRpcResponseFlowContextForBackend({
        getSessionId: params.state.getSessionId,
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
        emitIdleStatus: () => {
          params.emitMessage({ type: 'status', status: 'idle' });
        },
      }),
    createEventHandlerContext: () =>
      createPiRpcEventHandlerContextForBackend({
        disposed: params.isDisposed(),
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
        happierSessionId: params.options.happierSessionId,
        activeSessionId: params.state.getSessionId(),
        currentModelProvider: params.getCurrentModelProvider(),
        classifyRuntimeAuthFailure: params.classifyRuntimeAuthFailure,
        reportRuntimeAuthFailureForPendingTurn: params.reportRuntimeAuthFailureForPendingTurn,
        onRuntimeAuthFailure: params.onRuntimeAuthFailure,
      }),
    createProcessLifecycleContext: () =>
      createPiRpcProcessLifecycleContextForBackend({
        options: params.options,
        getProcess: params.state.getProcess,
        setProcess: params.state.setProcess,
        getStdoutLineReader: params.state.getStdoutLineReader,
        setStdoutLineReader: params.state.setStdoutLineReader,
        getStderrLineReader: params.state.getStderrLineReader,
        setStderrLineReader: params.state.setStderrLineReader,
        getSessionId: params.state.getSessionId,
        setSessionId: params.state.setSessionId,
        getSessionFile: params.state.getSessionFile,
        setSessionFile: params.state.setSessionFile,
        isDisposed: params.isDisposed,
        hasPendingTurn: params.hasPendingTurn,
        hasPendingTurnCompletionScheduled: params.hasPendingTurnCompletionScheduled,
        hasPendingCompactionResumeScheduled: params.hasPendingCompactionResumeScheduled,
        getLastAuthJsonMtimeMs: params.state.getLastAuthJsonMtimeMs,
        setLastAuthJsonMtimeMs: params.state.setLastAuthJsonMtimeMs,
        getAuthRestartPendingMtimeMs: params.state.getAuthRestartPendingMtimeMs,
        setAuthRestartPendingMtimeMs: params.state.setAuthRestartPendingMtimeMs,
        getAuthRestartInFlight: params.state.getAuthRestartInFlight,
        setAuthRestartInFlight: params.state.setAuthRestartInFlight,
        emitMessage: params.emitMessage,
        rejectAllPending: (error) => {
          rejectAllPiRpcPendingRequests(params.pendingRequests, error);
        },
        rejectPendingTurn: params.rejectPendingTurn,
        resolvePendingTurn: params.resolvePendingTurn,
        resolvePendingTurnAsCompactionPaused: params.resolvePendingTurnAsCompactionPaused,
        surfacePrimarySessionRuntimeIssue: params.surfacePrimarySessionRuntimeIssue,
        handleStdoutLine: params.handleStdoutLine,
        handleStderrLine: params.handleStderrLine,
        getState: params.getState,
        publishRuntimeState: params.publishRuntimeState,
      }),
  };
}
