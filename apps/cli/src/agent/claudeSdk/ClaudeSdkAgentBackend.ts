import { randomUUID } from 'node:crypto';

import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId, StartSessionResult } from '@/agent/core/AgentBackend';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { query } from '@/backends/claude/sdk/query';
import type { SDKAssistantMessage, SDKMessage, SDKResultMessage, SDKSystemMessage } from '@/backends/claude/sdk/types';

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

  private readonly sessionId: SessionId = `voice-mediator-claude-${randomUUID()}`;
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
    }>,
  ) {}

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
    if (this.started) return { sessionId: this.sessionId };
    this.started = true;

    const model = this.normalizeModelId(this.opts.modelId);
    const canCallTool = this.buildCanCallTool();

    this.emit({ type: 'status', status: 'starting' });
    const q = query({
      prompt: this.promptStream,
      options: {
        cwd: this.opts.cwd,
        model: model ?? undefined,
        canCallTool,
        settingsPath: this.opts.settingsPath,
        abort: this.abortController.signal,
      },
    });

    this.queryIter = q[Symbol.asyncIterator]();
    this.loopPromise = this.runLoop();

    return { sessionId: this.sessionId };
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    if (sessionId !== this.sessionId) {
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
    this.emit({ type: 'status', status: 'stopped' });
  }

  private normalizeModelId(modelIdRaw: string): string | null {
    const trimmed = String(modelIdRaw ?? '').trim();
    if (!trimmed || trimmed === 'default') return null;
    return trimmed;
  }

  private buildCanCallTool() {
    if (this.opts.permissionPolicy === 'no_tools') {
      return async () => ({ behavior: 'deny', message: 'Tools are disabled for voice mediator.', interrupt: true } as const);
    }

    return async (toolName: string, input: unknown) => {
      const normalizedToolName = normalizeToolNameForPolicy(toolName);
      if (!READ_ONLY_SAFE_TOOL_NAMES.has(normalizedToolName)) {
        return { behavior: 'deny', message: `Tool denied by voice mediator policy: ${toolName}`, interrupt: true } as const;
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
        this.emit({ type: 'status', status: 'running' });
      }
      return;
    }

    if (type === 'assistant') {
      const assistant = msg as SDKAssistantMessage;
      const text = this.extractAssistantText(assistant);
      if (!text) return;
      this.pendingTurn?.buffer.push(text);
      this.emit({ type: 'model-output', fullText: text });
      return;
    }

    if (type === 'result') {
      const result = msg as SDKResultMessage;
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
