import { t } from '@/text';

import type {
    DesktopActivityOverlayActionDescriptor,
    DesktopActivityOverlayExpandedCard,
} from '../shared/desktopActivityOverlayUiModel';

type PermissionRequestCard = Extract<DesktopActivityOverlayExpandedCard, { kind: 'permission_request' }>;
type UserQuestionCard = Extract<DesktopActivityOverlayExpandedCard, { kind: 'user_question' }>;
type RequestCard = PermissionRequestCard | UserQuestionCard;
type CompletionStateCard = Extract<DesktopActivityOverlayExpandedCard, { kind: 'completion_state' }>;

function isOpenManagementAction(card: RequestCard, action: DesktopActivityOverlayActionDescriptor): boolean {
    return action.id === 'open'
        || action.id.startsWith('open:')
        || action.actionIdentifier === card.openActionIdentifier;
}

function withServerScope(
    data: Readonly<Record<string, unknown>>,
    serverId: string | null,
): Readonly<Record<string, unknown>> {
    return serverId ? { ...data, serverId } : data;
}

export function resolveDesktopActivityOverlayRequestCardActions(
    card: RequestCard,
): readonly DesktopActivityOverlayActionDescriptor[] {
    const directActions = (card.actions ?? []).filter((action) => !isOpenManagementAction(card, action));
    if (card.kind === 'permission_request' && card.risk === 'high') {
        return (card.actions ?? []).filter((action) => (
            action.tone === 'danger' || isOpenManagementAction(card, action)
        )).map((action) => (
            isOpenManagementAction(card, action)
                ? {
                    ...action,
                    id: 'open',
                    label: t('common.open'),
                    tone: 'primary' as const,
                }
                : action
        ));
    }
    if (card.kind === 'permission_request' && card.risk === 'low' && directActions.length > 0) {
        return directActions.map((action) => (
            action.id.startsWith('allow:') ? { ...action, id: 'allow' }
                : action.id.startsWith('deny:') ? { ...action, id: 'deny' }
                    : action
        ));
    }
    if (card.kind === 'user_question' && directActions.length > 0) {
        return directActions;
    }

    return [
        ...(card.denyActionIdentifier ? [{
            id: 'deny',
            label: t('notifications.actions.deny'),
            actionIdentifier: card.denyActionIdentifier,
            data: withServerScope({
                requestId: card.requestId,
                sessionId: card.sessionId,
                decision: 'deny',
            }, card.serverId),
            tone: 'danger' as const,
        }] : []),
        ...(card.allowActionIdentifier ? [{
            id: 'allow',
            label: t('notifications.actions.allow'),
            actionIdentifier: card.allowActionIdentifier,
            data: withServerScope({
                requestId: card.requestId,
                sessionId: card.sessionId,
                decision: 'allow',
            }, card.serverId),
            tone: 'primary' as const,
        }] : []),
    ];
}

export function resolveDesktopActivityOverlayCompletionStateActions(
    card: CompletionStateCard,
): readonly DesktopActivityOverlayActionDescriptor[] {
    return [{
        id: 'open',
        label: t('common.open'),
        actionIdentifier: card.openActionIdentifier,
        data: withServerScope({ sessionId: card.sessionId }, card.serverId),
        tone: 'primary',
    }];
}
