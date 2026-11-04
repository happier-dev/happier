import { classifyBotActivity, type BotActivity } from '@/components/sessions/bots/botActivity';
import type { ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildActivitySurfaceViewModel } from '@/activity/presentation/buildActivitySurfaceViewModel';
import { resolveStricterActivitySurfacePrivacyMode } from './resolveActivityAttentionDeliveryPlan';
import type { ActivitySurfaceDeliveryAdmission } from './resolveActivitySurfaceDeliveryAdmission';
import { normalizeSessionAddress, sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { listSessionListPresentationPendingRequests } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { listPendingSessionRequests } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { t } from '@/text';

/** Privacy-filtered facts shared by ambient island and pet presentations. */
export type SharedActivityEntry = Readonly<{
    id: string;
    dismissKey: string;
    address: SessionAddress;
    sessionId: string;
    activity: BotActivity;
    title: string;
    subtitle: string | null;
    contextLine: string | null;
    accessibilityContext: string | null;
}>;

export type SharedActivityProjection = Readonly<{
    visible: boolean;
    activity: BotActivity;
    word: string;
    entries: readonly SharedActivityEntry[];
    tray: readonly SharedActivityEntry[];
}>;

/**
 * Admission owns delivery; WorkStatus owns semantics. Neither presenter re-reads raw
 * runtime, unread, transcripts or elapsed time to decide what the person needs.
 * Face membership is supplied by N3's owner, rather than duplicated here.
 */
export function buildSharedActivityProjection(params: Readonly<{
    admission: ActivitySurfaceDeliveryAdmission;
    policy: ActivitySurfacePolicy;
    selectedFaces?: readonly Readonly<{ activity: BotActivity }>[];
}>): SharedActivityProjection {
    const entries = params.admission.candidates.flatMap(candidate => {
        const address = candidate.address ?? normalizeSessionAddress(candidate.serverId ?? candidate.session.serverId, candidate.sessionId);
        if (!address) return [];
        const activity = classifyBotActivity(candidate.workStatus);
        const view = buildActivitySurfaceViewModel({ candidate, policy: params.policy,
            showMachinePath: true, showPreviewText: false, isPrimary: false,
            resolveCandidatePrivacyMode: value => resolveStricterActivitySurfacePrivacyMode(
                params.admission.privacyModeFor(value)!, params.policy.privacyMode),
        });
        // These are the already-held attention records, never transcript inference or a pet clock.
        const requests = activity === 'needsYou'
            ? candidate.presentationSource ? listSessionListPresentationPendingRequests(candidate.presentationSource, [])
                : 'agentState' in candidate.session ? listPendingSessionRequests(candidate.session, []) : []
            : [];
        const id = sessionAddressKey(address);
        return [{ id, address, sessionId: address.sessionId, activity,
            dismissKey: JSON.stringify([id, candidate.workStatus.attentionType,
                requests.map(request => request.id).sort(),
                activity === 'needsYou' && requests.length === 0 ? candidate.session.pendingRequestObservedAt : null,
                candidate.personalAttention.primary,
                candidate.lastTurnCompletedAt]),
            title: view.title,
            subtitle: view.contextLine ?? view.subtitle,
            contextLine: view.contextLine ?? null,
            accessibilityContext: view.contextLine ?? null,
        } satisfies SharedActivityEntry];
    });
    const needsYou = entries.filter(entry => entry.activity === 'needsYou');
    const working = entries.filter(entry => entry.activity === 'working');
    return {
        activity: needsYou.length > 0 ? 'needsYou' : working.length > 0 ? 'working' : 'quiet',
        visible: needsYou.length > 0 || (params.selectedFaces?.length ?? 0) > 0,
        word: needsYou.length > 0 ? t('workStatus.buckets.needs_you')
            : working.length > 0 ? t('bots.roster.working', { count: working.length }) : '',
        entries,
        tray: [...needsYou, ...working],
    };
}
