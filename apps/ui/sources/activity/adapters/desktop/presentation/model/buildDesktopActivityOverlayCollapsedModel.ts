import type { DesktopActivityOverlaySnapshot } from '../snapshot/desktopActivityOverlaySnapshotTypes';
import type { DesktopActivityOverlayExpandedCard, DesktopActivityOverlayModel } from './desktopActivityOverlayModelTypes';

export function buildDesktopActivityOverlayCollapsedModel(params: Readonly<{
    snapshot: DesktopActivityOverlaySnapshot;
    cards: readonly DesktopActivityOverlayExpandedCard[];
    showSessionCount: boolean;
}>): DesktopActivityOverlayModel['collapsed'] {
    const primaryCard = params.cards[0];
    const defaultTarget = params.snapshot.defaultTarget;
    const sessionCount = params.showSessionCount ? params.snapshot.sessions.length : null;

    if (!primaryCard || primaryCard.kind === 'idle_state') {
        return {
            title: params.snapshot.labels.emptyTitle,
            statusText: null,
            defaultTarget,
            sessionCount,
            primaryCardKind: 'idle_state',
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
        };
    }

    if (primaryCard.kind === 'session_overview') {
        return {
            title: primaryCard.title,
            statusText: primaryCard.statusText ?? null,
            defaultTarget,
            sessionCount,
            primaryCardKind: primaryCard.kind,
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
        };
    }

    return {
        title: primaryCard.title,
        statusText: primaryCard.statusText ?? primaryCard.body ?? null,
        defaultTarget,
        sessionCount,
        primaryCardKind: primaryCard.kind,
    };
}
