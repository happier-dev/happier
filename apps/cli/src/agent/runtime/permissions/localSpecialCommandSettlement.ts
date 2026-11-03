import type { ApiSessionClient } from '@/api/session/sessionClient';
import {
  normalizePermissionModeQueuedPromptLocalIds,
  normalizePermissionModeQueuedPromptUserMessageSeqs,
  readHighestPermissionModeQueuedPromptUserMessageSeq,
  type PermissionModeQueuedPrompt,
} from './queuedPrompt';

type LocalSpecialCommandSession = Partial<Pick<ApiSessionClient,
  'confirmUserMessageLocallyConsumed' | 'observeProviderInputSettlement'>>;

type QueuedPromptDeliveryIdentity = Readonly<{
  localIds: readonly string[];
  userMessageSeq: number | null;
  userMessageSeqs: readonly number[];
}>;

export function readQueuedPromptDeliveryIdentity(message: PermissionModeQueuedPrompt): QueuedPromptDeliveryIdentity {
  return {
    localIds: normalizePermissionModeQueuedPromptLocalIds(message),
    userMessageSeq: readHighestPermissionModeQueuedPromptUserMessageSeq(message),
    userMessageSeqs: normalizePermissionModeQueuedPromptUserMessageSeqs(message),
  };
}

export function hasQueuedPromptDeliveryIdentity(identity: QueuedPromptDeliveryIdentity): boolean {
  return identity.localIds.length > 0 || identity.userMessageSeq !== null || identity.userMessageSeqs.length > 0;
}

export function confirmLocallyConsumedPrompt(session: LocalSpecialCommandSession, message: PermissionModeQueuedPrompt): void {
  if (message.hostContextOnly) return;
  const identity = readQueuedPromptDeliveryIdentity(message);
  if (!hasQueuedPromptDeliveryIdentity(identity)) return;
  session.confirmUserMessageLocallyConsumed?.(identity);
}

export function observeLocalSpecialCommandSettlement(params: Readonly<{
  session: LocalSpecialCommandSession;
  message: PermissionModeQueuedPrompt;
  outcome:
    | Readonly<{ kind: 'accepted' }>
    | Readonly<{ kind: 'rejected_before_effect'; diagnosticMessage: string }>;
}>): void {
  if (params.message.hostContextOnly) return;
  const identity = readQueuedPromptDeliveryIdentity(params.message);
  if (identity.localIds.length !== 1) return;
  const localId = identity.localIds[0]!;
  const sharedIdentity = {
    localId,
    userMessageSeq: identity.userMessageSeq,
    ...(identity.userMessageSeqs.length > 0 ? { userMessageSeqs: identity.userMessageSeqs } : {}),
  };
  if (params.outcome.kind === 'accepted') {
    params.session.observeProviderInputSettlement?.({
      kind: 'accepted',
      ...sharedIdentity,
    });
    return;
  }
  params.session.observeProviderInputSettlement?.({
    kind: 'rejected_before_effect',
    ...sharedIdentity,
    reason: 'provider_rejected_before_acceptance',
    diagnostic: {
      code: 'local_special_command_rejected',
      severity: 'error',
      message: params.outcome.diagnosticMessage,
    },
    retryable: false,
  });
}
