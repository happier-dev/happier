import type { DesktopActivityOverlaySnapshot } from '../snapshot/desktopActivityOverlaySnapshotTypes';
import {
    DESKTOP_ACTIVITY_OVERLAY_COLLAPSED_CAROUSEL_CADENCE_MS,
    DESKTOP_ACTIVITY_OVERLAY_CRITICAL_UNATTENDED_MS,
    DESKTOP_ACTIVITY_OVERLAY_NEEDS_YOU_UNATTENDED_MS,
    DESKTOP_ACTIVITY_OVERLAY_PHASE_FLASH_DURATION_MS,
    DESKTOP_ACTIVITY_OVERLAY_READY_BOUNCE_DURATION_MS,
    DESKTOP_ACTIVITY_OVERLAY_URGENCY_POLL_MS,
} from '../../desktopActivityOverlayTiming';
import type {
    DesktopActivityOverlayCollapsedSlide,
    DesktopActivityOverlayCollapsedSlidePriority,
    DesktopActivityOverlayCollapsedTransitionCue,
    DesktopActivityOverlayCollapsedUrgency,
    DesktopActivityOverlayExpandedCard,
    DesktopActivityOverlayModel,
} from './desktopActivityOverlayModelTypes';

function normalizeText(value: string | null | undefined): string | null {
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
}

