import {
  ChangeDeliveryMuteResponseV1Schema,
  type FollowDeliveryMuteScopeV1,
} from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';

import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/** Whether this Account already mutes that participant Session; null when the mutes are not known. */
export function isDiscussionParticipantMuted(
  scopes: readonly FollowDeliveryMuteScopeV1[] | null | undefined,
  sessionId: string,
): boolean | null {
  if (!scopes) return null;
  return scopes.some(
    (scope) => scope.kind === 'sender_session' && scope.sessionId === sessionId,
  );
}

/**
 * Mutes or unmutes one Discussion participant's messages for this Account (CR3): the Follow family's
 * own mute Action with the exact sender scope, through the canonical Action front door. Resolves to
 * whether the change went through; the caller says so where it was asked.
 */
export async function setDiscussionParticipantMuted(
  params: Readonly<{
    sessionId: string;
    muted: boolean;
    accountLifetime?: ServerAccountScopeLifetime | null;
  }>,
): Promise<boolean> {
  try {
    const result = await callWorkflowAction({
      actionId: params.muted
        ? 'session.delivery.mute.set'
        : 'session.delivery.mute.remove',
      input: {
        receiver: { kind: 'account' },
        scope: { kind: 'sender_session', sessionId: params.sessionId },
      },
      ...(params.accountLifetime === undefined
        ? {}
        : { accountLifetime: params.accountLifetime }),
      parseResult: (value) => ChangeDeliveryMuteResponseV1Schema.parse(value),
    });
    return result.disposition === (params.muted ? 'muted' : 'unmuted');
  } catch {
    return false;
  }
}
