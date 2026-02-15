import { randomUUID } from 'node:crypto';

import type { AgentBackend, SessionId } from '@/agent/core/AgentBackend';
import { extractVoiceActionsFromAssistantText, type ExecutionRunResumeHandle, type VoiceAssistantAction } from '@happier-dev/protocol';

import { appendVoiceAgentHistoryTurn } from './voiceAgentHistory';
import { buildVoiceAgentCommitPrompt, buildVoiceAgentSeededUserTurnPrompt, buildVoiceAgentUserTurnPrompt } from './voiceAgentPrompts';
import { ingestVoiceAgentStreamingDelta } from './voiceAgentStreamingDeltas';
import type {
  BackendFactory,
  VoiceAgentInstance,
  VoiceAgentTurn,
  VoiceAgentTurnStreamState,
  PermissionPolicy,
  Verbosity,
  VoiceAgentCommitResult,
  VoiceAgentSendTurnResult,
  VoiceAgentStartParams,
  VoiceAgentStartResult,
  VoiceAgentTurnStreamReadResult,
  VoiceAgentTurnStreamStartResult,
} from './voiceAgentTypes';
import { VoiceAgentError } from './voiceAgentTypes';

export type {
  VoiceAgentCommitResult,
  VoiceAgentSendTurnResult,
  VoiceAgentStartParams,
  VoiceAgentStartResult,
  VoiceAgentTurnStreamReadResult,
  VoiceAgentTurnStreamStartResult,
} from './voiceAgentTypes';
export { VoiceAgentError } from './voiceAgentTypes';

export class VoiceAgentManager {
  private static readonly MAX_HISTORY_TURNS = 48;
  private static readonly MAX_TURN_TEXT_CHARS = 4_000;
  private readonly createBackend: BackendFactory;
  private readonly getNowMs: () => number;
  private readonly voiceAgents = new Map<string, VoiceAgentInstance>();
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

  getResumeHandle(voiceAgentId: string): ExecutionRunResumeHandle | null {
    const voiceAgent = this.voiceAgents.get(voiceAgentId) ?? null;
    if (!voiceAgent) return null;
    if (voiceAgent.commitBackend && voiceAgent.commitSessionId) {
      return {
        kind: 'voice_agent_sessions.v1',
        backendId: voiceAgent.agentId,
        chatVendorSessionId: voiceAgent.chatSessionId,
        commitVendorSessionId: voiceAgent.commitSessionId,
      };
    }
    return { kind: 'vendor_session.v1', backendId: voiceAgent.agentId, vendorSessionId: voiceAgent.chatSessionId };
  }

