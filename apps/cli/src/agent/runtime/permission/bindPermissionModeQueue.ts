import type { Metadata, PermissionMode, UserMessage } from '@/api/types';

import { pushTextToMessageQueueWithSpecialCommands, type SpecialCommandQueue } from '@/agent/runtime/queueSpecialCommands';

import { resolvePermissionModeUpdatedAtFromMessage } from './permissionModeCanonical';
import { resolvePermissionModeForQueueingUserMessage } from './permissionModeFromUserMessage';

export function registerPermissionModeMessageQueueBinding(opts: {
  session: {
    onUserMessage: (handler: (message: UserMessage) => void) => void;
    updateMetadata: (updater: (current: Metadata) => Metadata) => void;
  };
  queue: SpecialCommandQueue<{ permissionMode: PermissionMode }>;
  getCurrentPermissionMode: () => PermissionMode | undefined;
  setCurrentPermissionMode: (mode: PermissionMode | undefined) => void;
}): void {
  opts.session.onUserMessage((message) => {
    const resolvedMode = resolvePermissionModeForQueueingUserMessage({
      currentPermissionMode: opts.getCurrentPermissionMode(),
      messagePermissionModeRaw: message.meta?.permissionMode,
      updateMetadata: (updater) => opts.session.updateMetadata(updater),
      nowMs: () => resolvePermissionModeUpdatedAtFromMessage(message),
    });

    opts.setCurrentPermissionMode(resolvedMode.currentPermissionMode);

    pushTextToMessageQueueWithSpecialCommands({
      queue: opts.queue,
      text: message.content.text,
      mode: { permissionMode: resolvedMode.queuePermissionMode },
    });
  });
}
