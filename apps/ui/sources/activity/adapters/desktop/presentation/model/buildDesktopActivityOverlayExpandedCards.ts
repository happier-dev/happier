import { t } from '@/text';
import { activityInstanceKey, normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';

import type { DesktopActivityOverlayExpandedCard, DesktopActivityOverlaySessionRowModel } from './desktopActivityOverlayModelTypes';
import type { DesktopActivityOverlaySnapshot } from '../snapshot/desktopActivityOverlaySnapshotTypes';

function withServerScope(
    data: Readonly<Record<string, unknown>>,
    serverId: string | null,
): Readonly<Record<string, unknown>> {
    return serverId ? { ...data, serverId } : data;
}

/** A body only when it adds a fact: a summary that repeats the title is dropped. */
function distinctBody(title: string, ...candidates: readonly (string | null | undefined)[]): string | null {
    const normalizedTitle = title.trim();
    for (const candidate of candidates) {
        const body = candidate?.trim() ?? '';
        if (body.length > 0 && body !== normalizedTitle) return body;
    }
    return null;
}

/** The overlay's Session rows: at most eight, each carrying its state tone and Agent identity. */
export function buildDesktopActivityOverlaySessionRows(
    sessions: DesktopActivityOverlaySnapshot['sessions'],
): readonly DesktopActivityOverlaySessionRowModel[] {
    return sessions.slice(0, 8).map((session) => ({
        sessionId: session.sessionId,
        serverId: session.serverId,
        title: session.title,
        subtitle: session.subtitle ?? null,
        statusText: session.statusText ?? null,
        previewText: session.previewText ?? null,
        tone: session.tone ?? 'neutral',
        agentId: session.agentId ?? null,
        machineId: session.machineId ?? null,
        botFace: session.botFace ?? null,
    }));
}

/** The kind of thing a request acts on, as the card's title; the subject itself is the card's mono line. */
function formatSubjectTitle(subject: NonNullable<DesktopActivityOverlaySnapshot['permissionRequests'][number]['subject']>): string {
    switch (subject.kind) {
        case 'edit': return t('settingsDesktop.overlay.notchEditFile');
        case 'write': return t('settingsDesktop.overlay.notchWriteFile');
        case 'read': return t('settingsDesktop.overlay.notchReadFile');
        case 'command': return t('settingsDesktop.overlay.notchRunCommand');
    }
}

function buildSessionScopedCardId(
    prefix: string,
    sessionId: string,
    serverId: string | null,
): string {
    const address = normalizeSessionAddress(serverId, sessionId);
    return activityInstanceKey(
        address ?? { serverId: null, sessionId },
        prefix,
    );
}

function buildPermissionActions(
    request: DesktopActivityOverlaySnapshot['permissionRequests'][number],
) {
    const actions = (request.permissionChoices ?? []).map((choice) => {
        const { approved: _approved, ...response } = choice.response;
        return {
            id: choice.id,
            label: choice.label,
            actionIdentifier: choice.catalog ? 'overlay-mcp-always-allow' : 'session.permission.respond',
            data: withServerScope({ requestId: request.requestId,
                ...(request.turnId ? { turnId: request.turnId } : {}), sessionId: request.sessionId, ...response }, request.serverId),
            tone: choice.id === 'allow' ? 'primary' as const
                : choice.id === 'deny' || choice.id === 'stop' ? 'danger' as const : 'quiet' as const,
        };
    });
    return [...actions, {
        id: `open:${request.requestId}`, label: t('common.open'), actionIdentifier: request.openActionIdentifier,
        data: withServerScope({ requestId: request.requestId, sessionId: request.sessionId }, request.serverId),
        tone: 'secondary' as const,
    }];
}

function buildUserQuestionActions(
    request: DesktopActivityOverlaySnapshot['userQuestions'][number],
    directOptions: NonNullable<DesktopActivityOverlaySnapshot['userQuestions'][number]['directOptions']>,
) {
    const numberedOptions = directOptions.map((option, index) => ({
        id: `option-${index + 1}-${option.id}`,
        // The asker's own words: the chips already read in its order, so they carry no numbers.
        label: option.label,
        actionIdentifier: option.actionIdentifier,
        data: withServerScope({
            requestId: request.requestId,
            sessionId: request.sessionId,
            answers: option.answers,
        }, request.serverId),
        // Choices are equal: none of them is the view's one primary action.
        tone: 'secondary' as const,
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
    const sessionsByAddress = new Map(snapshot.sessions.map(session => [
        buildSessionScopedCardId('session', session.sessionId, session.serverId), session,
    ]));

    for (const request of snapshot.permissionRequests) {
        const subject = request.subject ?? null;
        const title = subject ? formatSubjectTitle(subject) : request.title;
        cards.push({
            id: request.activityInstanceId,
            kind: 'permission_request',
            session: sessionsByAddress.get(buildSessionScopedCardId('session', request.sessionId, request.serverId)),
            requestId: request.requestId,
            ...(request.turnId ? { turnId: request.turnId } : {}),
            sessionId: request.sessionId,
            serverId: request.serverId,
            title,
            // The subject line already carries the path or command, so a summary that only repeats it is dropped.
            body: distinctBody(title, ...[request.summary, request.questionText]
                .filter((candidate) => !subject || !candidate?.includes(subject.text))),
            subject,
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
            id: request.activityInstanceId,
            kind: 'user_question',
            session: sessionsByAddress.get(buildSessionScopedCardId('session', request.sessionId, request.serverId)),
            requestId: request.requestId,
            sessionId: request.sessionId,
            serverId: request.serverId,
            title: request.title,
            body: distinctBody(request.title, request.questionText, request.summary),
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
            id: buildSessionScopedCardId(
                'completion',
                completionState.sessionId,
                completionState.serverId,
            ),
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
        const session = snapshot.sessions[0];
        cards.push({
            id: buildSessionScopedCardId('session', session.sessionId, session.serverId),
            kind: 'session_overview',
            ...session,
            statusText: session.statusText ?? null,
        });
    }

    if (snapshot.sessions.length > 1) {
        cards.push({
            id: 'multi-session-list',
            kind: 'multi_session_list',
            title: snapshot.labels.sessionsTitle,
            rows: buildDesktopActivityOverlaySessionRows(snapshot.sessions),
        });
    }

    return cards;
}
