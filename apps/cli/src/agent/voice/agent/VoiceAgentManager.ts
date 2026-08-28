import { randomUUID } from 'node:crypto';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import { resolveExecutionRunRuntimeBackendId } from '@/agent/runtime/bridges/executionRun/backendTargets';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import {
  extractVoiceActionsFromAssistantText,
  buildBackendTargetKeyV2,
  readBackendTargetRefV2,
  type BackendTargetRefV1,
  type ProviderBoundModelRef,
  type ExecutionRunResumeHandle,
  type VoiceAssistantAction,
} from '@happier-dev/protocol';

import { appendVoiceAgentHistoryTurn } from './voiceAgentHistory';
import {
  buildVoiceAgentBootstrapPrompt,
  buildVoiceAgentCommitPrompt,
  buildVoiceAgentSeededUserTurnPrompt,
  buildVoiceAgentUserTurnPrompt,
} from './voiceAgentPrompts';
import { finalizeVoiceAgentStreamingSpeech, ingestVoiceAgentStreamingDelta } from './voiceAgentStreamingDeltas';
import { resolveCliMemoryRecallGuidanceEnabled } from '@/agent/prompts/library/resolveCliMemoryRecallGuidanceEnabled';
import type {
  BackendFactory,
  ResolveVoiceSystemAppendBlocksArgs,
  VoiceAgentInstance,
  VoiceAgentTurn,
  VoiceAgentTurnStreamState,
  Verbosity,
  VoiceAgentCommitResult,
  VoiceAgentSendTurnResult,
  VoiceAgentStartParams,
  VoiceAgentStartResult,
  VoiceAgentTurnStreamReadResult,
  VoiceAgentTurnStreamStartResult,
} from './voiceAgentTypes';
import type { PermissionIntent } from '@happier-dev/agents';
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

function areVoiceModelSelectionsEqual(
  left: ProviderBoundModelRef | undefined,
  right: ProviderBoundModelRef | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.agentTargetKey === right.agentTargetKey
    && left.providerConnectionId === right.providerConnectionId
    && left.modelId === right.modelId;
}

function assertVoiceModelSelectionMatches(
  selection: ProviderBoundModelRef | undefined,
  input: Readonly<{ backendTarget: BackendTargetRefV1; modelId: string; role: 'chat' | 'commit' }>,
): void {
  if (!selection) return;
  const targetKey = buildBackendTargetKeyV2(readBackendTargetRefV2(input.backendTarget));
  if (selection.agentTargetKey !== targetKey || selection.modelId !== input.modelId) {
    throw new VoiceAgentError(
      'VOICE_AGENT_START_FAILED',
      `${input.role} model selection does not match the Voice Agent target and model`,
    );
  }
}

export class VoiceAgentManager {
  private static readonly MAX_HISTORY_TURNS = 48;
  private static readonly MAX_TURN_TEXT_CHARS = 4_000;
  private static readonly MIN_IDLE_TTL_SECONDS = 60;
  private static readonly MAX_IDLE_TTL_SECONDS = 6 * 60 * 60; // 6h
  private readonly createRuntime: BackendFactory;
  private readonly resolveSystemAppendBlocks: (args: ResolveVoiceSystemAppendBlocksArgs) => Promise<readonly string[]>;
  private readonly responseTimeoutMs: number;
  private readonly getNowMs: () => number;
  private readonly onIdleReaped: ((voiceAgentId: string) => Promise<void>) | null;
  private readonly onTerminalFailure: ((voiceAgentId: string, reason: 'backend_replacement_failed') => Promise<void>) | null;
  private readonly voiceAgents = new Map<string, VoiceAgentInstance>();
  private readonly runtimeDisposals = new WeakMap<ExecutionRunHostRuntime, Promise<void>>();
  private readonly reaper: NodeJS.Timeout;
  private disposed = false;

  private unsubscribeBestEffort(unsubscribe: () => void): void {
    try {
      unsubscribe();
    } catch {
      // Subscription cleanup is a system-boundary best effort. Runtime
      // retirement must still run even when a provider disposer throws.
    }
  }

