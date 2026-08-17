import type { ApiSessionClient, SessionProviderInputOutcomeObserver } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { resolveAppendSystemPromptBaseOverride } from '@/agent/runtime/permission/appendSystemPromptField';
import {
  initializePermissionModeStateSync,
} from '@/agent/runtime/permission/permissionModeStateSync';
import { waitForNextPermissionModeMessage } from '@/agent/runtime/waitForNextPermissionModeMessage';
import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { PermissionModeQueuedPrompt } from '@/agent/runtime/permission/permissionModeQueuedPrompt';
import { resolveProviderPromptForDispatch } from '@/agent/runtime/prompt/resolveProviderPromptForDispatch';
import { normalizePendingDeliveryLocalIds } from '@/agent/runtime/session/pendingDelivery/undeliverableProviderPrompt';
import { isAbortLikeError } from '@/agent/executionRuns/runtime/turnDelivery';
import { configuration } from '@/configuration';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import { readPendingLocalId } from '@happier-dev/protocol';
import { readNewestSessionModelsMetadataStateV1 } from '@happier-dev/agents';
import {
  resolveProviderPromptFailureDeliveryReason,
  type ProviderPromptWithMeta,
} from '@/agent/runtime/providerPromptSubmission';

type PromptRuntime = {
  beginTurn: () => void;
  startOrLoad: (opts: { resumeId?: string; importHistory?: boolean; deferPendingDrain?: boolean }) => Promise<unknown>;
  drainPendingAfterStartOrLoad?: () => Promise<void>;
  sendPrompt: (message: string) => Promise<void>;
  sendPromptWithMeta?: (params: ProviderPromptWithMeta) => Promise<void>;
  // Read at dispatch to reconstruct provider context for composer references (INV-9).
  listVendorPlugins?: () => Promise<unknown>;
  listSkills?: () => Promise<unknown>;
  compactContext?: (command: string) => Promise<void>;
  failTurn?: (error: unknown) => void | boolean | Promise<void | boolean>;
  flushTurn: () => void | Promise<void>;
  reset: () => Promise<void>;
  getSessionId: () => string | null;
  shouldResumeAfterPermissionModeChange?: () => boolean;
};

type OverrideSynchronizer = {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
};

type QueuedPermissionModeMessage = {
  message: PermissionModeQueuedPrompt;
  mode: { permissionMode: PermissionMode; appendSystemPrompt?: string | null };
  hash: string;
  maxUserMessageSeq: number | null;
  userMessageLocalIds: readonly string[];
};

export type ReadyNotificationTurnContext = Readonly<{
  turnToken: string | null;
  startSeqExclusive: number | null;
}>;

class StrictInitialResumeError extends Error {
  public readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'StrictInitialResumeError';
    this.cause = cause;
  }
}

class ResumeFailClosedError extends Error {
  public readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'ResumeFailClosedError';
    this.cause = cause;
  }
}

