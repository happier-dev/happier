import { t } from '@/text';

import type { DesktopActivityOverlayExpandedCard } from './desktopActivityOverlayModelTypes';
import type { DesktopActivityOverlaySnapshot } from '../snapshot/desktopActivityOverlaySnapshotTypes';

function withServerScope(
    data: Readonly<Record<string, unknown>>,
    serverId: string | null,
): Readonly<Record<string, unknown>> {
    return serverId ? { ...data, serverId } : data;
}

function formatAlwaysAllowLabel(toolLabel: string): string {
    return t('notifications.actions.alwaysAllowTool', { tool: toolLabel });
}

function buildPermissionActions(
    request: DesktopActivityOverlaySnapshot['permissionRequests'][number],
) {
    const denyAction = request.denyActionIdentifier
        ? [{
            id: `deny:${request.requestId}`,
            label: t('notifications.actions.deny'),
            actionIdentifier: request.denyActionIdentifier,
            data: withServerScope({
                requestId: request.requestId,
                sessionId: request.sessionId,
                decision: 'deny',
            }, request.serverId),
            tone: 'danger' as const,
        }]
        : [];
    const openAction = {
        id: `open:${request.requestId}`,
        label: t('common.open'),
        actionIdentifier: request.openActionIdentifier,
        data: withServerScope({
            requestId: request.requestId,
            sessionId: request.sessionId,
        }, request.serverId),
        tone: 'secondary' as const,
    };

    if (request.risk === 'high') {
        return [
            ...denyAction,
            openAction,
        ];
    }

    const allowAction = request.allowActionIdentifier
        ? [{
            id: `allow:${request.requestId}`,
            label: t('notifications.actions.allow'),
            actionIdentifier: request.allowActionIdentifier,
            data: withServerScope({
                requestId: request.requestId,
                sessionId: request.sessionId,
                decision: 'allow',
            }, request.serverId),
            tone: 'primary' as const,
        }, {
            id: 'always_allow',
            label: formatAlwaysAllowLabel(request.toolLabel),
            actionIdentifier: request.allowActionIdentifier,
            data: withServerScope({
                requestId: request.requestId,
                sessionId: request.sessionId,
                decision: 'allow',
                persistence: 'always',
            }, request.serverId),
            tone: 'secondary' as const,
        }]
        : [];

    return [
        ...denyAction,
        ...allowAction,
        openAction,
    ];
}

function buildUserQuestionActions(
    request: DesktopActivityOverlaySnapshot['userQuestions'][number],
    directOptions: NonNullable<DesktopActivityOverlaySnapshot['userQuestions'][number]['directOptions']>,
) {
    const numberedOptions = directOptions.map((option, index) => ({
        id: `option-${index + 1}-${option.id}`,
        label: `${index + 1}. ${option.label}`,
        actionIdentifier: option.actionIdentifier,
        data: withServerScope({
            requestId: request.requestId,
            sessionId: request.sessionId,
            answers: option.answers,
        }, request.serverId),
        tone: 'primary' as const,
        accessibilityLabel: option.description ?? null,
    }));
    const inlineOther = request.count === 1 && numberedOptions.length > 0
        ? [{
            id: 'other',
            label: t('notifications.actions.other'),
            actionIdentifier: 'session.user_action.answer',
            data: withServerScope({
                requestId: request.requestId,
                sessionId: request.sessionId,
            }, request.serverId),
            tone: 'secondary' as const,
            inputKind: 'inline_text' as const,
        }]
        : [];

    return [
        ...numberedOptions,
        ...inlineOther,
        {
            id: `open:${request.requestId}`,
            label: t('common.open'),
            actionIdentifier: request.openActionIdentifier,
            data: withServerScope({
                requestId: request.requestId,
                sessionId: request.sessionId,
            }, request.serverId),
            tone: 'primary' as const,
        },
    ];
}

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
            serverId: request.serverId,
            title: request.title,
            body: request.summary ?? null,
            summary: request.summary ?? null,
            statusText: request.summary ?? null,
            badgeText: request.toolLabel,
            toolLabel: request.toolLabel,
            questionText: request.questionText,
            count: request.count,
            risk: request.risk ?? 'low',
            openActionIdentifier: request.openActionIdentifier,
            allowActionIdentifier: request.allowActionIdentifier,
            denyActionIdentifier: request.denyActionIdentifier,
            actions: buildPermissionActions(request),
        });
    }

    for (const request of snapshot.userQuestions) {
        const directOptions = Array.isArray(request.directOptions) ? request.directOptions : [];

        cards.push({
            id: `question:${request.requestId}`,
            kind: 'user_question',
            requestId: request.requestId,
            sessionId: request.sessionId,
            serverId: request.serverId,
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
            actions: buildUserQuestionActions(request, directOptions),
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
            serverId: completionState.serverId,
            title: completionState.title,
            body: completionState.summary,
            summary: completionState.summary,
            openActionIdentifier: completionState.openActionIdentifier,
            variant: completionState.variant,
            autoDismissMs: completionState.autoDismissMs,
            sticky: completionState.sticky,
            actions: [
                {
                    id: `open:${completionState.sessionId}`,
                    label: t('common.open'),
                    actionIdentifier: completionState.openActionIdentifier,
                    data: withServerScope({
                        sessionId: completionState.sessionId,
                    }, completionState.serverId),
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
                serverId: session.serverId,
                title: session.title,
                subtitle: session.subtitle ?? null,
                statusText: session.statusText ?? null,
                previewText: session.previewText ?? null,
            })),
        });
    }

    return cards;
}
