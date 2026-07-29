import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { hashObject } from '@/utils/deterministicJson';
import { registerPermissionModeMessageQueueBinding, type InFlightSteerController } from '@/agent/runtime/permissions/bindModeQueue';
import { resolveAppendSystemPromptQueueKeyValue } from '@/agent/runtime/permissions/appendSystemPrompt';
import { readPermissionModeUpdatedAtFromMetadataSnapshot } from '@/agent/runtime/permissions/modeStateSync';
import {
  combinePermissionModeQueuedPrompts,
  type PermissionModeQueuedPromptMode,
  type PermissionModeQueuedPrompt,
} from '@/agent/runtime/permissions/queuedPrompt';

export function createPermissionModeQueueState(opts: {
  session: ApiSessionClient;
  agentTargetKey: string;
  initialPermissionMode: PermissionMode;
  inFlightSteer?: InFlightSteerController | null;
  /**
   * Optional: provide a stable key used to batch messages and detect "effective" mode changes.
   *
   * This is useful when multiple permission modes map to the same backend configuration for a provider,
   * so toggling between them should not force a runtime restart.
   */
  resolvePermissionModeQueueKey?: (permissionMode: PermissionMode) => string;
}): {
  messageQueue: MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>;
  rebindSession: (session: ApiSessionClient) => void;
  getCurrentPermissionMode: () => PermissionMode | undefined;
  setCurrentPermissionMode: (mode: PermissionMode | undefined) => void;
  getCurrentPermissionModeUpdatedAt: () => number;
  setCurrentPermissionModeUpdatedAt: (updatedAt: number) => void;
} {
  const resolveQueueKey = opts.resolvePermissionModeQueueKey;
  const messageQueue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
    (mode) =>
      hashObject({
        permissionMode: resolveQueueKey ? resolveQueueKey(mode.permissionMode) : mode.permissionMode,
        appendSystemPrompt: resolveAppendSystemPromptQueueKeyValue(mode),
        modelSelection: mode.modelSelection ?? null,
        suppressUserEcho: mode.suppressUserEcho === true,
        providerPromptAlreadyResolved: mode.providerPromptAlreadyResolved === true,
      }),
    {
      batcher: (messages) => combinePermissionModeQueuedPrompts(messages),
    },
  );

  let currentPermissionMode: PermissionMode | undefined = opts.initialPermissionMode;
  let currentPermissionModeUpdatedAt = readPermissionModeUpdatedAtFromMetadataSnapshot(
    opts.session.getMetadataSnapshot(),
  );

  const binding = registerPermissionModeMessageQueueBinding({
    session: opts.session,
    agentTargetKey: opts.agentTargetKey,
    queue: messageQueue,
    getCurrentPermissionMode: () => currentPermissionMode,
    setCurrentPermissionMode: (mode) => {
      currentPermissionMode = mode;
    },
    inFlightSteer: opts.inFlightSteer ?? null,
  });

  return {
    messageQueue,
    rebindSession: (session) => {
      binding.bindSession(session);
    },
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
