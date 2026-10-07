import { randomUUID } from 'node:crypto';
import { waitForChange } from '@/utils/async/waitForChange';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import {
  areExecutionRunBackendTargetsEqual,
  resolveExecutionRunRuntimeBackendId,
} from '@/agent/runtime/bridges/executionRun/backendTargets';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { extractVoiceActionsFromAssistantText } from '@happier-dev/protocol/voice/actions';
import { canAppendVoiceAgentOutputEventsV1, createVoiceAgentOutputTurnV1, fitVoiceAgentOutputTextV1, ingestVoiceAgentOutputEventV1, VOICE_OUTPUT_INCOMPLETE_TEXT } from '@happier-dev/protocol/voice/outputEvents';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { BackendTargetRefV1, ProviderBoundModelRef, ExecutionRunResumeHandle, VoiceAssistantAction } from '@happier-dev/protocol';

import { appendVoiceAgentHistoryContext, appendVoiceAgentHistoryTurn } from './voiceAgentHistory';
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
import { renderSessionInputContextPromptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import type { SessionFollowPreparedContext } from '@/agent/runtime/session/follow/sessionFollowContextReconciler';
import { isSessionProviderInputOutcomeTerminal } from '@/agent/runtime/session/input/providerInputOutcome';

export type {
  VoiceAgentCommitResult,
  VoiceAgentSendTurnResult,
  VoiceAgentStartParams,
  VoiceAgentStartResult,
  VoiceAgentTurnStreamReadResult,
  VoiceAgentTurnStreamStartResult,
} from './voiceAgentTypes';
export { VoiceAgentError } from './voiceAgentTypes';

export type VoiceAgentRuntimeAuthorityV1 = Readonly<{
  runtimeState: 'active_turn' | 'idle';
  activeTurnId: string | null;
}>;

function areVoiceModelSelectionsEqual(
  left: ProviderBoundModelRef | undefined,
  right: ProviderBoundModelRef | undefined,
): boolean {
  if (!left || !right) return left === right;
  return areExecutionRunBackendTargetsEqual(left.agentTargetKey, right.agentTargetKey)
    && left.providerConnectionId === right.providerConnectionId
    && left.modelId === right.modelId;
}

function assertVoiceModelSelectionMatches(
  selection: ProviderBoundModelRef | undefined,
  input: Readonly<{ backendTarget: BackendTargetRefV1; modelId: string; role: 'chat' | 'commit' }>,
): void {
  if (!selection) return;
  if (
    !areExecutionRunBackendTargetsEqual(selection.agentTargetKey, input.backendTarget)
    || selection.modelId !== input.modelId
  ) {
    throw new VoiceAgentError(
      'VOICE_AGENT_START_FAILED',
      `${input.role} model selection does not match the Voice Agent target and model`,
    );
  }
}

export class VoiceAgentManager {
  private static readonly MAX_HISTORY_TURNS = 48;
  private static readonly MAX_TURN_TEXT_CHARS = 4_000;
  private static readonly DEFAULT_IDLE_TTL_SECONDS = 60;
  private readonly createRuntime: BackendFactory;
  private readonly resolveSystemAppendBlocks: (args: ResolveVoiceSystemAppendBlocksArgs) => Promise<readonly string[]>;
  private readonly responseTimeoutMs: number;
  private readonly getNowMs: () => number;
  private readonly onIdleReaped: ((voiceAgentId: string) => Promise<void>) | null;
  private readonly onTerminalFailure: ((voiceAgentId: string, reason: 'backend_replacement_failed') => Promise<void>) | null;
  private readonly onResumeHandleChanged: ((voiceAgentId: string, handle: ExecutionRunResumeHandle | null) => void) | null;
  private readonly prepareFollowContext: ((input: Readonly<{
    executionRunId: string;
    requiredPrompt: string;
    signal: AbortSignal;
  }>) => Promise<SessionFollowPreparedContext | null>) | null;
  private readonly voiceAgents = new Map<string, VoiceAgentInstance>();
  private readonly startingVoiceAgents = new Map<string, {
    cancelled: boolean;
    provisionalCleanup: (() => Promise<void>) | null;
    settled: Promise<void>;
    resolveSettled: () => void;
  }>();
  private readonly retiringVoiceAgents = new Map<string, Promise<void>>();
  private readonly runtimeDisposals = new WeakMap<ExecutionRunHostRuntime, Promise<void>>();
  private readonly reaper: NodeJS.Timeout;
  private disposed = false;

  /**
   * Live currentness projection for the exact nested Voice runtime. The Voice
   * manager remains the sole owner of chat/commit replacement; callers receive
   * only liveness and turn state. The parent Execution Run controller owns the
   * stable occurrence across chat and isolated-commit runtime replacement.
   */
  readCurrentRuntimeAuthority(voiceAgentId: string): VoiceAgentRuntimeAuthorityV1 | null {
    if (this.disposed || this.startingVoiceAgents.has(voiceAgentId) || this.retiringVoiceAgents.has(voiceAgentId)) {
      return null;
    }
    const voiceAgent = this.voiceAgents.get(voiceAgentId);
    if (!voiceAgent) return null;

    const readActive = (runtime: ExecutionRunHostRuntime | null): ReturnType<NonNullable<ExecutionRunHostRuntime['readActiveTurnAdmissionWitness']>> | null | undefined => {
      if (!runtime || runtime.getRuntimeLifetimeSignal().aborted) return null;
      try {
        return runtime.readActiveTurnAdmissionWitness?.() ?? undefined;
      } catch {
        return null;
      }
    };
    const chatActive = readActive(voiceAgent.chatBackend);
    if (chatActive === null) return null;
    const commitActive = voiceAgent.commitBackend ? readActive(voiceAgent.commitBackend) : undefined;
    if (commitActive === null || (chatActive && commitActive)) return null;
    const runtime = commitActive ? voiceAgent.commitBackend : voiceAgent.chatBackend;
    if (!runtime) return null;
    return Object.freeze({
      runtimeState: chatActive || commitActive ? 'active_turn' : 'idle',
      activeTurnId: (commitActive ?? chatActive)?.turnId ?? null,
    });
  }

  private unsubscribeBestEffort(unsubscribe: () => void): void {
    try {
      unsubscribe();
    } catch {
      // Subscription cleanup is a system-boundary best effort. Runtime
      // retirement must still run even when a provider disposer throws.
    }
  }

  private closeTurnStream(stream: VoiceAgentTurnStreamState | null): void {
    if (!stream) return;
    // Closing this pagination stream is separate from the provider turn and
    // its pending durable handoff, which retain their own graceful lifecycle.
    stream.done = true;
    stream.onEventsChanged();
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

  private beginRetirement(voiceAgentId: string, cleanup: () => Promise<void>): Promise<void> {
    const existing = this.retiringVoiceAgents.get(voiceAgentId);
    if (existing) return existing;

    let retirement!: Promise<void>;
    retirement = Promise.resolve()
      .then(cleanup)
      .finally(() => {
        if (this.retiringVoiceAgents.get(voiceAgentId) === retirement) {
          this.retiringVoiceAgents.delete(voiceAgentId);
        }
      });
    this.retiringVoiceAgents.set(voiceAgentId, retirement);
    return retirement;
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

  private async prepareFollowContextForPrompt(
    backend: ExecutionRunHostRuntime,
    prompt: string,
    durableUserTranscriptLocalId?: string,
    executionRunId?: string,
  ): Promise<SessionFollowPreparedContext | null> {
    // Follow settlement is defined only at the canonical provider-input outcome
    // boundary. A retained runtime without that boundary must not receive Follow
    // context that it can never acknowledge precisely.
    if (!backend.subscribeProviderInputOutcomes || !durableUserTranscriptLocalId || !executionRunId) return null;
    const followContext = await this.prepareFollowContext?.({
      executionRunId,
      requiredPrompt: prompt,
      signal: backend.getRuntimeLifetimeSignal(),
    }) ?? null;
    if (!followContext) return null;
    return {
      ...followContext,
      acknowledgeAccepted: (evidence) => {
        followContext.acknowledgeAccepted(evidence);
        const voiceAgent = executionRunId ? this.voiceAgents.get(executionRunId) : null;
        if (voiceAgent?.chatBackend !== backend || followContext.updates.length === 0) return;
        appendVoiceAgentHistoryContext(voiceAgent.history, {
          text: renderSessionInputContextPromptV1({ transformedUserText: '', sessionFollowUpdates: followContext.updates }),
          maxTurns: VoiceAgentManager.MAX_HISTORY_TURNS,
          maxTurnTextChars: VoiceAgentManager.MAX_TURN_TEXT_CHARS,
        });
      },
    };
  }

  /**
   * The single Voice entry point onto the host input ABI. `deliverInput` reports a
   * refusal as a value rather than a throw, so admission is checked here: every Voice
   * turn below this point may assume the prompt actually reached the Agent, exactly as
   * it could when delivery failures always threw.
   */
  private async deliverPrompt(
    backend: ExecutionRunHostRuntime,
    runtimeId: string,
    prompt: string,
    context?: Parameters<ExecutionRunHostRuntime['deliverInput']>[2],
    followContext?: SessionFollowPreparedContext | null,
    durableUserTranscriptLocalId?: string,
  ): Promise<void> {
    const composedPrompt = followContext
      ? renderSessionInputContextPromptV1({
          transformedUserText: prompt,
          sessionFollowUpdates: followContext.updates,
        })
      : prompt;
    const localInputId = durableUserTranscriptLocalId ?? randomUUID();
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    if (followContext && backend.subscribeProviderInputOutcomes) {
      unsubscribe = backend.subscribeProviderInputOutcomes((outcome) => {
        if (
          settled
          || outcome.localId !== localInputId
          || !isSessionProviderInputOutcomeTerminal(outcome)
        ) return;
        settled = true;
        if (unsubscribe) this.unsubscribeBestEffort(unsubscribe);
        if (outcome.kind === 'accepted') {
          followContext.acknowledgeAccepted({
            kind: 'admitted_input',
            localInputId: outcome.localId,
            userMessageSeq: outcome.userMessageSeq,
          });
        }
      });
      if (settled) this.unsubscribeBestEffort(unsubscribe);
    }
    let result: Awaited<ReturnType<ExecutionRunHostRuntime['deliverInput']>>;
    try {
      result = await backend.deliverInput(
        runtimeId,
        { text: composedPrompt },
        { ...context, localId: localInputId },
      );
    } catch (error) {
      settled = true;
      if (unsubscribe) this.unsubscribeBestEffort(unsubscribe);
      throw error;
    }
    if (result.status === 'admitted') return;
    settled = true;
    if (unsubscribe) this.unsubscribeBestEffort(unsubscribe);
    throw new VoiceAgentError(
      result.status === 'unsupported' ? 'VOICE_AGENT_UNSUPPORTED' : 'VOICE_AGENT_START_FAILED',
      result.diagnostic.message ?? `Voice prompt was not admitted (${result.status})`,
    );
  }

  private subscribeToChatBackend(
    voiceAgent: VoiceAgentInstance,
    backend: ExecutionRunHostRuntime,
    generation: number,
  ): () => void {
    return backend.subscribeMessages((msg: AgentMessage) => {
      if (voiceAgent.chatBackend !== backend || voiceAgent.chatGeneration !== generation) return;
      if (msg.type === 'event' && msg.name === 'provider_session_id') {
        this.notifyResumeHandleChanged(voiceAgent);
        return;
      }
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
              if (typeof next.outputSpeechText === 'string') activeStream.outputSpeechText = next.outputSpeechText;
              if (next.outputBudget) activeStream.outputBudget = next.outputBudget;
              if (typeof next.outputIncomplete === 'boolean') activeStream.outputIncomplete = next.outputIncomplete;
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
      // A cancelled provider runtime is tainted: provision a genuinely fresh
      // runtime before changing the live instance, then swap atomically.
      const replacementRuntime = await replacementBackend.provisionRuntime();
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
      voiceAgent.chatSessionId = replacementRuntime.runtimeId;
      voiceAgent.chatGeneration = replacementGeneration;
      voiceAgent.chatSessionSeeded = false;
      voiceAgent.clearChatBuffer();
      voiceAgent.unsubscribeChatMessages = replacementUnsubscribe;
      this.unsubscribeBestEffort(previousUnsubscribe);
      this.notifyResumeHandleChanged(voiceAgent);
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
    onResumeHandleChanged?: (voiceAgentId: string, handle: ExecutionRunResumeHandle | null) => void;
    prepareFollowContext?: (input: Readonly<{
      executionRunId: string;
      requiredPrompt: string;
      signal: AbortSignal;
    }>) => Promise<SessionFollowPreparedContext | null>;
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
    this.onResumeHandleChanged = opts.onResumeHandleChanged ?? null;
    this.prepareFollowContext = typeof opts.prepareFollowContext === 'function' ? opts.prepareFollowContext : null;
    const intervalMs = Math.max(5_000, Math.floor(opts.reaperIntervalMs ?? 30_000));
    this.reaper = setInterval(() => {
      void this.reapIdle();
    }, intervalMs);
    this.reaper.unref?.();
  }

  getResumeHandle(voiceAgentId: string): ExecutionRunResumeHandle | null {
    const voiceAgent = this.voiceAgents.get(voiceAgentId) ?? null;
    if (!voiceAgent) return null;
    const chatProviderSessionId = voiceAgent.chatBackend.readProviderSessionId?.() ?? null;
    if (!chatProviderSessionId) return null;
    const commitProviderSessionId = voiceAgent.commitBackend?.readProviderSessionId?.() ?? null;
    if (commitProviderSessionId) {
      return {
        kind: 'voice_agent_sessions.v1',
        backendTarget: readBackendTargetRefV2(voiceAgent.backendTarget),
        chatProviderSessionId,
        commitProviderSessionId,
      };
    }
    return {
      kind: 'provider_session.v1',
      backendTarget: readBackendTargetRefV2(voiceAgent.backendTarget),
      providerSessionId: chatProviderSessionId,
    };
  }

  private notifyResumeHandleChanged(voiceAgent: VoiceAgentInstance): void {
    if (
      this.voiceAgents.get(voiceAgent.id) !== voiceAgent
      || this.retiringVoiceAgents.has(voiceAgent.id)
      || this.disposed
    ) return;
    this.onResumeHandleChanged?.(voiceAgent.id, this.getResumeHandle(voiceAgent.id));
  }

  async waitForRetirement(voiceAgentId: string): Promise<void> {
    const retirement = this.retiringVoiceAgents.get(voiceAgentId)
      ?? this.voiceAgents.get(voiceAgentId)?.lifecycleInFlight
      ?? null;
    if (!retirement) return;
    await retirement.catch(() => {});
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
      // Publish the provisional runtime to the unpublished instance before the
      // first await. A concurrent stop then reaches the same instance disposer,
      // and both that path and this failure path converge on disposeRuntimeOnce.
      voiceAgent.commitBackend = commitBackend;
      commitBackend.subscribeMessages((msg: AgentMessage) => {
        if (voiceAgent.commitBackend !== commitBackend) return;
        if (msg.type === 'event' && msg.name === 'provider_session_id') {
          this.notifyResumeHandleChanged(voiceAgent);
          return;
        }
        if (msg.type !== 'model-output') return;
        if (typeof msg.textDelta === 'string') voiceAgent.commitBuffer += msg.textDelta;
        if (typeof msg.fullText === 'string') voiceAgent.commitBuffer = msg.fullText;
      });

      const runtimeId = await (async () => {
        return (
          await commitBackend.provisionRuntime(
            voiceAgent.commitResumeSessionId
              ? { resumeRuntimeId: voiceAgent.commitResumeSessionId }
              : undefined,
          )
        ).runtimeId;
      })();
      voiceAgent.commitSessionId = runtimeId;
      voiceAgent.commitResumeSessionId = null;
      this.notifyResumeHandleChanged(voiceAgent);
    } catch (e: unknown) {
      if (voiceAgent.commitBackend === commitBackend) {
        voiceAgent.commitBackend = null;
        voiceAgent.commitSessionId = null;
      }
      if (commitBackend) await this.disposeRuntimeOnce(commitBackend).catch(() => {});
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
      : VoiceAgentManager.DEFAULT_IDLE_TTL_SECONDS;
    const idleTtlMs =
      Math.max(1, rawTtlSeconds) * 1000;
    const verbosity: Verbosity = params.verbosity === 'balanced' ? 'balanced' : 'short';
    const disabledActionIds = Array.isArray(params.disabledActionIds)
      ? params.disabledActionIds.map((value) => String(value ?? '').trim()).filter(Boolean)
      : [];
    if (
      this.voiceAgents.has(voiceAgentId)
      || this.startingVoiceAgents.has(voiceAgentId)
      || this.retiringVoiceAgents.has(voiceAgentId)
    ) {
      throw new VoiceAgentError('VOICE_AGENT_START_FAILED', 'Voice agent is already active');
    }
    let resolveStartSettled!: () => void;
    const startSettled = new Promise<void>((resolve) => {
      resolveStartSettled = resolve;
    });
    const startOccurrence = {
      cancelled: false,
      provisionalCleanup: null as (() => Promise<void>) | null,
      settled: startSettled,
      resolveSettled: resolveStartSettled,
    };
    this.startingVoiceAgents.set(voiceAgentId, startOccurrence);
    const ensureCurrentStart = (): void => {
      if (
        this.disposed
        || startOccurrence.cancelled
        || this.startingVoiceAgents.get(voiceAgentId) !== startOccurrence
      ) {
        throw new VoiceAgentError('VOICE_AGENT_START_FAILED', 'Voice agent start was cancelled');
      }
    };
    const createRuntime = options?.createRuntime ?? this.createRuntime;
    const backendId = resolveExecutionRunRuntimeBackendId(params.backendTarget);

    let chatBackendForCleanup: ExecutionRunHostRuntime | undefined;
    let instanceForCleanup: VoiceAgentInstance | null = null;
    try {
      const memoryRecallGuidanceEnabled = await resolveCliMemoryRecallGuidanceEnabled({
        surfaces: ['voice'],
      });
      ensureCurrentStart();
      const systemAppendBlocks = await this.resolveSystemAppendBlocks({
        profileId: params.profileId ?? null,
        sessionId: params.contextSessionId ?? null,
      });
      ensureCurrentStart();
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
      // The start occurrence owns one cleanup handle as soon as a runtime exists.
      // Stop may invoke it while provisioning or READY is still pending; the
      // runtime WeakMap and the instance disposer make the eventual start catch
      // converge on the same disposal rather than retiring it twice.
      startOccurrence.provisionalCleanup = () => instanceForCleanup
        ? instanceForCleanup.dispose()
        : this.disposeRuntimeOnce(chatBackend);

      const clearChatBuffer = () => {
        if (instanceForCleanup) instanceForCleanup.chatBuffer = '';
      };
      const clearCommitBuffer = () => {
        if (instanceForCleanup) instanceForCleanup.commitBuffer = '';
      };
      const chatSessionId = await (async () => {
        return (
          await chatBackend.provisionRuntime(
            resume.chatSessionId
              ? { resumeRuntimeId: resume.chatSessionId }
              : undefined,
          )
        ).runtimeId;
      })();
      ensureCurrentStart();

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
        ...(params.voicePolicy ? { voicePolicy: {
          assistantLanguage: params.voicePolicy.assistantLanguage,
          welcome: { ...params.voicePolicy.welcome },
        } } : {}),
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
              this.closeTurnStream(instance.activeTurnStream);
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
      instanceForCleanup = instance;
      instance.unsubscribeChatMessages = this.subscribeToChatBackend(instance, chatBackend, instance.chatGeneration);

      if (resume.commitSessionId) {
        await this.ensureCommitBackendSession(instance);
        ensureCurrentStart();
      }

      const bootstrapMode = params.bootstrapMode ?? 'none';
      if (!resume.chatSessionId && bootstrapMode === 'ready_handshake') {
        const shouldDeferInitialContextUntilFirstTurn = params.initialContextMode === 'first_turn';
        instance.clearChatBuffer();
        const prompt = buildVoiceAgentBootstrapPrompt({
          verbosity: instance.verbosity,
          initialContext: shouldDeferInitialContextUntilFirstTurn ? '' : instance.initialContext,
          mode: 'ready_handshake',
          voicePolicy: instance.voicePolicy,
          disabledActionIds: instance.disabledActionIds,
          memoryRecallGuidanceEnabled: instance.memoryRecallGuidanceEnabled,
          systemAppendBlocks: instance.systemAppendBlocks,
        });
        await this.deliverPrompt(instance.chatBackend, instance.chatSessionId, prompt);
        ensureCurrentStart();
        if (instance.chatBackend.waitForTurnCompletion) {
          await instance.chatBackend.waitForTurnCompletion(this.resolveResponseTimeoutMs(params.bootstrapTimeoutMs));
          ensureCurrentStart();
        }
        const response = instance.chatBuffer.trim();
        if (response.toUpperCase() !== 'READY') {
          throw new VoiceAgentError('VOICE_AGENT_START_FAILED', 'Bootstrap failed');
        }
        instance.clearChatBuffer();
        instance.chatSessionSeeded = !shouldDeferInitialContextUntilFirstTurn;
        // A readiness handshake is not a greeting to the user.
        instance.welcomed = false;
      }

      ensureCurrentStart();
      this.startingVoiceAgents.delete(voiceAgentId);
      this.voiceAgents.set(voiceAgentId, instance);

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
      if (registeredVoiceAgent && registeredVoiceAgent === instanceForCleanup) {
        this.voiceAgents.delete(voiceAgentId);
        disposals.push(registeredVoiceAgent.dispose());
      } else if (instanceForCleanup) {
        disposals.push(instanceForCleanup.dispose());
      } else if (chatBackendForCleanup) {
        disposals.push(this.disposeRuntimeOnce(chatBackendForCleanup));
      }
      await Promise.allSettled(disposals);
      if (e instanceof VoiceAgentError) {
        throw e;
      }
      throw new VoiceAgentError('VOICE_AGENT_START_FAILED', e instanceof Error ? e.message : 'start failed');
    } finally {
      if (this.startingVoiceAgents.get(voiceAgentId) === startOccurrence) {
        this.startingVoiceAgents.delete(voiceAgentId);
      }
      startOccurrence.resolveSettled();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.reaper);

    for (const occurrence of this.startingVoiceAgents.values()) {
      occurrence.cancelled = true;
      void occurrence.provisionalCleanup?.().catch(() => {});
    }
    this.startingVoiceAgents.clear();

    const toStop = [...this.voiceAgents.values()];
    for (const voiceAgent of toStop) this.closeTurnStream(voiceAgent.activeTurnStream);
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
                history: voiceAgent.history,
                voicePolicy: voiceAgent.voicePolicy,
                welcomeAlreadyDelivered: voiceAgent.welcomed,
                userText: params.userText,
                disabledActionIds: voiceAgent.disabledActionIds,
                memoryRecallGuidanceEnabled: voiceAgent.memoryRecallGuidanceEnabled,
                systemAppendBlocks: voiceAgent.systemAppendBlocks,
              });
          const followContext = await this.prepareFollowContextForPrompt(
            voiceAgent.chatBackend,
            prompt,
          );
		      await this.deliverPrompt(voiceAgent.chatBackend, voiceAgent.chatSessionId, prompt, undefined, followContext);
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

  async welcome(params: Readonly<{
    voiceAgentId: string;
    welcomeText?: string;
    causalPermissionAuthority?: import('@happier-dev/protocol').SessionInputCausalPermissionAuthorityV1;
  }>): Promise<Readonly<{ assistantText: string }>> {
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
        voicePolicy: voiceAgent.voicePolicy,
        welcomeText: params.welcomeText,
        disabledActionIds: voiceAgent.disabledActionIds,
        memoryRecallGuidanceEnabled: voiceAgent.memoryRecallGuidanceEnabled,
        systemAppendBlocks: voiceAgent.systemAppendBlocks,
      });
      await this.deliverPrompt(
        voiceAgent.chatBackend,
        voiceAgent.chatSessionId,
        prompt,
        params.causalPermissionAuthority
          ? { causalPermissionAuthority: params.causalPermissionAuthority }
          : undefined,
      );
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
    speechSegmentTargetChars?: number;
    durableUserTranscriptLocalId?: string;
    causalPermissionAuthority?: import('@happier-dev/protocol').SessionInputCausalPermissionAuthorityV1;
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
    const eventWaiters = new Set<() => void>();
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
      outputSpeechText: '',
      outputBudget: createVoiceAgentOutputTurnV1(streamId),
      outputIncomplete: false,
      suppressActionDeltas: false,
      outputSeq: 0,
      outputSegmentIndex: 0,
      targetChars: params.speechSegmentTargetChars,
      eventWaiters,
      onEventsChanged: () => { for (const wake of eventWaiters) wake(); },
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
      stream.onEventsChanged();
      return true;
    };

    const run = (async () => {
      try {
        const prompt = voiceAgent.chatSessionSeeded
          ? buildVoiceAgentUserTurnPrompt({ userText: params.userText })
          : buildVoiceAgentSeededUserTurnPrompt({
              verbosity: voiceAgent.verbosity,
              initialContext: voiceAgent.initialContext,
              history: voiceAgent.history,
              voicePolicy: voiceAgent.voicePolicy,
              welcomeAlreadyDelivered: voiceAgent.welcomed,
              userText: params.userText,
              disabledActionIds: voiceAgent.disabledActionIds,
              memoryRecallGuidanceEnabled: voiceAgent.memoryRecallGuidanceEnabled,
              systemAppendBlocks: voiceAgent.systemAppendBlocks,
            });
        const followContext = await this.prepareFollowContextForPrompt(
          voiceAgent.chatBackend,
          prompt,
          params.durableUserTranscriptLocalId,
          params.voiceAgentId,
        );
        // Follow hydration is an awaited network read, so a barge-in or explicit
        // cancel can land while it is pending. Delivery is the provider effect
        // boundary: a turn already reported cancelled must not reach the backend
        // — which is still live at this point — and must not acknowledge the
        // Follow frontier for content nothing ever consumed.
        if (settleCancelled()) return;
        await this.deliverPrompt(
          voiceAgent.chatBackend,
          voiceAgent.chatSessionId,
          prompt,
          params.causalPermissionAuthority
            ? { causalPermissionAuthority: params.causalPermissionAuthority }
            : undefined,
          followContext,
          params.durableUserTranscriptLocalId,
        );
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
          if (typeof next.outputSpeechText === 'string') stream.outputSpeechText = next.outputSpeechText;
          if (next.outputBudget) stream.outputBudget = next.outputBudget;
          if (typeof next.outputIncomplete === 'boolean') stream.outputIncomplete = next.outputIncomplete;
          if (typeof next.outputSeq === 'number') stream.outputSeq = next.outputSeq;
          if (typeof next.outputSegmentIndex === 'number') stream.outputSegmentIndex = next.outputSegmentIndex;
        });

        if (settleCancelled()) return;
        const assistantText = voiceAgent.chatBuffer.trim();
        const extracted = extractVoiceActionsFromAssistantText(assistantText);
        const desiredText = this.normalizeAssistantTextForActions(extracted.assistantText, extracted.actions);
        const finalCandidate = { v: 1, kind: 'turn_final', turnId: stream.id, seq: stream.outputSeq, text: desiredText } as const;
        let cleanText = fitVoiceAgentOutputTextV1(stream.outputBudget, finalCandidate, '', VOICE_OUTPUT_INCOMPLETE_TEXT);
        if (cleanText.length < desiredText.length) {
          stream.outputIncomplete = true;
        }
        if (stream.outputIncomplete) {
          // Speech already consumed is retained in the terminal transcript even
          // when a later provider fullText changes its wording.
          if (stream.outputSpeechText && !cleanText.startsWith(stream.outputSpeechText.trimEnd())) {
            cleanText = stream.outputSpeechText.trimEnd();
          }
        }
        const admittedActions: VoiceAssistantAction[] = [];
        const actionEvents: VoiceAgentTurnStreamState['events'] = [];
        let plannedBudget = stream.outputBudget;
        let plannedSeq = stream.outputSeq;
        for (const [actionIndex, action] of extracted.actions.entries()) {
          const output = {
            v: 1, kind: 'side_effect', turnId: stream.id, seq: plannedSeq,
            effectId: `${stream.id}:effect:${actionIndex}`, action,
          } as const;
          if (!canAppendVoiceAgentOutputEventsV1(plannedBudget, [
            output, { ...finalCandidate, seq: plannedSeq + 1, text: `${cleanText}${VOICE_OUTPUT_INCOMPLETE_TEXT}` },
          ]) || !canAppendVoiceAgentOutputEventsV1(plannedBudget, [
            output, { ...finalCandidate, seq: plannedSeq + 1, text: `${stream.outputSpeechText.trimEnd()}${VOICE_OUTPUT_INCOMPLETE_TEXT}` },
          ])) {
            stream.outputIncomplete = true;
            break;
          }
          admittedActions.push(action);
          actionEvents.push({ t: 'voice_output', output });
          plannedBudget = ingestVoiceAgentOutputEventV1(plannedBudget, output).state;
          plannedSeq += 1;
        }
        if (admittedActions.length !== extracted.actions.length) {
          cleanText = fitVoiceAgentOutputTextV1(plannedBudget, {
            ...finalCandidate, seq: plannedSeq,
            text: this.normalizeAssistantTextForActions(extracted.assistantText, admittedActions),
          }, '', VOICE_OUTPUT_INCOMPLETE_TEXT);
          if (stream.outputSpeechText && !cleanText.startsWith(stream.outputSpeechText.trimEnd())) {
            cleanText = stream.outputSpeechText.trimEnd();
          }
        }
        if (stream.outputIncomplete) cleanText += VOICE_OUTPUT_INCOMPLETE_TEXT;
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
        stream.events.push(...actionEvents);
        stream.outputBudget = plannedBudget;
        stream.outputSeq = plannedSeq;
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
        stream.onEventsChanged();
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
    params: Readonly<{ voiceAgentId: string; streamId: string; cursor: number; maxEvents?: number; waitForEvents?: boolean; signal?: AbortSignal }>,
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
    if (params.waitForEvents && cursor === stream.events.length && !stream.done) {
      await waitForChange({
        subscribe: (wake) => { stream.eventWaiters.add(wake); return () => { stream.eventWaiters.delete(wake); }; },
        hasChanged: () => cursor < stream.events.length || stream.done,
        signal: params.signal,
      });
    }
    params.signal?.throwIfAborted();
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

  async commit(params: Readonly<{
    voiceAgentId: string;
    maxChars?: number;
    causalPermissionAuthority?: import('@happier-dev/protocol').SessionInputCausalPermissionAuthorityV1;
  }>): Promise<VoiceAgentCommitResult> {
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
            await this.deliverPrompt(
              voiceAgent.chatBackend,
              voiceAgent.chatSessionId,
              prompt,
              params.causalPermissionAuthority
                ? { causalPermissionAuthority: params.causalPermissionAuthority }
                : undefined,
            );
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
		      await this.deliverPrompt(
            voiceAgent.commitBackend!,
            voiceAgent.commitSessionId!,
            prompt,
            params.causalPermissionAuthority
              ? { causalPermissionAuthority: params.causalPermissionAuthority }
              : undefined,
          );
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
    if (!voiceAgent) {
      const starting = this.startingVoiceAgents.get(params.voiceAgentId);
      if (!starting) throw new VoiceAgentError('VOICE_AGENT_NOT_FOUND', 'Voice agent not found');
      starting.cancelled = true;
      this.beginRetirement(params.voiceAgentId, async () => {
        await starting.settled;
      });
      this.startingVoiceAgents.delete(params.voiceAgentId);
      // Cleanup is initiated but deliberately not awaited: the execution-run
      // lifecycle owner must be able to publish terminal cancellation even if
      // a provider disposal never settles.
      void starting.provisionalCleanup?.().catch(() => {});
      return { ok: true };
    }
    const retirement = this.beginRetirement(params.voiceAgentId, async () => {
      try {
        if (voiceAgent.lifecycleInFlight) {
          await voiceAgent.lifecycleInFlight.catch(() => {});
        } else if (voiceAgent.activeTurnStream) {
          if (voiceAgent.activeTurnStream.done || voiceAgent.activeTurnStream.completedHistory) {
            // Stop retires the whole voice-agent instance; it is not a claim that
            // an already committed turn was cancelled. Public turn cancellation
            // rejects this state so the bridge can preserve its durable pair.
            this.closeTurnStream(voiceAgent.activeTurnStream);
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
      } finally {
        await voiceAgent.dispose();
      }
    });
    // Publish retirement before removing the live occurrence. ExecutionRun
    // terminal truth may settle immediately, while same-id resume must still
    // wait for this exact Voice cleanup to finish.
    this.voiceAgents.delete(params.voiceAgentId);

    await retirement;
		    return { ok: true };
		  }

  private async reapIdle(): Promise<void> {
    const now = this.getNowMs();
    const reaping: Promise<void>[] = [];
    for (const voiceAgent of this.voiceAgents.values()) {
      if (voiceAgent.lifecycleInFlight || voiceAgent.inFlight) continue;
      if (now - voiceAgent.lastUsedAt <= voiceAgent.idleTtlMs) continue;

      const lifecycle = this.beginRetirement(voiceAgent.id, async () => {
        try {
          await this.onIdleReaped?.(voiceAgent.id);
        } finally {
          if (this.voiceAgents.get(voiceAgent.id) === voiceAgent) {
            this.voiceAgents.delete(voiceAgent.id);
          }
          await voiceAgent.dispose();
        }
      });
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
    stream.onEventsChanged();
    let cancellationSucceeded = false;
    try {
      await voiceAgent.chatBackend.cancel(voiceAgent.chatSessionId);
      cancellationSucceeded = true;
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
      const canContinue = cancellationSucceeded && awaitCompletion
        && await voiceAgent.chatBackend.canContinueAfterCancellation?.(this.resolveResponseTimeoutMs()).catch(() => false);
      if (!canContinue) await this.replaceChatBackendAfterCancellation(voiceAgent);
    } else {
      this.unsubscribeBestEffort(voiceAgent.unsubscribeChatMessages);
    }

    if (voiceAgent.activeTurnStream === stream) {
      voiceAgent.activeTurnStream = null;
    }
  }
}
