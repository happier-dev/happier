import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { hashObject } from '@/utils/deterministicJson';
import { registerPermissionModeMessageQueueBinding, type InFlightSteerController } from '@/agent/runtime/permission/bindPermissionModeQueue';
import { readPermissionModeUpdatedAtFromMetadataSnapshot } from '@/agent/runtime/permission/permissionModeStateSync';

export function createPermissionModeQueueState(opts: {
  session: ApiSessionClient;
  initialPermissionMode: PermissionMode;
  inFlightSteer?: InFlightSteerController | null;
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
    inFlightSteer: opts.inFlightSteer ?? null,
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
