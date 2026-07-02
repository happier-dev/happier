import type { Metadata, PermissionMode, UserMessage } from '@/api/types';

import { pushMessageToQueueWithSpecialCommands, type SpecialCommandQueue } from '@/agent/runtime/queueSpecialCommands';
import { resolveAppendSystemPromptModeOverride } from '@/agent/runtime/permissions/appendSystemPrompt';
import { resolveProviderPromptWithReplaySeed } from '@/agent/runtime/replaySeed/replaySeedV1';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';

import { resolvePermissionModeUpdatedAtFromMessage } from './modeCanonical';
import { resolvePermissionModeForQueueingUserMessage } from './modeFromUserMessage';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import type { PermissionModeQueuedPrompt } from '@/agent/runtime/permissions/queuedPrompt';

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
   * Whether the current active turn can safely accept steering right now.
   *
   * Some runtimes can keep a turn marked in-flight briefly after a terminal event, or after
   * the selected runtime configuration changes. Those turns must be handled by the normal queue.
   */
  canSteerPrompt?: () => boolean;
  /**
   * Send additional user text to the in-flight turn.
   *
   * This should NOT abort the current turn.
   */
  steerText: (text: string, options?: Readonly<{ localId?: string | null }>) => Promise<void>;
  /**
   * OPTIONAL capability (lane Q): apply a config delta to the RUNNING turn so a config-carrying
   * message can still steer. Backends that cannot own mid-turn config changes (e.g. turn-boundary
   * protocols) simply do not implement this; their messages keep the queue path.
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
  queue: SpecialCommandQueue<{ permissionMode: PermissionMode; appendSystemPrompt?: string | null }, PermissionModeQueuedPrompt>;
  getCurrentPermissionMode: () => PermissionMode | undefined;
  setCurrentPermissionMode: (mode: PermissionMode | undefined) => void;
  inFlightSteer?: InFlightSteerController | null;
}): { bindSession: (session: PermissionModeQueueSessionBinding) => void } {
  let steerSequence: Promise<void> = Promise.resolve();
  let didReplaySeedBootstrapForSteer = false;
  let currentSession = opts.session;

  const handleMessage = (session: PermissionModeQueueSessionBinding, message: UserMessage) => {
    if (currentSession !== session) {
      return;
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
    const special = parseSpecialCommand(text);
    // Alias-normalized change signal (ported S-6): a raw compare against the previous mode reads
    // an alias respelling ('acceptEdits' vs 'safe-yolo') as a change and wrongly blocks steering.
    const didChangePermissionMode = resolvedMode.didChange;

    // In-flight steer is only valid when:
    // - the runtime is currently processing a turn,
    // - steering is supported,
    // - the message is not a control command like /clear or /compact,
    // - and the message either does NOT alter permission mode, or the backend exposes the
    //   `applyConfigDeltaInFlight` capability (lane Q) so it can own the mode change mid-turn.
    //   Without the capability, mode changes keep the queue path (handled by the main loop).
    const steer = opts.inFlightSteer;
    if (
      steer &&
      steer.supportsInFlightSteer() &&
      (steer.canSteerPrompt?.() ?? steer.isTurnInFlight()) &&
      special.type === null &&
      (!didChangePermissionMode || typeof steer.applyConfigDeltaInFlight === 'function')
    ) {
      const applyConfigDelta = didChangePermissionMode ? steer.applyConfigDeltaInFlight : undefined;
      steerSequence = steerSequence.then(async () => {
        if (applyConfigDelta) {
          let configOutcome: InFlightConfigApplyOutcome;
          try {
            configOutcome = await applyConfigDelta({ permissionMode: resolvedMode.queuePermissionMode });
          } catch {
            configOutcome = { status: 'failed', reason: 'config_apply_threw' };
          }
          if (configOutcome.status !== 'applied' && configOutcome.status !== 'scheduled_in_turn') {
            // The backend cannot own the config mid-turn: legacy queue path (the mode applies
            // when the queue drains). The steer was never accepted, so this is not a bounce.
            try {
              pushMessageToQueueWithSpecialCommands({
                queue: opts.queue,
                message: { text, localId: message.localId ?? null },
                text,
                mode: {
                  permissionMode: resolvedMode.queuePermissionMode,
                  ...resolveAppendSystemPromptModeOverride(message.meta),
                },
              });
              notifyPromptQueuedDuringTurnBestEffort();
            } catch {
              // Best-effort fallback: queueing should not be able to crash the process.
            }
            return;
          }
        }
        try {
          let providerText = text;
          if (typeof session.getMetadataSnapshot === 'function') {
            try {
              const seedResolution = await resolveProviderPromptWithReplaySeed({
                session: {
                  getMetadataSnapshot: session.getMetadataSnapshot,
                  updateMetadata: session.updateMetadata,
                  refreshSessionSnapshotFromServerBestEffort: session.refreshSessionSnapshotFromServerBestEffort,
                },
                userText: text,
                allowSeed: true,
                localId: message.localId ?? null,
                nowMs: Date.now(),
                refreshMetadataBeforeRead: !didReplaySeedBootstrapForSteer,
              });
              didReplaySeedBootstrapForSteer = true;
              providerText = seedResolution.providerPrompt;
            } catch {
              // Best-effort only; fall back to steering the raw user text.
            }
          }

          await steer.steerText(providerText, { localId: message.localId ?? null });
          return;
        } catch {
          try {
            pushMessageToQueueWithSpecialCommands({
              queue: opts.queue,
              message: { text, localId: message.localId ?? null },
              text,
              mode: {
                permissionMode: resolvedMode.queuePermissionMode,
                ...resolveAppendSystemPromptModeOverride(message.meta),
              },
            });
            notifyPromptQueuedDuringTurnBestEffort();
          } catch {
            // Best-effort fallback: queueing should not be able to crash the process if a steer fails.
          }
        }
      });
      return;
    }

    pushMessageToQueueWithSpecialCommands({
      queue: opts.queue,
      message: { text, localId: message.localId ?? null },
      text,
      mode: {
        permissionMode: resolvedMode.queuePermissionMode,
        ...resolveAppendSystemPromptModeOverride(message.meta),
      },
    });
    if (steer?.isTurnInFlight()) {
      notifyPromptQueuedDuringTurnBestEffort();
    }
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

  const bindSession = (session: PermissionModeQueueSessionBinding) => {
    currentSession = session;
    session.onUserMessage((message) => {
      handleMessage(session, message);
    });
  };

  bindSession(opts.session);

  return { bindSession };
}

type PermissionModeQueueSessionBinding = {
  onUserMessage: (handler: (message: UserMessage) => void) => void;
  updateMetadata: (updater: (current: Metadata) => Metadata) => Promise<void> | void;
  getMetadataSnapshot?: () => unknown;
  refreshSessionSnapshotFromServerBestEffort?: (opts?: { reason: 'connect' | 'waitForMetadataUpdate' }) => Promise<void>;
};
