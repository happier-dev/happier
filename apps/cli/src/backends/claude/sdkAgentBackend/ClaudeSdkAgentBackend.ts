import { randomUUID } from 'node:crypto';

import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId, StartSessionResult } from '@/agent/core/AgentBackend';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { query } from '@/backends/claude/sdk/query';
import type { SDKAssistantMessage, SDKMessage, SDKResultMessage, SDKSystemMessage } from '@/backends/claude/sdk/types';
import { createSubprocessStderrAppender, type BoundedTextFileAppender } from '@/agent/runtime/subprocessArtifacts';
import { emitCanonicalTurnDiffTool } from '@/agent/runtime/emitCanonicalTurnDiffTool';
import { ensureClaudeJsRuntimeExecutable } from '@/backends/claude/utils/ensureClaudeJsRuntimeExecutable';
import { ClaudeTurnChangeTracker } from '../utils/ClaudeTurnChangeTracker';
import { isClaudeExplicitDiffToolInput } from '../utils/isClaudeExplicitDiffToolInput';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import {
  createClaudeProviderActivityLedger,
  normalizeClaudeProviderTaskEvent,
} from '@/backends/claude/providerActivity/createClaudeProviderActivityLedger';

export class ClaudeSdkAgentBackend implements AgentBackend {
  private readonly listeners: AgentMessageHandler[] = [];
  private readonly promptStream = new PushableAsyncIterable<SDKMessage>();
  private readonly abortController = new AbortController();
  private readonly env: NodeJS.ProcessEnv;
  private stderrAppender: BoundedTextFileAppender | null = null;
  private readonly toolNameByCallId = new Map<string, string>();
  private readonly suppressedExplicitDiffCallIds = new Set<string>();
  private readonly turnChangeTracker = new ClaudeTurnChangeTracker();
  private readonly providerActivityLedger = createClaudeProviderActivityLedger();
  private query: ReturnType<typeof query> | null = null;
  private activeTaskId: string | null = null;
  private activeTaskSessionId: string | null = null;

  private readonly localSessionId: SessionId = `voice-agent-claude-${randomUUID()}`;
  private readonly acceptedSessionIds = new Set<SessionId>();
  private vendorSessionId: SessionId | null = null;
  private resolveVendorSessionId: ((id: SessionId) => void) | null = null;
  private vendorSessionIdPromise: Promise<SessionId>;
  private started = false;
  private disposed = false;

  private queryIter: AsyncIterableIterator<SDKMessage> | null = null;
  private loopPromise: Promise<void> | null = null;
  private fatalError: Error | null = null;

  private sendChain: Promise<void> = Promise.resolve();
  private pendingTurn: { resolve: () => void; reject: (e: Error) => void; buffer: string[] } | null = null;
  private pendingTurnCompletion: Promise<void> | null = null;
  private ignoreNextNonSuccessResult = false;
  private currentTurnOrdinal = 0;
  private settledTurnOrdinal = 0;

  constructor(
    private readonly opts: Readonly<{
      cwd: string;
      modelId: string;
      permissionHandler: AcpPermissionHandler;
      settingsPath?: string;
      env?: NodeJS.ProcessEnv;
    }>,
  ) {
    this.env = this.opts.env ?? {};
    this.acceptedSessionIds.add(this.localSessionId);
    this.vendorSessionIdPromise = new Promise<SessionId>((resolve) => {
      this.resolveVendorSessionId = resolve;
    });
  }

  onMessage(handler: AgentMessageHandler): void {
    this.listeners.push(handler);
  }

