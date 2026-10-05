import type { BoardItemRefV1 } from '@happier-dev/protocol';

import type { InboxItemFocus } from '@/components/inbox/inboxItemFocus';

import type { BoardCard } from './boardCards';

export type BoardCardOpenTarget =
    | Readonly<{ kind: 'inbox'; item: InboxItemFocus }>
    | Readonly<{ kind: 'item'; ref: BoardItemRefV1 }>;

/**
 * Where pressing a card goes. A card never answers a permission or a hold: work that needs the person
 * opens the Inbox on its item (Boards has no peek host), and only when this viewer has no Inbox does it open
 * the item itself. A machine is never Inbox work. An item whose Home is not connected opens nothing.
 */
export function resolveBoardCardOpenTarget(
    card: BoardCard,
    context: Readonly<{ inboxAvailable: boolean }>,
): BoardCardOpenTarget | null {
    if (card.availability === 'home_unavailable') return null;
    const inboxWork = card.ref.kind === 'session' || card.ref.kind === 'workflow_run';
    if (inboxWork && card.status.bucket === 'needs_you' && context.inboxAvailable) {
        return { kind: 'inbox', item: { kind: card.ref.kind === 'session' ? 'session' : 'workflow_run',
            serverId: card.ref.qualifiedId.serverId, id: card.ref.qualifiedId.id } };
    }
    return { kind: 'item', ref: card.ref };
}
