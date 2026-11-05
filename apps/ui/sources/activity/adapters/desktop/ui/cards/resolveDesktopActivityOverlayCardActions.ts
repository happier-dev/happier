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
    return (card.actions ?? []).filter((action) => !isOpenManagementAction(card, action));
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
