import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import type { ActivitySurfacePrivacyMode } from '@/activity/attention/resolveActivitySurfacePolicy';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';

import type {
    ActivityAttentionDeliveryEventKind,
    ActivityAttentionSurface,
} from './activityAttentionDeliveryPlanTypes';
import { resolveActivityAttentionDeliveryPlan } from './resolveActivityAttentionDeliveryPlan';
import type { ExactHomeAccountSettingsResolver } from './useExactHomeAccountSettings';
import { ABSENT_SESSION_FOLLOW_FACTS_V1, resolveEffectiveAccountFollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { resolveRequestFollowEventV1, type FollowEventV1, type ResolveFollowDeliveryV1Params } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { resolvePendingRequestAttentionReasonV1 } from '@happier-dev/protocol/sessions/personal/attention';
import { selectOldestPendingRequest } from '@happier-dev/session-core/pending';
import { listPendingSessionRequests } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { listSessionListPresentationPendingRequests } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { readCurrentPersonalFollowOnceOccurrenceForViewer } from '@/sync/domains/session/readState/sessionViewerAttention';
import { isFollowDeliveryMutedV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';

type LocalSettingsLike = Readonly<Record<string, unknown>>;

/**
 * The exact Home a candidate belongs to. Activity candidates are Home-qualified
 * by the attention source; an unqualified candidate has no Account whose policy
 * could admit it.
 */
function resolveCandidateServerId(candidate: SessionActivityAttention): string | null {
    return normalizeSessionAddress(
        candidate.address?.serverId ?? candidate.serverId ?? candidate.session.serverId,
        candidate.sessionId,
    )?.serverId ?? null;
}

/** Opaque exact-address key; two Homes may legitimately carry the same Session ID. */
function candidateDeliveryKey(candidate: SessionActivityAttention): string {
    return sessionAddressKey({
        serverId: resolveCandidateServerId(candidate) ?? '',
        sessionId: candidate.sessionId,
    });
}

/**
 * The canonical attention event a candidate currently represents, read from the
 * attention owner's committed reasons rather than re-derived from session state.
 */
export function resolveActivityCandidateEventKind(
    candidate: SessionActivityAttention,
): ActivityAttentionDeliveryEventKind {
    if (candidate.reasons.hasPendingPermissionRequests) return 'permission_request';
    if (candidate.reasons.hasPendingUserActionRequests || candidate.reasons.hasBlockedPendingDelivery) {
        return 'user_action_request';
    }
    return 'ready';
}

function resolveCandidateFollowIntent(candidate: SessionActivityAttention): ResolveFollowDeliveryV1Params | undefined {
    // Passive working/progress cards are not new semantic occurrences.
    if (!candidate.hasAttention) return undefined;
    if (candidate.personalAttention.primary === 'manual' || candidate.personalAttention.primary === 'reminder_due'
        || candidate.personalAttention.primary === 'mentioned' || candidate.personalAttention.primary === 'unread_discussion') return undefined;
    const policy = resolveEffectiveAccountFollowPolicyV1({
        facts: candidate.session.viewer?.follow ?? ABSENT_SESSION_FOLLOW_FACTS_V1,
        isSessionOwner: candidate.session.access?.level === 'owner',
    });
    const reasons = candidate.personalAttention.reasons;
    const once = readCurrentPersonalFollowOnceOccurrenceForViewer(candidate.session, undefined, candidate.presentationSource);
    const pendingReason = candidate.reasons.hasPendingPermissionRequests ? 'permission_required'
        : candidate.reasons.hasPendingUserActionRequests ? 'user_action_required' : null;
    const requests = pendingReason ? (candidate.presentationSource ? listSessionListPresentationPendingRequests(candidate.presentationSource)
        : 'agentState' in candidate.session ? listPendingSessionRequests(candidate.session) : [])
        .filter(request => resolvePendingRequestAttentionReasonV1(request) === pendingReason) : [];
    const request = requests.find(value => value.id === once?.requestId) ?? selectOldestPendingRequest(requests);
    // Counts retain Inbox attention, but unopened user-action content cannot
    // establish continue mode or a manager handler for an interruption.
    if (pendingReason === 'user_action_required' && !request) {
        return { policies: [], event: { kind: 'needs_you', type: 'decision' } };
    }
    let event: FollowEventV1 = candidate.reasons.hasPendingPermissionRequests
        ? { kind: 'needs_you', type: 'approval' }
        : candidate.reasons.hasPendingUserActionRequests ? { kind: 'needs_you', type: 'decision' }
        : candidate.reasons.hasBlockedPendingDelivery ? { kind: 'needs_you', type: 'blocked' }
        : reasons.includes('failed') ? { kind: 'failed_or_stopped' }
        : reasons.includes('ready_after_read') ? { kind: 'finished' }
        : { kind: 'message' };
    if (request) event = resolveRequestFollowEventV1({ requestKind: resolvePendingRequestAttentionReasonV1(request) === 'permission_required' ? 'permission' : 'user_action',
        questionV1: request.questionV1, currentHandler: request.currentHandler });
    const onceMatches = once && (event.kind === 'needs_you'
        ? once.event === pendingReason && once.requestId === request?.id
        : event.kind === 'failed_or_stopped' ? once.event === 'failed'
        : event.kind === 'finished' && (once.event === 'ready' || once.event === 'cancelled'));
    if (onceMatches && once.event === 'cancelled') event = { kind: 'failed_or_stopped' };
    return { policies: [...(policy ? [policy] : []), ...(candidate.followRulePolicies ?? []),
        ...(onceMatches ? [{ preset: 'everything' as const }] : [])], event };
}

export type ActivitySurfaceDeliveryAdmission = Readonly<{
    /** Candidates whose own Home admits this surface, in the input order. */
    candidates: readonly SessionActivityAttention[];
    /** Exact-Home privacy projection for an admitted candidate, otherwise `null`. */
    privacyModeFor: (candidate: SessionActivityAttention) => ActivitySurfacePrivacyMode | null;
    /** Stable identity of the admission result, so bridges resync on a policy mutation. */
    fingerprint: string;
}>;

/**
 * Evaluate every exact `serverId` + `sessionId` candidate through the canonical
 * Activity delivery-plan owner using that candidate's own Account policy.
 *
 * A Home with no resolvable scope or no persisted Account settings fails closed:
 * it neither renders nor registers, and never inherits the active Home's policy.
 */
export function resolveActivitySurfaceDeliveryAdmission(params: Readonly<{
    candidates: readonly SessionActivityAttention[];
    surface: ActivityAttentionSurface;
    resolveAccountSettings: ExactHomeAccountSettingsResolver;
    localSettings: LocalSettingsLike;
    now: Date;
    /** An already-authorized conversation open is scoped to the Action's Account. */
    intent?: Readonly<{ kind: 'explicit_open'; scope: ServerAccountScope }>;
    accountDeliveryMutesByServerId?: ActivityAttentionSource['accountDeliveryMutesByServerId'];
    audienceScopes?: ActivityAttentionSource['audienceScopes'];
}>): ActivitySurfaceDeliveryAdmission {
    const privacyModeByKey = new Map<string, ActivitySurfacePrivacyMode>();
    const admitted: SessionActivityAttention[] = [];
    const fingerprintEntries: string[] = [];
    const explicitScope = params.intent?.scope;

    for (const candidate of params.candidates) {
        const key = candidateDeliveryKey(candidate);
        const serverId = resolveCandidateServerId(candidate);
        const muteSnapshot = serverId ? params.accountDeliveryMutesByServerId?.[serverId] : null;
        const scope = serverId ? params.audienceScopes?.get(serverId) : null;
        const scoped = scope && (explicitScope
            ? areServerAccountScopesEqual(scope, explicitScope)
            : muteSnapshot && areServerAccountScopesEqual(scope, muteSnapshot.scope)
                && !isFollowDeliveryMutedV1(muteSnapshot.scopes, { senderSessionId: candidate.sessionId,
                    source: { kind: 'session', sessionId: candidate.sessionId } }));
        if (!scoped) {
            fingerprintEntries.push(JSON.stringify([key, false]));
            continue;
        }
        const accountSettings = params.resolveAccountSettings(serverId);
        const plan = accountSettings
            ? resolveActivityAttentionDeliveryPlan({
                accountSettings,
                localSettings: params.localSettings,
                event: resolveActivityCandidateEventKind(candidate),
                channel: params.surface,
                surface: params.surface,
                now: params.now,
                ...(explicitScope ? {} : {
                    follow: resolveCandidateFollowIntent(candidate),
                    inboxItemType: candidate.personalAttention.primary === 'mentioned' ? 'mention'
                        : candidate.personalAttention.primary === 'unread_discussion' ? 'update' : undefined,
                }),
            })
            : null;
        if (!plan || plan.delivery === 'suppress') {
            fingerprintEntries.push(JSON.stringify([key, false]));
            continue;
        }

        const privacyMode = plan.previewBehavior;
        privacyModeByKey.set(key, privacyMode);
        admitted.push(candidate);
        fingerprintEntries.push(JSON.stringify([key, true, privacyMode]));
    }

    return {
        candidates: admitted,
        privacyModeFor: (candidate) => privacyModeByKey.get(candidateDeliveryKey(candidate)) ?? null,
        fingerprint: JSON.stringify(fingerprintEntries.sort()),
    };
}
