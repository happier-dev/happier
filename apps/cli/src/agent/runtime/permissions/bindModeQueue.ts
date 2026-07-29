import type { Metadata, PermissionMode, UserMessage } from '@/api/types';
import {
  readPendingLocalId,
  readSessionMessageModelSelectionV1,
  type ProviderBoundModelRef,
} from '@happier-dev/protocol';
import {
  readAttachmentEnvelopeLocalImagePaths,
  readHappierStructuredInputV1FromMeta,
} from '@happier-dev/protocol/runtime';

import { pushMessageToQueueWithSpecialCommands, type SpecialCommandQueue } from '@/agent/runtime/queueSpecialCommands';
import { resolveAppendSystemPromptModeOverride } from '@/agent/runtime/permissions/appendSystemPrompt';
import { resolveProviderPromptWithReplaySeed } from '@/agent/runtime/replaySeed/replaySeedV1';
import { isNonSteerablePromptPayload } from '@/cli/parsers/specialCommands';

import { resolvePermissionModeUpdatedAtFromMessage } from './modeCanonical';
import { resolvePermissionModeForQueueingUserMessage } from './modeFromUserMessage';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import type {
  PermissionModeQueuedPrompt,
  PermissionModeQueuedPromptMode,
} from '@/agent/runtime/permissions/queuedPrompt';

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
  /**
   * Whether the current active turn can safely accept steering right now.
   *
   * Some runtimes can keep a turn marked in-flight briefly after a terminal event, or after
   * the selected runtime configuration changes. Ambient input uses the normal queue; an exact
   * claimed steer is terminally rejected before provider effect.
   */
  canSteerPrompt?: () => boolean;
  /**
   * Non-authoritative routing snapshot from the shared session input consumer. Ambient input
   * observed blocked follows the existing queue path; exact claimed steer input is rejected.
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
  /**
   * Send additional user text to the in-flight turn.
   *
   * This should NOT abort the current turn.
   */
  steerText: (
    text: string,
    options?: Readonly<{
      localId?: string | null;
      localIds?: readonly string[];
      userMessageSeq?: number | null;
      userMessageSeqs?: readonly number[];
    }>,
  ) => Promise<void>;
  /**
   * Publish exact rejection evidence into the host's canonical provider-input outcome normalizer.
   * The normalizer remains the sole settlement owner.
   */
  rejectPromptBeforeProvider?: (info: Readonly<{
    localIds?: readonly string[];
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
    reason?: 'unsupported_action';
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
   * protocols) simply do not implement this; ambient messages keep the queue path and exact
   * claimed steer messages are rejected.
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
}): { bindSession: (session: PermissionModeQueueSessionBinding) => void } {
  let steerSequence: Promise<void> = Promise.resolve();
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

    const resolvedMode = resolvePermissionModeForQueueingUserMessage({
      currentPermissionMode: opts.getCurrentPermissionMode(),
      messagePermissionModeRaw: message.meta?.permissionMode,
      updateMetadata: (updater) =>
        updateMetadataBestEffort(session, updater, '[permissionMode]', 'permission_mode_from_user_message'),
      nowMs: () => resolvePermissionModeUpdatedAtFromMessage(message),
    });

    opts.setCurrentPermissionMode(resolvedMode.currentPermissionMode);

    const text = message.content.text;
    const structuredInput = readHappierStructuredInputV1FromMeta(message.meta, {
      allowedLocalImagePaths: readAttachmentEnvelopeLocalImagePaths(message.meta),
    });
    const queuedPromptIdentityFields = {
      ...(localIds.length === 0 ? {} : { localIds }),
      ...(userMessageSeq === null ? {} : { userMessageSeq, userMessageSeqs: [userMessageSeq] }),
    };
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
    const queueMode: PermissionModeQueuedPromptMode = {
      permissionMode: resolvedMode.queuePermissionMode,
      ...resolveAppendSystemPromptModeOverride(message.meta),
      ...(modelSelection
        ? { modelSelection }
        : {}),
    };
    const queuedPrompt: PermissionModeQueuedPrompt = {
      text,
      localId,
      ...queuedPromptIdentityFields,
      ...(structuredInput ? { structuredInput } : {}),
    };

    if (pendingProviderAction === 'send' || pendingProviderAction === 'interrupt_and_send') {
      const enqueueClaimedSend = (): void => {
        opts.queue.pushIsolateAndClear(
          queuedPrompt,
          queueMode,
        );
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
            || outcome.status !== 'interrupted'
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
        });
      } catch {
        // Evidence publication must not crash the session input consumer.
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
    //   loop), while exact claimed steer input is rejected.
    const steer = opts.inFlightSteer;
    const canSteerCurrentProviderTurn = Boolean(
      steer &&
      steer.supportsInFlightSteer() &&
      (steer.canSteerPrompt?.() ?? steer.isTurnInFlight()) &&
      (steer.isProviderInputAdmitted?.() ?? true) &&
      !isNonSteerablePromptPayload(text) &&
      !structuredInput &&
      !modelOverride &&
      (!didChangePermissionMode || typeof steer.applyConfigDeltaInFlight === 'function')
    );
    if (isExactClaimedSteer && !canSteerCurrentProviderTurn) {
      rejectExactSteerBeforeProvider();
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
        const queueBlockedSteer = (
          queuedText: string = text,
          queuedMode: PermissionModeQueuedPromptMode = queueMode,
        ): void => {
          try {
            pushMessageToQueueWithSpecialCommands({
              queue: opts.queue,
              message: {
                ...queuedPrompt,
                text: queuedText,
              },
              text: queuedText,
              mode: queuedMode,
            });
            notifyPromptQueuedDuringTurnBestEffort();
          } catch {
            // Best-effort fallback: queueing should not be able to crash the process.
          }
        };
        if (steer.isProviderInputAdmitted?.() === false) {
          if (isExactClaimedSteer) {
            rejectExactSteerBeforeProvider();
          } else {
            queueBlockedSteer();
          }
          return;
        }
        const dispatchSteer = async (): Promise<void> => {
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
              if (isExactClaimedSteer) {
                rejectExactSteerBeforeProvider();
              } else {
                queueBlockedSteer();
              }
              return;
            }
          }
          try {
            if (stopForLostBinding()) return;
            let providerText = text;
            if (typeof session.getMetadataSnapshot === 'function') {
              try {
                if (stopForLostBinding()) return;
                const seedResolution = await resolveProviderPromptWithReplaySeed({
                  session: {
                    getMetadataSnapshot: () =>
                      isCurrentBinding(session, messageBindingGeneration) ? session.getMetadataSnapshot?.() : {},
                    updateMetadata: (updater) => {
                      if (!isCurrentBinding(session, messageBindingGeneration)) return;
                      return session.updateMetadata((current) =>
                        isCurrentBinding(session, messageBindingGeneration) ? updater(current) : current,
                      );
                    },
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
                  },
                  userText: text,
                  allowSeed: true,
                  localId: message.localId ?? null,
                  nowMs: Date.now(),
                  refreshMetadataBeforeRead: !didReplaySeedBootstrapForSteer,
                });
                if (stopForLostBinding()) return;
                didReplaySeedBootstrapForSteer = true;
                providerText = seedResolution.providerPrompt;
              } catch {
                if (stopForLostBinding()) return;
                // Best-effort only; fall back to steering the raw user text.
              }
            }

            if (stopForLostBinding()) return;
            const canStillSteerCurrentProviderTurn = Boolean(
              steer.supportsInFlightSteer()
              && (steer.canSteerPrompt?.() ?? steer.isTurnInFlight())
              && (steer.isProviderInputAdmitted?.() ?? true)
            );
            if (!canStillSteerCurrentProviderTurn) {
              if (isExactClaimedSteer) {
                rejectExactSteerBeforeProvider();
              } else {
                queueBlockedSteer(providerText);
              }
              return;
            }
            await steer.steerText(providerText, { localId, ...queuedPromptIdentityFields });
            if (stopForLostBinding()) return;
            return;
          } catch {
            if (!isCurrentBinding(session, messageBindingGeneration)) return;
            if (isExactClaimedSteer) {
              reportExactSteerEffectMayHaveOccurred();
            } else {
              queueBlockedSteer();
            }
          }
        };
        if (steer.runProviderInputDispatch) {
          const dispatchOutcome = await steer.runProviderInputDispatch({
            abortSignal: messageBindingAbortSignal,
            dispatch: dispatchSteer,
          });
          if (dispatchOutcome.status === 'cancelled' && isCurrentBinding(session, messageBindingGeneration)) {
            if (isExactClaimedSteer) {
              rejectExactSteerBeforeProvider();
            } else {
              queueBlockedSteer();
            }
          }
        } else {
          await dispatchSteer();
        }
      });
      return true;
    }

    if (structuredInput) {
      opts.queue.pushIsolateAndClear(queuedPrompt, queueMode);
    } else {
      pushMessageToQueueWithSpecialCommands({
        queue: opts.queue,
        message: queuedPrompt,
        text,
        mode: queueMode,
      });
    }
    if (steer?.isTurnInFlight()) {
      notifyPromptQueuedDuringTurnBestEffort();
    }
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

  return { bindSession };
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
};
