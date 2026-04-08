import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getSessionName, getSessionStatus, getSessionSubtitle } from '@/utils/sessions/sessionUtils';

import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import { normalizeActivityPreviewText } from '@/activity/attention/buildActivityPreviewText';
import type { ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import {
    ACTIVITY_SURFACE_TARGETS,
    createActivitySurfaceSessionRoute,
    createActivitySurfaceSessionTarget,
} from '@/activity/actions/activitySurfaceTargets';
import type { ActivitySurfaceSessionViewModel } from '@/activity/presentation/activitySurfaceViewModels';

function resolveViewModelTitle(params: Readonly<{
    candidate: SessionActivityAttention;
    statusText: string;
    privacyMode: ActivitySurfacePolicy['privacyMode'];
}>): string {
    if (params.privacyMode === 'status_only') {
        return params.statusText;
    }

    return getSessionName(params.candidate.session);
}

function resolveViewModelSubtitle(params: Readonly<{
    candidate: SessionActivityAttention;
    privacyMode: ActivitySurfacePolicy['privacyMode'];
    showMachinePath: boolean;
}>): string | null {
    if (!params.showMachinePath) return null;
    if (params.privacyMode !== 'include_preview') return null;

    const subtitle = getSessionSubtitle(params.candidate.session).trim();
    return subtitle.length > 0 ? subtitle : null;
}

function resolveViewModelStatusText(params: Readonly<{
    statusText: string;
    privacyMode: ActivitySurfacePolicy['privacyMode'];
}>): string | null {
    if (params.privacyMode === 'status_only') {
        return null;
    }
    const trimmed = params.statusText.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function resolveViewModelPreviewText(params: Readonly<{
    candidate: SessionActivityAttention;
    privacyMode: ActivitySurfacePolicy['privacyMode'];
    showPreviewText: boolean;
}>): string | null {
    if (params.privacyMode !== 'include_preview') {
        return null;
    }
    if (!params.showPreviewText) {
        return null;
    }

    const previewText = params.candidate.session.metadata?.summary?.text;
    if (typeof previewText !== 'string') {
        return null;
    }

    const normalizedPreviewText = normalizeActivityPreviewText(previewText);
    return normalizedPreviewText.length > 0 ? normalizedPreviewText : null;
}

export function resolvePrimaryActivitySurfaceTarget(
    policy: ActivitySurfacePolicy,
    sessionId: string | null,
): string {
    if (policy.tapTarget === 'open_sessions' || !sessionId) {
        return ACTIVITY_SURFACE_TARGETS.openInbox;
    }

    return createActivitySurfaceSessionTarget(sessionId);
}

export function buildActivitySurfaceViewModel(params: Readonly<{
    candidate: SessionActivityAttention;
    policy: ActivitySurfacePolicy;
    showMachinePath: boolean;
    showPreviewText: boolean;
    isPrimary: boolean;
    nowMs?: number;
}>): ActivitySurfaceSessionViewModel {
    const status = getSessionStatus(
        buildSessionListRenderableFromSession(params.candidate.session),
        params.nowMs,
    );

    return {
        sessionId: params.candidate.sessionId,
        title: resolveViewModelTitle({
            candidate: params.candidate,
            statusText: status.statusText,
            privacyMode: params.policy.privacyMode,
        }),
        subtitle: resolveViewModelSubtitle({
            candidate: params.candidate,
            privacyMode: params.policy.privacyMode,
            showMachinePath: params.showMachinePath,
        }),
        previewText: resolveViewModelPreviewText({
            candidate: params.candidate,
            privacyMode: params.policy.privacyMode,
            showPreviewText: params.showPreviewText,
        }),
        statusText: resolveViewModelStatusText({
            statusText: status.statusText,
            privacyMode: params.policy.privacyMode,
        }),
        attentionState: params.candidate.attentionState,
        route: createActivitySurfaceSessionRoute(params.candidate.sessionId),
        target: createActivitySurfaceSessionTarget(params.candidate.sessionId),
        defaultTarget: createActivitySurfaceSessionTarget(params.candidate.sessionId),
        updatedAt: params.candidate.session.updatedAt,
        isPrimary: params.isPrimary,
    };
}

export function buildActivitySurfaceViewModels(params: Readonly<{
    candidates: readonly SessionActivityAttention[];
    policy: ActivitySurfacePolicy;
    showMachinePath: boolean;
    showPreviewText: boolean;
    nowMs?: number;
}>): readonly ActivitySurfaceSessionViewModel[] {
    return params.candidates.map((candidate, index) =>
        buildActivitySurfaceViewModel({
            candidate,
            policy: params.policy,
            showMachinePath: params.showMachinePath,
            showPreviewText: params.showPreviewText,
            isPrimary: index === 0,
            nowMs: params.nowMs,
        }),
    );
}
