import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createManualCompactionQueue, type ManualCompactionQueue } from './queueSpecialCommands';
import { hashObject } from '@/utils/deterministicJson';
import { registerPermissionModeMessageQueueBinding, type InFlightSteerController } from '@/agent/runtime/permissions/bindModeQueue';
import {
  createUnsettledReplaySeedRetirement,
  type UnsettledReplaySeedRetirement,
} from '@/agent/runtime/replaySeed/unsettledReplaySeedRetirement';
import { resolveAppendSystemPromptQueueKeyValue } from '@/agent/runtime/permissions/appendSystemPrompt';
import { resolvePermissionIntentFromMetadataSnapshot } from '@/agent/runtime/permissions/modeFromMetadata';
import {
  combinePermissionModeQueuedPrompts,
  appendNextTurnContextToQueuedPrompt,
  isNextTurnContextQueuedPrompt,
  type PermissionModeQueuedPromptMode,
  type PermissionModeQueuedPrompt,
} from '@/agent/runtime/permissions/queuedPrompt';

export function createPermissionModeQueueState(opts: {
  session: ApiSessionClient;
  agentTargetKey: string;
  initialPermissionMode: PermissionMode;
  inFlightSteer?: InFlightSteerController | null;
  readManualCompactionAvailable?: () => boolean;
  /**
   * Optional: provide a stable key used to batch messages and detect "effective" mode changes.
   *
   * This is useful when multiple permission modes map to the same backend configuration for a provider,
   * so toggling between them should not force a runtime restart.
   */
  resolvePermissionModeQueueKey?: (permissionMode: PermissionMode) => string;
}): {
  messageQueue: MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>;
  manualCompaction: ManualCompactionQueue<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>;
  rebindSession: (session: ApiSessionClient) => void;
  releaseRejectedBeforeProviderPromptIdentity: (
    session: ApiSessionClient,
    message: PermissionModeQueuedPrompt,
  ) => void;
  getCurrentPermissionMode: () => PermissionMode | undefined;
  setCurrentPermissionMode: (mode: PermissionMode | undefined) => void;
  getCurrentPermissionModeUpdatedAt: () => number;
  setCurrentPermissionModeUpdatedAt: (updatedAt: number) => void;
  /**
   * Session-scoped hold for an accepted replay seed whose metadata retirement has not
   * succeeded. Shared by the prompt loop's queue admission and this binding's in-flight
   * steer admission; both retry the same idempotent settler at their admission boundaries
   * and admit no provider input until it succeeds.
   */
  replaySeedRetirement: UnsettledReplaySeedRetirement;
} {
  const resolveQueueKey = opts.resolvePermissionModeQueueKey;
  const messageQueue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
    (mode) =>
      hashObject({
        permissionMode: resolveQueueKey ? resolveQueueKey(mode.permissionMode) : mode.permissionMode,
        appendSystemPrompt: resolveAppendSystemPromptQueueKeyValue(mode),
        modelSelection: mode.modelSelection ?? null,
        callerInputConstraints: mode.callerInputConstraints ?? null,
        suppressUserEcho: mode.suppressUserEcho === true,
        providerPromptAlreadyResolved: mode.providerPromptAlreadyResolved === true,
        causalPermissionAuthority: mode.causalPermissionAuthority ?? null,
        actionRequestAttributionV1: mode.actionRequestAttributionV1 ?? null,
        discussionAddressing: mode.discussionAddressing ?? null,
        inputContextBlock: mode.inputContextBlock ?? '',
        inputProvenance: mode.inputProvenance ?? null,
        returnedAnswer: mode.returnedAnswer ?? null,
      }),
    {
      batcher: (messages) => combinePermissionModeQueuedPrompts(messages),
      isContextOnly: isNextTurnContextQueuedPrompt,
      withContext: appendNextTurnContextToQueuedPrompt,
    },
  );

  const currentPermissionIntent = resolvePermissionIntentFromMetadataSnapshot({ metadata: opts.session.getMetadataSnapshot() });
  let currentPermissionMode: PermissionMode | undefined = currentPermissionIntent?.intent ?? opts.initialPermissionMode;
  let currentPermissionModeUpdatedAt = currentPermissionIntent?.updatedAt ?? 0;

  const replaySeedRetirement = createUnsettledReplaySeedRetirement();
  const manualCompaction = createManualCompactionQueue({
    queue: messageQueue,
    readText: (message: PermissionModeQueuedPrompt) => message.text,
    isAvailable: () => opts.readManualCompactionAvailable?.() === true,
  });

  const binding = registerPermissionModeMessageQueueBinding({
    session: opts.session,
    agentTargetKey: opts.agentTargetKey,
    queue: messageQueue,
    manualCompaction,
    getCurrentPermissionMode: () => currentPermissionMode,
    setCurrentPermissionMode: (mode) => {
      currentPermissionMode = mode;
    },
    inFlightSteer: opts.inFlightSteer ?? null,
    replaySeedRetirement,
  });

  return {
    messageQueue,
    manualCompaction,
    rebindSession: (session) => {
      binding.bindSession(session);
    },
    releaseRejectedBeforeProviderPromptIdentity: (session, message) => {
      binding.releaseRejectedBeforeProviderPromptIdentity(session, message);
    },
    getCurrentPermissionMode: () => currentPermissionMode,
    setCurrentPermissionMode: (mode) => {
      currentPermissionMode = mode;
    },
    getCurrentPermissionModeUpdatedAt: () => currentPermissionModeUpdatedAt,
    setCurrentPermissionModeUpdatedAt: (updatedAt) => {
      currentPermissionModeUpdatedAt = updatedAt;
    },
    replaySeedRetirement,
  };
}
