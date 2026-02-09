import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { hashObject } from '@/utils/deterministicJson';
import { registerPermissionModeMessageQueueBinding } from '@/agent/runtime/permission/bindPermissionModeQueue';
import { readPermissionModeUpdatedAtFromMetadataSnapshot } from '@/agent/runtime/permission/permissionModeStateSync';

export function createPermissionModeQueueState(opts: {
  session: ApiSessionClient;
  initialPermissionMode: PermissionMode;
}): {
  messageQueue: MessageQueue2<{ permissionMode: PermissionMode }>;
  getCurrentPermissionMode: () => PermissionMode | undefined;
  setCurrentPermissionMode: (mode: PermissionMode | undefined) => void;
  getCurrentPermissionModeUpdatedAt: () => number;
  setCurrentPermissionModeUpdatedAt: (updatedAt: number) => void;
} {
  const messageQueue = new MessageQueue2<{ permissionMode: PermissionMode }>((mode) => hashObject({
    permissionMode: mode.permissionMode,
  }));

  let currentPermissionMode: PermissionMode | undefined = opts.initialPermissionMode;
  let currentPermissionModeUpdatedAt = readPermissionModeUpdatedAtFromMetadataSnapshot(
    opts.session.getMetadataSnapshot(),
  );

  registerPermissionModeMessageQueueBinding({
    session: opts.session,
    queue: messageQueue,
    getCurrentPermissionMode: () => currentPermissionMode,
    setCurrentPermissionMode: (mode) => {
      currentPermissionMode = mode;
    },
  });

  return {
    messageQueue,
    getCurrentPermissionMode: () => currentPermissionMode,
    setCurrentPermissionMode: (mode) => {
      currentPermissionMode = mode;
    },
    getCurrentPermissionModeUpdatedAt: () => currentPermissionModeUpdatedAt,
    setCurrentPermissionModeUpdatedAt: (updatedAt) => {
      currentPermissionModeUpdatedAt = updatedAt;
    },
  };
}
