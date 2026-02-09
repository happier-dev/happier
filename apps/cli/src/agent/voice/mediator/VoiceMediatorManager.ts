import { randomUUID } from 'node:crypto';

import type { AgentBackend, AgentId, SessionId } from '@/agent/core/AgentBackend';

type PermissionPolicy = 'no_tools' | 'read_only';
type Verbosity = 'short' | 'balanced';

export type VoiceMediatorStartParams = Readonly<{
  agentId: AgentId;
  chatModelId: string;
  commitModelId: string;
  permissionPolicy: PermissionPolicy;
  idleTtlSeconds: number;
  initialContext: string;
  verbosity?: Verbosity;
}>;

export type VoiceMediatorStartResult = Readonly<{
  mediatorId: string;
  effective: {
    chatModelId: string;
    commitModelId: string;
    permissionPolicy: PermissionPolicy;
  };
}>;

export type VoiceMediatorSendTurnResult = Readonly<{ assistantText: string }>;
export type VoiceMediatorCommitResult = Readonly<{ commitText: string }>;

export class VoiceMediatorError extends Error {
  readonly code:
    | 'VOICE_MEDIATOR_NOT_FOUND'
    | 'VOICE_MEDIATOR_BUSY'
    | 'VOICE_MEDIATOR_UNSUPPORTED'
    | 'VOICE_MEDIATOR_START_FAILED';