  async start(params: VoiceAgentStartParams): Promise<VoiceAgentStartResult> {
    if (this.disposed) {
      throw new VoiceAgentError('VOICE_AGENT_START_FAILED', 'Manager is disposed');
    }

    const voiceAgentId = randomUUID();
    const rawTtlSeconds = Number.isFinite(params.idleTtlSeconds) ? Math.floor(params.idleTtlSeconds) : 60;
    const idleTtlMs = Math.max(60, Math.min(3600, rawTtlSeconds)) * 1000;
    const verbosity: Verbosity = params.verbosity === 'balanced' ? 'balanced' : 'short';

    let chatBackendForCleanup: AgentBackend | undefined;
    try {
      const resume = (() => {
        const handle = params.resumeHandle ?? null;
        if (!handle) return { chatSessionId: null as SessionId | null, commitSessionId: null as SessionId | null };
        if (handle.kind === 'vendor_session.v1') {
          return { chatSessionId: handle.vendorSessionId as SessionId, commitSessionId: null as SessionId | null };
        }
        return {
          chatSessionId: handle.chatVendorSessionId as SessionId,
          commitSessionId: handle.commitVendorSessionId as SessionId,
        };
      })();

      const chatBackend = (chatBackendForCleanup = this.createBackend({
        agentId: params.agentId,
        modelId: params.chatModelId,
        permissionPolicy: params.permissionPolicy,
      }));

      let instanceRef: VoiceAgentInstance | null = null;
      const clearChatBuffer = () => {
        if (instanceRef) instanceRef.chatBuffer = '';
      };
      const clearCommitBuffer = () => {
        if (instanceRef) instanceRef.commitBuffer = '';
      };
      chatBackend.onMessage((msg) => {
        if (msg.type !== 'model-output') return;
        if (typeof msg.textDelta === 'string') {
          if (instanceRef) instanceRef.chatBuffer += msg.textDelta;
          const stream = instanceRef?.activeTurnStream ?? null;
          if (stream && !stream.done) {
            ingestVoiceAgentStreamingDelta(
              stream,
              (next) => {
                if (typeof next.deltaHold === 'string') stream.deltaHold = next.deltaHold;
                if (typeof next.suppressActionDeltas === 'boolean') stream.suppressActionDeltas = next.suppressActionDeltas;
              },
              msg.textDelta,
            );
          }
        }
        if (typeof msg.fullText === 'string') {
          if (instanceRef) instanceRef.chatBuffer = msg.fullText;
        }
      });

      const chatSessionId = await (async () => {
        if (resume.chatSessionId) {
          if (!chatBackend.loadSession) {
            throw new VoiceAgentError('VOICE_AGENT_START_FAILED', 'Backend does not support resume');
          }
          const loaded = await chatBackend.loadSession(resume.chatSessionId);
          return loaded.sessionId;
        }
        const started = await chatBackend.startSession();
        return started.sessionId;
      })();

      const instance: VoiceAgentInstance = {
        id: voiceAgentId,
        agentId: params.agentId,
        chatBackend,
        chatSessionId,
        commitBackend: null,
        commitSessionId: null,
        commitResumeSessionId: resume.commitSessionId,
        permissionPolicy: params.permissionPolicy,
        verbosity,
        chatModelId: params.chatModelId,
        commitModelId: params.commitModelId,
        initialContext: params.initialContext,
        bootstrapped: Boolean(resume.chatSessionId),
        history: [] as VoiceAgentTurn[],
        lastUsedAt: this.getNowMs(),
        idleTtlMs,
        inFlight: null,
        chatBuffer: '',
        commitBuffer: '',
        clearChatBuffer,
        clearCommitBuffer,
        activeTurnStream: null,
        dispose: async () => {
          const disposals: Promise<unknown>[] = [chatBackend.dispose()];
          if (instance.commitBackend) disposals.push(instance.commitBackend.dispose());
          await Promise.allSettled(disposals);
        },
      };
      instanceRef = instance;

      this.voiceAgents.set(voiceAgentId, instance);

      return {
        voiceAgentId,
        effective: {
          chatModelId: params.chatModelId,
          commitModelId: params.commitModelId,
          permissionPolicy: params.permissionPolicy,
        },
      };
    } catch (e: any) {
      const disposals: Promise<unknown>[] = [];
      if (chatBackendForCleanup) disposals.push(chatBackendForCleanup.dispose());
      await Promise.allSettled(disposals);
      if (e instanceof VoiceAgentError) {
        throw e;
      }
      throw new VoiceAgentError('VOICE_AGENT_START_FAILED', e instanceof Error ? e.message : 'start failed');
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.reaper);

    const toStop = [...this.voiceAgents.values()];
    this.voiceAgents.clear();

    await Promise.allSettled(
      toStop.map(async (m) => {
        if (m.inFlight) await m.inFlight.catch(() => {});
        await m.dispose();
      }),
    );
  }

  async sendTurn(params: Readonly<{ voiceAgentId: string; userText: string }>): Promise<VoiceAgentSendTurnResult> {
    const voiceAgent = this.voiceAgents.get(params.voiceAgentId);
    if (!voiceAgent) throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Voice agent not found');
    if (voiceAgent.inFlight) throw new VoiceAgentError('VOICE_AGENT_BUSY', 'Voice agent busy');

    voiceAgent.lastUsedAt = this.getNowMs();
		    const run = (async () => {
		      voiceAgent.clearChatBuffer();
          const prompt = voiceAgent.bootstrapped
            ? buildVoiceAgentUserTurnPrompt({ userText: params.userText })
            : buildVoiceAgentSeededUserTurnPrompt({
                verbosity: voiceAgent.verbosity,
                initialContext: voiceAgent.initialContext,
                userText: params.userText,
              });
		      await voiceAgent.chatBackend.sendPrompt(voiceAgent.chatSessionId, prompt);
		      if (voiceAgent.chatBackend.waitForResponseComplete) {
		        await voiceAgent.chatBackend.waitForResponseComplete();
		      }
          voiceAgent.bootstrapped = true;
		      const extracted = extractVoiceActionsFromAssistantText(voiceAgent.chatBuffer);
		      const assistantText = extracted.assistantText.trim();
		      appendVoiceAgentHistoryTurn(voiceAgent.history, {
		        userText: params.userText,
		        assistantText,
		        maxTurns: VoiceAgentManager.MAX_HISTORY_TURNS,
		        maxTurnTextChars: VoiceAgentManager.MAX_TURN_TEXT_CHARS,
		      });
		      return extracted.actions.length > 0 ? { assistantText, actions: extracted.actions } : { assistantText };
		    })();

    voiceAgent.inFlight = run;
    try {
      return await run;
    } finally {
      if (voiceAgent.inFlight === run) voiceAgent.inFlight = null;
    }
  }

