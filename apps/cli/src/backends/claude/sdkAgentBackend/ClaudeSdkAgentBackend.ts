import { randomUUID } from 'node:crypto';

import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId, StartSessionResult } from '@/agent/core/AgentBackend';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { query } from '@/backends/claude/sdk/query';
import type { SDKAssistantMessage, SDKMessage, SDKResultMessage, SDKSystemMessage } from '@/backends/claude/sdk/types';
import { createSubprocessStderrAppender, type BoundedTextFileAppender } from '@/agent/runtime/subprocessArtifacts';

export type ClaudeSdkPermissionPolicy = 'no_tools' | 'read_only';

const READ_ONLY_SAFE_TOOL_NAMES = new Set([
  'fetch',
  'read',
  'search',
  'grep',
  'glob',
  'ls',
  'list',
  'webfetch',
  'websearch',
  'todoread',
]);

function normalizeToolNameForPolicy(toolName: string): string {
  return String(toolName ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export class ClaudeSdkAgentBackend implements AgentBackend {
  private readonly listeners: AgentMessageHandler[] = [];
  private readonly promptStream = new PushableAsyncIterable<SDKMessage>();
  private readonly abortController = new AbortController();
  private readonly env: NodeJS.ProcessEnv;
  private stderrAppender: BoundedTextFileAppender | null = null;
  private readonly toolNameByCallId = new Map<string, string>();

  private readonly localSessionId: SessionId = `voice-agent-claude-${randomUUID()}`;
  private readonly acceptedSessionIds = new Set<SessionId>();
  private vendorSessionId: SessionId | null = null;
  private resolveVendorSessionId: ((id: SessionId) => void) | null = null;
  private vendorSessionIdPromise: Promise<SessionId>;
  private started = false;
  private disposed = false;

  private queryIter: AsyncIterableIterator<SDKMessage> | null = null;
  private loopPromise: Promise<void> | null = null;

  private sendChain: Promise<void> = Promise.resolve();
  private pendingTurn: { resolve: () => void; reject: (e: Error) => void; buffer: string[] } | null = null;

  constructor(
    private readonly opts: Readonly<{
      cwd: string;
      modelId: string;
      permissionPolicy: ClaudeSdkPermissionPolicy;
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

    const model = this.normalizeModelId(this.opts.modelId);
    const canCallTool = this.buildCanCallTool();

    this.emit({ type: 'status', status: 'starting' });
    this.stderrAppender = await createSubprocessStderrAppender({
      agentName: 'claude',
      pid: null,
      label: 'claude-sdk',
    });
    const q = query({
      prompt: this.promptStream,
      options: {
        cwd: this.opts.cwd,
        model: model ?? undefined,
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

    this.queryIter = q[Symbol.asyncIterator]();
    this.loopPromise = this.runLoop();
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    if (!this.acceptedSessionIds.has(sessionId)) {
      throw new Error(`Unknown sessionId: ${sessionId}`);
    }
    if (this.disposed) throw new Error('Backend disposed');
    if (!this.started) {
      await this.startSession();
    }

    // Serialize turns.
    const run = async () => {
      if (this.disposed) throw new Error('Backend disposed');
      const result = await new Promise<void>((resolve, reject) => {
        this.pendingTurn = { resolve, reject, buffer: [] };
        this.promptStream.push({
          type: 'user',
          message: { role: 'user', content: prompt },
        });
      });
      return result;
    };

    this.sendChain = this.sendChain.then(run, run);
    return await this.sendChain;
  }

  async cancel(_sessionId: SessionId): Promise<void> {
    // Best-effort: abort the whole process.
    this.abortController.abort();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const pending = this.pendingTurn;
    if (pending) {
      this.pendingTurn = null;
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
    this.emit({ type: 'status', status: 'stopped' });
  }

  private normalizeModelId(modelIdRaw: string): string | null {
    const trimmed = String(modelIdRaw ?? '').trim();
    if (!trimmed || trimmed === 'default') return null;
    return trimmed;
  }

  private buildCanCallTool() {
    if (this.opts.permissionPolicy === 'no_tools') {
      return async () => ({ behavior: 'deny', message: 'Tools are disabled for voice agent.', interrupt: true } as const);
    }

    return async (toolName: string, input: unknown) => {
      const normalizedToolName = normalizeToolNameForPolicy(toolName);
      if (!READ_ONLY_SAFE_TOOL_NAMES.has(normalizedToolName)) {
        return { behavior: 'deny', message: `Tool denied by voice agent policy: ${toolName}`, interrupt: true } as const;
      }
      const updatedInput = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      return { behavior: 'allow', updatedInput } as const;
    };
  }

  private async runLoop(): Promise<void> {
    if (!this.queryIter) return;
    for await (const msg of this.queryIter) {
      if (this.disposed) return;
      this.handleSdkMessage(msg);
    }
  }

  private handleSdkMessage(msg: SDKMessage): void {
    if (!msg || typeof msg !== 'object') return;
    const type = msg.type;
    if (type === 'system') {
      const system = msg as SDKSystemMessage;
      if (system.subtype === 'init') {
        this.noteVendorSessionId(system.session_id);
        this.emit({ type: 'status', status: 'running' });
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
      this.noteVendorSessionId(result.session_id);
      this.emitTokenCountTelemetry(result);
      if (result.subtype === 'success') {
        // A completed turn means tool call ids won't be reused; keep memory bounded.
        this.toolNameByCallId.clear();
      }
      if (result.subtype === 'success') {
        const pending = this.pendingTurn;
        if (pending) {
          this.pendingTurn = null;
          pending.resolve();
        }
        this.emit({ type: 'status', status: 'idle' });
        return;
      }

      const pending = this.pendingTurn;
      if (pending) {
        this.pendingTurn = null;
        pending.reject(new Error(`Claude SDK error: ${result.subtype}`));
      }
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
    if (!this.acceptedSessionIds.has(normalized)) {
      this.acceptedSessionIds.add(normalized);
      this.emit({ type: 'event', name: 'vendor_session_id', payload: { sessionId: normalized } });
    }
    if (!this.vendorSessionId) {
      this.vendorSessionId = normalized;
      const resolve = this.resolveVendorSessionId;
      this.resolveVendorSessionId = null;
      resolve?.(normalized);
    }
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
