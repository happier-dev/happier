import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { getSessionName, getSessionStatus, getSessionSubtitle } from '@/utils/sessions/sessionUtils';

import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import type { ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';

import { ACTIVITY_SURFACE_TARGETS, createActivitySurfaceSessionRoute } from './activitySurfaceRouting';

export type ActivitySurfaceSessionCard = Readonly<{
    sessionId: string;
    title: string;
    subtitle: string | null;
    statusText: string | null;
    attentionState: SessionActivityAttention['attentionState'];
    route: string;
    target: string;
    isPrimary: boolean;
}>;

function resolveCardTitle(params: Readonly<{
    session: Session;
    statusText: string;
    privacyMode: ActivitySurfacePolicy['privacyMode'];
}>): string {
    if (params.privacyMode === 'status_only') {
        return params.statusText;
    }

    return getSessionName(params.session);
}

function resolveCardSubtitle(params: Readonly<{
    session: Session;
    privacyMode: ActivitySurfacePolicy['privacyMode'];
    showMachinePath: boolean;
}>): string | null {
    if (!params.showMachinePath) return null;
    if (params.privacyMode !== 'include_preview') return null;

    const subtitle = getSessionSubtitle(params.session).trim();
    return subtitle.length > 0 ? subtitle : null;
}

function resolveCardStatusText(params: Readonly<{
    statusText: string;
    privacyMode: ActivitySurfacePolicy['privacyMode'];
    showPreviewText: boolean;
}>): string | null {
    if (params.privacyMode === 'status_only') {
        return null;
    }
    if (!params.showPreviewText) {
        return null;
    }
    const trimmed = params.statusText.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolvePrimaryActivitySurfaceTarget(
    policy: ActivitySurfacePolicy,
    sessionId: string | null,
): string {
    if (policy.tapTarget === 'open_sessions' || !sessionId) {
        return ACTIVITY_SURFACE_TARGETS.openInbox;
    }

    return `${ACTIVITY_SURFACE_TARGETS.openSessionPrefix}${sessionId}`;
}

export function buildActivitySurfaceSessionCard(params: Readonly<{
    candidate: SessionActivityAttention;
    policy: ActivitySurfacePolicy;
    showMachinePath: boolean;
    showPreviewText: boolean;
    isPrimary: boolean;
    nowMs?: number;
}>): ActivitySurfaceSessionCard {
    const status = getSessionStatus(
        buildSessionListRenderableFromSession(params.candidate.session),
        params.nowMs,
    );

    return {
        sessionId: params.candidate.sessionId,
        title: resolveCardTitle({
            session: params.candidate.session,
            statusText: status.statusText,
            privacyMode: params.policy.privacyMode,
        }),
        subtitle: resolveCardSubtitle({
            session: params.candidate.session,
            privacyMode: params.policy.privacyMode,
            showMachinePath: params.showMachinePath,
        }),
        statusText: resolveCardStatusText({
            statusText: status.statusText,
            privacyMode: params.policy.privacyMode,
            showPreviewText: params.showPreviewText,
        }),
        attentionState: params.candidate.attentionState,
        route: createActivitySurfaceSessionRoute(params.candidate.sessionId),
        target: `${ACTIVITY_SURFACE_TARGETS.openSessionPrefix}${params.candidate.sessionId}`,
        isPrimary: params.isPrimary,
    };
}