  private disposeRuntimeOnce(runtime: ExecutionRunHostRuntime): Promise<void> {
    const existing = this.runtimeDisposals.get(runtime);
    if (existing) return existing;
    const disposal = Promise.resolve()
      .then(() => runtime.dispose())
      .then(() => undefined, () => undefined);
    this.runtimeDisposals.set(runtime, disposal);
    return disposal;
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

  private subscribeToChatBackend(
    voiceAgent: VoiceAgentInstance,
    backend: ExecutionRunHostRuntime,
    generation: number,
  ): () => void {
    return backend.subscribeMessages((msg: AgentMessage) => {
      if (voiceAgent.chatBackend !== backend || voiceAgent.chatGeneration !== generation) return;
      if (msg.type !== 'model-output') return;
      const activeStream = voiceAgent.activeTurnStream;
      if (activeStream?.cancelled) return;
      if (typeof msg.textDelta === 'string') {
        voiceAgent.chatBuffer += msg.textDelta;
        if (activeStream && !activeStream.done) {
          ingestVoiceAgentStreamingDelta(
            activeStream,
            (next) => {
              if (typeof next.deltaHold === 'string') activeStream.deltaHold = next.deltaHold;
              if (typeof next.outputSpeechBuffer === 'string') activeStream.outputSpeechBuffer = next.outputSpeechBuffer;
              if (typeof next.outputSpeechChars === 'number') activeStream.outputSpeechChars = next.outputSpeechChars;
              if (typeof next.suppressActionDeltas === 'boolean') activeStream.suppressActionDeltas = next.suppressActionDeltas;
              if (typeof next.outputSeq === 'number') activeStream.outputSeq = next.outputSeq;
              if (typeof next.outputSegmentIndex === 'number') activeStream.outputSegmentIndex = next.outputSegmentIndex;
            },
            msg.textDelta,
          );
        }
      }
      if (typeof msg.fullText === 'string') {
        voiceAgent.chatBuffer = msg.fullText;
      }
    });
  }

  private async replaceChatBackendAfterCancellation(voiceAgent: VoiceAgentInstance): Promise<void> {
    const previousBackend = voiceAgent.chatBackend;
    const previousUnsubscribe = voiceAgent.unsubscribeChatMessages;
    let replacementBackend: ExecutionRunHostRuntime | null = null;
    let replacementUnsubscribe: (() => void) | null = null;
    try {
      replacementBackend = voiceAgent.createRuntime({
        backendTarget: voiceAgent.backendTarget,
        backendId: voiceAgent.backendId,
        modelId: voiceAgent.chatModelId,
        ...(voiceAgent.chatModelSelection ? { modelSelection: voiceAgent.chatModelSelection } : {}),
        ...(voiceAgent.sessionConfigOptionOverrides
          ? { sessionConfigOptionOverrides: voiceAgent.sessionConfigOptionOverrides }
          : {}),
        permissionIntent: voiceAgent.permissionIntent,
        start: { intent: 'voice_agent' },
        ...(voiceAgent.connectedServices !== undefined ? { connectedServices: voiceAgent.connectedServices } : {}),
      });
      if (replacementBackend === previousBackend) {
        throw new Error('Cancelled backend factory returned the tainted runtime instance');
      }
      // A cancelled provider session is tainted: provision a genuinely fresh
      // session before changing the live instance, then swap atomically.
      const replacementSession = await replacementBackend.provisionSession();
      if (this.voiceAgents.get(voiceAgent.id) !== voiceAgent) {
        await this.disposeRuntimeOnce(replacementBackend);
        return;
      }
      const replacementGeneration = voiceAgent.chatGeneration + 1;
      replacementUnsubscribe = this.subscribeToChatBackend(
        voiceAgent,
        replacementBackend,
        replacementGeneration,
      );

      // Commit the new generation only after every fallible preparation step
      // has succeeded. Until this point the canonical instance still owns and
      // can retire the previous generation.
      voiceAgent.chatBackend = replacementBackend;
      voiceAgent.chatSessionId = replacementSession.sessionId;
      voiceAgent.chatGeneration = replacementGeneration;
      voiceAgent.chatSessionSeeded = false;
      voiceAgent.clearChatBuffer();
      voiceAgent.unsubscribeChatMessages = replacementUnsubscribe;
      this.unsubscribeBestEffort(previousUnsubscribe);
    } catch {
      if (replacementUnsubscribe) this.unsubscribeBestEffort(replacementUnsubscribe);
      if (replacementBackend && replacementBackend !== previousBackend) {
        await this.disposeRuntimeOnce(replacementBackend);
      }
      if (this.voiceAgents.get(voiceAgent.id) === voiceAgent) this.voiceAgents.delete(voiceAgent.id);
      voiceAgent.activeTurnStream = null;
      await voiceAgent.dispose();
      await this.onTerminalFailure?.(voiceAgent.id, 'backend_replacement_failed');
      return;
    }
    if (replacementBackend !== previousBackend) {
      await this.disposeRuntimeOnce(previousBackend);
    }
  }

  constructor(opts: Readonly<{
    createRuntime?: BackendFactory;
    createBackend?: BackendFactory;
    resolveSystemAppendBlocks?: (args: ResolveVoiceSystemAppendBlocksArgs) => Promise<readonly string[]>;
    responseTimeoutMs?: number;
    getNowMs?: () => number;
    reaperIntervalMs?: number;
    onIdleReaped?: (voiceAgentId: string) => Promise<void>;
    onTerminalFailure?: (voiceAgentId: string, reason: 'backend_replacement_failed') => Promise<void>;
  }>) {
    const createRuntime = opts.createRuntime ?? opts.createBackend;
    if (!createRuntime) {
      throw new Error('VoiceAgentManager requires a runtime factory');
    }
    this.createRuntime = createRuntime;
    this.resolveSystemAppendBlocks = opts.resolveSystemAppendBlocks ?? (async () => []);
    this.responseTimeoutMs =
      typeof opts.responseTimeoutMs === 'number' && Number.isFinite(opts.responseTimeoutMs) && opts.responseTimeoutMs > 0
        ? Math.floor(opts.responseTimeoutMs)
        : 120_000;
    this.getNowMs = opts.getNowMs ?? (() => Date.now());
    this.onIdleReaped = typeof opts.onIdleReaped === 'function' ? opts.onIdleReaped : null;
    this.onTerminalFailure = typeof opts.onTerminalFailure === 'function' ? opts.onTerminalFailure : null;
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
        backendTarget: readBackendTargetRefV2(voiceAgent.backendTarget),
        chatProviderSessionId: voiceAgent.chatSessionId,
        commitProviderSessionId: voiceAgent.commitSessionId,
      };
    }
    return {
      kind: 'provider_session.v1',
      backendTarget: readBackendTargetRefV2(voiceAgent.backendTarget),
      providerSessionId: voiceAgent.chatSessionId,
    };
  }

  private async ensureCommitBackendSession(voiceAgent: VoiceAgentInstance): Promise<void> {
    if (voiceAgent.commitBackend && voiceAgent.commitSessionId) {
      return;
    }

    let commitBackend: ExecutionRunHostRuntime | null = null;
    try {
      commitBackend = voiceAgent.createRuntime({
        backendTarget: voiceAgent.backendTarget,
        backendId: voiceAgent.backendId,
        modelId: voiceAgent.commitModelId,
        ...(voiceAgent.commitModelSelection ? { modelSelection: voiceAgent.commitModelSelection } : {}),
        ...(voiceAgent.sessionConfigOptionOverrides
          ? { sessionConfigOptionOverrides: voiceAgent.sessionConfigOptionOverrides }
          : {}),
        permissionIntent: voiceAgent.permissionIntent,
        start: { intent: 'voice_agent' },
        ...(voiceAgent.connectedServices !== undefined ? { connectedServices: voiceAgent.connectedServices } : {}),
      });
      commitBackend.subscribeMessages((msg: AgentMessage) => {
        if (msg.type !== 'model-output') return;
        if (typeof msg.textDelta === 'string') voiceAgent.commitBuffer += msg.textDelta;
        if (typeof msg.fullText === 'string') voiceAgent.commitBuffer = msg.fullText;
      });

      const sessionId = await (async () => {
        return (
          await commitBackend.provisionSession(
            voiceAgent.commitResumeSessionId
              ? { resumeSessionId: voiceAgent.commitResumeSessionId }
              : undefined,
          )
        ).sessionId;
      })();

      voiceAgent.commitBackend = commitBackend;
      voiceAgent.commitSessionId = sessionId;
      voiceAgent.commitResumeSessionId = null;
    } catch (e: unknown) {
      if (commitBackend) await commitBackend.dispose().catch(() => {});
      throw new VoiceAgentError('VOICE_AGENT_START_FAILED', e instanceof Error ? e.message : 'commit backend unavailable');
    }
  }

  async start(
    params: VoiceAgentStartParams,
    options?: Readonly<{ createRuntime?: BackendFactory }>,
  ): Promise<VoiceAgentStartResult> {
    if (this.disposed) {
      throw new VoiceAgentError('VOICE_AGENT_START_FAILED', 'Manager is disposed');
    }
    assertVoiceModelSelectionMatches(params.chatModelSelection, {
      backendTarget: params.backendTarget,
      modelId: params.chatModelId,
      role: 'chat',
    });
    assertVoiceModelSelectionMatches(params.commitModelSelection, {
      backendTarget: params.backendTarget,
      modelId: params.commitModelId,
      role: 'commit',
    });

    const voiceAgentId = typeof params.voiceAgentId === 'string' && params.voiceAgentId.trim().length > 0
      ? params.voiceAgentId.trim()
      : randomUUID();
    const rawTtlSeconds = Number.isFinite(params.idleTtlSeconds)
      ? Math.floor(params.idleTtlSeconds)
      : VoiceAgentManager.MIN_IDLE_TTL_SECONDS;
    const idleTtlMs =
      Math.max(VoiceAgentManager.MIN_IDLE_TTL_SECONDS, Math.min(VoiceAgentManager.MAX_IDLE_TTL_SECONDS, rawTtlSeconds)) * 1000;
    const verbosity: Verbosity = params.verbosity === 'balanced' ? 'balanced' : 'short';
    const disabledActionIds = Array.isArray(params.disabledActionIds)
      ? params.disabledActionIds.map((value) => String(value ?? '').trim()).filter(Boolean)
      : [];
    const memoryRecallGuidanceEnabled = await resolveCliMemoryRecallGuidanceEnabled({
      surfaces: ['voice'],
    });
    const systemAppendBlocks = await this.resolveSystemAppendBlocks({
      profileId: params.profileId ?? null,
      sessionId: params.contextSessionId ?? null,
    });
    const createRuntime = options?.createRuntime ?? this.createRuntime;
    const backendId = resolveExecutionRunRuntimeBackendId(params.backendTarget);

    let chatBackendForCleanup: ExecutionRunHostRuntime | undefined;
    try {
      const resume = (() => {
        const handle = params.resumeHandle ?? null;
        if (!handle) return { chatSessionId: null as string | null, commitSessionId: null as string | null };
        if (handle.kind === 'provider_session.v1') {
          return { chatSessionId: handle.providerSessionId as string, commitSessionId: null as string | null };
        }
        return {
          chatSessionId: handle.chatProviderSessionId as string,
          commitSessionId: handle.commitProviderSessionId as string,
        };
      })();

      const chatBackend = (chatBackendForCleanup = createRuntime({
        backendTarget: params.backendTarget,
        backendId,
        modelId: params.chatModelId,
        ...(params.chatModelSelection ? { modelSelection: params.chatModelSelection } : {}),
        ...(params.sessionConfigOptionOverrides
          ? { sessionConfigOptionOverrides: params.sessionConfigOptionOverrides }
          : {}),
        permissionIntent: params.permissionIntent,
        start: { intent: 'voice_agent' },
        ...(params.connectedServices !== undefined ? { connectedServices: params.connectedServices } : {}),
      }));

      let instanceRef: VoiceAgentInstance | null = null;
      const clearChatBuffer = () => {
        if (instanceRef) instanceRef.chatBuffer = '';
      };
      const clearCommitBuffer = () => {
        if (instanceRef) instanceRef.commitBuffer = '';
      };
      const chatSessionId = await (async () => {
        return (
          await chatBackend.provisionSession(
            resume.chatSessionId
              ? { resumeSessionId: resume.chatSessionId }
              : undefined,
          )
        ).sessionId;
      })();

      const instance: VoiceAgentInstance = {
        id: voiceAgentId,
        backendTarget: params.backendTarget,
        backendId,
        createRuntime,
        chatBackend,
        chatSessionId,
        commitIsolation: params.commitIsolation === true,
        commitBackend: null,
        commitSessionId: null,
        commitResumeSessionId: resume.commitSessionId,
        permissionIntent: params.permissionIntent,
        verbosity,
        chatModelId: params.chatModelId,
        commitModelId: params.commitModelId,
        ...(params.chatModelSelection ? { chatModelSelection: params.chatModelSelection } : {}),
        ...(params.commitModelSelection ? { commitModelSelection: params.commitModelSelection } : {}),
        ...(params.sessionConfigOptionOverrides
          ? { sessionConfigOptionOverrides: params.sessionConfigOptionOverrides }
          : {}),
        initialContext: params.initialContext,
        ...(params.connectedServices !== undefined ? { connectedServices: params.connectedServices } : {}),
        disabledActionIds,
        memoryRecallGuidanceEnabled,
        systemAppendBlocks: [...systemAppendBlocks],
        chatSessionSeeded: Boolean(resume.chatSessionId),
        welcomed: Boolean(resume.chatSessionId),
        history: [] as VoiceAgentTurn[],
        lastUsedAt: this.getNowMs(),
        idleTtlMs,
        inFlight: null,
        lifecycleInFlight: null,
        chatGeneration: 0,
        chatBuffer: '',
        commitBuffer: '',
        clearChatBuffer,
        clearCommitBuffer,
        unsubscribeChatMessages: () => {},
        activeTurnStream: null,
        dispose: (() => {
          let disposeInFlight: Promise<void> | null = null;
          return () => {
            if (disposeInFlight) return disposeInFlight;
            disposeInFlight = (async () => {
              this.unsubscribeBestEffort(instance.unsubscribeChatMessages);
              const disposals: Promise<unknown>[] = [this.disposeRuntimeOnce(instance.chatBackend)];
              if (instance.commitBackend && instance.commitBackend !== instance.chatBackend) {
                disposals.push(this.disposeRuntimeOnce(instance.commitBackend));
              }
              await Promise.allSettled(disposals);
            })();
            return disposeInFlight;
          };
        })(),
      };
      instanceRef = instance;
      instance.unsubscribeChatMessages = this.subscribeToChatBackend(instance, chatBackend, instance.chatGeneration);

      this.voiceAgents.set(voiceAgentId, instance);

      if (resume.commitSessionId) {
        await this.ensureCommitBackendSession(instance);
      }

      const bootstrapMode = params.bootstrapMode ?? 'none';
      if (!resume.chatSessionId && bootstrapMode === 'ready_handshake') {
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
        await instance.chatBackend.sendPrompt(instance.chatSessionId, prompt);
        if (instance.chatBackend.waitForTurnCompletion) {
          await instance.chatBackend.waitForTurnCompletion(this.resolveResponseTimeoutMs(params.bootstrapTimeoutMs));
        }
        const response = instance.chatBuffer.trim();
        if (response.toUpperCase() !== 'READY') {
          throw new VoiceAgentError('VOICE_AGENT_START_FAILED', 'Bootstrap failed');
        }
        instance.clearChatBuffer();
        instance.chatSessionSeeded = !shouldDeferInitialContextUntilFirstTurn;
        instance.welcomed = !shouldDeferInitialContextUntilFirstTurn;
      }

      return {
        voiceAgentId,
        effective: {
          chatModelId: params.chatModelId,
          commitModelId: params.commitModelId,
          permissionIntent: params.permissionIntent,
        },
      };
    } catch (e: unknown) {
      const disposals: Promise<unknown>[] = [];
      const registeredVoiceAgent = this.voiceAgents.get(voiceAgentId) ?? null;
      if (chatBackendForCleanup && registeredVoiceAgent?.chatBackend === chatBackendForCleanup) {
        this.voiceAgents.delete(voiceAgentId);
        disposals.push(registeredVoiceAgent.dispose());
      } else if (chatBackendForCleanup) {
        disposals.push(chatBackendForCleanup.dispose());
      }
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
        if (m.lifecycleInFlight) await m.lifecycleInFlight.catch(() => {});
        if (m.inFlight) await m.inFlight.catch(() => {});
        await m.dispose();
      }),
    );
  }

  async sendTurn(params: Readonly<{ voiceAgentId: string; userText: string }>): Promise<VoiceAgentSendTurnResult> {
    const voiceAgent = this.voiceAgents.get(params.voiceAgentId);
    if (!voiceAgent) throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Voice agent not found');
    if (voiceAgent.lifecycleInFlight || voiceAgent.inFlight) throw new VoiceAgentError('VOICE_AGENT_BUSY', 'Voice agent busy');

    voiceAgent.lastUsedAt = this.getNowMs();
		    const run = (async () => {
		      voiceAgent.clearChatBuffer();
          const prompt = voiceAgent.chatSessionSeeded
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
		      if (voiceAgent.chatBackend.waitForTurnCompletion) {
		        await voiceAgent.chatBackend.waitForTurnCompletion(this.resolveResponseTimeoutMs());
		      }
          voiceAgent.chatSessionSeeded = true;
          voiceAgent.welcomed = true;
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

    voiceAgent.inFlight = run;
    try {
      return await run;
    } finally {
      if (voiceAgent.inFlight === run) voiceAgent.inFlight = null;
    }
  }

  async welcome(params: Readonly<{ voiceAgentId: string; welcomeText?: string }>): Promise<Readonly<{ assistantText: string }>> {
    const voiceAgent = this.voiceAgents.get(params.voiceAgentId);
    if (!voiceAgent) throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Voice agent not found');
    if (voiceAgent.lifecycleInFlight || voiceAgent.inFlight || voiceAgent.activeTurnStream) {
      throw new VoiceAgentError('VOICE_AGENT_BUSY', 'Voice agent busy');
    }

    // Idempotent across backend replacement: a second welcome would pollute conversation memory.
    if (voiceAgent.welcomed) return { assistantText: '' };

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
      if (voiceAgent.chatBackend.waitForTurnCompletion) {
        await voiceAgent.chatBackend.waitForTurnCompletion(this.resolveResponseTimeoutMs());
      }
      const assistantText = extractVoiceActionsFromAssistantText(voiceAgent.chatBuffer).assistantText;
      voiceAgent.clearChatBuffer();
      voiceAgent.chatSessionSeeded = true;
      voiceAgent.welcomed = true;
      return { assistantText };
    })();

    voiceAgent.inFlight = run;
    try {
      return await run;
    } finally {
      if (voiceAgent.inFlight === run) voiceAgent.inFlight = null;
    }
  }

  async startTurnStream(params: Readonly<{
    voiceAgentId: string;
    userText: string;
    onTurnFinal?: (assistantText: string) => Promise<void> | void;
  }>): Promise<VoiceAgentTurnStreamStartResult> {
    const voiceAgent = this.voiceAgents.get(params.voiceAgentId);
    if (!voiceAgent) throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Voice agent not found');
    if (voiceAgent.lifecycleInFlight || voiceAgent.inFlight || voiceAgent.activeTurnStream) {
      throw new VoiceAgentError('VOICE_AGENT_BUSY', 'Voice agent busy');
    }

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
      outputSpeechBuffer: '',
      outputSpeechChars: 0,
      suppressActionDeltas: false,
      outputSeq: 0,
      outputSegmentIndex: 0,
    };
    voiceAgent.activeTurnStream = stream;

    const settleCancelled = (): boolean => {
      if (!stream.cancelled) {
        return false;
      }
      stream.deltaHold = '';
      stream.outputSpeechBuffer = '';
      stream.suppressActionDeltas = true;
      voiceAgent.clearChatBuffer();
      if (!stream.events.some((event) => event.t === 'voice_output' && event.output.kind === 'turn_cancelled')) {
        stream.events.push({
          t: 'voice_output',
          output: { v: 1, kind: 'turn_cancelled', turnId: stream.id, seq: stream.outputSeq },
        });
        stream.outputSeq += 1;
      }
      stream.done = true;
      return true;
    };

    const run = (async () => {
      try {
        const prompt = voiceAgent.chatSessionSeeded
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
        if (settleCancelled()) return;
        if (voiceAgent.chatBackend.waitForTurnCompletion) {
          await voiceAgent.chatBackend.waitForTurnCompletion(this.resolveResponseTimeoutMs());
        }
        if (settleCancelled()) return;
        voiceAgent.chatSessionSeeded = true;
        voiceAgent.welcomed = true;
        if (settleCancelled()) return;

        // Flush any held chars that were buffered for action-tag detection.
        if (settleCancelled()) return;
        finalizeVoiceAgentStreamingSpeech(stream, (next) => {
          if (typeof next.deltaHold === 'string') stream.deltaHold = next.deltaHold;
          if (typeof next.outputSpeechBuffer === 'string') stream.outputSpeechBuffer = next.outputSpeechBuffer;
          if (typeof next.outputSpeechChars === 'number') stream.outputSpeechChars = next.outputSpeechChars;
          if (typeof next.outputSeq === 'number') stream.outputSeq = next.outputSeq;
          if (typeof next.outputSegmentIndex === 'number') stream.outputSegmentIndex = next.outputSegmentIndex;
        });

        if (settleCancelled()) return;
        const assistantText = voiceAgent.chatBuffer.trim();
        const extracted = extractVoiceActionsFromAssistantText(assistantText);
        const cleanText = this.normalizeAssistantTextForActions(extracted.assistantText, extracted.actions).slice(0, 65_536);
        if (settleCancelled()) return;
        appendVoiceAgentHistoryTurn(voiceAgent.history, {
          userText: params.userText,
          assistantText: cleanText,
          maxTurns: VoiceAgentManager.MAX_HISTORY_TURNS,
          maxTurnTextChars: VoiceAgentManager.MAX_TURN_TEXT_CHARS,
        });
        if (settleCancelled()) return;
        stream.completedHistory = true;
        if (settleCancelled()) return;
        await params.onTurnFinal?.(cleanText);
        if (settleCancelled()) return;
        for (const [actionIndex, action] of extracted.actions.entries()) {
          stream.events.push({
            t: 'voice_output',
            output: {
              v: 1,
              kind: 'side_effect',
              turnId: stream.id,
              seq: stream.outputSeq,
              effectId: `${stream.id}:effect:${actionIndex}`,
              action,
            },
          });
          stream.outputSeq += 1;
        }
        stream.events.push({
          t: 'voice_output',
          output: { v: 1, kind: 'turn_final', turnId: stream.id, seq: stream.outputSeq, text: cleanText },
        });
        stream.outputSeq += 1;
      } catch (error: unknown) {
        if (settleCancelled()) return;
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
    if (cursor > stream.events.length) {
      throw new VoiceAgentError('VOICE_AGENT_INVALID_CURSOR', 'Turn stream cursor is ahead of produced events');
    }
    const maxEvents =
      typeof params.maxEvents === 'number' && Number.isFinite(params.maxEvents) && params.maxEvents > 0
        ? Math.min(128, Math.floor(params.maxEvents))
        : 32;
    const end = Math.min(stream.events.length, cursor + maxEvents);
    const events = stream.events.slice(cursor, end);
    const done = stream.done && end >= stream.events.length;
    const terminalEvent = stream.done
      ? [...stream.events].reverse().find((event) => (
          event.t === 'error'
          || event.t === 'cancelled'
          || event.t === 'done'
          || (
            event.t === 'voice_output'
            && (event.output.kind === 'turn_final' || event.output.kind === 'turn_cancelled')
          )
        ))
      : undefined;

    if (done) {
      voiceAgent.activeTurnStream = null;
    }

    return {
      streamId: stream.id,
      events,
      nextCursor: end,
      done,
      ...(terminalEvent ? { terminalEvent } : {}),
    };
  }

  async cancelTurnStream(params: Readonly<{ voiceAgentId: string; streamId: string }>): Promise<{ ok: true }> {
    const voiceAgent = this.voiceAgents.get(params.voiceAgentId);
    if (!voiceAgent) throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Voice agent not found');
    const stream = voiceAgent.activeTurnStream;
    if (!stream || stream.id !== params.streamId) {
      throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Turn stream not found');
    }
    if (!voiceAgent.lifecycleInFlight) {
      const lifecycle = this.cancelActiveTurnStream(voiceAgent, stream);
      voiceAgent.lifecycleInFlight = lifecycle;
      void lifecycle.then(() => {
        if (voiceAgent.lifecycleInFlight === lifecycle) voiceAgent.lifecycleInFlight = null;
      }, () => {
        if (voiceAgent.lifecycleInFlight === lifecycle) voiceAgent.lifecycleInFlight = null;
      });
    }
    await voiceAgent.lifecycleInFlight;
    return { ok: true };
  }

  async commit(params: Readonly<{ voiceAgentId: string; maxChars?: number }>): Promise<VoiceAgentCommitResult> {
    const voiceAgent = this.voiceAgents.get(params.voiceAgentId);
    if (!voiceAgent) throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Voice agent not found');
    if (voiceAgent.lifecycleInFlight || voiceAgent.inFlight) throw new VoiceAgentError('VOICE_AGENT_BUSY', 'Voice agent busy');

    voiceAgent.lastUsedAt = this.getNowMs();
		    const run = (async () => {
          const canReuseChatBackend = voiceAgent.commitIsolation !== true
            && voiceAgent.commitModelId === voiceAgent.chatModelId
            && areVoiceModelSelectionsEqual(
              voiceAgent.chatModelSelection,
              voiceAgent.commitModelSelection,
            );
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
            if (voiceAgent.chatBackend.waitForTurnCompletion) {
              await voiceAgent.chatBackend.waitForTurnCompletion(this.resolveResponseTimeoutMs());
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
		      if (voiceAgent.commitBackend!.waitForTurnCompletion) {
		        await voiceAgent.commitBackend!.waitForTurnCompletion(this.resolveResponseTimeoutMs());
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
    if (voiceAgent.lifecycleInFlight) {
      await voiceAgent.lifecycleInFlight.catch(() => {});
    } else if (voiceAgent.activeTurnStream) {
      if (voiceAgent.activeTurnStream.done || voiceAgent.activeTurnStream.completedHistory) {
        // Stop retires the whole voice-agent instance; it is not a claim that
        // an already committed turn was cancelled. Public turn cancellation
        // rejects this state so the bridge can preserve its durable pair.
        voiceAgent.activeTurnStream = null;
      } else {
        await this.cancelActiveTurnStream(voiceAgent, voiceAgent.activeTurnStream, {
          awaitCompletion: false,
          replaceBackend: false,
        });
      }
    }
    if (voiceAgent.inFlight && !voiceAgent.activeTurnStream) {
      await voiceAgent.inFlight.catch(() => {});
    }
    await voiceAgent.dispose();
		    return { ok: true };
		  }

  private async reapIdle(): Promise<void> {
    const now = this.getNowMs();
    const reaping: Promise<void>[] = [];
    for (const voiceAgent of this.voiceAgents.values()) {
      if (voiceAgent.lifecycleInFlight || voiceAgent.inFlight) continue;
      if (now - voiceAgent.lastUsedAt <= voiceAgent.idleTtlMs) continue;

      const lifecycle = (async () => {
        try {
          await this.onIdleReaped?.(voiceAgent.id);
        } finally {
          if (this.voiceAgents.get(voiceAgent.id) === voiceAgent) {
            this.voiceAgents.delete(voiceAgent.id);
          }
          await voiceAgent.dispose();
        }
      })();
      voiceAgent.lifecycleInFlight = lifecycle;
      reaping.push(lifecycle);
      void lifecycle.then(
        () => {
          if (voiceAgent.lifecycleInFlight === lifecycle) voiceAgent.lifecycleInFlight = null;
        },
        () => {
          if (voiceAgent.lifecycleInFlight === lifecycle) voiceAgent.lifecycleInFlight = null;
        },
      );
    }
    if (reaping.length === 0) return;
    await Promise.allSettled(reaping);
  }

  private async cancelActiveTurnStream(
    voiceAgent: VoiceAgentInstance,
    stream: VoiceAgentTurnStreamState,
    options?: Readonly<{ awaitCompletion?: boolean; replaceBackend?: boolean }>,
  ): Promise<void> {
    if (stream.done || stream.completedHistory) {
      throw new VoiceAgentError(
        'VOICE_AGENT_TURN_COMPLETED',
        'Turn already completed and cannot be cancelled',
      );
    }

    stream.cancelled = true;
    stream.deltaHold = '';
    stream.outputSpeechBuffer = '';
    stream.suppressActionDeltas = true;
    voiceAgent.clearChatBuffer();
    if (!stream.events.some((event) => event.t === 'voice_output' && event.output.kind === 'turn_cancelled')) {
      stream.events.push({
        t: 'voice_output',
        output: { v: 1, kind: 'turn_cancelled', turnId: stream.id, seq: stream.outputSeq },
      });
      stream.outputSeq += 1;
    }
    stream.done = true;
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

    if (options?.replaceBackend !== false) {
      await this.replaceChatBackendAfterCancellation(voiceAgent);
    } else {
      this.unsubscribeBestEffort(voiceAgent.unsubscribeChatMessages);
    }

    if (voiceAgent.activeTurnStream === stream) {
      voiceAgent.activeTurnStream = null;
    }
  }
}
