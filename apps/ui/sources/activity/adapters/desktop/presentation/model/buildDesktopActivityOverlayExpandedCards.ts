import type { DesktopActivityOverlayExpandedCard } from './desktopActivityOverlayModelTypes';
import type { DesktopActivityOverlaySnapshot } from '../snapshot/desktopActivityOverlaySnapshotTypes';

export function buildDesktopActivityOverlayExpandedCards(
    snapshot: DesktopActivityOverlaySnapshot,
): readonly DesktopActivityOverlayExpandedCard[] {
    if (snapshot.state === 'idle') {
        return [
            {
                id: 'idle',
                kind: 'idle_state',
                title: snapshot.labels.emptyTitle,
            },
        ];
    }

    const cards: DesktopActivityOverlayExpandedCard[] = [];

    for (const request of snapshot.permissionRequests) {
        cards.push({
            id: `permission:${request.requestId}`,
            kind: 'permission_request',
            requestId: request.requestId,
            sessionId: request.sessionId,
            title: request.title,
            body: request.summary ?? null,
            summary: request.summary ?? null,
            statusText: request.summary ?? null,
            badgeText: request.toolLabel,
            toolLabel: request.toolLabel,
            questionText: request.questionText,
            count: request.count,
            openActionIdentifier: request.openActionIdentifier,
            allowActionIdentifier: request.allowActionIdentifier,
            denyActionIdentifier: request.denyActionIdentifier,
            actions: [
                ...(request.allowActionIdentifier
                    ? [{
                        id: `allow:${request.requestId}`,
                        label: 'Allow',
                        actionIdentifier: request.allowActionIdentifier,
                        data: {
                            requestId: request.requestId,
                            sessionId: request.sessionId,
                            decision: 'allow',
                        },
                        tone: 'primary' as const,
                    }]
                    : []),
                ...(request.denyActionIdentifier
                    ? [{
                        id: `deny:${request.requestId}`,
                        label: 'Deny',
                        actionIdentifier: request.denyActionIdentifier,
                        data: {
                            requestId: request.requestId,
                            sessionId: request.sessionId,
                            decision: 'deny',
                        },
                        tone: 'danger' as const,
                    }]
                    : []),
                {
                    id: `open:${request.requestId}`,
                    label: 'Open',
                    actionIdentifier: request.openActionIdentifier,
                    data: {
                        requestId: request.requestId,
                        sessionId: request.sessionId,
                    },
                    tone: 'secondary',
                },
            ],
        });
    }

    for (const request of snapshot.userQuestions) {
        const directOptions = Array.isArray(request.directOptions) ? request.directOptions : [];

        cards.push({
            id: `question:${request.requestId}`,
            kind: 'user_question',
            requestId: request.requestId,
            sessionId: request.sessionId,
            title: request.title,
            body: request.questionText ?? request.summary ?? null,
            summary: request.summary ?? null,
            badgeText: request.toolLabel,
            toolLabel: request.toolLabel,
            questionText: request.questionText,
            count: request.count,
            openActionIdentifier: request.openActionIdentifier,
            allowActionIdentifier: request.allowActionIdentifier,
            denyActionIdentifier: request.denyActionIdentifier,
            actions: [
                ...directOptions.map((option) => ({
                    id: option.id,
                    label: option.label,
                    actionIdentifier: option.actionIdentifier,
                    data: {
                        requestId: request.requestId,
                        sessionId: request.sessionId,
                        answers: option.answers,
                    },
                    tone: 'primary' as const,
                    accessibilityLabel: option.description ?? null,
                })),
                {
                    id: `open:${request.requestId}`,
                    label: 'Open',
                    actionIdentifier: request.openActionIdentifier,
                    data: {
                        requestId: request.requestId,
                        sessionId: request.sessionId,
                    },
                    tone: 'primary',
                },
            ],
        });
    }

    for (const summary of snapshot.quotaSummaries) {
        cards.push({
            id: `quota:${summary.id}`,
            kind: 'quota_summary',
            title: summary.title,
            body: summary.summary,
            summary: summary.summary,
        });
    }

    for (const completionState of snapshot.completionStates) {
        cards.push({
            id: `completion:${completionState.sessionId}`,
            kind: 'completion_state',
            sessionId: completionState.sessionId,
            title: completionState.title,
            body: completionState.summary,
            summary: completionState.summary,
            openActionIdentifier: completionState.openActionIdentifier,
            actions: [
                {
                    id: `open:${completionState.sessionId}`,
                    label: 'Open',
                    actionIdentifier: completionState.openActionIdentifier,
                    data: {
                        sessionId: completionState.sessionId,
                    },
                    tone: 'primary',
                },
            ],
        });
    }

    if (cards.length > 0) {
        return cards;
    }

    if (snapshot.sessions.length === 1) {
        cards.push({
            id: `session:${snapshot.sessions[0].sessionId}`,
            kind: 'session_overview',
            ...snapshot.sessions[0],
            statusText: snapshot.sessions[0].statusText ?? null,
        });
    }

    if (snapshot.sessions.length > 1) {
        cards.push({
            id: 'multi-session-list',
            kind: 'multi_session_list',
            title: snapshot.labels.sessionsTitle,
            rows: snapshot.sessions.slice(0, 8).map((session) => ({
                sessionId: session.sessionId,
                title: session.title,
                subtitle: session.subtitle ?? null,
                statusText: session.statusText ?? null,
                previewText: session.previewText ?? null,
            })),
        });
    }

    return cards;
}
