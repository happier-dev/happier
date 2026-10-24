import { randomUUID } from 'node:crypto';

import type { AgentBackend, SessionId } from '@/agent/core/AgentBackend';
import { logger } from '@/ui/logger';
import { extractVoiceActionsFromAssistantText, type ExecutionRunResumeHandle, type VoiceAssistantAction } from '@happier-dev/protocol';

import { appendVoiceAgentHistoryTurn } from './voiceAgentHistory';
import {
  buildVoiceAgentBootstrapPrompt,
  buildVoiceAgentCommitPrompt,
  buildVoiceAgentSeededUserTurnPrompt,
  buildVoiceAgentUserTurnPrompt,
} from './voiceAgentPrompts';
import { ingestVoiceAgentStreamingDelta } from './voiceAgentStreamingDeltas';
import type {
  BackendFactory,
  ResolveVoiceSystemAppendBlocksArgs,
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

import { resolveVoiceActionBlockMemoryRecallGuidanceEnabled } from './resolveVoiceActionBlockMemoryRecallGuidanceEnabled';

export type {
  VoiceAgentCommitResult,
  VoiceAgentSendTurnResult,
  VoiceAgentStartParams,
  VoiceAgentStartResult,
  VoiceAgentTurnStreamReadResult,
  VoiceAgentTurnStreamStartResult,
} from './voiceAgentTypes';
export { VoiceAgentError } from './voiceAgentTypes';

type InitializingVoiceAgent = Readonly<{
  kind: 'initializing';
  id: string;
  dispose: () => Promise<void>;
}>;

/** Models often decorate the READY handshake ("Ready.", "READY!"); only the word itself matters. */
function isVoiceAgentReadyHandshakeReply(text: string): boolean {
  return text.trim().replace(/[\s.!"'`*]+$/u, '').replace(/^[\s"'`*]+/u, '').toUpperCase() === 'READY';
}

async function awaitWithinVoiceAgentBootstrapBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T> {
  if (budgetMs <= 0) {
    // The deadline error supersedes whatever the abandoned step settles with later.
    promise.catch(() => {});
    throw new VoiceAgentError('VOICE_AGENT_START_FAILED', 'Voice agent bootstrap budget exhausted');
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new VoiceAgentError('VOICE_AGENT_START_FAILED', `Voice agent bootstrap timed out after ${budgetMs}ms`)),
          budgetMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class VoiceAgentManager {
  private static readonly MAX_HISTORY_TURNS = 48;
  private static readonly MAX_TURN_TEXT_CHARS = 4_000;
  private static readonly MIN_IDLE_TTL_SECONDS = 60;
  private static readonly MAX_IDLE_TTL_SECONDS = 6 * 60 * 60; // 6h
  private readonly createBackend: BackendFactory;
  private readonly resolveSystemAppendBlocks: (args: ResolveVoiceSystemAppendBlocksArgs) => Promise<readonly string[]>;
  private readonly responseTimeoutMs: number;
  private readonly getNowMs: () => number;
  private readonly onActivityChanged: ((voiceAgentId: string) => void) | undefined;
  private readonly voiceAgents = new Map<string, VoiceAgentInstance | InitializingVoiceAgent>();
  private readonly reaper: NodeJS.Timeout;
  private disposed = false;
  private disposalPromise: Promise<void> | null = null;

  private getReadyVoiceAgent(voiceAgentId: string): VoiceAgentInstance | null {
    const entry = this.voiceAgents.get(voiceAgentId);
    return entry && !('kind' in entry) ? entry : null;
  }

  private normalizeAssistantTextForActions(
    assistantText: string,
    actions: readonly VoiceAssistantAction[],
  ): string {
    const trimmed = assistantText.trim();
    if (actions.some((action) => action?.t === 'sendSessionMessage')) {
      return 'I sent that to the coding assistant and am waiting for its update.';
    }
    return trimmed;
  }

  private resolveResponseTimeoutMs(explicitTimeoutMs?: number | null): number {
    if (typeof explicitTimeoutMs === 'number' && Number.isFinite(explicitTimeoutMs) && explicitTimeoutMs > 0) {
      return Math.floor(explicitTimeoutMs);
    }
    return this.responseTimeoutMs;
  }

  constructor(opts: Readonly<{
    createBackend: BackendFactory;
    resolveSystemAppendBlocks?: (args: ResolveVoiceSystemAppendBlocksArgs) => Promise<readonly string[]>;
    responseTimeoutMs?: number;
    getNowMs?: () => number;
    reaperIntervalMs?: number;
    onActivityChanged?: (voiceAgentId: string) => void;
  }>) {
    this.createBackend = opts.createBackend;
    this.resolveSystemAppendBlocks = opts.resolveSystemAppendBlocks ?? (async () => []);
    this.responseTimeoutMs =
      typeof opts.responseTimeoutMs === 'number' && Number.isFinite(opts.responseTimeoutMs) && opts.responseTimeoutMs > 0
        ? Math.floor(opts.responseTimeoutMs)
        : 120_000;
    this.getNowMs = opts.getNowMs ?? (() => Date.now());
    this.onActivityChanged = opts.onActivityChanged;
    const intervalMs = Math.max(5_000, Math.floor(opts.reaperIntervalMs ?? 30_000));
    this.reaper = setInterval(() => {
      void this.reapIdle();
    }, intervalMs);
    this.reaper.unref?.();
  }

  isTurnInFlight(voiceAgentId: string): boolean {
    return this.getReadyVoiceAgent(voiceAgentId)?.inFlight != null;
  }

  private notifyActivityChanged(voiceAgentId: string): void {
    try {
      this.onActivityChanged?.(voiceAgentId);
    } catch (error) {
      logger.infoFile('[VOICE AGENT] Failed to publish work activity', { voiceAgentId, error });
    }
  }

  private trackInFlight<T>(voiceAgent: VoiceAgentInstance, run: Promise<T>): Promise<T> {
    voiceAgent.inFlight = run;
    this.notifyActivityChanged(voiceAgent.id);
    return run.finally(() => {
      if (voiceAgent.inFlight !== run) return;
      voiceAgent.inFlight = null;
      if (this.voiceAgents.get(voiceAgent.id) === voiceAgent) this.notifyActivityChanged(voiceAgent.id);
    });
  }

  getResumeHandle(voiceAgentId: string): ExecutionRunResumeHandle | null {
    const voiceAgent = this.getReadyVoiceAgent(voiceAgentId);
    if (!voiceAgent) return null;
    if (voiceAgent.commitBackend && voiceAgent.commitSessionId) {
      return {
        kind: 'voice_agent_sessions.v1',
        backendTarget: { kind: 'builtInAgent', agentId: voiceAgent.agentId },
        chatVendorSessionId: voiceAgent.chatSessionId,
        commitVendorSessionId: voiceAgent.commitSessionId,
      };
    }
    return {
      kind: 'vendor_session.v1',
      backendTarget: { kind: 'builtInAgent', agentId: voiceAgent.agentId },
      vendorSessionId: voiceAgent.chatSessionId,
    };
  }

  private async ensureCommitBackendSession(voiceAgent: VoiceAgentInstance): Promise<void> {
    if (voiceAgent.commitBackend && voiceAgent.commitSessionId) {
      return;
    }

    let commitBackend: AgentBackend | null = null;
    try {
      commitBackend = this.createBackend({
        agentId: voiceAgent.agentId,
        modelId: voiceAgent.commitModelId,
        permissionPolicy: voiceAgent.permissionPolicy,
        start: { intent: 'voice_agent' },
        connectedServicesEnv: voiceAgent.connectedServicesEnv,
      });
      commitBackend.onMessage((msg) => {
        if (msg.type !== 'model-output') return;
        if (typeof msg.textDelta === 'string') voiceAgent.commitBuffer += msg.textDelta;
        if (typeof msg.fullText === 'string') voiceAgent.commitBuffer = msg.fullText;
      });

      // The instance owns the acquired process before native-open acknowledgement.
      voiceAgent.commitBackend = commitBackend;

      const sessionId = await (async () => {
        if (voiceAgent.commitResumeSessionId && commitBackend.loadSession) {
          const loaded = await commitBackend.loadSession(voiceAgent.commitResumeSessionId);
          return loaded.sessionId;
        }
        const started = await commitBackend.startSession();
        return started.sessionId;
      })();

      if (this.disposed || this.voiceAgents.get(voiceAgent.id) !== voiceAgent) {
        throw new VoiceAgentError('VOICE_AGENT_START_FAILED', 'Voice agent is no longer active');
      }
      voiceAgent.commitSessionId = sessionId;
      voiceAgent.commitResumeSessionId = null;
    } catch (e: any) {
      if (voiceAgent.commitBackend === commitBackend) {
        voiceAgent.commitBackend = null;
        voiceAgent.commitSessionId = null;
      }
      if (commitBackend) await commitBackend.dispose().catch(() => {});
      throw new VoiceAgentError('VOICE_AGENT_START_FAILED', e instanceof Error ? e.message : 'commit backend unavailable');
    }
  }

  async start(params: VoiceAgentStartParams): Promise<VoiceAgentStartResult> {
    if (this.disposed) {
      throw new VoiceAgentError('VOICE_AGENT_START_FAILED', 'Manager is disposed');
    }

    const voiceAgentId = randomUUID();
    const rawTtlSeconds = Number.isFinite(params.idleTtlSeconds)
      ? Math.floor(params.idleTtlSeconds)
      : VoiceAgentManager.MIN_IDLE_TTL_SECONDS;
    const idleTtlMs =
      Math.max(VoiceAgentManager.MIN_IDLE_TTL_SECONDS, Math.min(VoiceAgentManager.MAX_IDLE_TTL_SECONDS, rawTtlSeconds)) * 1000;
    const verbosity: Verbosity = params.verbosity === 'balanced' ? 'balanced' : 'short';
    const disabledActionIds = Array.isArray(params.disabledActionIds)
      ? params.disabledActionIds.map((value) => String(value ?? '').trim()).filter(Boolean)
      : [];
    const memoryRecallGuidanceEnabled = await resolveVoiceActionBlockMemoryRecallGuidanceEnabled();
    const systemAppendBlocks = await this.resolveSystemAppendBlocks({
      profileId: params.profileId ?? null,
      sessionId: params.contextSessionId ?? null,
    });

    // Run-scoped connected-services release is owned at the INSTANCE level and must fire EXACTLY once
    // across every exit path — happy return (via instance.dispose), a pre-instance boot failure, or a
    // post-registration bootstrap throw. Hoisted to the method scope so the catch path can release even
    // when no instance was ever created (R4-1). Idempotent guard prevents any double-release.
    const connectedServicesCleanup = params.connectedServicesCleanup ?? null;
    let connectedServicesReleased = false;
    const releaseConnectedServicesOnce = async (): Promise<void> => {
      if (connectedServicesCleanup && !connectedServicesReleased) {
        connectedServicesReleased = true;
        await connectedServicesCleanup().catch(() => {});
      }
    };

    let chatBackendForCleanup: AgentBackend | undefined;
    let instanceRef: VoiceAgentInstance | null = null;
    let backendDisposal: Promise<void> | null = null;
    const disposeAcquiredBackends = (): Promise<void> => {
      backendDisposal ??= (async () => {
        const disposals: Promise<unknown>[] = [];
        if (chatBackendForCleanup) disposals.push(chatBackendForCleanup.dispose());
        if (instanceRef?.commitBackend) disposals.push(instanceRef.commitBackend.dispose());
        await Promise.allSettled(disposals);
        await releaseConnectedServicesOnce();
      })();
      return backendDisposal;
    };
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

      const connectedServicesEnv = params.connectedServicesEnv ?? null;

      if (this.disposed) throw new VoiceAgentError('VOICE_AGENT_START_FAILED', 'Manager is disposed');

      const chatBackend = (chatBackendForCleanup = this.createBackend({
        agentId: params.agentId,
        modelId: params.chatModelId,
        permissionPolicy: params.permissionPolicy,
        start: { intent: 'voice_agent' },
        connectedServicesEnv,
      }));
      const initializing: InitializingVoiceAgent = {
        kind: 'initializing', id: voiceAgentId, dispose: disposeAcquiredBackends,
      };
      this.voiceAgents.set(voiceAgentId, initializing);

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

      // Session start/load and the READY handshake are one bootstrap: they share a single deadline
      // derived from the bootstrap budget instead of each waiting the full budget (or unbounded).
      const bootstrapDeadlineMs = this.getNowMs() + this.resolveResponseTimeoutMs(params.bootstrapTimeoutMs);
      const remainingBootstrapBudgetMs = () => Math.max(0, bootstrapDeadlineMs - this.getNowMs());
      const chatSessionId = await awaitWithinVoiceAgentBootstrapBudget((async () => {
        if (resume.chatSessionId) {
          if (!chatBackend.loadSession) {
            throw new VoiceAgentError('VOICE_AGENT_START_FAILED', 'Backend does not support resume');
          }
          const loaded = await chatBackend.loadSession(resume.chatSessionId);
          return loaded.sessionId;
        }
        const started = await chatBackend.startSession();
        return started.sessionId;
      })(), remainingBootstrapBudgetMs());

      if (this.disposed || this.voiceAgents.get(voiceAgentId) !== initializing) {
        throw new VoiceAgentError('VOICE_AGENT_START_FAILED', 'Voice agent is no longer active');
      }

      const instance: VoiceAgentInstance = {
        id: voiceAgentId,
        agentId: params.agentId,
        chatBackend,
        chatSessionId,
        commitIsolation: params.commitIsolation === true,
        commitBackend: null,
        commitSessionId: null,
        commitResumeSessionId: resume.commitSessionId,
        permissionPolicy: params.permissionPolicy,
        verbosity,
        chatModelId: params.chatModelId,
        commitModelId: params.commitModelId,
        initialContext: params.initialContext,
        connectedServicesEnv,
        disabledActionIds,
        memoryRecallGuidanceEnabled,
        systemAppendBlocks: [...systemAppendBlocks],
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
        dispose: disposeAcquiredBackends,
      };
      instanceRef = instance;

      this.voiceAgents.set(voiceAgentId, instance);

      if (resume.commitSessionId) {
        await this.trackInFlight(instance, this.ensureCommitBackendSession(instance));
      }

      const bootstrapMode = params.bootstrapMode ?? 'none';
      if (!resume.chatSessionId && bootstrapMode === 'ready_handshake') {
        await this.trackInFlight(instance, (async () => {
          const shouldDeferInitialContextUntilFirstTurn = params.initialContextMode === 'first_turn';
          instance.clearChatBuffer();
          const prompt = buildVoiceAgentBootstrapPrompt({
            verbosity: instance.verbosity,
            initialContext: shouldDeferInitialContextUntilFirstTurn ? '' : instance.initialContext,
            mode: 'ready_handshake',
            disabledActionIds: instance.disabledActionIds,
            memoryRecallGuidanceEnabled: instance.memoryRecallGuidanceEnabled,
            systemAppendBlocks: instance.systemAppendBlocks,
          });
          // The whole handshake (prompt write + response) stays inside the bootstrap deadline: a stalled
          // write or a backend whose response wait extends on every update must not outlive it.
          await awaitWithinVoiceAgentBootstrapBudget((async () => {
            await instance.chatBackend.sendPrompt(instance.chatSessionId, prompt);
            if (instance.chatBackend.waitForResponseComplete) {
              await instance.chatBackend.waitForResponseComplete(Math.max(1, remainingBootstrapBudgetMs()));
            }
          })(), remainingBootstrapBudgetMs());
          if (!isVoiceAgentReadyHandshakeReply(instance.chatBuffer)) {
            throw new VoiceAgentError('VOICE_AGENT_START_FAILED', 'Bootstrap failed');
          }
          instance.clearChatBuffer();
          instance.bootstrapped = !shouldDeferInitialContextUntilFirstTurn;
        })());
      }

      return {
        voiceAgentId,
        effective: {
          chatModelId: params.chatModelId,
          commitModelId: params.commitModelId,
          permissionPolicy: params.permissionPolicy,
        },
      };
    } catch (e: any) {
      this.voiceAgents.delete(voiceAgentId);
      await disposeAcquiredBackends().catch(() => {});
      if (e instanceof VoiceAgentError) {
        throw e;
      }
      throw new VoiceAgentError('VOICE_AGENT_START_FAILED', e instanceof Error ? e.message : 'start failed');
    }
  }

  dispose(): Promise<void> {
    if (this.disposalPromise) return this.disposalPromise;
    this.disposed = true;
    clearInterval(this.reaper);

    const toStop = [...this.voiceAgents.values()];
    this.voiceAgents.clear();
    for (const voiceAgent of toStop) {
      if (!('kind' in voiceAgent) && voiceAgent.inFlight) this.notifyActivityChanged(voiceAgent.id);
    }

    this.disposalPromise = Promise.allSettled(
      toStop.map(async (m) => {
        await m.dispose();
        if (!('kind' in m) && m.inFlight) await m.inFlight.catch(() => {});
      }),
    ).then(() => {});
    return this.disposalPromise;
  }

  async sendTurn(params: Readonly<{ voiceAgentId: string; userText: string }>): Promise<VoiceAgentSendTurnResult> {
    const voiceAgent = this.getReadyVoiceAgent(params.voiceAgentId);
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
                disabledActionIds: voiceAgent.disabledActionIds,
                memoryRecallGuidanceEnabled: voiceAgent.memoryRecallGuidanceEnabled,
                systemAppendBlocks: voiceAgent.systemAppendBlocks,
              });
		      await voiceAgent.chatBackend.sendPrompt(voiceAgent.chatSessionId, prompt);
		      if (voiceAgent.chatBackend.waitForResponseComplete) {
		        await voiceAgent.chatBackend.waitForResponseComplete(this.resolveResponseTimeoutMs());
		      }
          voiceAgent.bootstrapped = true;
		      const extracted = extractVoiceActionsFromAssistantText(voiceAgent.chatBuffer);
		      const assistantText = this.normalizeAssistantTextForActions(extracted.assistantText, extracted.actions);
		      appendVoiceAgentHistoryTurn(voiceAgent.history, {
		        userText: params.userText,
		        assistantText,
		        maxTurns: VoiceAgentManager.MAX_HISTORY_TURNS,
		        maxTurnTextChars: VoiceAgentManager.MAX_TURN_TEXT_CHARS,
		      });
		      return extracted.actions.length > 0 ? { assistantText, actions: extracted.actions } : { assistantText };
		    })();

    return await this.trackInFlight(voiceAgent, run);
  }

  async welcome(params: Readonly<{ voiceAgentId: string; welcomeText?: string }>): Promise<Readonly<{ assistantText: string }>> {
    const voiceAgent = this.getReadyVoiceAgent(params.voiceAgentId);
    if (!voiceAgent) throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Voice agent not found');
    if (voiceAgent.inFlight || voiceAgent.activeTurnStream) throw new VoiceAgentError('VOICE_AGENT_BUSY', 'Voice agent busy');

    // Idempotent: when the session is already bootstrapped, a welcome would likely pollute vendor memory.
    if (voiceAgent.bootstrapped) return { assistantText: '' };

    voiceAgent.lastUsedAt = this.getNowMs();
    const run = (async () => {
      voiceAgent.clearChatBuffer();
      const prompt = buildVoiceAgentBootstrapPrompt({
        verbosity: voiceAgent.verbosity,
        initialContext: voiceAgent.initialContext,
        mode: 'welcome',
        welcomeText: params.welcomeText,
        disabledActionIds: voiceAgent.disabledActionIds,
        memoryRecallGuidanceEnabled: voiceAgent.memoryRecallGuidanceEnabled,
        systemAppendBlocks: voiceAgent.systemAppendBlocks,
      });
      await voiceAgent.chatBackend.sendPrompt(voiceAgent.chatSessionId, prompt);
      if (voiceAgent.chatBackend.waitForResponseComplete) {
        await voiceAgent.chatBackend.waitForResponseComplete(this.resolveResponseTimeoutMs());
      }
      const assistantText = voiceAgent.chatBuffer.trim();
      voiceAgent.clearChatBuffer();
      voiceAgent.bootstrapped = true;
      return { assistantText };
    })();

    return await this.trackInFlight(voiceAgent, run);
  }

  async startTurnStream(params: Readonly<{ voiceAgentId: string; userText: string }>): Promise<VoiceAgentTurnStreamStartResult> {
    const voiceAgent = this.getReadyVoiceAgent(params.voiceAgentId);
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
                  disabledActionIds: voiceAgent.disabledActionIds,
                  memoryRecallGuidanceEnabled: voiceAgent.memoryRecallGuidanceEnabled,
                  systemAppendBlocks: voiceAgent.systemAppendBlocks,
                });
		        await voiceAgent.chatBackend.sendPrompt(voiceAgent.chatSessionId, prompt);
		        if (voiceAgent.chatBackend.waitForResponseComplete) {
		          await voiceAgent.chatBackend.waitForResponseComplete(this.resolveResponseTimeoutMs());
		        }
            voiceAgent.bootstrapped = true;

        // Flush any held chars that were buffered for action-tag detection.
        if (!stream.suppressActionDeltas && stream.deltaHold) {
          stream.events.push({ t: 'delta', textDelta: stream.deltaHold });
          stream.deltaHold = '';
        }

		        const assistantText = voiceAgent.chatBuffer.trim();
		        const extracted = extractVoiceActionsFromAssistantText(assistantText);
		        const cleanText = this.normalizeAssistantTextForActions(extracted.assistantText, extracted.actions);
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

    stream.run = this.trackInFlight(voiceAgent, run);

    return { streamId };
  }

  async readTurnStream(
    params: Readonly<{ voiceAgentId: string; streamId: string; cursor: number; maxEvents?: number }>,
  ): Promise<VoiceAgentTurnStreamReadResult> {
    const voiceAgent = this.getReadyVoiceAgent(params.voiceAgentId);
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
    const voiceAgent = this.getReadyVoiceAgent(params.voiceAgentId);
    if (!voiceAgent) throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Voice agent not found');
    const stream = voiceAgent.activeTurnStream;
    if (!stream || stream.id !== params.streamId) {
      throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Turn stream not found');
    }
    await this.cancelActiveTurnStream(voiceAgent, stream);
    return { ok: true };
  }

  async commit(params: Readonly<{ voiceAgentId: string; maxChars?: number }>): Promise<VoiceAgentCommitResult> {
    const voiceAgent = this.getReadyVoiceAgent(params.voiceAgentId);
    if (!voiceAgent) throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Voice agent not found');
    if (voiceAgent.inFlight) throw new VoiceAgentError('VOICE_AGENT_BUSY', 'Voice agent busy');

    voiceAgent.lastUsedAt = this.getNowMs();
		    const run = (async () => {
          const canReuseChatBackend = voiceAgent.commitIsolation !== true && voiceAgent.commitModelId === voiceAgent.chatModelId;
          if (canReuseChatBackend) {
            voiceAgent.clearChatBuffer();
            const effectiveMaxChars =
              typeof params.maxChars === 'number' && Number.isFinite(params.maxChars) && params.maxChars > 0 ? Math.floor(params.maxChars) : 4000;
            const prompt = buildVoiceAgentCommitPrompt({
              initialContext: voiceAgent.initialContext,
              history: voiceAgent.history,
              maxChars: effectiveMaxChars,
            });
            await voiceAgent.chatBackend.sendPrompt(voiceAgent.chatSessionId, prompt);
            if (voiceAgent.chatBackend.waitForResponseComplete) {
              await voiceAgent.chatBackend.waitForResponseComplete(this.resolveResponseTimeoutMs());
            }
            const commitText = voiceAgent.chatBuffer.trim();
            voiceAgent.clearChatBuffer();
            return { commitText };
          }

          await this.ensureCommitBackendSession(voiceAgent);

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
		        await voiceAgent.commitBackend!.waitForResponseComplete(this.resolveResponseTimeoutMs());
		      }
      const commitText = voiceAgent.commitBuffer.trim();
      return { commitText };
    })();
    return await this.trackInFlight(voiceAgent, run);
  }

  async stop(params: Readonly<{ voiceAgentId: string }>): Promise<{ ok: true }> {
    const voiceAgent = this.voiceAgents.get(params.voiceAgentId);
    if (!voiceAgent) throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Voice agent not found');
    // Remove from registry first to prevent new operations from starting while we await in-flight work.
    this.voiceAgents.delete(params.voiceAgentId);
    if ('kind' in voiceAgent) {
      await voiceAgent.dispose();
      return { ok: true };
    }
    if (voiceAgent.inFlight) this.notifyActivityChanged(voiceAgent.id);
    const cancellation = voiceAgent.activeTurnStream
      ? this.cancelActiveTurnStream(voiceAgent, voiceAgent.activeTurnStream, { awaitCompletion: false })
      : Promise.resolve();
    // Releasing the backend interrupts a pending turn; waiting for that turn first can
    // retain its process indefinitely when the provider never produces a terminal event.
    await Promise.all([cancellation, voiceAgent.dispose()]);
    if (voiceAgent.inFlight && !voiceAgent.activeTurnStream) {
      await voiceAgent.inFlight.catch(() => {});
    }
		    return { ok: true };
		  }

		  private async reapIdle(): Promise<void> {
		    const now = this.getNowMs();
		    const toDispose: VoiceAgentInstance[] = [];
    for (const voiceAgent of this.voiceAgents.values()) {
      if ('kind' in voiceAgent) continue;
      if (voiceAgent.inFlight) continue;
      if (now - voiceAgent.lastUsedAt > voiceAgent.idleTtlMs) {
        this.voiceAgents.delete(voiceAgent.id);
        toDispose.push(voiceAgent);
      }
    }
    if (toDispose.length === 0) return;
    await Promise.allSettled(toDispose.map((m) => m.dispose()));
  }

  private async cancelActiveTurnStream(
    voiceAgent: VoiceAgentInstance,
    stream: VoiceAgentTurnStreamState,
    options?: Readonly<{ awaitCompletion?: boolean }>,
  ): Promise<void> {
    if (stream.done) {
      if (voiceAgent.activeTurnStream === stream) {
        voiceAgent.activeTurnStream = null;
      }
      return;
    }

    stream.cancelled = true;
    try {
      await voiceAgent.chatBackend.cancel(voiceAgent.chatSessionId);
    } catch {
      // best-effort cancellation
    }

    const awaitCompletion = options?.awaitCompletion !== false;
    if (awaitCompletion) {
      try {
        await stream.run;
      } catch {
        // stream lifecycle converts errors into stream events
      }
    }

    if (!stream.done) {
      stream.events.push({ t: 'error', error: 'cancelled' });
      stream.done = true;
    }

    if (voiceAgent.activeTurnStream === stream) {
      voiceAgent.activeTurnStream = null;
    }
  }
}
