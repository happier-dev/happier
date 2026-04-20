import type { AgentMessage, AgentMessageHandler, SessionId, StartSessionResult } from '@/agent/core/AgentBackend';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { SDKMessage, SDKResultMessage } from '@/backends/claude/sdk/types';
import { buildTokenCountAgentMessageFromUsageObservation } from '@/usage/usageObservation';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { buildClaudeSdkResultUsageObservation } from '../usage/buildClaudeSdkResultUsageObservation';
import { createClaudeSdkRuntimeController } from './createClaudeSdkRuntimeController';
import { resolveClaudeSdkPendingPermissionRequests, respondToClaudeSdkPermissionRequest } from './permissionPolicy';
import { createClaudeSdkLifecycleState, createClaudeSdkRuntimeState } from './runtimeState';
import { noteClaudeSdkVendorSessionId, waitForClaudeSdkVendorSessionId } from './sessionIdentity';
import type { ClaudeSdkAgentBackendOptions } from './types';

export type { ClaudeSdkPermissionPolicy } from './types';

export class ClaudeSdkAgentBackend implements ExecutionRunHostRuntime {
  private readonly listeners: AgentMessageHandler[] = [];
  private readonly promptStream = new PushableAsyncIterable<SDKMessage>();
  private readonly abortController = new AbortController();
  private readonly lifecycle = createClaudeSdkLifecycleState();
  private readonly runtime = createClaudeSdkRuntimeState();
  private readonly env: NodeJS.ProcessEnv;
  private readonly runtimeController: ReturnType<typeof createClaudeSdkRuntimeController>;

  constructor(private readonly opts: ClaudeSdkAgentBackendOptions) {
    this.env = this.opts.env ?? {};
    this.runtimeController = createClaudeSdkRuntimeController({
      abortController: this.abortController,
      emit: (message) => this.emit(message),
      emitTokenCountTelemetry: (result) => this.emitTokenCountTelemetry(result),
      env: this.env,
      lifecycle: this.lifecycle,
      noteVendorSessionId: (sessionIdRaw) => this.noteVendorSessionId(sessionIdRaw),
      opts: this.opts,
      promptStream: this.promptStream,
      resolvePendingPermissionRequests: (params) => this.resolvePendingPermissionRequests(params),
      runtime: this.runtime,
    });
  }

  onMessage(handler: AgentMessageHandler): void {
    this.listeners.push(handler);
  }

  subscribeMessages(handler: AgentMessageHandler): () => void {
    this.onMessage(handler);
    return () => { this.offMessage?.(handler); };
  }

  offMessage(handler: AgentMessageHandler): void {
    const index = this.listeners.indexOf(handler);
    if (index >= 0) this.listeners.splice(index, 1);
  }

  private emit(msg: AgentMessage): void {
    if (this.lifecycle.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch {
        // ignore listener errors
      }
    }
  }

  async startSession(): Promise<StartSessionResult> {
    if (this.lifecycle.started) return { sessionId: this.lifecycle.localSessionId };
    await this.startSessionInternal({ resume: null });
    return { sessionId: this.lifecycle.localSessionId };
  }

  async readResumeSupport(opts?: Readonly<{ captureReplay?: boolean }>): Promise<boolean> { return opts?.captureReplay === true ? false : true; }

  async provisionSession(opts?: Readonly<{
    initialPrompt?: string;
    resumeSessionId?: string;
    captureReplay?: boolean;
  }>): Promise<StartSessionResult> {
    if (opts?.captureReplay === true) {
      throw new Error('Claude SDK execution runs do not support replay capture');
    }
    const resumeSessionId = typeof opts?.resumeSessionId === 'string' ? opts.resumeSessionId.trim() : '';
    if (resumeSessionId) {
      return await this.loadSession(resumeSessionId);
    }
    const started = await this.startSession();
    const initialPrompt = typeof opts?.initialPrompt === 'string' ? opts.initialPrompt : '';
    if (initialPrompt.trim().length > 0) {
      await this.sendPrompt(started.sessionId, initialPrompt);
    }
    return started;
  }

  async loadSession(sessionId: SessionId): Promise<StartSessionResult> {
    if (this.lifecycle.started) {
      throw new Error('Session already started');
    }

    const resume = String(sessionId ?? '').trim();
    if (!resume) {
      throw new Error('Missing sessionId');
    }

    this.lifecycle.acceptedSessionIds.add(resume);

    await this.startSessionInternal({ resume });

    const resolved = await waitForClaudeSdkVendorSessionId({
      lifecycle: this.lifecycle,
      timeoutMs: 2_000,
    });
    return { sessionId: resolved ?? (resume as SessionId) };
  }

  private async startSessionInternal(params: Readonly<{ resume: string | null }>): Promise<void> {
    await this.runtimeController.startSession(params);
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    if (!this.lifecycle.acceptedSessionIds.has(sessionId)) {
      throw new Error(`Unknown sessionId: ${sessionId}`);
    }
    if (this.lifecycle.disposed) throw new Error('Backend disposed');
    if (this.lifecycle.fatalError) throw this.lifecycle.fatalError;
    if (!this.lifecycle.started) {
      await this.startSession();
    }

    await this.runtimeController.sendPrompt(prompt);
  }

  async sendSteerPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    if (!this.lifecycle.acceptedSessionIds.has(sessionId)) {
      throw new Error(`Unknown sessionId: ${sessionId}`);
    }
    if (this.lifecycle.disposed) throw new Error('Backend disposed');
    if (this.lifecycle.fatalError) throw this.lifecycle.fatalError;
    if (!this.lifecycle.started) {
      await this.startSession();
    }

    await this.runtimeController.sendSteerPrompt(prompt);
  }

  async cancel(sessionId: SessionId): Promise<void> {
    if (!this.lifecycle.acceptedSessionIds.has(sessionId)) {
      throw new Error(`Unknown sessionId: ${sessionId}`);
    }
    if (this.lifecycle.disposed) return;

    this.runtimeController.cancel();
  }

  async waitForResponseComplete(timeoutMs?: number): Promise<void> {
    await this.runtimeController.waitForResponseComplete(timeoutMs);
  }

  async waitForTurnCompletion(timeoutMs?: number | null): Promise<void> { await this.waitForResponseComplete(timeoutMs ?? undefined); }

  async dispose(): Promise<void> {
    await this.runtimeController.dispose();
  }

  async respondToPermission(requestId: string, approved: boolean): Promise<void> {
    respondToClaudeSdkPermissionRequest({
      approved,
      emit: (message) => this.emit(message),
      pendingPermissionRequests: this.runtime.pendingPermissionRequests,
      requestId,
    });
  }

  private resolvePendingPermissionRequests(params: Readonly<{
    approved: boolean;
    reason: string;
    emitResponses: boolean;
  }>): void {
    resolveClaudeSdkPendingPermissionRequests({
      ...params,
      emit: (message) => this.emit(message),
      pendingPermissionRequests: this.runtime.pendingPermissionRequests,
    });
  }

  private emitTokenCountTelemetry(result: SDKResultMessage): void {
    const observation = buildClaudeSdkResultUsageObservation({
      modelId: this.opts.modelId,
      result,
    });
    const telemetry = observation ? buildTokenCountAgentMessageFromUsageObservation(observation) : null;
    if (telemetry) {
      this.emit(telemetry as any);
    }
  }

  private noteVendorSessionId(sessionIdRaw: unknown): void {
    noteClaudeSdkVendorSessionId({
      emit: (message) => this.emit(message),
      lifecycle: this.lifecycle,
      sessionIdRaw,
    });
  }
}
