import { isSessionPersonallyTrackedForViewerV1 } from '@happier-dev/protocol/sessions/personal/tracking';
import { resolveSessionPersonalEventEligibilityV1, resolveSessionPersonalFollowEventV1 } from '@happier-dev/protocol/sessions/personal/eventEligibility';
import { projectSessionFinishedPersonFollowV1, resolveEffectiveAccountFollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import type { FollowEventV1, FollowPolicyV1, ResolveFollowDeliveryV1Params } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { SessionFollowUpdateNotificationV1Schema, SourceFollowUpdateNotificationV1Schema } from '@happier-dev/protocol/activity/webhookPayload';

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type { ActivityNotificationEvent } from './activityNotificationEvent';
import type { FollowDeliveryMuteScopeV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';

export type SessionNotificationContextReader = Readonly<{
  fetchSessionNotificationContext?: (sessionId: string) => Promise<RawSessionRecord | null>;
  /** HTTP boundary bound to the sending Account and Home, never the source owner. */
  readAccountSessionDeliveryMutedScopes?: () => Promise<readonly FollowDeliveryMuteScopeV1[] | null>;
}>;

/** Session candidacy precedes every delivery channel; Account policy remains downstream. */
export async function resolveSessionActivityNotificationAdmission(params: Readonly<{
  event: ActivityNotificationEvent;
  fetchSessionNotificationContext?: SessionNotificationContextReader['fetchSessionNotificationContext'];
  followEvent?: FollowEventV1;
  admittedRulePolicies?: readonly FollowPolicyV1[];
  settledFinished?: true;
}>): Promise<Readonly<{ eligible: boolean; homeOwnsPush?: true; follow?: ResolveFollowDeliveryV1Params }>> {
  const { event } = params;
  if (event.topic === 'follow_update' && 'original' in event.follow) {
    // The exact source and own Account Follow were admitted by the source route;
    // channel selection stays at the same canonical policy owner.
    return SourceFollowUpdateNotificationV1Schema.safeParse(event).success && params.admittedRulePolicies?.length
      ? { eligible: true, follow: { policies: params.admittedRulePolicies, event: event.follow.event } }
      : { eligible: false };
  }
  if (event.topic !== 'ready' && event.topic !== 'permission_request' && event.topic !== 'user_action_request' && event.topic !== 'follow_update') {
    return { eligible: true };
  }
  if (event.topic === 'follow_update' && !SessionFollowUpdateNotificationV1Schema.safeParse(event).success) return { eligible: false };
  if (!params.fetchSessionNotificationContext) return { eligible: false };
  if (!('sessionId' in event)) return { eligible: false };
  const session = await params.fetchSessionNotificationContext(event.sessionId);
  if (!session || session.id !== event.sessionId || !session.viewer || !session.effectiveAccess) return { eligible: false };
  const access = session.effectiveAccess;
  const viewer = session.viewer;
  const isSessionOwner = access.level === 'owner';
  const followEvent = event.topic === 'follow_update' ? event.follow.event : params.followEvent;
  const personalEvent = event.topic === 'follow_update'
    ? followEvent?.kind === 'needs_you' ? followEvent.type === 'approval' ? 'permission_required' : 'user_action_required'
      : followEvent?.kind === 'finished' ? 'ready' : followEvent?.kind === 'failed_or_stopped' ? 'failed'
        : followEvent?.kind === 'person_wrote' ? 'human_message' : 'message'
    : event.topic === 'ready' ? 'ready' : event.topic === 'permission_request' ? 'permission_required' : 'user_action_required';
  const eligibility = resolveSessionPersonalEventEligibilityV1({
    event: personalEvent,
    isSessionOwner,
    accessible: access.capabilities.readTranscript,
    // The authenticated current detail operation has already admitted an active Account.
    accountSuspended: false,
    archived: session.archivedAt != null,
    responsible: viewer.relevance.reasons.includes('responsible_for_me'),
    tracked: isSessionPersonallyTrackedForViewerV1({ isSessionOwner, followFacts: viewer.follow }),
    // Ordinary runtime requests are ongoing events, not explicitly targeted one-shot requests.
    targeted: false,
    followFacts: viewer.follow,
    followEvent,
    admittedRulePolicies: params.admittedRulePolicies,
    capabilities: {
      canSubmitAgentInput: access.capabilities.submitAgentInput,
      canApprovePermissions: access.capabilities.approveRuntimePermissions,
    },
  });
  const policy = resolveEffectiveAccountFollowPolicyV1({ facts: viewer.follow, isSessionOwner });
  const selectedEvent = followEvent ?? resolveSessionPersonalFollowEventV1(personalEvent);
  const settledSessionPerson = selectedEvent?.kind === 'finished'
    && (params.settledFinished || event.topic === 'follow_update' && 'sourceTurn' in event.follow)
    ? projectSessionFinishedPersonFollowV1({ originKind: session.origin?.kind, isSessionOwner,
      manager: session.manager ? 'assigned' : undefined })
    : undefined;
  // Fulfilled one-shot custody belongs to Home for this exact original only.
  // Ongoing explicit/rule interest may still select other channels.
  const once = viewer.follow.onceDelivery;
  const requestId = event.topic === 'permission_request' || event.topic === 'user_action_request' ? event.requestId
    : event.topic === 'follow_update' && event.follow.sourceRequests?.requests.length === 1
      ? event.follow.sourceRequests.requests[0]?.requestId : undefined;
  const transcriptSeq = event.topic === 'ready' ? event.committedSequence
    : event.topic === 'follow_update' ? event.follow.sourceMessage?.seq : undefined;
  const matchesOnceEvent = once?.event === personalEvent || event.topic === 'follow_update'
    && event.follow.event.kind === 'failed_or_stopped' && once?.event === 'cancelled';
  const homeOwnsPush = matchesOnceEvent && (requestId !== undefined
    ? once?.requestId === requestId : transcriptSeq !== undefined && once?.transcriptSeq === transcriptSeq);
  return { eligible: eligibility.eligible,
    ...(homeOwnsPush ? { homeOwnsPush: true } : {}),
    ...(selectedEvent ? { follow: { policies: [...(policy ? [policy] : []), ...(params.admittedRulePolicies ?? [])],
      event: selectedEvent, settledSessionPerson } } : {}),
  };
}
