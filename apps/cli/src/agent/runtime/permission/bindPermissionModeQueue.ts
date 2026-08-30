import type { AgentState, Metadata, PermissionMode, UserMessage } from '@/api/types';

import { pushMessageToQueueWithSpecialCommands, type SpecialCommandQueue } from '@/agent/runtime/queueSpecialCommands';
import { resolveAppendSystemPromptModeOverride } from '@/agent/runtime/permission/appendSystemPromptField';
import { resolveProviderPromptForDispatch } from '@/agent/runtime/prompt/resolveProviderPromptForDispatch';
import { createProviderPromptAcceptanceSettlement } from '@/agent/runtime/prompt/createProviderPromptAcceptanceSettlement';
import { isNonSteerablePromptPayload } from '@/cli/parsers/specialCommands';

import { resolvePermissionModeUpdatedAtFromMessage } from './permissionModeCanonical';
import { resolvePermissionModeForQueueingUserMessage } from './permissionModeFromUserMessage';
import { updateAgentStateBestEffort, updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import type { PermissionModeQueuedPrompt } from '@/agent/runtime/permission/permissionModeQueuedPrompt';
import type { PendingProviderAction } from '@/agent/runtime/modeMessageQueue';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import type { SessionUserMessageDeliveryInfo } from '@/api/session/sessionClientPort';
import type { PendingQueueDeliveryBlockedReason } from '@/api/session/pendingQueueV2Transport';

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

export type InFlightSteerController = Readonly<{
  /**
   * Whether the runtime is currently processing a turn (i.e. can accept steer input).
   */
  isTurnInFlight: () => boolean;
  /**
   * Whether the runtime/backend combination supports steering input into an active turn.
   */
  supportsInFlightSteer: () => boolean;
  /**
   * Send additional user text to the in-flight turn.
   *
   * This should NOT abort the current turn.
   */
  steerText: (
    text: string,
    identity?: InFlightSteerDeliveryIdentity,
    callbacks?: Readonly<{ onProviderPromptAccepted?: () => void }>,
  ) => Promise<void>;
  /** Cancel the active provider turn before executing an `interrupt_and_send` Pending action. */
  cancelActiveTurn?: (() => Promise<void>) | undefined;
  /**
   * OPTIONAL capability (lane Q): apply a config delta to the RUNNING turn so a config-carrying
   * message can still steer. Backends that cannot own mid-turn config changes (e.g. Codex —
   * turn-boundary protocol) simply do not implement this; their messages keep the queue path.
   */
  applyConfigDeltaInFlight?: ((delta: SteerConfigDelta) => Promise<InFlightConfigApplyOutcome>) | undefined;
}>;

export type InFlightSteerDeliveryIdentity = Readonly<{
  localId?: string | null;
  localIds?: readonly string[];
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
}>;

export function registerPermissionModeMessageQueueBinding(opts: {
  session: PermissionModeQueueSessionBinding;
  queue: SpecialCommandQueue<{ permissionMode: PermissionMode; appendSystemPrompt?: string | null }, PermissionModeQueuedPrompt>;
  getCurrentPermissionMode: () => PermissionMode | undefined;
  setCurrentPermissionMode: (mode: PermissionMode | undefined) => void;
  inFlightSteer?: InFlightSteerController | null;
}): { bindSession: (session: PermissionModeQueueSessionBinding) => void } {
  let steerSequence: Promise<void> = Promise.resolve();
  const steerReplaySeedRetirement = createProviderPromptAcceptanceSettlement();
  let didReplaySeedBootstrapForSteer = false;
  let currentSession = opts.session;
  let bindingGeneration = 0;

  const isCurrentBinding = (session: PermissionModeQueueSessionBinding, generation: number): boolean =>
    currentSession === session && bindingGeneration === generation;

  const handleMessage = (
    session: PermissionModeQueueSessionBinding,
    message: UserMessage,
    deliveryInfo?: SessionUserMessageDeliveryInfo,
  ): void | Promise<void> => {
    const messageBindingGeneration = bindingGeneration;
    if (!isCurrentBinding(session, messageBindingGeneration)) {
      return;
    }

    const previousPermissionMode = opts.getCurrentPermissionMode();
    const resolvedMode = resolvePermissionModeForQueueingUserMessage({
      currentPermissionMode: previousPermissionMode,
      messagePermissionModeRaw: message.meta?.permissionMode,
      updateMetadata: (updater) => {
        if (!isCurrentBinding(session, messageBindingGeneration)) return;
        updateMetadataBestEffort(
          session,
          (current) => (isCurrentBinding(session, messageBindingGeneration) ? updater(current) : current),
          '[permissionMode]',
          'permission_mode_from_user_message',
        );
      },
      nowMs: () => resolvePermissionModeUpdatedAtFromMessage(message),
    });

    opts.setCurrentPermissionMode(resolvedMode.currentPermissionMode);

    const text = message.content.text;
    const didChangePermissionMode = previousPermissionMode !== resolvedMode.currentPermissionMode;
    const deliveryIdentity = resolveInFlightSteerDeliveryIdentity(session, message, deliveryInfo);

    // In-flight steer is only valid when:
    // - the runtime is currently processing a turn,
    // - steering is supported,
    // - the message is not a control command like /clear or /compact,
    // - and the message either does NOT alter permission mode, or the backend exposes the
    //   `applyConfigDeltaInFlight` capability (lane Q) so it can own the mode change mid-turn.
    //   Without the capability, mode changes keep the queue path (handled by the main loop).
    const steer = opts.inFlightSteer;
    const pushToQueueBestEffort = (pendingProviderAction?: PendingProviderAction) => {
      if (!isCurrentBinding(session, messageBindingGeneration)) return;
      try {
        pushMessageToQueueWithSpecialCommands({
          queue: opts.queue,
          message: { text, localId: deliveryIdentity.localId, ...(message.meta ? { meta: message.meta } : {}) },
          text,
          mode: {
            permissionMode: resolvedMode.queuePermissionMode,
            ...resolveAppendSystemPromptModeOverride(message.meta),
          },
          ...deliveryIdentity.queueOptions,
          ...(pendingProviderAction ? { pendingProviderAction } : {}),
        });
      } catch {
        // Best-effort fallback: queueing should not be able to crash the process if a steer fails.
      }
    };
    const blockPendingDelivery = async (
      reason: PendingQueueDeliveryBlockedReason,
      providerEffect?: 'none',
    ) => {
      if (!isCurrentBinding(session, messageBindingGeneration)) return;
      await session.blockPendingMessageDelivery?.({
        localIds: deliveryIdentity.queueOptions.userMessageLocalIds,
        reason,
        ...(providerEffect ? { providerEffect } : {}),
      });
    };
    const claimedProviderAction = deliveryInfo?.pendingProviderAction;

    if (claimedProviderAction === 'send') {
      pushToQueueBestEffort('send');
      return;
    }

    if (claimedProviderAction === 'interrupt_and_send') {
      steerSequence = steerSequence.then(async () => {
        if (!isCurrentBinding(session, messageBindingGeneration)) return;
        try {
          if (!steer?.cancelActiveTurn) {
            throw new Error('active-turn cancellation is unavailable');
          }
          await steer.cancelActiveTurn();
          if (!isCurrentBinding(session, messageBindingGeneration)) return;
          pushToQueueBestEffort('send');
        } catch {
          if (!isCurrentBinding(session, messageBindingGeneration)) return;
          await blockPendingDelivery('provider_rejected_before_acceptance');
        }
      });
      return steerSequence;
    }

    const isClaimedSteer = claimedProviderAction === 'steer';
    const canSteerNow = Boolean(
      steer
      && steer.supportsInFlightSteer()
      && steer.isTurnInFlight()
      && !isNonSteerablePromptPayload(text)
      && (!didChangePermissionMode || typeof steer.applyConfigDeltaInFlight === 'function'),
    );

    if (isClaimedSteer && !canSteerNow) {
      steerSequence = steerSequence.then(async () => {
        await blockPendingDelivery('steering_unavailable', 'none');
      });
      return steerSequence;
    }
    if (
      steer && canSteerNow
    ) {
      const applyConfigDelta = didChangePermissionMode ? steer.applyConfigDeltaInFlight : undefined;
      steerSequence = steerSequence.then(async () => {
        if (!isCurrentBinding(session, messageBindingGeneration)) return;
        if (applyConfigDelta) {
          let configOutcome: InFlightConfigApplyOutcome;
          try {
            if (!isCurrentBinding(session, messageBindingGeneration)) return;
            configOutcome = await applyConfigDelta({ permissionMode: resolvedMode.queuePermissionMode });
          } catch {
            configOutcome = { status: 'failed', reason: 'config_apply_threw' };
          }
          if (!isCurrentBinding(session, messageBindingGeneration)) return;
          if (configOutcome.status !== 'applied' && configOutcome.status !== 'scheduled_in_turn') {
            if (isClaimedSteer) {
              await blockPendingDelivery('steering_unavailable', 'none');
              return;
            }
            // The backend cannot own the config mid-turn: legacy queue path (the mode applies when
            // the queue drains). Not a bounce — the steer was never accepted — so no corrective
            // unsafe_window publish (the UI already routes known-refused payloads honestly).
            pushToQueueBestEffort();
            return;
          }
        }
        try {
          if (!isCurrentBinding(session, messageBindingGeneration)) return;
          await steerReplaySeedRetirement.drain();
          if (!isCurrentBinding(session, messageBindingGeneration)) return;
          let providerText = text;
          let settleReplaySeedOnProviderAcceptance: (() => Promise<unknown>) | null = null;
          if (typeof session.getMetadataSnapshot === 'function') {
            try {
              if (!isCurrentBinding(session, messageBindingGeneration)) return;
              // ACP steer carries no metadata to the PROVIDER, so the resolved meta below is
              // discarded — but the message's own metadata is still handed in, because the
              // session-reference projection is TEXT and must be identical on send and steer
              // (D-21). No catalog readers are supplied, so this costs no RPC and cannot
              // reject: skill/vendor provider context is a meta projection no ACP backend
              // reads. It routes through the one prompt-finalization owner (D-21a) rather
              // than calling the replay seed directly.
              const seedResolution = await resolveProviderPromptForDispatch({
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
                localId: deliveryIdentity.localId,
                nowMs: Date.now(),
                refreshMetadataBeforeRead: !didReplaySeedBootstrapForSteer,
                ...(message.meta ? { meta: message.meta } : {}),
              });
              if (!isCurrentBinding(session, messageBindingGeneration)) return;
              didReplaySeedBootstrapForSteer = true;
              providerText = seedResolution.providerPrompt;
              if (seedResolution.seedApplied) {
                settleReplaySeedOnProviderAcceptance = seedResolution.settleReplaySeedOnProviderAcceptance;
              }
            } catch {
              if (!isCurrentBinding(session, messageBindingGeneration)) return;
              // Best-effort only; fall back to steering the raw user text.
            }
          }

          if (!isCurrentBinding(session, messageBindingGeneration)) return;
          const onProviderPromptAccepted = settleReplaySeedOnProviderAcceptance
            ? steerReplaySeedRetirement.createAcceptanceCallback(
                settleReplaySeedOnProviderAcceptance,
              )
            : null;
          if (deliveryIdentity.steerOptions === undefined) {
            if (onProviderPromptAccepted) {
              await steer.steerText(providerText, undefined, { onProviderPromptAccepted });
            } else {
              await steer.steerText(providerText);
            }
          } else if (onProviderPromptAccepted) {
            await steer.steerText(
              providerText,
              deliveryIdentity.steerOptions,
              { onProviderPromptAccepted },
            );
          } else {
            await steer.steerText(providerText, deliveryIdentity.steerOptions);
          }
          // Exact runtimes confirm before returning and are drained here. A runtime that returns
          // at transport custody confirms later. Each callback closes over its own settler so a
          // late ACK cannot retire context for a newer steer; the next serialized steer drains any
          // settlement that has begun before it reads replaySeedV1 again.
          if (onProviderPromptAccepted) {
            await steerReplaySeedRetirement.drain();
          }
          if (!isCurrentBinding(session, messageBindingGeneration)) return;
          return;
        } catch {
          if (!isCurrentBinding(session, messageBindingGeneration)) return;
          if (isClaimedSteer) {
            await blockPendingDelivery('steering_unavailable');
            if (!isCurrentBinding(session, messageBindingGeneration)) return;
            publishSteerBounceUnavailable(session);
            return;
          }
          pushToQueueBestEffort();
          if (!isCurrentBinding(session, messageBindingGeneration)) return;
          // Lane P (O-design Seam A corrective): a steer the runner accepted just BOUNCED to the
          // queue — tell the UI the window is unsafe so the demotion is not silent.
          publishSteerBounceUnavailable(session);
        }
      });
      return steerSequence;
    }

    if (!isCurrentBinding(session, messageBindingGeneration)) return;
    pushMessageToQueueWithSpecialCommands({
      queue: opts.queue,
      message: { text, localId: deliveryIdentity.localId, ...(message.meta ? { meta: message.meta } : {}) },
      text,
      mode: {
        permissionMode: resolvedMode.queuePermissionMode,
        ...resolveAppendSystemPromptModeOverride(message.meta),
      },
      ...deliveryIdentity.queueOptions,
    });
  };

  const bindSession = (session: PermissionModeQueueSessionBinding) => {
    bindingGeneration += 1;
    currentSession = session;
    session.onUserMessage((message, deliveryInfo) => handleMessage(session, message, deliveryInfo));
  };

  bindSession(opts.session);

  return { bindSession };
}

function publishSteerBounceUnavailable(session: PermissionModeQueueSessionBinding): void {
  const updateAgentState = session.updateAgentState;
  if (typeof updateAgentState !== 'function') return;
  updateAgentStateBestEffort(
    { updateAgentState: updateAgentState.bind(session) },
    (current) => ({
      ...current,
      capabilities: {
        ...(current.capabilities && typeof current.capabilities === 'object' ? current.capabilities : {}),
        inFlightSteerAvailable: false,
        inFlightSteerUnavailableReason: 'unsafe_window',
        inFlightSteerStateAt: Date.now(),
      },
    }),
    '[permissionMode]',
    'in_flight_steer_bounce',
  );
}

type PermissionModeQueueSessionBinding = {
  onUserMessage: (handler: (message: UserMessage, info?: SessionUserMessageDeliveryInfo) => void | Promise<void>) => void;
  updateMetadata: (updater: (current: Metadata) => Metadata) => Promise<void> | void;
  updateAgentState?: (updater: (current: AgentState) => AgentState) => Promise<void> | void;
  getCommittedUserMessageSeq?: (localId: string) => number | null;
  getMetadataSnapshot?: () => unknown;
  refreshSessionSnapshotFromServerBestEffort?: (opts?: { reason: 'connect' | 'waitForMetadataUpdate' }) => Promise<void>;
  blockPendingMessageDelivery?: (params: Readonly<{
    localIds: readonly string[] | null | undefined;
    reason: PendingQueueDeliveryBlockedReason;
    providerEffect?: 'none';
  }>) => Promise<boolean>;
};

function resolveInFlightSteerDeliveryIdentity(
  session: PermissionModeQueueSessionBinding,
  message: UserMessage,
  deliveryInfo?: SessionUserMessageDeliveryInfo,
): Readonly<{
  localId: string | null;
  userMessageSeq: number | null;
  queueOptions: {
    userMessageSeq: number | null;
    userMessageLocalId: string | null;
    userMessageLocalIds: readonly string[] | null;
    providerAcceptancePending?: boolean;
    pendingProviderAction?: PendingProviderAction;
  };
  steerOptions: InFlightSteerDeliveryIdentity | undefined;
}> {
  const localId = normalizeDeliveryLocalId(message.localId);
  const localIds = localId === null ? [] : [localId];
  const userMessageSeq = localId === null || typeof session.getCommittedUserMessageSeq !== 'function'
    ? null
    : normalizeDeliverySeq(session.getCommittedUserMessageSeq(localId));
  const userMessageSeqs = userMessageSeq === null ? [] : [userMessageSeq];
  const hasSteerIdentity = localIds.length > 0 || userMessageSeqs.length > 0;

  return {
    localId,
    userMessageSeq,
    queueOptions: {
      userMessageSeq,
      userMessageLocalId: localId,
      userMessageLocalIds: localIds.length === 0 ? null : localIds,
      ...(deliveryInfo?.providerAcceptancePending === true ? { providerAcceptancePending: true } : {}),
      ...(deliveryInfo?.pendingProviderAction ? { pendingProviderAction: deliveryInfo.pendingProviderAction } : {}),
    },
    steerOptions: hasSteerIdentity
      ? {
          ...(localId === null ? {} : { localId, localIds }),
          ...(userMessageSeq === null ? {} : { userMessageSeq, userMessageSeqs }),
        }
      : undefined,
  };
}

function normalizeDeliveryLocalId(value: unknown): string | null {
  return readNonBlankOpaqueIdentifier(value);
}

function normalizeDeliverySeq(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
