import type { Metadata, PermissionMode, UserMessage } from '@/api/types';
import { readPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { isConditionalPendingSteerClaim } from '@happier-dev/protocol/sessions/messages/pendingDeliveryBlockedReason';
import { normalizePendingRequestedActionV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { readHappierStructuredInputV1FromMeta } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { readSessionInputCausalPermissionAuthorityV1, readSessionMessageProvenance } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { resolveSessionInputPromptProvenanceV1, renderSessionInputContextBlockV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import { readSessionMessageModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';
import { isModelRefGrantedV1, isPermissionModeGrantedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { ProviderBoundModelRef } from '@happier-dev/protocol';
import { readAdmittedHappierStructuredInputV1FromMeta } from '@happier-dev/protocol/runtime/input/structuredInputV1';

import { isAbortLikeError } from '@/agent/runtime/lifecycle/classifyAbortLikeError';
import { logger } from '@/ui/logger';
import { pushMessageToQueueWithSpecialCommands, type SpecialCommandQueue } from '@/agent/runtime/queueSpecialCommands';
import { resolveAppendSystemPromptModeOverride } from '@/agent/runtime/permissions/appendSystemPrompt';
import { resolveProviderPromptWithReplaySeed } from '@/agent/runtime/replaySeed/replaySeedV1';
import type { DurableProviderInputAcceptanceV1 } from '@/agent/runtime/session/input/providerInputOutcome';
import type {
  ReplaySeedSettlement,
  UnsettledReplaySeedRetirement,
} from '@/agent/runtime/replaySeed/unsettledReplaySeedRetirement';
import { isNonSteerablePromptPayload } from '@/cli/parsers/specialCommands';
import { readAdmittedSessionMediaInputForDispatchV1 } from '@/session/services/admitSessionStructuredInputV1';

import { normalizePermissionModeToIntent, resolvePermissionModeUpdatedAtFromMessage } from './modeCanonical';
import { resolvePermissionModeForQueueingUserMessage } from './modeFromUserMessage';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import type {
  PermissionModeQueuedPrompt,
  PermissionModeQueuedPromptMode,
} from '@/agent/runtime/permissions/queuedPrompt';
import { prepareSessionInputForProviderDispatch, readStructuredInputPreparationFailure, type SessionInputDispatchServices } from '@/agent/runtime/turns/prepareSessionInputForProviderDispatch';
import type { RuntimeTurnPromptMeta } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { HostPreparedContext } from '@/agent/runtime/session/contextOnly/hostContextOnlyInput';

/**
 * Config change carried by a steered message that the backend must own BEFORE the text joins the
 * active turn (lane Q). Today this is the permission mode only; new members must stay optional so
 * existing capability implementations keep compiling.
 */
export type SteerConfigDelta = Readonly<{
  permissionMode: PermissionMode;
}>;

/**
 * Outcome of an in-flight config-delta application (lane Q):
 * - `applied`: the backend verified the config is effective for the running turn.
 * - `scheduled_in_turn`: the backend owns the delta and will apply it at the next safe point
 *   DURING the current turn (still before/independent of the steered text's effect window).
 * - `unsupported` / `failed`: the backend cannot own the delta mid-turn — the message must take
 *   the legacy queue path (config applies when the queue drains at turn end).
 */
export type InFlightConfigApplyOutcome = Readonly<
  | { status: 'applied' }
  | { status: 'scheduled_in_turn' }
  | { status: 'unsupported'; reason?: string | undefined }
  | { status: 'failed'; reason?: string | undefined }
>;

export type InFlightInterruptOutcome = Readonly<
  | { status: 'interrupted' }
  | { status: 'deferred_until_turn_end' }
  | { status: 'unsupported'; reason?: string | undefined }
>;

export type InFlightSteerController = Readonly<{
  /** Exact running-session selection; null means the owner is not yet provable. */
  readActiveModelSelection?: () => ProviderBoundModelRef | null;
  /**
   * Whether the runtime is currently processing a turn (i.e. can accept steer input).
   */
  isTurnInFlight: () => boolean;
  /**
   * Whether the runtime/backend combination supports steering input into an active turn.
   */
  supportsInFlightSteer: () => boolean;
  isProviderNativeCommand?: (prompt: string) => boolean;
  readStructuredInputDispatchServices?: () => SessionInputDispatchServices;
  /**
   * Whether the current active turn can safely accept steering right now.
   *
   * Some runtimes can keep a turn marked in-flight briefly after a terminal event, or after
   * the selected runtime configuration changes. Unavailable explicit or ambient input uses the normal queue; conditional
   * claimed steering returns to ordinary Pending admission before provider effect.
   */
  canSteerPrompt?: () => boolean;
  /**
   * Non-authoritative routing snapshot from the shared session input consumer. Explicit or ambient input
   * observed blocked follows the existing queue path; conditional steering returns to Pending admission.
   * Provider dispatch authorization remains exclusively owned by runProviderInputDispatch.
   */
  isProviderInputAdmitted?: () => boolean;
  /**
   * Canonical admission/dispatch linearization owned by the shared session input consumer.
   */
  runProviderInputDispatch?: <Value>(opts: Readonly<{
    abortSignal: AbortSignal;
    dispatch: () => Promise<Value>;
  }>) => Promise<
    | Readonly<{ status: 'dispatched'; value: Value }>
    | Readonly<{ status: 'cancelled' }>
  >;
  /** Register a localId-correlated host effect consumed by canonical provider acceptance. */
  registerProviderAcceptedEffect: (
    localId: string,
    onAccepted: (() => void) | null,
  ) => void;
  /** Collect destination-owned Follow context at the steer provider-effect boundary. */
  prepareHostContext?: (input: Readonly<{
    signal: AbortSignal;
    /** Final required steer prompt before optional Follow blocks are admitted. */
    requiredPrompt: string;
    contextOnlyWorkerUpdate?: import('@happier-dev/protocol').WorkerUpdateV1;
  }>) => Promise<HostPreparedContext | null>;
  /**
   * Send additional user text to the in-flight turn.
   *
   * This should NOT abort the current turn.
   */
  steerText: (
    text: string,
    options?: RuntimeTurnPromptMeta,
  ) => Promise<void>;
  /**
   * Publish exact rejection evidence into the host's canonical provider-input outcome normalizer.
   * The normalizer remains the sole settlement owner.
   */
  rejectPromptBeforeProvider?: (info: Readonly<{
    localIds?: readonly string[];
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
    preparationFailure?: Readonly<{ code: string; retryable: boolean }>;
    reason?: 'unsupported_action' | 'steering_unavailable' | 'conditional_steer_unavailable' | 'model_not_granted' | 'permission_mode_not_granted';
  }>) => void;
  /**
   * Publish conservative effect-possible evidence after a provider steer invocation throws.
   * Provider-owned exact evidence remains authoritative at the host normalizer.
   */
  reportPromptEffectMayHaveOccurred?: (info: Readonly<{
    localIds?: readonly string[];
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
  }>) => void;
  interruptActiveTurn?: () => Promise<InFlightInterruptOutcome>;
  /**
   * OPTIONAL capability (lane Q): apply a config delta to the RUNNING turn so a config-carrying
   * message can still steer. Backends that cannot own mid-turn config changes (e.g. turn-boundary
   * protocols) simply do not implement this; explicit and ambient messages keep the queue path,
   * while conditional claimed steering returns to ordinary Pending admission.
   */
  applyConfigDeltaInFlight?: ((delta: SteerConfigDelta) => Promise<InFlightConfigApplyOutcome>) | undefined;
  /**
   * Demand signal: a message was queued behind the running turn (mode change, special command,
   * or steer fallback). Runtimes use it to arm bounded stale-turn recovery so a turn whose
   * completion evidence was lost cannot starve the queue forever (incident cmq7pyqkj, L1).
   */
  onPromptQueuedDuringTurn?: () => void;
}>;

export function registerPermissionModeMessageQueueBinding(opts: {
  session: PermissionModeQueueSessionBinding;
  agentTargetKey?: string;
  queue: SpecialCommandQueue<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>;
  getCurrentPermissionMode: () => PermissionMode | undefined;
  setCurrentPermissionMode: (mode: PermissionMode | undefined) => void;
  inFlightSteer?: InFlightSteerController | null;
  /** Session-scoped hold for an accepted seed whose metadata retirement has not succeeded. */
  replaySeedRetirement?: UnsettledReplaySeedRetirement;
}): {
  bindSession: (session: PermissionModeQueueSessionBinding) => void;
  releaseRejectedBeforeProviderPromptIdentity: (
    session: PermissionModeQueueSessionBinding,
    message: PermissionModeQueuedPrompt,
  ) => void;
} {
  let steerSequence: Promise<void> = Promise.resolve();
  let replaySeedSettlementSequence: Promise<void> = Promise.resolve();
  let didReplaySeedBootstrapForSteer = false;
  let currentSession = opts.session;
  let currentBindingGeneration = 0;
  let currentBindingAbortController = new AbortController();
  const handledUserPromptLocalIds = new Set<string>();
  const handledUserPromptSeqs = new Set<number>();

  const isCurrentBinding = (
    session: PermissionModeQueueSessionBinding,
    generation: number,
  ): boolean => currentSession === session && currentBindingGeneration === generation;

  const handleMessage = (session: PermissionModeQueueSessionBinding, message: UserMessage): boolean => {
    if (currentSession !== session) {
      return false;
    }
    const messageBindingGeneration = currentBindingGeneration;
    const messageBindingAbortSignal = currentBindingAbortController.signal;
    // The committed-seq tracker records the seq before this handler runs.
    const localId = readPendingLocalId(message.localId);
    const localIds = localId === null ? [] : [localId];
    const userMessageSeq = (() => {
      if (!localId || typeof session.getCommittedUserMessageSeq !== 'function') return null;
      const seq = session.getCommittedUserMessageSeq(localId);
      return typeof seq === 'number' && Number.isFinite(seq) ? seq : null;
    })();
    if (hasHandledUserPromptIdentity(localId, userMessageSeq)) {
      return true;
    }
    markHandledUserPromptIdentity(localId, userMessageSeq);

    const rejectCallerInput = (reason: 'model_not_granted' | 'permission_mode_not_granted'): void => {
      opts.inFlightSteer?.rejectPromptBeforeProvider?.({
        localIds, userMessageSeq,
        ...(userMessageSeq === null ? {} : { userMessageSeqs: [userMessageSeq] }),
        reason,
      });
    };
    const requestedPermissionMode = normalizePermissionModeToIntent(message.meta?.permissionMode)
      ?? opts.getCurrentPermissionMode() ?? 'default';
    if (message.callerInputConstraints && !isPermissionModeGrantedV1(message.callerInputConstraints, requestedPermissionMode)) {
      rejectCallerInput('permission_mode_not_granted');
      return true;
    }

    const resolvedMode = resolvePermissionModeForQueueingUserMessage({
      currentPermissionMode: opts.getCurrentPermissionMode(),
      messagePermissionModeRaw: message.meta?.permissionMode,
      updateMetadata: (updater) =>
        updateMetadataBestEffort(session, updater, '[permissionMode]', 'permission_mode_from_user_message'),
      nowMs: () => resolvePermissionModeUpdatedAtFromMessage(message),
    });

    opts.setCurrentPermissionMode(resolvedMode.currentPermissionMode);

    const text = message.content.text;
    // The queue consumes the canonical envelope Message admission persisted.
    // It must not rerun ingress local-path trust; alias-only legacy metadata is
    // the sole path that still reaches the compatibility reader below.
    const admittedStructuredInput = readAdmittedHappierStructuredInputV1FromMeta(message.meta);
    const causalPermissionAuthority = readSessionInputCausalPermissionAuthorityV1(message.meta);
    const inputProvenance = readSessionMessageProvenance(message.meta) ?? undefined;
    const inputContextBlock = renderSessionInputContextBlockV1({
      provenance: resolveSessionInputPromptProvenanceV1(message.meta),
    });
    const queuedPromptIdentityFields = {
      ...(localIds.length === 0 ? {} : { localIds }),
      ...(userMessageSeq === null ? {} : { userMessageSeq, userMessageSeqs: [userMessageSeq] }),
    };
    if (admittedStructuredInput.status === 'invalid') {
      try {
        opts.inFlightSteer?.rejectPromptBeforeProvider?.({
          ...(localIds.length === 0 ? {} : { localIds }),
          userMessageSeq,
          ...(userMessageSeq === null ? {} : { userMessageSeqs: [userMessageSeq] }),
        });
      } catch {
        // Fail-closed consumption must not crash the session queue binding.
      }
      return true;
    }
    const structuredInput = admittedStructuredInput.status === 'admitted'
      ? admittedStructuredInput.structuredInput
      : readHappierStructuredInputV1FromMeta(message.meta);
    const admittedSessionMedia = structuredInput
      ? readAdmittedSessionMediaInputForDispatchV1({
          meta: message.meta,
          structuredInput,
        })
      : { status: 'absent' as const };
    if (admittedSessionMedia.status === 'invalid') {
      try {
        opts.inFlightSteer?.rejectPromptBeforeProvider?.({
          ...(localIds.length === 0 ? {} : { localIds }),
          userMessageSeq,
          ...(userMessageSeq === null ? {} : { userMessageSeqs: [userMessageSeq] }),
        });
      } catch {
        // Fail-closed consumption must not crash the session queue binding.
      }
      return true;
    }
    // Alias-normalized change signal (ported S-6): a raw compare against the previous mode reads
    // an alias respelling ('acceptEdits' vs 'safe-yolo') as a change and wrongly blocks steering.
    const didChangePermissionMode = resolvedMode.didChange;
    const modelOverride = resolveModelOverrideFromUserMessage(message, opts.agentTargetKey);
    const modelSelection = (() => {
      if (!modelOverride || modelOverride.kind === 'invalid_structured') return null;
      if (modelOverride.kind === 'structured') return modelOverride.selection;
      const active = opts.inFlightSteer?.readActiveModelSelection?.() ?? null;
      return active?.providerConnectionId === null
        && active.agentTargetKey === opts.agentTargetKey
        ? { ...active, modelId: modelOverride.modelId }
        : null;
    })();
    if (
      modelOverride?.kind === 'invalid_structured'
      || (modelOverride?.kind === 'legacy' && !modelSelection)
    ) {
      try {
        opts.inFlightSteer?.rejectPromptBeforeProvider?.({
          ...(localIds.length === 0 ? {} : { localIds }),
          userMessageSeq,
          ...(userMessageSeq === null ? {} : { userMessageSeqs: [userMessageSeq] }),
        });
      } catch {
        // Fail-closed consumption must not crash the session queue binding.
      }
      return true;
    }
    const pendingProviderAction = message.pendingProviderAction === 'send'
      || message.pendingProviderAction === 'steer'
      || message.pendingProviderAction === 'interrupt_and_send'
      ? message.pendingProviderAction
      : null;
    const isExactClaimedSteer = pendingProviderAction === 'steer';
    const requestedAction = (() => {
      try {
        return normalizePendingRequestedActionV1(
          message.pendingRequestedAction,
        );
      } catch {
        return null;
      }
    })();
    const exactSteerRejectionReason = isConditionalPendingSteerClaim({
      requestedAction,
      providerAction: pendingProviderAction,
    })
      ? 'conditional_steer_unavailable' as const
      : 'steering_unavailable' as const;
    const queueMode: PermissionModeQueuedPromptMode = {
      ...(message.callerInputConstraints ? { callerInputConstraints: message.callerInputConstraints } : {}),
      permissionMode: resolvedMode.queuePermissionMode,
      ...resolveAppendSystemPromptModeOverride(message.meta),
      ...(modelSelection
        ? { modelSelection }
        : {}),
      ...(causalPermissionAuthority ? { causalPermissionAuthority } : {}),
      ...(inputContextBlock ? { inputContextBlock } : {}),
      ...(inputProvenance ? { inputProvenance } : {}),
    };
    const queuedPrompt: PermissionModeQueuedPrompt = {
      text,
      localId,
      ...queuedPromptIdentityFields,
      ...(structuredInput ? { structuredInput } : {}),
      ...(admittedSessionMedia.status === 'admitted'
        ? { sessionMedia: admittedSessionMedia.media }
        : {}),
      ...(causalPermissionAuthority ? { causalPermissionAuthority } : {}),
      ...(inputContextBlock ? { inputContextBlock } : {}),
      ...(inputProvenance ? { inputProvenance } : {}),
    };

    const enqueuePrompt = (): void => {
      if (structuredInput) {
        opts.queue.pushIsolate(queuedPrompt, queueMode);
      } else {
        pushMessageToQueueWithSpecialCommands({
          queue: opts.queue,
          message: queuedPrompt,
          text,
          mode: queueMode,
        });
      }
      if (opts.inFlightSteer?.isTurnInFlight()) notifyPromptQueuedDuringTurnBestEffort();
    };

    if (pendingProviderAction === 'send' || pendingProviderAction === 'interrupt_and_send') {
      const enqueueClaimedSend = (): void => {
        if (structuredInput || isNonSteerablePromptPayload(text)) {
          enqueuePrompt();
          return;
        }
        opts.queue.pushIsolateAndClear(queuedPrompt, queueMode);
      };
      if (pendingProviderAction === 'interrupt_and_send') {
        const interruptActiveTurn = opts.inFlightSteer?.interruptActiveTurn;
        const rejectUnsupportedInterrupt = (): void => {
          try {
            opts.inFlightSteer?.rejectPromptBeforeProvider?.({
              ...(localIds.length === 0 ? {} : { localIds }),
              userMessageSeq,
              ...(userMessageSeq === null ? {} : { userMessageSeqs: [userMessageSeq] }),
              reason: 'unsupported_action',
            });
          } catch {
            // Evidence publication must not crash the session input consumer.
          }
        };
        steerSequence = steerSequence.then(async () => {
          if (!isCurrentBinding(session, messageBindingGeneration) || !interruptActiveTurn) {
            rejectUnsupportedInterrupt();
            return;
          }
          let outcome: InFlightInterruptOutcome;
          try {
            outcome = await interruptActiveTurn();
          } catch {
            rejectUnsupportedInterrupt();
            return;
          }
          if (
            !isCurrentBinding(session, messageBindingGeneration)
            || (
              outcome.status !== 'interrupted'
              && outcome.status !== 'deferred_until_turn_end'
            )
          ) {
            rejectUnsupportedInterrupt();
            return;
          }
          enqueueClaimedSend();
        });
      } else {
        enqueueClaimedSend();
      }
      return true;
    }

    const rejectExactSteerBeforeProvider = (): void => {
      try {
        opts.inFlightSteer?.rejectPromptBeforeProvider?.({
          ...(localIds.length === 0 ? {} : { localIds }),
          userMessageSeq,
          ...(userMessageSeq === null ? {} : { userMessageSeqs: [userMessageSeq] }),
          reason: exactSteerRejectionReason,
        });
        if (exactSteerRejectionReason === 'conditional_steer_unavailable') {
          releaseHandledUserPromptIdentity(localId, userMessageSeq);
        }
      } catch {
        // Evidence publication must not crash the session input consumer.
      }
    };

    const queueUnavailableSteer = (): void => {
      if (isExactClaimedSteer && exactSteerRejectionReason === 'conditional_steer_unavailable') {
        rejectExactSteerBeforeProvider();
      } else {
        try {
          enqueuePrompt();
        } catch (error) {
          logger.warnLocalFile('[permissionMode] Failed to queue non-interrupting provider input', { error, localId });
        }
      }
    };

    const reportExactSteerEffectMayHaveOccurred = (): void => {
      try {
        opts.inFlightSteer?.reportPromptEffectMayHaveOccurred?.({
          ...(localIds.length === 0 ? {} : { localIds }),
          userMessageSeq,
          ...(userMessageSeq === null ? {} : { userMessageSeqs: [userMessageSeq] }),
        });
      } catch {
        // Evidence publication must not crash or terminalize the foreground turn.
      }
    };

    // In-flight steer is only valid when:
    // - the runtime is currently processing a turn,
    // - steering is supported,
    // - the message is not a non-steerable control command like /clear or /compact,
    // - and the message either does NOT alter permission mode, or the backend exposes the
    //   `applyConfigDeltaInFlight` capability (lane Q) so it can own the mode change mid-turn.
    //   Without the capability, ambient mode changes keep the queue path (handled by the main
    //   loop). Explicit non-interrupting input also uses that queue when steering is unavailable.
    const steer = opts.inFlightSteer;
    const canSteerCurrentProviderTurn = Boolean(
      steer &&
      steer.supportsInFlightSteer() &&
      (steer.canSteerPrompt?.() ?? steer.isTurnInFlight()) &&
      (steer.isProviderInputAdmitted?.() ?? true) &&
      !isNonSteerablePromptPayload(text) &&
      !modelOverride &&
      (!didChangePermissionMode || typeof steer.applyConfigDeltaInFlight === 'function')
    );
    if (isExactClaimedSteer && !canSteerCurrentProviderTurn) {
      queueUnavailableSteer();
      return true;
    }
    if (steer && canSteerCurrentProviderTurn) {
      const applyConfigDelta = didChangePermissionMode ? steer.applyConfigDeltaInFlight : undefined;
      steerSequence = steerSequence.then(async () => {
        const stopForLostBinding = (): boolean => {
          if (isCurrentBinding(session, messageBindingGeneration)) return false;
          if (isExactClaimedSteer) rejectExactSteerBeforeProvider();
          return true;
        };
        if (stopForLostBinding()) return;
        // Exact provider acceptance may arrive after the native steer call returns. Drain any
        // settlement it started before the next steer reads replaySeedV1, otherwise the same
        // activation seed can be prefixed to two provider inputs.
        await replaySeedSettlementSequence;
        if (stopForLostBinding()) return;
        if (steer.isProviderInputAdmitted?.() === false) {
          queueUnavailableSteer();
          return;
        }
        // A seed the provider already ACCEPTED must be retired before any further provider
        // input is admitted. The admission boundary retries the same idempotent settler once;
        // while its retirement keeps failing, this input is not dispatched: ambient input
        // returns to the queue; conditional steering is requeued by the Pending owner.
        const unsettledRetirementOutcome = opts.replaySeedRetirement
          ? await opts.replaySeedRetirement.settleBeforeAdmitting()
          : null;
        if (stopForLostBinding()) return;
        if (unsettledRetirementOutcome === 'failed') {
          queueUnavailableSteer();
          return;
        }
        const dispatchSteer = async (): Promise<void> => {
          const constraints = message.callerInputConstraints;
          if (constraints && !isModelRefGrantedV1(constraints, steer.readActiveModelSelection?.() ?? 'automatic')) {
            rejectCallerInput('model_not_granted');
            return;
          }
          if (constraints && !isPermissionModeGrantedV1(constraints, resolvedMode.queuePermissionMode)) {
            rejectCallerInput('permission_mode_not_granted');
            return;
          }
          if (applyConfigDelta) {
            let configOutcome: InFlightConfigApplyOutcome;
            try {
              if (stopForLostBinding()) return;
              configOutcome = await applyConfigDelta({ permissionMode: resolvedMode.queuePermissionMode });
            } catch {
              configOutcome = { status: 'failed', reason: 'config_apply_threw' };
            }
            if (stopForLostBinding()) return;
            if (configOutcome.status !== 'applied' && configOutcome.status !== 'scheduled_in_turn') {
              // The backend cannot own the config mid-turn: legacy queue path (the mode applies
              // when the queue drains). The steer was never accepted, so this is not a bounce.
              queueUnavailableSteer();
              return;
            }
          }
          let providerEffectStarted = false;
          let releaseUndispatchedReplaySeed: (() => Promise<void>) | null = null;
          try {
            if (stopForLostBinding()) return;
            const providerNativeCommand = steer.isProviderNativeCommand?.(text) === true;
            let providerText = text;
            let settleReplaySeedOnProviderAcceptance: ReplaySeedSettlement | null = null;
            if (typeof session.getMetadataSnapshot === 'function') {
              try {
                if (stopForLostBinding()) return;
                const seedResolution = await resolveProviderPromptWithReplaySeed({
                  session: {
                    getMetadataSnapshot: () =>
                      isCurrentBinding(session, messageBindingGeneration) ? session.getMetadataSnapshot?.() : {},
                    // Resolution is generation-guarded above and below. This writer is retained
                    // only by the exact provider-acceptance settlement, which must still retire
                    // the seed on its original Session after the queue binding moves elsewhere.
                    updateMetadata: (updater) => session.updateMetadata(updater),
                    ...(typeof session.refreshSessionSnapshotFromServerBestEffort === 'function'
                      ? {
                          refreshSessionSnapshotFromServerBestEffort: (refreshOpts?: {
                            reason: 'connect' | 'waitForMetadataUpdate';
                          }) => {
                            if (!isCurrentBinding(session, messageBindingGeneration)) return Promise.resolve();
                            return session.refreshSessionSnapshotFromServerBestEffort?.(refreshOpts) ?? Promise.resolve();
                          },
                        }
                      : {}),
                    ...(typeof session.readDurableProviderInputAcceptanceV1 === 'function'
                      ? {
                          // Reconciliation must answer for the seed's ORIGINAL Session even after
                          // the queue binding moved, exactly like the settlement writer above.
                          readDurableProviderInputAcceptanceV1: (
                            associatedLocalId: string,
                          ) => session.readDurableProviderInputAcceptanceV1!(associatedLocalId),
                        }
                      : {}),
                  },
                  userText: text,
                  allowSeed: !providerNativeCommand,
                  localId: message.localId ?? null,
                  nowMs: Date.now(),
                  refreshMetadataBeforeRead: !didReplaySeedBootstrapForSteer,
                });
                releaseUndispatchedReplaySeed = seedResolution.seedApplied
                  ? seedResolution.releaseUndispatchedSeed
                  : null;
                if (stopForLostBinding()) return;
                didReplaySeedBootstrapForSteer = true;
                providerText = seedResolution.providerPrompt;
                settleReplaySeedOnProviderAcceptance = seedResolution.seedApplied
                  ? seedResolution.settleOnProviderAcceptance
                  : null;
              } catch {
                if (stopForLostBinding()) return;
                // Best-effort only; fall back to steering the raw user text.
              }
            }

            const stopForUnavailableSteer = (): boolean => {
              if (stopForLostBinding()) return true;
              if (
                steer.supportsInFlightSteer()
                && (steer.canSteerPrompt?.() ?? steer.isTurnInFlight())
                && (steer.isProviderInputAdmitted?.() ?? true)
              ) return false;
              // Requeue raw text so an unaccepted replay seed is applied once by normal dispatch.
              queueUnavailableSteer();
              return true;
            };
            if (stopForUnavailableSteer()) return;
            const preparedDispatch = await prepareSessionInputForProviderDispatch({
              prompt: queuedPrompt,
              transformedUserText: providerText,
              providerNativeCommand,
              signal: messageBindingAbortSignal,
              localId,
              services: steer.readStructuredInputDispatchServices?.(),
            });
            if (stopForUnavailableSteer()) return;
            let preparedSessionFollowContext = localId
              ? await opts.inFlightSteer?.prepareHostContext?.({
                  signal: messageBindingAbortSignal,
                  requiredPrompt: preparedDispatch.requiredProviderContextForBudget,
                }) ?? null
              : null;
            // Follow reads may outlive the current turn or Session binding. Reuse the same
            // admission decision before associating acceptance effects or touching the provider.
            if (stopForUnavailableSteer()) return;
            if (preparedSessionFollowContext?.recheckAdmission
              && !await preparedSessionFollowContext.recheckAdmission(messageBindingAbortSignal)) {
              preparedSessionFollowContext = null;
            }
            if (stopForUnavailableSteer()) return;
            const dispatchText = preparedDispatch.renderPrompt({
              ...(preparedSessionFollowContext
                ? { sessionFollowUpdates: preparedSessionFollowContext.updates, workerUpdates: preparedSessionFollowContext.workerUpdates }
                : {}),
            });
            const confirmProviderPromptAccepted = (): void => {
              const settle = settleReplaySeedOnProviderAcceptance;
              if (!settle) return;
              settleReplaySeedOnProviderAcceptance = null;
              const priorSettlements = replaySeedSettlementSequence;
              const replaySeedSettlement = priorSettlements.then(async () => {
                await (opts.replaySeedRetirement
                  ? opts.replaySeedRetirement.settleOnProviderAcceptance(settle)
                  : settle());
              });
              replaySeedSettlementSequence = replaySeedSettlement;
            };
            if (localId) {
              steer.registerProviderAcceptedEffect(
                localId,
                settleReplaySeedOnProviderAcceptance || preparedSessionFollowContext
                  ? () => {
                      if (settleReplaySeedOnProviderAcceptance) confirmProviderPromptAccepted();
                      preparedSessionFollowContext?.acknowledgeAccepted({
                        kind: 'admitted_input',
                        localInputId: localId,
                        userMessageSeq,
                      });
                    }
                  : null,
              );
            }
            // Invoking the runtime is the provider-effect boundary. Any failure after this point
            // is ambiguous and must retain the durable association for restart reconciliation.
            releaseUndispatchedReplaySeed = null;
            providerEffectStarted = true;
            const steerSend = steer.steerText(dispatchText, {
              localId,
              ...queuedPromptIdentityFields,
              ...(causalPermissionAuthority ? { causalPermissionAuthority } : {}),
              ...(preparedDispatch.structuredInput ? { structuredInput: preparedDispatch.structuredInput } : {}),
            });
            void preparedDispatch.retainComposition({ deliveryKind: 'steer', observedAtMs: Date.now(), turnId: null });
            await steerSend;
            if (stopForLostBinding()) return;
            return;
          } catch (error) {
            if (!isCurrentBinding(session, messageBindingGeneration)) return;
            if (!providerEffectStarted) {
              const preparationFailure = readStructuredInputPreparationFailure(error);
              if (!preparationFailure || isAbortLikeError(error)) {
                queueUnavailableSteer();
                return;
              }
              logger.warnLocalFile('[permissionMode] Structured steer preparation rejected before provider input', { code: preparationFailure.code, localId });
              steer.rejectPromptBeforeProvider?.({
                ...(localIds.length === 0 ? {} : { localIds }),
                userMessageSeq,
                ...(userMessageSeq === null ? {} : { userMessageSeqs: [userMessageSeq] }),
                preparationFailure: { code: preparationFailure.code, retryable: preparationFailure.retryable },
              });
              return;
            }
            if (isExactClaimedSteer) {
              reportExactSteerEffectMayHaveOccurred();
            } else {
              queueUnavailableSteer();
            }
          } finally {
            const release = releaseUndispatchedReplaySeed;
            releaseUndispatchedReplaySeed = null;
            await release?.();
          }
        };
        if (steer.runProviderInputDispatch) {
          const dispatchOutcome = await steer.runProviderInputDispatch({
            abortSignal: messageBindingAbortSignal,
            dispatch: dispatchSteer,
          });
          if (dispatchOutcome.status === 'cancelled' && isCurrentBinding(session, messageBindingGeneration)) {
            queueUnavailableSteer();
          }
        } else {
          await dispatchSteer();
        }
      });
      return true;
    }

    enqueuePrompt();
    return true;
  };

  // The message was queued behind a running turn: let the runtime arm its bounded
  // stale-turn recovery so a phantom turn cannot starve the queue forever (L1).
  const notifyPromptQueuedDuringTurnBestEffort = (): void => {
    try {
      opts.inFlightSteer?.onPromptQueuedDuringTurn?.();
    } catch {
      // Best-effort only.
    }
  };

  const hasHandledUserPromptIdentity = (localId: string | null, userMessageSeq: number | null): boolean => {
    if (userMessageSeq !== null && handledUserPromptSeqs.has(userMessageSeq)) {
      return true;
    }
    if (userMessageSeq === null && localId !== null && handledUserPromptLocalIds.has(localId)) {
      return true;
    }
    return false;
  };

  const markHandledUserPromptIdentity = (localId: string | null, userMessageSeq: number | null): void => {
    if (localId !== null) {
      handledUserPromptLocalIds.add(localId);
    }
    if (userMessageSeq !== null) {
      handledUserPromptSeqs.add(userMessageSeq);
    }
  };

  const releaseHandledUserPromptIdentity = (localId: string | null, userMessageSeq: number | null): void => {
    if (localId !== null) handledUserPromptLocalIds.delete(localId);
    if (userMessageSeq !== null) handledUserPromptSeqs.delete(userMessageSeq);
  };

  const releaseRejectedBeforeProviderPromptIdentity = (
    session: PermissionModeQueueSessionBinding,
    message: PermissionModeQueuedPrompt,
  ): void => {
    if (session !== currentSession) return;
    const localIds = new Set<string>([message.localId, ...(message.localIds ?? [])]
      .filter((localId): localId is string => typeof localId === 'string' && localId.length > 0));
    for (const localId of localIds) {
      releaseHandledUserPromptIdentity(localId, null);
    }
    for (const userMessageSeq of [message.userMessageSeq, ...(message.userMessageSeqs ?? [])]) {
      if (typeof userMessageSeq === 'number' && Number.isFinite(userMessageSeq)) {
        releaseHandledUserPromptIdentity(null, userMessageSeq);
      }
    }
  };

  const bindSession = (session: PermissionModeQueueSessionBinding) => {
    currentBindingAbortController.abort('permission-mode-queue-session-rebound');
    currentBindingAbortController = new AbortController();
    currentSession = session;
    currentBindingGeneration += 1;
    handledUserPromptLocalIds.clear();
    handledUserPromptSeqs.clear();
    session.onUserMessage((message) => handleMessage(session, message));
  };

  bindSession(opts.session);

  return { bindSession, releaseRejectedBeforeProviderPromptIdentity };
}

function resolveModelOverrideFromUserMessage(
  message: UserMessage,
  agentTargetKey: string | undefined,
): Readonly<
  | { kind: 'structured'; selection: ProviderBoundModelRef }
  | { kind: 'invalid_structured' }
  | { kind: 'legacy'; modelId: string }
> | null {
  const structured = readSessionMessageModelSelectionV1(message.meta);
  if (structured.status !== 'absent') {
    return structured.status === 'valid' && structured.selection.ref.agentTargetKey === agentTargetKey
      ? { kind: 'structured', selection: structured.selection.ref }
      : { kind: 'invalid_structured' };
  }
  const raw = message.meta && typeof message.meta === 'object'
    ? (message.meta as Record<string, unknown>).model
    : null;
  const model = typeof raw === 'string' ? raw.trim() : '';
  return model.length > 0 ? { kind: 'legacy', modelId: model } : null;
}

type PermissionModeQueueSessionBinding = {
  onUserMessage: (handler: (message: UserMessage) => boolean | void) => void;
  updateMetadata: (updater: (current: Metadata) => Metadata) => Promise<void> | void;
  getMetadataSnapshot?: () => unknown;
  refreshSessionSnapshotFromServerBestEffort?: (opts?: { reason: 'connect' | 'waitForMetadataUpdate' }) => Promise<void>;
  /** Committed transcript seq used to suppress replay of exact host-consumed local commands. */
  getCommittedUserMessageSeq?: (localId: string) => number | null;
  /** Durable accepted-delivery authority for the replay seed's dispatch association. */
  readDurableProviderInputAcceptanceV1?: (
    localId: string,
  ) => Promise<DurableProviderInputAcceptanceV1>;
};