function truncateSlideText(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function formatSessionCount(count: number): string {
    return count === 1 ? '1 session' : `${count} sessions`;
}

function formatDurationFromMs(durationMs: number): string | null {
    if (!Number.isFinite(durationMs) || durationMs < 60_000) {
        return null;
    }
    const minutes = Math.max(1, Math.round(durationMs / 60_000));
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.round(minutes / 60);
    return `${hours}h`;
}

function formatProjectDuration(projectTitle: string, snapshot: DesktopActivityOverlaySnapshot): string {
    const updatedAt = resolveUpdatedAtEpochMs(snapshot);
    const duration = updatedAt ? formatDurationFromMs(snapshot.generatedAt - updatedAt) : null;
    return duration ? `${projectTitle} · ${duration}` : projectTitle;
}

function resolveLastToolTitle(value: string): string {
    const trimmed = value.trim();
    const editMatch = trimmed.match(/^Edit(?:ing)?\s+(.+)$/i);
    if (!editMatch) {
        return trimmed;
    }
    const rawPath = editMatch[1]?.trim() ?? '';
    const filename = rawPath.split(/[\\/]/).filter(Boolean).at(-1) ?? rawPath;
    return `Edit: ${filename}`;
}

function priorityFromSnapshot(snapshot: DesktopActivityOverlaySnapshot): DesktopActivityOverlayCollapsedSlidePriority {
    if (snapshot.counts.permissionRequired > 0 || snapshot.counts.actionRequired > 0) return 'attention';
    if (snapshot.completionStates.length > 0) return 'ready';
    if (snapshot.counts.thinking > 0) return 'running';
    return snapshot.sessions.length > 0 ? 'running' : 'idle';
}

function resolveStatusTitle(params: Readonly<{
    snapshot: DesktopActivityOverlaySnapshot;
    primaryCard: DesktopActivityOverlayExpandedCard | undefined;
}>): string {
    return normalizeText(params.primaryCard?.statusText)
        ?? normalizeText(params.primaryCard?.body)
        ?? normalizeText(params.snapshot.primary?.statusText)
        ?? normalizeText(params.primaryCard?.title)
        ?? normalizeText(params.snapshot.primary?.title)
        ?? params.snapshot.labels.emptyTitle;
}

function buildCollapsedSlides(params: Readonly<{
    snapshot: DesktopActivityOverlaySnapshot;
    primaryCard: DesktopActivityOverlayExpandedCard | undefined;
    showPreviewText: boolean;
}>): readonly DesktopActivityOverlayCollapsedSlide[] {
    const priority = priorityFromSnapshot(params.snapshot);
    const primary = params.snapshot.primary;
    const statusTitle = resolveStatusTitle(params);
    const taskTitle = normalizeText(primary?.title) ?? normalizeText(params.primaryCard?.title) ?? params.snapshot.labels.emptyTitle;
    const preview = params.showPreviewText ? normalizeText(primary?.previewText) : null;
    const subtitle = normalizeText(primary?.subtitle);
    const sessionCount = formatSessionCount(params.snapshot.sessions.length);
    const lastToolTitle = normalizeText(primary?.statusText)
        ?? normalizeText(params.primaryCard?.statusText)
        ?? normalizeText(params.primaryCard?.eyebrow)
        ?? statusTitle;
    const projectTitle = subtitle ?? sessionCount;

    return [
        {
            id: 'status',
            title: statusTitle,
            subtitle: taskTitle === statusTitle ? subtitle : taskTitle,
            animatedEllipsis: priority === 'running',
            priority,
        },
        {
            id: 'task_title',
            title: truncateSlideText(taskTitle, 24),
            subtitle: preview ?? subtitle,
            animatedEllipsis: false,
            priority,
        },
        {
            id: 'last_tool',
            title: truncateSlideText(resolveLastToolTitle(lastToolTitle), 18),
            subtitle,
            animatedEllipsis: priority === 'running',
            priority,
        },
        {
            id: 'project_duration',
            title: formatProjectDuration(projectTitle, params.snapshot),
            subtitle: sessionCount,
            animatedEllipsis: false,
            priority,
        },
    ];
}

function resolveUpdatedAtEpochMs(snapshot: DesktopActivityOverlaySnapshot): number | null {
    const updatedAt = snapshot.primary?.updatedAt;
    return typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > 1_000_000_000_000
        ? updatedAt
        : null;
}

function buildCollapsedUrgency(snapshot: DesktopActivityOverlaySnapshot): DesktopActivityOverlayCollapsedUrgency {
    const priority = priorityFromSnapshot(snapshot);
    const updatedAt = resolveUpdatedAtEpochMs(snapshot);
    const unattendedMs = updatedAt ? Math.max(0, snapshot.generatedAt - updatedAt) : 0;
    if (priority === 'attention') {
        return {
            level: unattendedMs >= DESKTOP_ACTIVITY_OVERLAY_CRITICAL_UNATTENDED_MS
                ? 'critical'
                : unattendedMs >= DESKTOP_ACTIVITY_OVERLAY_NEEDS_YOU_UNATTENDED_MS
                    ? 'needs_you'
                    : 'needs_you',
            unattendedMs,
            pollMs: DESKTOP_ACTIVITY_OVERLAY_URGENCY_POLL_MS,
        };
    }
    if (priority === 'ready') {
        return {
            level: unattendedMs >= DESKTOP_ACTIVITY_OVERLAY_CRITICAL_UNATTENDED_MS ? 'critical' : 'needs_you',
            unattendedMs,
            pollMs: DESKTOP_ACTIVITY_OVERLAY_URGENCY_POLL_MS,
        };
    }
    return {
        level: priority === 'running' ? 'running' : 'idle',
        unattendedMs,
        pollMs: DESKTOP_ACTIVITY_OVERLAY_URGENCY_POLL_MS,
    };
}

function buildTransitionCueKey(
    snapshot: DesktopActivityOverlaySnapshot,
    phase: DesktopActivityOverlayCollapsedSlidePriority,
): string {
    const sessionId = normalizeText(snapshot.primary?.sessionId)
        ?? normalizeText(snapshot.sessions[0]?.sessionId)
        ?? 'none';
    const updatedAt = typeof snapshot.primary?.updatedAt === 'number' && Number.isFinite(snapshot.primary.updatedAt)
        ? snapshot.primary.updatedAt
        : snapshot.generatedAt;
    return [
        phase,
        sessionId,
        updatedAt,
        snapshot.counts.permissionRequired,
        snapshot.counts.actionRequired,
        snapshot.completionStates.length,
        snapshot.counts.thinking,
    ].join(':');
}

function buildCollapsedTransitionCue(snapshot: DesktopActivityOverlaySnapshot): DesktopActivityOverlayCollapsedTransitionCue | null {
    const phase = priorityFromSnapshot(snapshot);
    if (phase === 'ready') {
        return {
            kind: 'bounce_on_ready',
            phase,
            key: buildTransitionCueKey(snapshot, phase),
            durationMs: DESKTOP_ACTIVITY_OVERLAY_READY_BOUNCE_DURATION_MS,
        };
    }
    if (phase === 'attention' || phase === 'running') {
        return {
            kind: 'phase_flash',
            phase,
            key: buildTransitionCueKey(snapshot, phase),
            durationMs: DESKTOP_ACTIVITY_OVERLAY_PHASE_FLASH_DURATION_MS,
        };
    }
    return null;
}

export function buildDesktopActivityOverlayCollapsedModel(params: Readonly<{
    snapshot: DesktopActivityOverlaySnapshot;
    cards: readonly DesktopActivityOverlayExpandedCard[];
    showSessionCount: boolean;
    showPreviewText: boolean;
    carouselEnabled: boolean;
}>): DesktopActivityOverlayModel['collapsed'] {
    const primaryCard = params.cards[0];
    const defaultTarget = params.snapshot.defaultTarget;
    const sessionCount = params.showSessionCount ? params.snapshot.sessions.length : null;
    const shared = {
        slides: buildCollapsedSlides({
            snapshot: params.snapshot,
            primaryCard,
            showPreviewText: params.showPreviewText,
        }),
        carousel: {
            enabled: params.carouselEnabled,
            cadenceMs: DESKTOP_ACTIVITY_OVERLAY_COLLAPSED_CAROUSEL_CADENCE_MS,
            freezeReason: params.carouselEnabled ? null : 'disabled',
        },
        urgency: buildCollapsedUrgency(params.snapshot),
        transitionCue: buildCollapsedTransitionCue(params.snapshot),
    } satisfies Pick<DesktopActivityOverlayModel['collapsed'], 'slides' | 'carousel' | 'urgency' | 'transitionCue'>;

    if (!primaryCard || primaryCard.kind === 'idle_state') {
        return {
            title: params.snapshot.labels.emptyTitle,
            statusText: null,
            defaultTarget,
            sessionCount,
            primaryCardKind: 'idle_state',
            ...shared,
        };
    }

    if (primaryCard.kind === 'permission_request' || primaryCard.kind === 'user_question') {
        return {
            title: primaryCard.title,
            statusText: primaryCard.statusText ?? primaryCard.body ?? null,
            defaultTarget,
            sessionCount,
            primaryCardKind: primaryCard.kind,
            accentText: primaryCard.badgeText ?? null,
            ...shared,
        };
    }

    if (primaryCard.kind === 'session_overview') {
        return {
            title: primaryCard.title,
            statusText: primaryCard.statusText ?? null,
            defaultTarget,
            sessionCount,
            primaryCardKind: primaryCard.kind,
            ...shared,
        };
    }

    if (primaryCard.kind === 'multi_session_list') {
        const primarySession = params.snapshot.primary ?? params.snapshot.sessions[0] ?? null;

        return {
            title: primarySession?.title ?? params.snapshot.labels.sessionsTitle,
            statusText: primarySession?.statusText ?? null,
            defaultTarget,
            sessionCount,
            primaryCardKind: primaryCard.kind,
            ...shared,
        };
    }

    return {
        title: primaryCard.title,
        statusText: primaryCard.statusText ?? primaryCard.body ?? null,
        defaultTarget,
        sessionCount,
        primaryCardKind: primaryCard.kind,
        ...shared,
    };
}
