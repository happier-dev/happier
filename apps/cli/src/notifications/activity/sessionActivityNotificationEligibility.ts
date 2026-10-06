import { isSessionPersonallyTrackedForViewerV1 } from '@happier-dev/protocol/sessions/personal/tracking';
import { resolveSessionPersonalEventEligibilityV1 } from '@happier-dev/protocol/sessions/personal/eventEligibility';

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type { ActivityNotificationEvent } from './activityNotificationEvent';

export type SessionNotificationContextReader = Readonly<{
  fetchSessionNotificationContext?: (sessionId: string) => Promise<RawSessionRecord | null>;
}>;

/** Session candidacy precedes every delivery channel; Account policy remains downstream. */
export async function isSessionActivityNotificationEligible(params: Readonly<{
  event: ActivityNotificationEvent;
  fetchSessionNotificationContext?: SessionNotificationContextReader['fetchSessionNotificationContext'];
}>): Promise<boolean> {
  const { event } = params;
  if (event.topic !== 'ready' && event.topic !== 'permission_request' && event.topic !== 'user_action_request') {
    return true;
  }
  if (!params.fetchSessionNotificationContext) return false;
  const session = await params.fetchSessionNotificationContext(event.sessionId);
  if (!session || session.id !== event.sessionId || !session.viewer || !session.effectiveAccess) return false;
  const access = session.effectiveAccess;
  const viewer = session.viewer;
  const isSessionOwner = access.level === 'owner';
  return resolveSessionPersonalEventEligibilityV1({
    event: event.topic === 'ready' ? 'ready'
      : event.topic === 'permission_request' ? 'permission_required' : 'user_action_required',
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
    capabilities: {
      canSubmitAgentInput: access.capabilities.submitAgentInput,
      canApprovePermissions: access.capabilities.approveRuntimePermissions,
    },
  }).eligible;
}
