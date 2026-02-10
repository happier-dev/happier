import type { Metadata, PermissionMode, UserMessage } from '@/api/types';

import { pushTextToMessageQueueWithSpecialCommands, type SpecialCommandQueue } from '@/agent/runtime/queueSpecialCommands';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';

import { resolvePermissionModeUpdatedAtFromMessage } from './permissionModeCanonical';
import { resolvePermissionModeForQueueingUserMessage } from './permissionModeFromUserMessage';

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
  steerText: (text: string) => Promise<void>;
}>;

export function registerPermissionModeMessageQueueBinding(opts: {
  session: {
    onUserMessage: (handler: (message: UserMessage) => void) => void;
    updateMetadata: (updater: (current: Metadata) => Metadata) => void;
  };
  queue: SpecialCommandQueue<{ permissionMode: PermissionMode }>;
  getCurrentPermissionMode: () => PermissionMode | undefined;
  setCurrentPermissionMode: (mode: PermissionMode | undefined) => void;
  inFlightSteer?: InFlightSteerController | null;
}): void {
  let steerSequence: Promise<void> = Promise.resolve();

  opts.session.onUserMessage((message) => {
    const previousPermissionMode = opts.getCurrentPermissionMode();
    const resolvedMode = resolvePermissionModeForQueueingUserMessage({
      currentPermissionMode: previousPermissionMode,
      messagePermissionModeRaw: message.meta?.permissionMode,
      updateMetadata: (updater) => opts.session.updateMetadata(updater),
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
      steer.isTurnInFlight() &&
      !didChangePermissionMode &&
      special.type === null
    ) {
      steerSequence = steerSequence.then(async () => {
        try {
          await steer.steerText(text);
          return;
        } catch {
          try {
            pushTextToMessageQueueWithSpecialCommands({
              queue: opts.queue,
              text,
              mode: { permissionMode: resolvedMode.queuePermissionMode },
            });
          } catch {
            // Best-effort fallback: queueing should not be able to crash the process if a steer fails.
          }
        }
      });
      return;
    }

    pushTextToMessageQueueWithSpecialCommands({
      queue: opts.queue,
      text,
      mode: { permissionMode: resolvedMode.queuePermissionMode },
    });
  });
}