  async startTurnStream(params: Readonly<{ voiceAgentId: string; userText: string }>): Promise<VoiceAgentTurnStreamStartResult> {
    const voiceAgent = this.voiceAgents.get(params.voiceAgentId);
    if (!voiceAgent) throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Voice agent not found');
    if (voiceAgent.inFlight || voiceAgent.activeTurnStream) throw new VoiceAgentError('VOICE_AGENT_BUSY', 'Voice agent busy');

    voiceAgent.lastUsedAt = this.getNowMs();
    voiceAgent.clearChatBuffer();
    const streamId = randomUUID();
    const stream: VoiceAgentTurnStreamState = {
      id: streamId,
      userText: params.userText,
      events: [],
      done: false,
      run: Promise.resolve(),
      completedHistory: false,
      cancelled: false,
      deltaHold: '',
      suppressActionDeltas: false,
    };
    voiceAgent.activeTurnStream = stream;

	    const run = (async () => {
	      try {
            const prompt = voiceAgent.bootstrapped
              ? buildVoiceAgentUserTurnPrompt({ userText: params.userText })
              : buildVoiceAgentSeededUserTurnPrompt({
                  verbosity: voiceAgent.verbosity,
                  initialContext: voiceAgent.initialContext,
                  userText: params.userText,
                });
		        await voiceAgent.chatBackend.sendPrompt(voiceAgent.chatSessionId, prompt);
		        if (voiceAgent.chatBackend.waitForResponseComplete) {
		          await voiceAgent.chatBackend.waitForResponseComplete();
		        }
            voiceAgent.bootstrapped = true;

        // Flush any held chars that were buffered for action-tag detection.
        if (!stream.suppressActionDeltas && stream.deltaHold) {
          stream.events.push({ t: 'delta', textDelta: stream.deltaHold });
          stream.deltaHold = '';
        }

		        const assistantText = voiceAgent.chatBuffer.trim();
		        const extracted = extractVoiceActionsFromAssistantText(assistantText);
		        const cleanText = extracted.assistantText.trim();
		        appendVoiceAgentHistoryTurn(voiceAgent.history, {
		          userText: params.userText,
		          assistantText: cleanText,
		          maxTurns: VoiceAgentManager.MAX_HISTORY_TURNS,
		          maxTurnTextChars: VoiceAgentManager.MAX_TURN_TEXT_CHARS,
		        });
	        stream.completedHistory = true;
	        stream.events.push(
	          extracted.actions.length > 0
            ? { t: 'done', assistantText: cleanText, actions: extracted.actions }
            : { t: 'done', assistantText: cleanText },
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'stream_failed';
        const code =
          error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
            ? ((error as { code: string }).code)
            : undefined;
        stream.events.push({ t: 'error', error: message, ...(code ? { errorCode: code } : {}) });
      } finally {
        stream.done = true;
      }
    })();

	    stream.run = run;
	    voiceAgent.inFlight = run;
	    void run.finally(() => {
	      if (voiceAgent.inFlight === run) voiceAgent.inFlight = null;
	    });

    return { streamId };
  }

  async readTurnStream(
    params: Readonly<{ voiceAgentId: string; streamId: string; cursor: number; maxEvents?: number }>,
  ): Promise<VoiceAgentTurnStreamReadResult> {
    const voiceAgent = this.voiceAgents.get(params.voiceAgentId);
    if (!voiceAgent) throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Voice agent not found');
    const stream = voiceAgent.activeTurnStream;
    if (!stream || stream.id !== params.streamId) {
      throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Turn stream not found');
    }

    const cursor = Number.isFinite(params.cursor) && params.cursor >= 0 ? Math.floor(params.cursor) : 0;
    const maxEvents =
      typeof params.maxEvents === 'number' && Number.isFinite(params.maxEvents) && params.maxEvents > 0
        ? Math.min(128, Math.floor(params.maxEvents))
        : 32;
    const end = Math.min(stream.events.length, cursor + maxEvents);
    const events = stream.events.slice(cursor, end);
    const done = stream.done && end >= stream.events.length;

    if (done) {
      voiceAgent.activeTurnStream = null;
    }

    return {
      streamId: stream.id,
      events,
      nextCursor: end,
      done,
    };
  }

  async cancelTurnStream(params: Readonly<{ voiceAgentId: string; streamId: string }>): Promise<{ ok: true }> {
    const voiceAgent = this.voiceAgents.get(params.voiceAgentId);
    if (!voiceAgent) throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Voice agent not found');
    const stream = voiceAgent.activeTurnStream;
    if (!stream || stream.id !== params.streamId) {
      throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Turn stream not found');
    }
    if (stream.done) {
      voiceAgent.activeTurnStream = null;
      return { ok: true };
    }

    stream.cancelled = true;
    try {
      await voiceAgent.chatBackend.cancel(voiceAgent.chatSessionId);
    } catch {
      // best-effort cancellation
    }

    try {
      await stream.run;
    } catch {
      // stream lifecycle converts errors into stream events
    }

    if (!stream.done) {
      stream.events.push({ t: 'error', error: 'cancelled' });
      stream.done = true;
    }

    return { ok: true };
  }

  async commit(params: Readonly<{ voiceAgentId: string; maxChars?: number }>): Promise<VoiceAgentCommitResult> {
    const voiceAgent = this.voiceAgents.get(params.voiceAgentId);
    if (!voiceAgent) throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Voice agent not found');
    if (voiceAgent.inFlight) throw new VoiceAgentError('VOICE_AGENT_BUSY', 'Voice agent busy');

    voiceAgent.lastUsedAt = this.getNowMs();
		    const run = (async () => {
          if (!voiceAgent.commitBackend || !voiceAgent.commitSessionId) {
            let commitBackend: AgentBackend | null = null;
            try {
              commitBackend = this.createBackend({
                agentId: voiceAgent.agentId,
                modelId: voiceAgent.commitModelId,
                permissionPolicy: voiceAgent.permissionPolicy,
              });
              commitBackend.onMessage((msg) => {
                if (msg.type !== 'model-output') return;
                if (typeof msg.textDelta === 'string') voiceAgent.commitBuffer += msg.textDelta;
                if (typeof msg.fullText === 'string') voiceAgent.commitBuffer = msg.fullText;
              });

              const sessionId = await (async () => {
                if (voiceAgent.commitResumeSessionId && commitBackend.loadSession) {
                  const loaded = await commitBackend.loadSession(voiceAgent.commitResumeSessionId);
                  return loaded.sessionId;
                }
                const started = await commitBackend.startSession();
                return started.sessionId;
              })();
              voiceAgent.commitBackend = commitBackend;
              voiceAgent.commitSessionId = sessionId;
              voiceAgent.commitResumeSessionId = null;
            } catch (e: any) {
              if (commitBackend) await commitBackend.dispose().catch(() => {});
              throw new VoiceAgentError('VOICE_AGENT_START_FAILED', e instanceof Error ? e.message : 'commit backend unavailable');
            }
          }

		      voiceAgent.clearCommitBuffer();
		      const effectiveMaxChars =
		        typeof params.maxChars === 'number' && Number.isFinite(params.maxChars) && params.maxChars > 0 ? Math.floor(params.maxChars) : 4000;
		      const prompt = buildVoiceAgentCommitPrompt({
		        initialContext: voiceAgent.initialContext,
		        history: voiceAgent.history,
		        maxChars: effectiveMaxChars,
		      });
		      await voiceAgent.commitBackend!.sendPrompt(voiceAgent.commitSessionId!, prompt);
		      if (voiceAgent.commitBackend!.waitForResponseComplete) {
		        await voiceAgent.commitBackend!.waitForResponseComplete();
		      }
      const commitText = voiceAgent.commitBuffer.trim();
      return { commitText };
    })();
    voiceAgent.inFlight = run;
    try {
      return await run;
    } finally {
      if (voiceAgent.inFlight === run) voiceAgent.inFlight = null;
    }
  }

  async stop(params: Readonly<{ voiceAgentId: string }>): Promise<{ ok: true }> {
    const voiceAgent = this.voiceAgents.get(params.voiceAgentId);
    if (!voiceAgent) throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Voice agent not found');
    // Remove from registry first to prevent new operations from starting while we await in-flight work.
    this.voiceAgents.delete(params.voiceAgentId);
    if (voiceAgent.inFlight) {
      await voiceAgent.inFlight.catch(() => {});
    }
    await voiceAgent.dispose();
		    return { ok: true };
		  }

		  private async reapIdle(): Promise<void> {
		    const now = this.getNowMs();
		    const toDispose: VoiceAgentInstance[] = [];
    for (const voiceAgent of this.voiceAgents.values()) {
      if (voiceAgent.inFlight) continue;
      if (now - voiceAgent.lastUsedAt > voiceAgent.idleTtlMs) {
        this.voiceAgents.delete(voiceAgent.id);
        toDispose.push(voiceAgent);
      }
    }
    if (toDispose.length === 0) return;
    await Promise.allSettled(toDispose.map((m) => m.dispose()));
  }
}
