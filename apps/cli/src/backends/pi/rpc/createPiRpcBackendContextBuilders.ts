import type { AgentMessage, SessionId } from '@/agent/core';
import type { SurfacePrimarySessionRuntimeIssueInput } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';

import type { PendingRpcRequest } from './rpcSupport';
import type {
  PiRpcCommandWithoutId,
  PiRpcResponse,
  PiRpcStateData,
} from './types';
import type { PiRpcPromptBarrier } from './responseFlow';
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
  }>;
  state: PiRpcBackendMutableState;
  isDisposed: () => boolean;
  hasPendingTurn: () => boolean;
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
  rejectPendingTurn: (error: Error) => void;
  resolvePendingTurn: () => void;
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
  publishUsageStatsBestEffort: () => Promise<void>;
  surfacePrimarySessionRuntimeIssue?: (input: SurfacePrimarySessionRuntimeIssueInput) => void | Promise<void>;
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
        rejectPendingTurn: params.rejectPendingTurn,
        resolvePendingTurn: params.resolvePendingTurn,
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
        resolvePendingTurn: params.resolvePendingTurn,
        rejectPendingTurn: params.rejectPendingTurn,
        surfacePrimarySessionRuntimeIssue: params.surfacePrimarySessionRuntimeIssue,
        publishUsageStatsBestEffort: params.publishUsageStatsBestEffort,
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
        surfacePrimarySessionRuntimeIssue: params.surfacePrimarySessionRuntimeIssue,
        handleStdoutLine: params.handleStdoutLine,
        handleStderrLine: params.handleStderrLine,
        getState: params.getState,
        publishRuntimeState: params.publishRuntimeState,
      }),
  };
}
