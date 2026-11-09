import type { BoardItemRefV1 } from '@happier-dev/protocol/boards/workBoardV1';

import type { InboxItemFocus } from '@/components/inbox/inboxItemFocus';

import type { BoardCard } from './boardCards';
import { isWorkStatusNeedsYou } from '@/components/work/status/resolveWorkStatusTone';

export type BoardCardOpenTarget =
    | Readonly<{ kind: 'inbox'; item: InboxItemFocus }>
    | Readonly<{ kind: 'item'; ref: BoardItemRefV1; intent?: 'run' }>;

export type BoardCardSecondaryAction = 'review' | 'run';
/** A card's secondary action, or the task card's button for one Session linked to it. */
export type BoardCardAction = BoardCardSecondaryAction | Readonly<{ session: Readonly<{ serverId: string; sessionId: string }> }>;

/**
 * Where pressing a card goes. A card never answers a permission or a hold: work that needs the person
 * opens its Inbox item, and only when this viewer has no Inbox does it open the item itself.
 * A machine is never Inbox work. An item whose Home is not connected opens nothing.
 */
export function resolveBoardCardOpenTarget(
    card: BoardCard,
    context: Readonly<{ inboxAvailable: boolean; action?: BoardCardAction }>,
): BoardCardOpenTarget | null {
    if (card.availability === 'home_unavailable') return null;
    if (typeof context.action === 'object') return { kind: 'item', ref: { kind: 'session',
        qualifiedId: { serverId: context.action.session.serverId, id: context.action.session.sessionId } } };
    if (card.ref.kind === 'task' && (card.availability !== 'ready' || card.body.kind !== 'task' || !card.body.item.page)) return null;
    // Secondary actions open native owners; neither dispatches a Run nor answers a hold here.
    if (context.action === 'run') return card.ref.kind === 'workflow' && card.availability === 'ready'
        ? { kind: 'item', ref: card.ref, intent: 'run' } : null;
    if (context.action === 'review') return { kind: 'item', ref: card.ref };
    const inboxWork = card.ref.kind === 'session' || card.ref.kind === 'workflow_run';
    if (inboxWork && isWorkStatusNeedsYou(card.status) && context.inboxAvailable) {
        return { kind: 'inbox', item: { kind: card.ref.kind === 'session' ? 'session' : 'workflow_run',
            serverId: card.ref.qualifiedId.serverId, id: card.ref.qualifiedId.id } };
    }
    return { kind: 'item', ref: card.ref };
}

/**
 * The detail a target opens over the board, drawn by the Inbox's own detail body. Null for the kinds with
 * no details destination (a Workflow, a Machine, a plugin task page): they keep their own pages.
 */
export function readBoardCardDetailFocus(target: BoardCardOpenTarget): InboxItemFocus | null {
    if (target.kind === 'inbox') return target.item;
    if (target.ref.kind !== 'session' && target.ref.kind !== 'workflow_run') return null;
    return { kind: target.ref.kind, serverId: target.ref.qualifiedId.serverId, id: target.ref.qualifiedId.id };
}
