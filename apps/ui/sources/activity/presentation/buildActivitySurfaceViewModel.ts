import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { readLockedSessionName } from '@/utils/sessions/sessionUtils';

import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import { normalizeActivityPreviewText } from '@/activity/attention/buildActivityPreviewText';
import type { ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import {
    ACTIVITY_SURFACE_TARGETS,
    createActivitySurfaceSessionRoute,
    createActivitySurfaceSessionTarget,
} from '@/activity/actions/activitySurfaceTargets';
import type { ActivitySurfaceSessionViewModel } from '@/activity/presentation/activitySurfaceViewModels';
import { resolveSessionContextLine } from '@/sync/domains/session/presentation/sessionContextPresentation';
import { readSessionDisplayTitleField } from '@/sync/state/selectors';
import { readSessionListPresentationDisplay } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';

function resolveViewModelTitle(params: Readonly<{
    candidate: SessionActivityAttention;
    mayShowPrivateContent: boolean;
    /** The device opened the content, so the candidate's title is the real in-app name. */
    candidateNamesContent: boolean;
    statusText: string;
    privacyMode: ActivitySurfacePolicy['privacyMode'];
}>): string {
    // An off-app surface also honours the Home's notification ceiling, so it never falls back to
    // the in-app name of content this device opened; an unread candidate's title is already safe.
    if (!params.mayShowPrivateContent) {
        return params.candidateNamesContent ? readLockedSessionName() : params.candidate.title;
    }
    if (params.privacyMode === 'status_only') {
        return params.statusText;
    }

    return params.candidate.title;
}

function resolveViewModelSubtitle(params: Readonly<{
    candidate: SessionActivityAttention;
    mayShowWorkspace: boolean;
}>): string | null {
    if (!params.mayShowWorkspace) return null;
    const subtitle = params.candidate.subtitle.trim();
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
    mayShowPrivateContent: boolean;
    privacyMode: ActivitySurfacePolicy['privacyMode'];
    showPreviewText: boolean;
}>): string | null {
    if (!params.mayShowPrivateContent) return null;
    if (params.privacyMode !== 'include_preview') {
        return null;
    }
    if (!params.showPreviewText) {
        return null;
    }

    const previewText = readSessionDisplayTitleField(params.candidate.presentationSource
        ? readSessionListPresentationDisplay(params.candidate.presentationSource) : params.candidate.session).value;
    if (!previewText) return null;

    const normalizedPreviewText = normalizeActivityPreviewText(previewText);
    return normalizedPreviewText.length > 0 ? normalizedPreviewText : null;
}

export function resolvePrimaryActivitySurfaceTarget(
    policy: ActivitySurfacePolicy,
    sessionId: string | null,
    serverId?: string | null,
): string {
    if (policy.tapTarget === 'open_sessions' || !sessionId) {
        return ACTIVITY_SURFACE_TARGETS.openInbox;
    }

    return createActivitySurfaceSessionTarget(sessionId, serverId);
}

/**
 * Privacy for one candidate. Surfaces that resolved the candidate's own Home
 * delivery plan supply it here; the policy value remains the fallback for
 * callers with no Home-qualified plan.
 */
export type ActivitySurfaceCandidatePrivacyModeResolver =
    (candidate: SessionActivityAttention) => ActivitySurfacePolicy['privacyMode'] | null | undefined;

export function buildActivitySurfaceViewModel(params: Readonly<{
    candidate: SessionActivityAttention;
    policy: ActivitySurfacePolicy;
    showMachinePath: boolean;
    showPreviewText: boolean;
    /** False drops the Home from the context line, for a surface whose rows all share one Home. */
    showHome?: boolean;
    isPrimary: boolean;
    nowMs?: number;
    resolveCandidatePrivacyMode?: ActivitySurfaceCandidatePrivacyModeResolver;
}>): ActivitySurfaceSessionViewModel {
    const privacyMode = params.resolveCandidatePrivacyMode?.(params.candidate) ?? params.policy.privacyMode;
    const isStatusOnly = params.candidate.session.viewer?.attention.presentation === 'status_only';
    const contentReadable = isSessionAwarenessContentReadableV1(params.candidate.awareness.encryption);
    const mayShowPrivateContent = !isStatusOnly && contentReadable;
    const mayShowWorkspace = params.showMachinePath && mayShowPrivateContent && privacyMode === 'include_preview';
    const statusText = params.candidate.workStatus.word;
    const contextLine = resolveSessionContextLine(params.candidate.context, {
        showWorkspace: mayShowWorkspace,
        showHome: params.showHome,
    });

    return {
        serverId: params.candidate.serverId ?? params.candidate.session.serverId ?? null,
        serverUrl: params.candidate.serverUrl ?? null,
        serverName: params.candidate.serverName ?? null,
        sessionId: params.candidate.sessionId,
        contextLine,
        title: resolveViewModelTitle({
            candidate: params.candidate,
            mayShowPrivateContent,
            candidateNamesContent: contentReadable,
            statusText,
            privacyMode,
        }),
        subtitle: resolveViewModelSubtitle({
            candidate: params.candidate,
            mayShowWorkspace,
        }),
        previewText: resolveViewModelPreviewText({
            candidate: params.candidate,
            mayShowPrivateContent,
            privacyMode,
            showPreviewText: params.showPreviewText,
        }),
        statusText: resolveViewModelStatusText({
            statusText,
            privacyMode,
        }),
        attentionState: params.candidate.attentionState,
        route: params.candidate.route ?? createActivitySurfaceSessionRoute(
            params.candidate.sessionId,
            params.candidate.address?.serverId ?? params.candidate.serverId,
        ),
        target: params.candidate.target ?? createActivitySurfaceSessionTarget(
            params.candidate.sessionId,
            params.candidate.address?.serverId ?? params.candidate.serverId,
        ),
        defaultTarget: params.candidate.target ?? createActivitySurfaceSessionTarget(
            params.candidate.sessionId,
            params.candidate.address?.serverId ?? params.candidate.serverId,
        ),
        activityName: params.candidate.activityName ?? null,
        activityInstanceKey: params.candidate.activityInstanceKey ?? null,
        canExecuteDirectActions: params.candidate.directActionCapability?.canExecute ?? false,
        updatedAt: params.candidate.presentationSource?.lifecycle.updatedAt ?? params.candidate.session.updatedAt,
        isPrimary: params.isPrimary,
    };
}

export function buildActivitySurfaceViewModels(params: Readonly<{
    candidates: readonly SessionActivityAttention[];
    policy: ActivitySurfacePolicy;
    showMachinePath: boolean;
    showPreviewText: boolean;
    showHome?: boolean;
    nowMs?: number;
    resolveCandidatePrivacyMode?: ActivitySurfaceCandidatePrivacyModeResolver;
}>): readonly ActivitySurfaceSessionViewModel[] {
    return params.candidates.map((candidate, index) =>
        buildActivitySurfaceViewModel({
            candidate,
            policy: params.policy,
            showMachinePath: params.showMachinePath,
            showPreviewText: params.showPreviewText,
            showHome: params.showHome,
            isPrimary: index === 0,
            nowMs: params.nowMs,
            resolveCandidatePrivacyMode: params.resolveCandidatePrivacyMode,
        }),
    );
}
