import type { Metadata, PermissionMode, UserMessage } from '@/api/types';

import { pushMessageToQueueWithSpecialCommands, type SpecialCommandQueue } from '@/agent/runtime/queueSpecialCommands';
import { resolveAppendSystemPromptModeOverride } from '@/agent/runtime/permissions/appendSystemPrompt';
import { resolveProviderPromptWithReplaySeed } from '@/agent/runtime/replaySeed/replaySeedV1';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';

import { resolvePermissionModeUpdatedAtFromMessage } from './modeCanonical';
import { resolvePermissionModeForQueueingUserMessage } from './modeFromUserMessage';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import type { PermissionModeQueuedPrompt } from '@/agent/runtime/permissions/queuedPrompt';

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
  steerText: (text: string) => Promise<void>;
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

    const previousPermissionMode = opts.getCurrentPermissionMode();
    const resolvedMode = resolvePermissionModeForQueueingUserMessage({
      currentPermissionMode: previousPermissionMode,
      messagePermissionModeRaw: message.meta?.permissionMode,
      updateMetadata: (updater) =>
        updateMetadataBestEffort(session, updater, '[permissionMode]', 'permission_mode_from_user_message'),
      nowMs: () => resolvePermissionModeUpdatedAtFromMessage(message),
    });

    opts.setCurrentPermissionMode(resolvedMode.currentPermissionMode);

    const text = message.content.text;
    const special = parseSpecialCommand(text);
    const didChangePermissionMode = previousPermissionMode !== resolvedMode.currentPermissionMode;

    // In-flight steer is only valid when:
    // - the runtime is currently processing a turn,
    // - steering is supported,
    // - the message does NOT alter permission mode (mode changes must be handled by the main loop),
    // - and the message is not a control command like /clear or /compact.
    const steer = opts.inFlightSteer;
    if (
      steer &&
      steer.supportsInFlightSteer() &&
      (steer.canSteerPrompt?.() ?? steer.isTurnInFlight()) &&
      !didChangePermissionMode &&
      special.type === null
    ) {
      steerSequence = steerSequence.then(async () => {
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

          await steer.steerText(providerText);
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