function normalizePositiveSeq(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

async function waitForCommittedUserPromptBoundary(
  session: ApiSessionClient,
  localId: string | null,
): Promise<number | null> {
  const exactLocalId = readPendingLocalId(localId);
  if (!exactLocalId) return null;

  const syncSeq = normalizePositiveSeq(session.getCommittedUserMessageSeq?.(exactLocalId));
  if (syncSeq !== null) return syncSeq;

  return normalizePositiveSeq(await session.waitForCommittedUserMessageSeq?.(exactLocalId, {
    timeoutMs: configuration.promptLoopUserMessageSeqWaitTimeoutMs,
  }));
}

export async function runPermissionModePromptLoop(opts: {
  providerName: string;
  providerId?: string;
  agentMessageType: Parameters<ApiSessionClient['sendAgentMessage']>[0];
  explicitPermissionMode: PermissionMode | undefined;
  session: ApiSessionClient;
  providerInputOutcomeObserver?: SessionProviderInputOutcomeObserver | null;
  messageQueue: MessageQueue2<{ permissionMode: PermissionMode; appendSystemPrompt?: string | null }, PermissionModeQueuedPrompt>;
  inputConsumer?: SessionProviderInputConsumer<{ permissionMode: PermissionMode; appendSystemPrompt?: string | null }, PermissionModeQueuedPrompt>;
  permissionHandler: ProviderEnforcedPermissionHandler;
  runtime: PromptRuntime;
  createOverrideSynchronizer: (isStarted: () => boolean) => OverrideSynchronizer;
  messageBuffer: MessageBuffer;
  shouldExit: () => boolean;
  getAbortSignal: () => AbortSignal;
  keepAlive: () => void;
  setThinking: (value: boolean) => void;
  sendReady: (context?: ReadyNotificationTurnContext) => void;
  currentPermissionModeUpdatedAt: number;
  setCurrentPermissionMode: (mode: PermissionMode) => void;
  setCurrentPermissionModeUpdatedAt: (updatedAt: number) => void;
  initialResumeId?: string;
  strictInitialResume?: boolean;
  failClosedOnResumeFailure?: boolean;
  startRuntimeBeforeFirstPrompt?: boolean;
  onAfterStart?: (() => void | Promise<void>) | null;
  onAfterReset?: (() => void | Promise<void>) | null;
  resolveFreshSessionSystemPrompt?: (args: {
    baseOverride?: string | null;
  }) => Promise<string | null | undefined>;
  formatPromptErrorMessage: (error: unknown) => string;
}): Promise<void> {
  let wasStarted = false;
  let currentModeHash: string | null = null;
  let pending: QueuedPermissionModeMessage | null = null;
  let storedSessionIdForResume: { value: string; origin: 'initial' | 'restart' } | null = null;
  let didReplaySeedBootstrap = false;
  let turnInFlight = false;
  let pendingFreshSessionSystemPrompt = false;
  let snapshotFreshForNextPromptBoundary = false;

  const normalizedResumeId = readNonBlankOpaqueIdentifier(opts.initialResumeId) ?? '';
  if (normalizedResumeId) {
    storedSessionIdForResume = { value: normalizedResumeId, origin: 'initial' };
  }

  const overrideSync = opts.createOverrideSynchronizer(() => wasStarted);
  const shouldDeferPostStartPendingDrain = () => typeof opts.runtime.drainPendingAfterStartOrLoad === 'function';
  const buildStartOrLoadOptions = (
    base: { resumeId?: string; importHistory?: boolean } = {},
  ): { resumeId?: string; importHistory?: boolean; deferPendingDrain?: boolean } => ({
    ...base,
    ...(shouldDeferPostStartPendingDrain() ? { deferPendingDrain: true } : {}),
  });

  const permissionModeStateSync = await initializePermissionModeStateSync({
    explicitPermissionMode: opts.explicitPermissionMode,
    session: opts.session,
    currentPermissionModeUpdatedAt: opts.currentPermissionModeUpdatedAt,
    take: 50,
    applyMode: ({ mode, updatedAt }) => {
      opts.setCurrentPermissionMode(mode);
      opts.setCurrentPermissionModeUpdatedAt(updatedAt);
      opts.permissionHandler.setPermissionMode(mode);
    },
  });
  opts.setCurrentPermissionModeUpdatedAt(permissionModeStateSync.permissionModeUpdatedAt);

  const syncPermissionModeFromMetadata = () => {
    const updatedAt = permissionModeStateSync.syncFromMetadata(opts.session.getMetadataSnapshot());
    opts.setCurrentPermissionModeUpdatedAt(updatedAt);
  };

  const refreshSessionSnapshotBeforeTurnBestEffort = async (): Promise<void> => {
    if (typeof opts.session.refreshSessionSnapshotFromServerBestEffort === 'function') {
      try {
        await opts.session.refreshSessionSnapshotFromServerBestEffort({ reason: 'waitForMetadataUpdate' });
        snapshotFreshForNextPromptBoundary = true;
      } catch {
        // Best-effort only: prompt delivery must not block on snapshot refresh failures.
      }
      return;
    }
    if (typeof opts.session.ensureMetadataSnapshot === 'function') {
      try {
        await opts.session.ensureMetadataSnapshot();
        snapshotFreshForNextPromptBoundary = true;
      } catch {
        // Best-effort only.
      }
    }
  };

  const confirmQueuedUserMessageDeliveredToProvider = (
    message: QueuedPermissionModeMessage,
    appliedModelId?: string | null,
  ): void => {
    const localIds = normalizePendingDeliveryLocalIds(message.userMessageLocalIds);
    if (localIds.length !== 1) return;
    const normalizedAppliedModelId = readNonBlankOpaqueIdentifier(appliedModelId);
    opts.providerInputOutcomeObserver?.({
      kind: 'accepted',
      localId: localIds[0],
      ...(normalizedAppliedModelId ? { appliedModelId: normalizedAppliedModelId } : {}),
    });
  };

  const reportQueuedUserMessageFailureBeforeProviderAcceptance = (
    message: QueuedPermissionModeMessage,
    error: unknown,
    didAttemptProviderSend: boolean,
  ): void => {
    const localIds = normalizePendingDeliveryLocalIds(message.userMessageLocalIds);
    if (localIds.length !== 1) return;
    const reason = resolveProviderPromptFailureDeliveryReason(error, didAttemptProviderSend);
    if (reason === 'ambiguous_terminal_delivery') {
      opts.providerInputOutcomeObserver?.({
        kind: 'effect_may_have_occurred',
        localId: localIds[0],
      });
      return;
    }
    opts.providerInputOutcomeObserver?.({
      kind: 'rejected_before_effect',
      localId: localIds[0],
      reason,
    });
  };

  const ensureFreshSessionSnapshotBeforeTurnBestEffort = async (): Promise<void> => {
    if (snapshotFreshForNextPromptBoundary) {
      return;
    }
    await refreshSessionSnapshotBeforeTurnBestEffort();
  };

  overrideSync.syncFromMetadata();

  const ensureRuntimeStarted = async (): Promise<{ startedFreshSessionForTurn: boolean }> => {
    if (wasStarted) return { startedFreshSessionForTurn: false };

    const resume = storedSessionIdForResume;
    const resumeId = readNonBlankOpaqueIdentifier(resume?.value) ?? '';
    let strictAbort: StrictInitialResumeError | null = null;
    let startedFreshSessionForTurn = false;

    if (resumeId) {
      storedSessionIdForResume = null; // consume once
      opts.messageBuffer.addMessage('Resuming previous context…', 'status');
      try {
        // Avoid importing ACP replay history into Happier on normal resume; Happier transcript is the source of truth.
        await opts.runtime.startOrLoad(buildStartOrLoadOptions({ resumeId, importHistory: false }));
      } catch (error) {
        if (opts.shouldExit()) return { startedFreshSessionForTurn };
        const shouldFailClosed =
          opts.failClosedOnResumeFailure === true ||
          (opts.strictInitialResume === true && resume?.origin === 'initial');
        if (shouldFailClosed) {
          const formatted = opts.formatPromptErrorMessage(error);
          opts.messageBuffer.addMessage(`Resume failed; cannot continue: ${formatted}`, 'status');
          opts.session.sendAgentMessage(opts.agentMessageType, { type: 'message', message: `Resume failed; cannot continue: ${formatted}` });
          try {
            await opts.runtime.reset();
          } catch {
            // ignore cleanup failure
          }
          if (opts.shouldExit()) return { startedFreshSessionForTurn };
          strictAbort = opts.strictInitialResume === true && resume?.origin === 'initial'
            ? new StrictInitialResumeError('Strict initial resume failed', error)
            : new ResumeFailClosedError('Resume failed closed', error);
        } else {
          opts.messageBuffer.addMessage('Resume failed; starting a new session.', 'status');
          opts.session.sendAgentMessage(opts.agentMessageType, { type: 'message', message: 'Resume failed; starting a new session.' });
          await opts.runtime.reset();
          if (opts.shouldExit()) return { startedFreshSessionForTurn };
          await opts.runtime.startOrLoad(buildStartOrLoadOptions());
          startedFreshSessionForTurn = true;
        }
      }
    } else {
      await opts.runtime.startOrLoad(buildStartOrLoadOptions());
      startedFreshSessionForTurn = true;
    }

    if (opts.shouldExit()) return { startedFreshSessionForTurn };
    if (strictAbort) throw strictAbort;

    await opts.onAfterStart?.();
    if (opts.shouldExit()) return { startedFreshSessionForTurn };
    wasStarted = true;
    await overrideSync.flushPendingAfterStart();
    if (opts.shouldExit()) return { startedFreshSessionForTurn };
    // Provider startup can publish metadata after the prompt-boundary refresh, so keep one post-start catch-up.
    await refreshSessionSnapshotBeforeTurnBestEffort();
    if (opts.shouldExit()) return { startedFreshSessionForTurn };
    syncPermissionModeFromMetadata();
    overrideSync.syncFromMetadata();
    await overrideSync.flushPendingAfterStart();
    if (opts.shouldExit()) return { startedFreshSessionForTurn };
    await opts.runtime.drainPendingAfterStartOrLoad?.();
    return { startedFreshSessionForTurn };
  };

  if (opts.startRuntimeBeforeFirstPrompt === true && !wasStarted) {
    await ensureFreshSessionSnapshotBeforeTurnBestEffort();
    if (opts.shouldExit()) return;
    overrideSync.syncFromMetadata();
    const eagerStart = await ensureRuntimeStarted();
    if (opts.shouldExit()) return;
    pendingFreshSessionSystemPrompt = eagerStart.startedFreshSessionForTurn;
  }

  while (!opts.shouldExit()) {
    let message: QueuedPermissionModeMessage | null = pending;
    pending = null;

    if (!message) {
      const next = await waitForNextPermissionModeMessage({
        messageQueue: opts.messageQueue,
        abortSignal: opts.getAbortSignal(),
        session: opts.session,
        inputConsumer: opts.inputConsumer,
        onMetadataUpdate: async () => {
          await refreshSessionSnapshotBeforeTurnBestEffort();
          syncPermissionModeFromMetadata();
          overrideSync.syncFromMetadata();
          if (!turnInFlight) {
            await overrideSync.flushPendingAfterStart();
          }
        },
      });
      if (!next) continue;
      message = {
        message: next.message,
        mode: next.mode,
        hash: next.hash,
        maxUserMessageSeq: next.maxUserMessageSeq ?? null,
        userMessageLocalIds: next.userMessageLocalIds ?? [],
      };
    }
    if (!message) continue;

    opts.permissionHandler.setPermissionMode(message.mode.permissionMode);

    if (wasStarted && currentModeHash && message.hash !== currentModeHash) {
      const resumeId = opts.runtime.getSessionId();
      currentModeHash = message.hash;
      const shouldResumeAfterPermissionModeChange =
        typeof opts.runtime.shouldResumeAfterPermissionModeChange === 'function'
          ? opts.runtime.shouldResumeAfterPermissionModeChange()
          : true;
      if (resumeId && shouldResumeAfterPermissionModeChange) {
        storedSessionIdForResume = { value: resumeId, origin: 'restart' };
      } else {
        storedSessionIdForResume = null;
      }

      opts.messageBuffer.addMessage(`Restarting ${opts.providerName} session (permission settings changed)…`, 'status');
      await opts.runtime.reset();
      if (opts.shouldExit()) break;
      wasStarted = false;
      pendingFreshSessionSystemPrompt = false;
      await opts.onAfterReset?.();
      if (opts.shouldExit()) break;
      opts.permissionHandler.reset();
      opts.setThinking(false);
      opts.keepAlive();

      pending = message;
      continue;
    }

    currentModeHash = message.hash;
    await ensureFreshSessionSnapshotBeforeTurnBestEffort();
    syncPermissionModeFromMetadata();
    overrideSync.syncFromMetadata();
    await overrideSync.flushPendingAfterStart();
    opts.messageBuffer.addMessage(message.message.text, 'user');

    const special = parseSpecialCommand(message.message.text);
    if (special.type === 'clear') {
      opts.messageBuffer.addMessage(`Resetting ${opts.providerName} session…`, 'status');
      await opts.runtime.reset();
      confirmQueuedUserMessageDeliveredToProvider(message);
      wasStarted = false;
      pendingFreshSessionSystemPrompt = false;
      await opts.onAfterReset?.();
      opts.permissionHandler.reset();
      opts.setThinking(false);
      opts.keepAlive();
      opts.messageBuffer.addMessage('Session reset.', 'status');
      opts.sendReady();
      continue;
    }

    let shouldSendReady = true;
    let suppressFlushTurnFailure = false;
    let didBeginRuntimeTurn = false;
    let readyTurnContext: ReadyNotificationTurnContext | undefined;
    let didAttemptProviderSend = false;
    let didConfirmProviderAccepted = false;
    let appliedModelIdForPrompt: string | null = null;
    const confirmProviderAccepted = (): void => {
      if (didConfirmProviderAccepted) return;
      didConfirmProviderAccepted = true;
      confirmQueuedUserMessageDeliveredToProvider(message, appliedModelIdForPrompt);
    };
    try {
      turnInFlight = true;
      let shouldApplyFreshSessionSystemPrompt = pendingFreshSessionSystemPrompt;
      pendingFreshSessionSystemPrompt = false;
      const localId = typeof message.message.localId === 'string' && message.message.localId ? message.message.localId : null;
      const committedUserMessageSeq = await waitForCommittedUserPromptBoundary(opts.session, localId);
      if (opts.shouldExit()) {
        shouldSendReady = false;
        break;
      }
      const lastObservedMessageSeq = typeof opts.session.getLastObservedMessageSeq === 'function'
        ? normalizePositiveSeq(opts.session.getLastObservedMessageSeq())
        : null;
      const startSeqExclusive = committedUserMessageSeq !== null && lastObservedMessageSeq !== null
        ? Math.max(committedUserMessageSeq, lastObservedMessageSeq)
        : committedUserMessageSeq ?? lastObservedMessageSeq;
      if (typeof opts.session.beginTurnAssistantTextSnapshot === 'function') {
        const turnToken = opts.session.beginTurnAssistantTextSnapshot({
          startSeqExclusive,
        });
        readyTurnContext = { turnToken, startSeqExclusive };
      }
      opts.runtime.beginTurn();
      didBeginRuntimeTurn = true;
      if (!wasStarted) {
        const runtimeStart = await ensureRuntimeStarted();
        if (opts.shouldExit()) {
          shouldSendReady = false;
          break;
        }
        shouldApplyFreshSessionSystemPrompt =
          runtimeStart.startedFreshSessionForTurn || shouldApplyFreshSessionSystemPrompt;
      }

      const special = parseSpecialCommand(message.message.text);
      if (special.type === 'compact' && typeof opts.runtime.compactContext === 'function') {
        const compact = async () => {
          await opts.runtime.compactContext!(special.originalMessage ?? message.message.text.trim());
        };
        if (opts.inputConsumer) {
          const outcome = await opts.inputConsumer.runProviderInputDispatch({
            abortSignal: opts.getAbortSignal(),
            dispatch: compact,
          });
          if (outcome.status === 'cancelled') {
            shouldSendReady = false;
            continue;
          }
        } else {
          await compact();
        }
        confirmQueuedUserMessageDeliveredToProvider(message);
        continue;
      }

      const nowMs = Date.now();
      const seedResolution = await resolveProviderPromptForDispatch({
        session: opts.session,
        userText: message.message.text,
        allowSeed: special.type === null,
        localId,
        nowMs,
        refreshMetadataBeforeRead: false,
        meta: message.message.meta,
        catalogs: {
          ...(typeof opts.runtime.listSkills === 'function'
            ? { listSkills: () => opts.runtime.listSkills!() }
            : {}),
          ...(typeof opts.runtime.listVendorPlugins === 'function'
            ? { listVendorPlugins: () => opts.runtime.listVendorPlugins!() }
            : {}),
        },
      });
      const dispatchMeta = seedResolution.meta;
      if (opts.shouldExit()) {
        shouldSendReady = false;
        break;
      }
      snapshotFreshForNextPromptBoundary = false;
      didReplaySeedBootstrap = true;
      const explicitBaseOverride = shouldApplyFreshSessionSystemPrompt
        ? resolveAppendSystemPromptBaseOverride(message.mode)
        : undefined;
      const freshSessionSystemPrompt = shouldApplyFreshSessionSystemPrompt
        ? await opts.resolveFreshSessionSystemPrompt?.({
            baseOverride: explicitBaseOverride,
          })
        : undefined;
      if (opts.shouldExit()) {
        shouldSendReady = false;
        break;
      }
      const effectiveAppendSystemPrompt = typeof freshSessionSystemPrompt === 'string'
        ? freshSessionSystemPrompt.trim()
        : '';
      const providerPrompt =
        shouldApplyFreshSessionSystemPrompt && effectiveAppendSystemPrompt.trim().length > 0
          ? `${effectiveAppendSystemPrompt.trim()}\n\n${seedResolution.providerPrompt}`
          : seedResolution.providerPrompt;

      const dispatchProviderPrompt = async () => {
        const modelState = readNewestSessionModelsMetadataStateV1(opts.session.getMetadataSnapshot());
        appliedModelIdForPrompt = (
          !opts.providerId
          || modelState?.provider === opts.providerId
        )
          ? modelState?.currentModelId ?? null
          : null;
        if (typeof opts.runtime.sendPromptWithMeta === 'function') {
          didAttemptProviderSend = true;
          await opts.runtime.sendPromptWithMeta({
            text: providerPrompt,
            localId,
            ...(dispatchMeta ? { meta: dispatchMeta as Record<string, unknown> } : {}),
            onProviderPromptAccepted: confirmProviderAccepted,
          });
          confirmProviderAccepted();
        } else {
          didAttemptProviderSend = true;
          await opts.runtime.sendPrompt(providerPrompt);
          confirmProviderAccepted();
        }
        if (seedResolution.seedApplied) {
          // Only now does the seed's carry-over context actually sit with the provider,
          // so this is the only safe point to retire it. Guarded so an ordinary turn
          // adds no extra await to the dispatch path.
          await seedResolution.settleReplaySeedOnProviderAcceptance();
        }
      };
      if (opts.inputConsumer) {
        const outcome = await opts.inputConsumer.runProviderInputDispatch({
          abortSignal: opts.getAbortSignal(),
          dispatch: dispatchProviderPrompt,
        });
        if (outcome.status === 'cancelled') {
          shouldSendReady = false;
          continue;
        }
      } else {
        await dispatchProviderPrompt();
      }
    } catch (error) {
      if (!didConfirmProviderAccepted) {
        reportQueuedUserMessageFailureBeforeProviderAcceptance(message, error, didAttemptProviderSend);
      }

      if (error instanceof StrictInitialResumeError || error instanceof ResumeFailClosedError) {
        shouldSendReady = false;
        suppressFlushTurnFailure = true;
        throw error;
      }
      if (!isAbortLikeError(error)) {
        let surfacedStructuredFailure = false;
        if (typeof opts.runtime.failTurn === 'function') {
          try {
            const result = await opts.runtime.failTurn(error);
            surfacedStructuredFailure = result !== false;
          } catch {
            surfacedStructuredFailure = false;
          }
        }
        if (!surfacedStructuredFailure) {
          opts.session.sendAgentMessage(opts.agentMessageType, { type: 'message', message: opts.formatPromptErrorMessage(error) });
        }
      }
    } finally {
      turnInFlight = false;
      if (didBeginRuntimeTurn && !opts.shouldExit()) {
        if (suppressFlushTurnFailure) {
          try {
            await opts.runtime.flushTurn();
          } catch {}
        } else {
          await opts.runtime.flushTurn();
        }
      }
      // Metadata updates can arrive while we're mid-turn.
      overrideSync.syncFromMetadata();
      opts.setThinking(false);
      opts.keepAlive();
      if (shouldSendReady && !opts.shouldExit()) {
        opts.sendReady(readyTurnContext);
      }
    }
  }
}