  constructor(code: VoiceMediatorError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

type BackendFactory = (opts: { agentId: AgentId; modelId: string; permissionPolicy: PermissionPolicy }) => AgentBackend;

type MediatorTurn = { role: 'user' | 'assistant'; text: string };

type MediatorInstance = {
  id: string;
  chatBackend: AgentBackend;
  chatSessionId: SessionId;
  commitBackend: AgentBackend;
  commitSessionId: SessionId;
  permissionPolicy: PermissionPolicy;
  verbosity: Verbosity;
  chatModelId: string;
  commitModelId: string;
  initialContext: string;
  history: MediatorTurn[];
  lastUsedAt: number;
  idleTtlMs: number;
  inFlight: Promise<unknown> | null;
  chatBuffer: string;
  commitBuffer: string;
  clearChatBuffer: () => void;
  clearCommitBuffer: () => void;
  dispose: () => Promise<void>;
};

export class VoiceMediatorManager {
  private readonly createBackend: BackendFactory;
  private readonly getNowMs: () => number;
  private readonly mediators = new Map<string, MediatorInstance>();
  private readonly reaper: NodeJS.Timeout;
  private disposed = false;

  constructor(opts: Readonly<{ createBackend: BackendFactory; getNowMs?: () => number; reaperIntervalMs?: number }>) {
    this.createBackend = opts.createBackend;
    this.getNowMs = opts.getNowMs ?? (() => Date.now());
    const intervalMs = Math.max(5_000, Math.floor(opts.reaperIntervalMs ?? 30_000));
    this.reaper = setInterval(() => {
      void this.reapIdle();
    }, intervalMs);
    this.reaper.unref?.();
  }

  async start(params: VoiceMediatorStartParams): Promise<VoiceMediatorStartResult> {
    if (this.disposed) {
      throw new VoiceMediatorError('VOICE_MEDIATOR_START_FAILED', 'Manager is disposed');
    }

    const mediatorId = randomUUID();
    const rawTtlSeconds = Number.isFinite(params.idleTtlSeconds) ? Math.floor(params.idleTtlSeconds) : 60;
    const idleTtlMs = Math.max(60, Math.min(3600, rawTtlSeconds)) * 1000;
    const verbosity: Verbosity = params.verbosity === 'balanced' ? 'balanced' : 'short';

    let chatBackendForCleanup: AgentBackend | undefined;
    let commitBackendForCleanup: AgentBackend | undefined;
    try {
      const chatBackend = (chatBackendForCleanup = this.createBackend({
        agentId: params.agentId,
        modelId: params.chatModelId,
        permissionPolicy: params.permissionPolicy,
      }));
      const commitBackend = (commitBackendForCleanup = this.createBackend({
        agentId: params.agentId,
        modelId: params.commitModelId,
        permissionPolicy: params.permissionPolicy,
      }));

      const chatTextChunks: string[] = [];
      const commitTextChunks: string[] = [];
      const clearChatBuffer = () => {
        chatTextChunks.length = 0;
      };
      const clearCommitBuffer = () => {
        commitTextChunks.length = 0;
      };
      chatBackend.onMessage((msg) => {
        if (msg.type !== 'model-output') return;
        if (typeof msg.textDelta === 'string') chatTextChunks.push(msg.textDelta);
        if (typeof msg.fullText === 'string') {
          chatTextChunks.length = 0;
          chatTextChunks.push(msg.fullText);
        }
      });
      commitBackend.onMessage((msg) => {
        if (msg.type !== 'model-output') return;
        if (typeof msg.textDelta === 'string') commitTextChunks.push(msg.textDelta);
        if (typeof msg.fullText === 'string') {
          commitTextChunks.length = 0;
          commitTextChunks.push(msg.fullText);
        }
      });

      const chatStarted = await chatBackend.startSession();
      const commitStarted = await commitBackend.startSession();

      const instance: MediatorInstance = {
        id: mediatorId,
        chatBackend,
        chatSessionId: chatStarted.sessionId,
        commitBackend,
        commitSessionId: commitStarted.sessionId,
        permissionPolicy: params.permissionPolicy,
        verbosity,
        chatModelId: params.chatModelId,
        commitModelId: params.commitModelId,
        initialContext: params.initialContext,
        history: [],
        lastUsedAt: this.getNowMs(),
        idleTtlMs,
        inFlight: null,
        chatBuffer: '',
        commitBuffer: '',
        clearChatBuffer,
        clearCommitBuffer,
        dispose: async () => {
          await Promise.allSettled([chatBackend.dispose(), commitBackend.dispose()]);
        },
      };

      // Bind buffers to latest captured state
      Object.defineProperty(instance, 'chatBuffer', {
        get: () => chatTextChunks.join(''),
        set: () => {},
        enumerable: true,
        configurable: true,
      });
      Object.defineProperty(instance, 'commitBuffer', {
        get: () => commitTextChunks.join(''),
        set: () => {},
        enumerable: true,
        configurable: true,
      });

      this.mediators.set(mediatorId, instance);

      return {
        mediatorId,
        effective: {
          chatModelId: params.chatModelId,
          commitModelId: params.commitModelId,
          permissionPolicy: params.permissionPolicy,
        },
      };
    } catch (e: any) {
      const disposals: Promise<unknown>[] = [];
      if (chatBackendForCleanup) disposals.push(chatBackendForCleanup.dispose());
      if (commitBackendForCleanup) disposals.push(commitBackendForCleanup.dispose());
      await Promise.allSettled(disposals);
      if (e instanceof VoiceMediatorError) {
        throw e;
      }
      throw new VoiceMediatorError('VOICE_MEDIATOR_START_FAILED', e instanceof Error ? e.message : 'start failed');
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.reaper);

    const toStop = [...this.mediators.values()];
    this.mediators.clear();

    await Promise.allSettled(
      toStop.map(async (m) => {
        if (m.inFlight) await m.inFlight.catch(() => {});
        await m.dispose();
      }),
    );
  }

  async sendTurn(params: Readonly<{ mediatorId: string; userText: string }>): Promise<VoiceMediatorSendTurnResult> {
    const mediator = this.mediators.get(params.mediatorId);
    if (!mediator) throw new VoiceMediatorError('VOICE_MEDIATOR_NOT_FOUND', 'Mediator not found');
    if (mediator.inFlight) throw new VoiceMediatorError('VOICE_MEDIATOR_BUSY', 'Mediator busy');

    mediator.lastUsedAt = this.getNowMs();
    const run = (async () => {
      mediator.clearChatBuffer();
      const prompt = this.buildChatPrompt({ mediator, userText: params.userText });
      await mediator.chatBackend.sendPrompt(mediator.chatSessionId, prompt);
      if (mediator.chatBackend.waitForResponseComplete) {
        await mediator.chatBackend.waitForResponseComplete();
      }
      const assistantText = mediator.chatBuffer.trim();
      mediator.history.push({ role: 'user', text: params.userText });
      mediator.history.push({ role: 'assistant', text: assistantText });
      return { assistantText };
    })();

    mediator.inFlight = run;
    try {
      return await run;
    } finally {
      if (mediator.inFlight === run) mediator.inFlight = null;
    }
  }

  async commit(params: Readonly<{ mediatorId: string; maxChars?: number }>): Promise<VoiceMediatorCommitResult> {
    const mediator = this.mediators.get(params.mediatorId);
    if (!mediator) throw new VoiceMediatorError('VOICE_MEDIATOR_NOT_FOUND', 'Mediator not found');
    if (mediator.inFlight) throw new VoiceMediatorError('VOICE_MEDIATOR_BUSY', 'Mediator busy');

    mediator.lastUsedAt = this.getNowMs();
    const run = (async () => {
      mediator.clearCommitBuffer();
      const prompt = this.buildCommitPrompt({ mediator, maxChars: params.maxChars });
      await mediator.commitBackend.sendPrompt(mediator.commitSessionId, prompt);
      if (mediator.commitBackend.waitForResponseComplete) {
        await mediator.commitBackend.waitForResponseComplete();
      }
      const commitText = mediator.commitBuffer.trim();
      return { commitText };
    })();
    mediator.inFlight = run;
    try {
      return await run;
    } finally {
      if (mediator.inFlight === run) mediator.inFlight = null;
    }
  }

  async stop(params: Readonly<{ mediatorId: string }>): Promise<{ ok: true }> {
    const mediator = this.mediators.get(params.mediatorId);
    if (!mediator) throw new VoiceMediatorError('VOICE_MEDIATOR_NOT_FOUND', 'Mediator not found');
    // Remove from registry first to prevent new operations from starting while we await in-flight work.
    this.mediators.delete(params.mediatorId);
    if (mediator.inFlight) {
      await mediator.inFlight.catch(() => {});
    }
    await mediator.dispose();
    return { ok: true };
  }

  private buildChatPrompt(params: Readonly<{ mediator: MediatorInstance; userText: string }>): string {
    const { mediator, userText } = params;
    const lines: string[] = [];
    lines.push('You are a fast voice mediator for an AI coding agent.');
    if (mediator.verbosity === 'balanced') {
      lines.push('Keep replies conversational; be concise but include enough detail to be helpful.');
    } else {
      lines.push('Keep replies short and conversational.');
    }
    lines.push('');
    lines.push('Initial context:');
    lines.push(mediator.initialContext);
    lines.push('');
    if (mediator.history.length > 0) {
      lines.push('Conversation so far:');
      for (const turn of mediator.history) {
        lines.push(`${turn.role === 'user' ? 'User' : 'Mediator'}: ${turn.text}`);
      }
      lines.push('');
    }
    lines.push(`User: ${userText}`);
    lines.push('Mediator:');
    return lines.join('\n');
  }

  private buildCommitPrompt(params: Readonly<{ mediator: MediatorInstance; maxChars?: number }>): string {
    const { mediator, maxChars } = params;
    const effectiveMaxChars =
      typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 4000;
    const lines: string[] = [];
    lines.push('You are preparing a single instruction message for an AI coding agent.');
    lines.push(`Return ONLY the instruction text (no preamble), max ${effectiveMaxChars} chars.`);
    lines.push('');
    lines.push('Initial context:');
    lines.push(mediator.initialContext);
    lines.push('');
    if (mediator.history.length > 0) {
      lines.push('Conversation:');
      for (const turn of mediator.history) {
        lines.push(`${turn.role === 'user' ? 'User' : 'Mediator'}: ${turn.text}`);
      }
      lines.push('');
    }
    lines.push('Instruction:');
    return lines.join('\n');
  }

  private async reapIdle(): Promise<void> {
    const now = this.getNowMs();
    const toDispose: MediatorInstance[] = [];
    for (const mediator of this.mediators.values()) {
      if (mediator.inFlight) continue;
      if (now - mediator.lastUsedAt > mediator.idleTtlMs) {
        this.mediators.delete(mediator.id);
        toDispose.push(mediator);
      }
    }
    if (toDispose.length === 0) return;
    await Promise.allSettled(toDispose.map((m) => m.dispose()));
  }
}
