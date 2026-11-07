import type { BoardItemRefV1 } from '@happier-dev/protocol/boards/workBoardV1';

import type { InboxItemFocus } from '@/components/inbox/inboxItemFocus';

import type { BoardCard } from './boardCards';
import { isWorkStatusNeedsYou } from '@/components/work/status/resolveWorkStatusTone';

export type BoardCardOpenTarget =
    | Readonly<{ kind: 'inbox'; item: InboxItemFocus }>
    | Readonly<{ kind: 'item'; ref: BoardItemRefV1; intent?: 'run' }>;

export type BoardCardAction = 'review' | 'run';

/**
 * Where pressing a card goes. A card never answers a permission or a hold: work that needs the person
 * opens the Inbox on its item (Boards has no peek host), and only when this viewer has no Inbox does it open
 * the item itself. A machine is never Inbox work. An item whose Home is not connected opens nothing.
 */
export function resolveBoardCardOpenTarget(
    card: BoardCard,
    context: Readonly<{ inboxAvailable: boolean; action?: BoardCardAction }>,
): BoardCardOpenTarget | null {
    if (card.availability === 'home_unavailable') return null;
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