  private emit(msg: AgentMessage): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch {
        // ignore listener errors
      }
    }
  }

  async startSession(): Promise<StartSessionResult> {
    if (this.started) return { sessionId: this.localSessionId };
    await this.startSessionInternal({ resume: null });
    return { sessionId: this.localSessionId };
  }

  async loadSession(sessionId: SessionId): Promise<StartSessionResult> {
    if (this.started) {
      throw new Error('Session already started');
    }

    const resume = String(sessionId ?? '').trim();
    if (!resume) {
      throw new Error('Missing sessionId');
    }

    this.acceptedSessionIds.add(resume);

    await this.startSessionInternal({ resume });

    const resolved = await this.waitForVendorSessionId({ timeoutMs: 2_000 });
    return { sessionId: resolved ?? (resume as SessionId) };
  }

  private async startSessionInternal(params: Readonly<{ resume: string | null }>): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.activeTaskId = null;
    this.activeTaskSessionId = null;

    const model = this.normalizeModelId(this.opts.modelId);
    const canCallTool = this.buildCanCallTool();

    this.emit({ type: 'status', status: 'starting' });
    this.stderrAppender = await createSubprocessStderrAppender({
      agentName: 'claude',
      pid: null,
      label: 'claude-sdk',
    });
    const runtimeExecutable = await ensureClaudeJsRuntimeExecutable();
    const q = query({
      prompt: this.promptStream,
      options: {
        cwd: this.opts.cwd,
        model: model ?? undefined,
        executable: runtimeExecutable,
        canCallTool,
        settingsPath: this.opts.settingsPath,
        env: this.env,
        ...(params.resume ? { resume: params.resume } : {}),
        abort: this.abortController.signal,
        stderr: (data) => {
          this.stderrAppender?.append(data);
        },
      },
    });

    this.query = q;
    this.queryIter = q[Symbol.asyncIterator]();
    this.loopPromise = this.runLoop();
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    if (!this.acceptedSessionIds.has(sessionId)) {
      throw new Error(`Unknown sessionId: ${sessionId}`);
    }
    if (this.disposed) throw new Error('Backend disposed');
    if (this.fatalError) throw this.fatalError;
    if (!this.started) {
      await this.startSession();
    }

    let startedResolve!: () => void;
    let startedReject!: (e: Error) => void;
    const startedPromise = new Promise<void>((resolve, reject) => {
      startedResolve = resolve;
      startedReject = reject;
    });

    // Serialize turns: enqueue the prompt only once the previous turn has settled.
    const run = async () => {
      if (this.disposed) throw new Error('Backend disposed');
      if (this.fatalError) throw this.fatalError;

      try {
        let completionResolve!: () => void;
        let completionReject!: (e: Error) => void;
        const completionPromise = new Promise<void>((resolve, reject) => {
          completionResolve = resolve;
          completionReject = reject;
        });

        this.pendingTurn = { resolve: completionResolve, reject: completionReject, buffer: [] };
        this.pendingTurnCompletion = completionPromise;
        this.currentTurnOrdinal += 1;
        this.turnChangeTracker.beginTurn();

        this.promptStream.push({
          type: 'user',
          message: { role: 'user', content: typeof prompt === 'string' ? prompt : '' },
        });
        startedResolve();

        // Hold the send chain until the turn settles (success/error/cancel) so subsequent sendPrompt calls
        // don't overlap. Do not propagate the rejection into the chain.
        await completionPromise.catch(() => {});
      } catch (e: any) {
        const err = e instanceof Error ? e : new Error('Failed to enqueue prompt');
        startedReject(err);
        throw err;
      }
    };

    this.sendChain = this.sendChain.then(run, run);

    try {
      await startedPromise;
    } catch (e: any) {
      throw e instanceof Error ? e : new Error('Failed to send prompt');
    }
  }

  async sendSteerPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    if (!this.acceptedSessionIds.has(sessionId)) {
      throw new Error(`Unknown sessionId: ${sessionId}`);
    }
    if (this.disposed) throw new Error('Backend disposed');
    if (this.fatalError) throw this.fatalError;
    if (!this.started) {
      await this.startSession();
    }

    // If there's no active turn, treat steer as a normal prompt.
    if (!this.pendingTurn) {
      await this.sendPrompt(sessionId, prompt);
      return;
    }

    this.promptStream.push({
      type: 'user',
      message: { role: 'user', content: prompt },
    });
  }

  async cancel(sessionId: SessionId): Promise<void> {
    if (!this.acceptedSessionIds.has(sessionId)) {
      throw new Error(`Unknown sessionId: ${sessionId}`);
    }
    if (this.disposed) return;

    // Only ignore a non-success result when we're actually cancelling an in-flight turn.
    // Otherwise we'd swallow legitimate error results from future turns.
    const hadPendingTurn = Boolean(this.pendingTurn);
    if (hadPendingTurn) {
      this.ignoreNextNonSuccessResult = true;
      const pending = this.pendingTurn;
      this.pendingTurn = null;
      this.pendingTurnCompletion = null;
      this.settledTurnOrdinal = this.currentTurnOrdinal;
      this.turnChangeTracker.resetTurn();
      pending?.reject(new Error('Turn cancelled'));
    }

    // Best-effort: interrupt the current execution in the Claude Code subprocess.
    try {
      const stopTask = (this.query as any)?.stopTask;
      const taskId = this.activeTaskId;
      if (typeof stopTask === 'function' && typeof taskId === 'string' && taskId.trim().length > 0) {
        void stopTask.call(this.query, taskId).catch(() => {});
        return;
      }

      void this.query?.interrupt().catch(() => {});
    } catch {
      // Best-effort: interrupt is optional and should not crash cancellation.
    }
  }

  async waitForResponseComplete(timeoutMs?: number | null): Promise<void> {
    if (this.disposed) throw new Error('Backend disposed');
    const completion = this.pendingTurnCompletion;
    if (!completion) {
      if (this.fatalError) throw this.fatalError;
      return;
    }

    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 1) {
      await completion;
      return;
    }

    const ms = Math.floor(timeoutMs);
    await Promise.race([
      completion,
      new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      }),
    ]);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const pending = this.pendingTurn;
    if (pending) {
      this.pendingTurn = null;
      this.pendingTurnCompletion = null;
      this.suppressedExplicitDiffCallIds.clear();
      this.settledTurnOrdinal = this.currentTurnOrdinal;
      pending.reject(new Error('Agent disposed'));
    }
    try {
      this.promptStream.end();
    } catch {}
    try {
      this.abortController.abort();
    } catch {}
    try {
      await this.loopPromise;
    } catch {}
    try {
      await this.stderrAppender?.close();
    } catch {}
    this.stderrAppender = null;
    this.query = null;
    this.emit({ type: 'status', status: 'stopped' });
  }

  private normalizeModelId(modelIdRaw: string): string | null {
    const trimmed = String(modelIdRaw ?? '').trim();
    if (!trimmed || trimmed === 'default') return null;
    return trimmed;
  }

  private buildCanCallTool() {
    return async (toolName: string, input: unknown) => {
      const result = await this.opts.permissionHandler.handleToolCall(
        'claude-sdk-execution-run',
        toolName,
        input,
      );
      if (result.decision === 'denied' || result.decision === 'abort') {
        return { behavior: 'deny', message: `Tool denied by execution-run policy: ${toolName}`, interrupt: true } as const;
      }
      const updatedInput = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      return { behavior: 'allow', updatedInput } as const;
    };
  }

  private async runLoop(): Promise<void> {
    if (!this.queryIter) return;
    try {
      for await (const msg of this.queryIter) {
        if (this.disposed) return;
        this.handleSdkMessage(msg);
      }
    } catch (error) {
      const fatal = error instanceof Error ? error : new Error(String(error));
      this.fatalError = fatal;

      const pending = this.pendingTurn;
      if (pending) {
        this.pendingTurn = null;
        this.pendingTurnCompletion = null;
        this.turnChangeTracker.resetTurn();
        this.suppressedExplicitDiffCallIds.clear();
        pending.reject(fatal);
      }

      if (!this.disposed) {
        this.emit({ type: 'status', status: 'error', detail: fatal.message });
      }
    }
  }

  private emitIdleIfProviderBackgroundWorkComplete(): void {
    if (this.pendingTurn || this.providerActivityLedger.hasActiveProviderTasks()) return;
    // The execution/cancellation target is deliberately broader than Activity membership:
    // typed task starts remain actionable even when they do not prove background work.
    if (this.activeTaskId) return;
    this.emit({ type: 'status', status: 'idle' });
  }

  private completeSuccessfulTurn(params: Readonly<{ settledTurnOrdinal: number | null }>): void {
    const turnChangeSet = this.turnChangeTracker.completeTurn({
      sessionId: this.vendorSessionId ?? this.localSessionId,
      status: 'completed',
    });
    if (turnChangeSet) {
      emitCanonicalTurnDiffTool({
        turnChangeSet,
        protocol: 'claude',
        rawToolName: 'ClaudeTurnDiff',
        sendToolCall: ({ toolName, input, callId }) => {
          const resolvedCallId = callId ?? randomUUID();
          const args = input && typeof input === 'object' && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {};
          this.emit({ type: 'tool-call', toolName, callId: resolvedCallId, args });
          return resolvedCallId;
        },
        sendToolResult: ({ callId, output }) => {
          this.emit({ type: 'tool-result', toolName: 'Diff', callId, result: output });
        },
      });
    }

    this.toolNameByCallId.clear();
    this.suppressedExplicitDiffCallIds.clear();
    const pending = this.pendingTurn;
    if (pending) {
      this.pendingTurn = null;
      this.pendingTurnCompletion = null;
      pending.resolve();
    }
    if (params.settledTurnOrdinal !== null) {
      this.settledTurnOrdinal = params.settledTurnOrdinal;
    }
    this.emitIdleIfProviderBackgroundWorkComplete();
  }

  private handleSdkMessage(msg: SDKMessage): void {
    if (!msg || typeof msg !== 'object') return;
    const type = msg.type;
    const taskFacts = normalizeClaudeProviderTaskEvent(msg);
    const taskActivity = taskFacts.activity;
    if (taskActivity) this.providerActivityLedger.apply(taskActivity);
    // The cancellation target is deliberately BROADER than Activity membership - a typed task that
    // names no session stays actionable - but broader is not unowned. A row that names ANOTHER
    // session is the one case we can prove is not ours, read from the same owner the admission gate
    // uses (PLAN 4.9.1 step 2). Adopting it would point `stopTask` at someone else's work and, on
    // its own, keep this runtime out of `idle` for as long as that foreign task lives.
    const isForeignTaskRow = (
      taskActivity !== null
      && !this.providerActivityLedger.isOwnedSessionId(taskActivity.sessionId)
    );
    // A foreign row simply has no target from this runtime's point of view. Everything else about
    // the message is unchanged: it still flows through the rest of this handler exactly as before.
    const interruptTarget = isForeignTaskRow ? null : taskFacts.interruptTarget;
    if (interruptTarget?.type === 'active') {
      const startsNewTarget = (
        type === 'user'
        || (type === 'system' && (msg as SDKSystemMessage).subtype === 'task_started')
      );
      if (startsNewTarget || !this.activeTaskId) {
        this.activeTaskId = interruptTarget.taskId;
        this.activeTaskSessionId = taskActivity?.sessionId ?? null;
      }
    } else if (
      interruptTarget?.type === 'terminal'
      && interruptTarget.taskId === this.activeTaskId
      && taskActivity?.type === 'terminal'
      && (
        this.activeTaskSessionId === null
        || taskActivity.sessionId === this.activeTaskSessionId
      )
    ) {
      const terminalTaskId = interruptTarget.taskId;
      const activeBlockers = this.providerActivityLedger
        .getActiveProviderTaskBlockers()
        .filter((blocker) => blocker.taskId !== terminalTaskId);
      const fallbackBlocker = activeBlockers.at(-1) ?? null;
      this.activeTaskId = fallbackBlocker?.taskId ?? null;
      this.activeTaskSessionId = fallbackBlocker?.sessionId ?? null;
    }

    if (type === 'system') {
      const system = msg as SDKSystemMessage;
      this.emitIdleIfProviderBackgroundWorkComplete();

      if (system.subtype === 'init') {
        const previousVendorSessionId = this.vendorSessionId;
        this.noteVendorSessionId(system.session_id);
        this.activeTaskId = null;
        this.activeTaskSessionId = null;
        this.emit({ type: 'status', status: 'running' });
        const pending = this.pendingTurn;
        const isSessionBoundary = Boolean(
          pending &&
          previousVendorSessionId &&
          typeof system.session_id === 'string' &&
          system.session_id.trim().length > 0 &&
          previousVendorSessionId !== system.session_id.trim(),
        );
        if (isSessionBoundary && pending) {
          this.completeSuccessfulTurn({ settledTurnOrdinal: this.currentTurnOrdinal });
        }
      }
      return;
    }

    if (type === 'user') {
      // Tool results are emitted as user-content blocks in the Claude SDK stream.
      const user = msg as any;
      const content = user?.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          if ((block as any).type !== 'tool_result') continue;
          const callId = typeof (block as any).tool_use_id === 'string' ? String((block as any).tool_use_id) : '';
          if (!callId) continue;
          this.turnChangeTracker.observeToolResult({
            callId,
            isError: (block as any).is_error === true,
          });
          if (this.suppressedExplicitDiffCallIds.has(callId)) {
            continue;
          }
          const toolName = this.toolNameByCallId.get(callId) ?? 'unknown';
          this.emit({
            type: 'tool-result',
            toolName,
            callId,
            result: (block as any).content,
          });
        }
      }
      return;
    }

    if (type === 'assistant') {
      const assistant = msg as SDKAssistantMessage;
      // Tool calls are emitted as assistant-content blocks in the Claude SDK stream.
      const assistantContent = assistant?.message?.content;
      if (Array.isArray(assistantContent)) {
        for (const block of assistantContent) {
          if (!block || typeof block !== 'object') continue;
          if ((block as any).type !== 'tool_use') continue;
          const callId = typeof (block as any).id === 'string' ? String((block as any).id) : '';
          const toolName = typeof (block as any).name === 'string' ? String((block as any).name) : '';
          if (!callId || !toolName) continue;
          this.toolNameByCallId.set(callId, toolName);
          const rawInput = (block as any).input;
          const args =
            rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
              ? (rawInput as Record<string, unknown>)
              : {};
          this.turnChangeTracker.observeToolCall({
            callId,
            toolName,
            args,
            parentToolUseId: assistant.parent_tool_use_id,
          });
          if (isClaudeExplicitDiffToolInput(toolName, args)) {
            this.suppressedExplicitDiffCallIds.add(callId);
            continue;
          }
          this.emit({ type: 'tool-call', toolName, callId, args });
        }
      }
      const text = this.extractAssistantText(assistant);
      if (!text) return;
      const pending = this.pendingTurn;
      if (pending) {
        pending.buffer.push(text);
        // AgentBackend contract: `fullText` is the full assistant text so far for the
        // current turn. ExecutionRunManager relies on this to assemble bounded outputs.
        this.emit({ type: 'model-output', fullText: pending.buffer.join('\n').trim() });
      } else {
        this.emit({ type: 'model-output', fullText: text });
      }
      return;
    }

    if (type === 'result') {
      const result = msg as SDKResultMessage;
      if (result.num_turns <= this.settledTurnOrdinal) {
        if (this.ignoreNextNonSuccessResult) {
          this.ignoreNextNonSuccessResult = false;
        }
        return;
      }

      this.noteVendorSessionId(result.session_id);
      this.emitTokenCountTelemetry(result);

      if (result.subtype === 'success') {
        this.completeSuccessfulTurn({ settledTurnOrdinal: result.num_turns });
        return;
      }

      if (this.ignoreNextNonSuccessResult) {
        // Cancellation raced with a clean completion; clear the ignore flag so we don't swallow future errors.
        this.ignoreNextNonSuccessResult = false;
      }
      const pending = this.pendingTurn;
      if (pending) {
        this.pendingTurn = null;
        this.pendingTurnCompletion = null;
        this.turnChangeTracker.resetTurn();
        this.suppressedExplicitDiffCallIds.clear();
        pending.reject(new Error(`Claude SDK error: ${result.subtype}`));
      }
      this.settledTurnOrdinal = result.num_turns;
      this.emit({ type: 'status', status: 'error', detail: String(result.subtype) });
      return;
    }
  }

  private emitTokenCountTelemetry(result: SDKResultMessage): void {
    const usage = (result as any)?.usage;
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return;

    const asNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

    const inputTokens = asNum((usage as any).input_tokens);
    const outputTokens = asNum((usage as any).output_tokens);
    const cacheReadTokens = asNum((usage as any).cache_read_input_tokens);
    const cacheCreationTokens = asNum((usage as any).cache_creation_input_tokens);

    if (inputTokens == null && outputTokens == null && cacheReadTokens == null && cacheCreationTokens == null) return;

    const payload: Record<string, unknown> = {
      type: 'token-count',
      ...(inputTokens != null ? { input_tokens: inputTokens } : {}),
      ...(outputTokens != null ? { output_tokens: outputTokens } : {}),
      ...(cacheReadTokens != null ? { cache_read_input_tokens: cacheReadTokens } : {}),
      ...(cacheCreationTokens != null ? { cache_creation_input_tokens: cacheCreationTokens } : {}),
    };

    const cost = (result as any)?.total_cost_usd;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
      payload.cost = cost;
    }

    this.emit(payload as any);
  }

  private noteVendorSessionId(sessionIdRaw: unknown): void {
    const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
    if (!sessionId) return;
    const normalized = sessionId as SessionId;
    this.vendorSessionId = normalized;
    // PLAN 4.9.1 step 2. This backend owns its OWN provider-activity ledger, so it arms the identity
    // gate at its own session-identity chokepoint. A lineage, not a swap: `init` mints a new vendor
    // session id at every compact boundary, and a task started before one must not become foreign to
    // the ledger that is counting it.
    this.providerActivityLedger.noteOwnedSessionId(normalized);
    if (!this.acceptedSessionIds.has(normalized)) {
      this.acceptedSessionIds.add(normalized);
      this.emit({ type: 'event', name: 'vendor_session_id', payload: { sessionId: normalized } });
    }
    const resolve = this.resolveVendorSessionId;
    if (!resolve) return;
    this.resolveVendorSessionId = null;
    resolve(normalized);
  }

  private async waitForVendorSessionId(params: Readonly<{ timeoutMs: number }>): Promise<SessionId | null> {
    if (this.vendorSessionId) return this.vendorSessionId;
    const timeoutMs = Math.max(1, Math.floor(params.timeoutMs));
    try {
      const vendor = await Promise.race([
        this.vendorSessionIdPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      return vendor;
    } catch {
      return null;
    }
  }

  private extractAssistantText(msg: SDKAssistantMessage): string {
    const parts = Array.isArray(msg?.message?.content) ? msg.message.content : [];
    const texts: string[] = [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const record = part as { type?: unknown; text?: unknown };
      if (record.type !== 'text') continue;
      const text = record.text;
      if (typeof text === 'string' && text.trim().length > 0) texts.push(text);
    }
    return texts.join('\n').trim();
  }
}
