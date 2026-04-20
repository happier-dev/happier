import type {
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
} from '@/agent/core';
import type {
  ExecutionRunHostRuntime,
  ExecutionRunHostRuntimeMessageHandler,
  ExecutionRunSessionProvisionOptions,
  ExecutionRunSessionProvisionResult,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { AcpRuntimeBackend } from '@/agent/acp/runtime/acpRuntimeBackendContract';
import {
  asRecord,
  type PendingRpcRequest,
} from './rpcSupport';
import {
  emitPiRpcMessage,
  handlePiRpcStderrLine,
  handlePiRpcStdoutLine,
  type PiRpcEventHandlerContext,
} from './eventHandlers';
import {
  capturePiRpcAuthJsonSnapshot,
  ensurePiRpcProcess,
  maybeRestartPiRpcProcessForUpdatedAuthJson,
  restartPiRpcProcessAndContinue,
  spawnPiRpcProcess,
  stopPiRpcProcessForRestart,
  type PiRpcProcessLifecycleContext,
} from './processLifecycle';
import type { PiRpcCommandWithoutId, PiRpcResponse, PiRpcStateData } from './types';
import { PiPendingTurnState } from './piPendingTurnState';
import { PiRuntimeStateTracker } from './piRuntimeStateTracker';
import {
  cancelPiRpcTurn,
  sendPiRpcPrompt,
  sendPiRpcSteerPrompt,
  setPiRpcSessionConfigOption,
  setPiRpcSessionModel,
  type PiRpcResponseFlowContext,
} from './responseFlow';
import { sendPiRpcCommand } from './sendPiRpcCommand';
import { assertPiRpcSession, loadPiRpcSession, startPiRpcSession } from './sessionState';
import { createPiRpcStateOperations } from './backendStateOperations';
import { createPiRpcBackendContextBuilders } from './createPiRpcBackendContextBuilders';
import { createPiRpcBackendMutableState } from './createPiRpcBackendMutableState';

export type PiRpcSpawnOptions = {
  cwd: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
};

// Intentional provider-local dual-role leaf: Pi RPC is the native runtime surface
// for both direct backend usage and execution-run hosting, so no second adapter
// owns session/process state for this provider.
export class PiRpcBackend implements AcpRuntimeBackend, ExecutionRunHostRuntime {
  readonly options: Readonly<{
    cwd: string;
    command: string;
    args: string[];
    env: Record<string, string>;
  }>;

  private readonly messageHandlers = new Set<AgentMessageHandler>();
  private readonly pendingRequests = new Map<string, PendingRpcRequest>();
  private readonly openPromptRequestIds = new Set<string>();
  private readonly turnState = new PiPendingTurnState({
    resetOpenPromptRequestIds: () => {
      this.openPromptRequestIds.clear();
    },
  });
  private readonly createPendingTurn = (timeoutMs: number): Promise<void> => {
    return this.turnState.createPendingTurn(timeoutMs);
  };
  private readonly runtimeState = new PiRuntimeStateTracker();
  private readonly mutableState = createPiRpcBackendMutableState();
  private readonly stateOperations = createPiRpcStateOperations({
    sendCommand: async (command, timeoutMs) => await this.sendCommand(command, timeoutMs),
    runtimeState: this.runtimeState,
    emitMessage: (message) => {
      this.emitMessage(message);
    },
    isDisposed: () => this.disposed,
    hasProcess: () => Boolean(this.mutableState.getProcess()),
  });
  private disposed = false;
  private readonly contextBuilders: ReturnType<
    typeof createPiRpcBackendContextBuilders
  >;

  constructor(options: PiRpcSpawnOptions) {
    this.options = {
      cwd: options.cwd,
      command: options.command,
      args: [...options.args],
      env: { ...(options.env ?? {}) },
    };
    this.contextBuilders = createPiRpcBackendContextBuilders({
      options: this.options,
      state: this.mutableState,
      isDisposed: () => this.disposed,
      hasPendingTurn: () => this.turnState.hasPendingTurn(),
      emitMessage: (message) => {
        this.emitMessage(message);
      },
      ensureProcess: async () => {
        await this.ensureProcess();
      },
      stopRpcProcessForRestart: async () => {
        await this.stopRpcProcessForRestart();
      },
      spawnRpcProcess: (params) => {
        this.spawnRpcProcess(params);
      },
      captureAuthJsonSnapshot: async () => {
        await this.captureAuthJsonSnapshot();
      },
      getState: async () => await this.stateOperations.getState(),
      publishRuntimeState: async (state) => {
        await this.publishRuntimeState(state);
      },
      assertSession: (sessionId) => {
        this.assertSession(sessionId);
      },
      beginPromptBarrier: () => this.turnState.beginPromptBarrier(),
      createPendingTurn: (timeoutMs) => this.createPendingTurn(timeoutMs),
      rejectPendingTurn: (error) => {
        this.turnState.rejectPendingTurn(error);
      },
      resolvePendingTurn: () => {
        this.turnState.resolvePendingTurn();
      },
      maybeRestartForUpdatedAuthJson: () => this.maybeRestartForUpdatedAuthJson(),
      restartAndContinue: async () => {
        await this.restartAndContinue();
      },
      sendCommand: async (command, timeoutMs) =>
        await this.sendCommand(command, timeoutMs),
      resolveModelSelection: async (modelIdRaw) =>
        await this.resolveModelSelection(modelIdRaw),
      rememberCurrentModelProvider: (provider) => {
        this.runtimeState.rememberCurrentModelProvider(provider);
      },
      pendingRequests: this.pendingRequests,
      messageHandlers: this.messageHandlers,
      openPromptRequestIds: this.openPromptRequestIds,
      publishUsageStatsBestEffort: async () => {
        await this.publishUsageStatsBestEffort();
      },
      handleStdoutLine: (line) => {
        this.handleStdoutLine(line);
      },
      handleStderrLine: (line) => {
        this.handleStderrLine(line);
      },
    });
  }

  onMessage(handler: AgentMessageHandler): void {
    this.messageHandlers.add(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.messageHandlers.delete(handler);
  }

  async readResumeSupport(opts?: Readonly<{ captureReplay?: boolean }>): Promise<boolean> {
    return opts?.captureReplay === true ? false : typeof this.loadSession === 'function';
  }

  async provisionSession(
    opts?: ExecutionRunSessionProvisionOptions,
  ): Promise<ExecutionRunSessionProvisionResult> {
    if (opts?.resumeSessionId) {
      const loaded = await this.loadSession(opts.resumeSessionId);
      return { sessionId: loaded.sessionId };
    }

    const started = await this.startSession();
    return { sessionId: started.sessionId };
  }

  subscribeMessages(handler: ExecutionRunHostRuntimeMessageHandler): () => void {
    this.onMessage(handler);
    return () => {
      this.offMessage(handler);
    };
  }

  async startSession(): Promise<StartSessionResult> {
    return await startPiRpcSession(this.createSessionStateContext(async () => {
        const created = await this.sendCommand({ type: 'new_session' }, 60_000);
        if ((asRecord(created.data)?.cancelled ?? false) === true) {
          throw new Error('Pi cancelled new_session');
        }
      }),
    );
  }

  async loadSession(sessionId: SessionId): Promise<StartSessionResult> {
    return await loadPiRpcSession(this.createSessionStateContext(async () => {}), sessionId);
  }

  /**
   * Exposed for best-effort model probing (see `capabilities/probes/agentModelsProbe.ts`).
   * This mirrors the ACP `getSessionModelState` shape.
   */
  getSessionModelState(): { currentModelId: string; availableModels: Array<{ id: string; name: string; description?: string }> } | null {
    return this.runtimeState.getSessionModelState();
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    await sendPiRpcPrompt(this.createResponseFlowContext(), sessionId, prompt);
  }

  async sendSteerPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    await sendPiRpcSteerPrompt(this.createResponseFlowContext(), sessionId, prompt);
  }

  async setSessionModel(sessionId: SessionId, modelId: string): Promise<void> {
    await setPiRpcSessionModel(this.createResponseFlowContext(), sessionId, modelId);
  }

  async setSessionConfigOption(sessionId: SessionId, configId: string, value: string | number | boolean | null): Promise<void> {
    await setPiRpcSessionConfigOption(this.createResponseFlowContext(), sessionId, configId, value);
  }

  async cancel(sessionId: SessionId): Promise<void> {
    await cancelPiRpcTurn(this.createResponseFlowContext(), sessionId);
  }

  async waitForResponseComplete(timeoutMs?: number | null): Promise<void> {
    await this.turnState.waitForResponseComplete(timeoutMs);
  }

  async waitForTurnCompletion(timeoutMs?: number | null): Promise<void> {
    await this.waitForResponseComplete(timeoutMs);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    this.createProcessLifecycleContext().rejectAllPending(
      new Error('Pi backend disposed'),
    );
    this.turnState.rejectPendingTurn(new Error('Pi backend disposed'));
    this.turnState.rejectBarrier(new Error('Pi backend disposed'));
    await this.stopRpcProcessForRestart();
  }

  private async ensureProcess(): Promise<void> {
    await ensurePiRpcProcess(this.createProcessLifecycleContext());
  }

  private spawnRpcProcess(params: Readonly<{ args: string[] }>): void {
    spawnPiRpcProcess(this.createProcessLifecycleContext(), params);
  }

  private async captureAuthJsonSnapshot(): Promise<void> {
    await capturePiRpcAuthJsonSnapshot(this.createProcessLifecycleContext());
  }

  private maybeRestartForUpdatedAuthJson(): Promise<void> | void {
    return maybeRestartPiRpcProcessForUpdatedAuthJson(this.createProcessLifecycleContext());
  }

  private async restartAndContinue(): Promise<void> {
    await restartPiRpcProcessAndContinue(this.createProcessLifecycleContext());
  }

  private async stopRpcProcessForRestart(): Promise<void> {
    await stopPiRpcProcessForRestart(this.createProcessLifecycleContext());
  }

  private handleStdoutLine(line: string): void {
    handlePiRpcStdoutLine(this.createEventHandlerContext(), (message) => this.emitMessage(message), line);
  }

  private async publishUsageStatsBestEffort(): Promise<void> {
    await this.stateOperations.publishUsageStatsBestEffort();
  }

  private handleStderrLine(line: string): void {
    handlePiRpcStderrLine(this.disposed, (message) => this.emitMessage(message), line);
  }

  private emitMessage(message: AgentMessage): void {
    emitPiRpcMessage(this.messageHandlers, message);
  }

  private async sendCommand(
    command: PiRpcCommandWithoutId,
    timeoutMs = 30_000,
  ): Promise<PiRpcResponse> {
    return await sendPiRpcCommand({
      ensureProcess: async () => {
        await this.ensureProcess();
      },
      getProcess: this.mutableState.getProcess,
      pendingRequests: this.pendingRequests,
      openPromptRequestIds: this.openPromptRequestIds,
      command,
      timeoutMs,
    });
  }

  private async publishRuntimeState(state: PiRpcStateData): Promise<void> {
    await this.stateOperations.publishRuntimeState(state);
  }

  private async resolveModelSelection(modelIdRaw: string): Promise<{ provider: string; modelId: string }> {
    return await this.stateOperations.resolveModelSelection(modelIdRaw);
  }

  private assertSession(sessionId: SessionId): void {
    assertPiRpcSession(this.mutableState.getSessionId(), sessionId);
  }

  private createSessionStateContext(createSession: () => Promise<void>) {
    return this.contextBuilders.createSessionStateContext(createSession);
  }

  private createResponseFlowContext(): PiRpcResponseFlowContext {
    return this.contextBuilders.createResponseFlowContext();
  }

  private createEventHandlerContext(): PiRpcEventHandlerContext {
    return this.contextBuilders.createEventHandlerContext();
  }

  private createProcessLifecycleContext(): PiRpcProcessLifecycleContext {
    return this.contextBuilders.createProcessLifecycleContext();
  }

}
