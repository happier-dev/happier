import type { SessionFollowRuleSourceOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { SessionFollowUpdateNotificationV1Schema, SourceFollowUpdateNotificationV1Schema,
  type DiscussionFollowUpdateNotificationV1 } from '@happier-dev/protocol/activity/webhookPayload';
import type { SessionFollowRunOccurrence } from '@/daemon/sessions/sessionActivityChangedContract';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { dispatchActivityNotificationAsync } from './dispatchActivityNotification';
import type { SessionActivityChangedResult } from '@/daemon/sessions/sessionActivityChangedContract';

type WithoutPublisher<T> = T extends unknown ? Omit<T, 'sourcePublisher'> : never;

export type PersonalFollowOccurrenceDispatch = Readonly<({
  sourceSessionId: string; occurrence: WithoutPublisher<SessionFollowRuleSourceOccurrenceV1>;
} | { sourceSessionId?: never; occurrence: SessionFollowRunOccurrence
    | { discussion: DiscussionFollowUpdateNotificationV1['follow'] & { seq: number } }; acceptDelivery: () => Promise<boolean> }) & {
  /** The Account's authorized private evaluator has already selected this route and applied receiver mute. */
  policies: readonly FollowPolicyV1[];
  signal: AbortSignal;
}>;

export type PersonalFollowOccurrenceDispatchResult = Readonly<{
  attemptedChannels: number;
  deliveredChannels: number;
}> & SessionActivityChangedResult;

/** Thin Account adapter; Follow selects routes and Activity owns channel delivery. */
export function createPersonalFollowOccurrenceDispatcher(params: Readonly<{
  operationContext: SavedSecretOperationContextV1;
  /** Reuses the caller's original-source/publisher/request and admitted-route currentness. */
  isCurrent: (input: PersonalFollowOccurrenceDispatch) => boolean | Promise<boolean>;
}> & Pick<Parameters<typeof dispatchActivityNotificationAsync>[0],
  'expoPushSender' | 'pluginNotifications' | 'fetchSessionNotificationContext' | 'readAccountSessionDeliveryMutedScopes' | 'webhookNetwork' | 'nowMs'>) {
  return async (input: PersonalFollowOccurrenceDispatch): Promise<PersonalFollowOccurrenceDispatchResult> => {
    const isCurrent = async () => !input.signal.aborted && await params.operationContext.isCurrent() && await params.isCurrent(input);
    const assertCurrent = async () => {
      input.signal.throwIfAborted();
      if (!await isCurrent()) throw new Error('personal_follow_scope_retired');
    };
    await assertCurrent();
    if ('original' in input.occurrence || 'discussion' in input.occurrence) {
      return await runWithServerHttpBaseUrl(params.operationContext.serverHttpBaseUrl, () => dispatchActivityNotificationAsync({
        ...params, settings: params.operationContext.readSnapshot()?.settings, isCurrent,
        admittedRulePolicies: input.policies,
        acceptSourceFollowDelivery: 'acceptDelivery' in input ? input.acceptDelivery : undefined,
        event: SourceFollowUpdateNotificationV1Schema.parse({ topic: 'follow_update', follow: 'discussion' in input.occurrence
          ? { original: input.occurrence.discussion.original, event: input.occurrence.discussion.event } : input.occurrence }),
      }));
    }
    if (input.sourceSessionId !== input.occurrence.sourceSessionId) throw new Error('personal_follow_source_mismatch');
    const occurrence = input.occurrence;
    const sourceSessionId = occurrence.sourceSessionId;
    // Requests and successful terminal updates already have an original rich
    // notification owner. Return the selected contribution to that owner before
    // its one send; the daemon must not race it with a second outward effect.
    if ('sourceRequests' in occurrence) {
      return { attemptedChannels: 0, deliveredChannels: 0, personalFollow: { sourceSessionId,
        requests: occurrence.sourceRequests.requests.map(request => ({ requestId: request.requestId, policies: [...input.policies] })) } };
    }
    if (occurrence.evidence.event.kind === 'finished') {
      return { attemptedChannels: 0, deliveredChannels: 0, personalFollow: { sourceSessionId,
        sourceMessage: { ...occurrence.sourceMessage, policies: [...input.policies] } } };
    }
    await assertCurrent();
    const result = await dispatchActivityNotificationAsync({ ...params, operationContext: params.operationContext,
      settings: params.operationContext.readSnapshot()?.settings, isCurrent,
      fetchSessionNotificationContext: params.fetchSessionNotificationContext ?? (sessionId => fetchSessionById({
        reason: 'session-notification',
        token: params.operationContext.credentials.token, serverUrl: params.operationContext.serverHttpBaseUrl,
        sessionId, signal: input.signal,
      })),
      admittedRulePolicies: input.policies,
      event: SessionFollowUpdateNotificationV1Schema.parse({ topic: 'follow_update', sessionId: sourceSessionId,
        follow: { event: occurrence.evidence.event, sourceMessage: occurrence.sourceMessage } }),
    });
    return { attemptedChannels: result.attemptedChannels, deliveredChannels: result.deliveredChannels };
  };
}
