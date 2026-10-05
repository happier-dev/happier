import * as React from 'react';
import type { ScrollView } from 'react-native';
import type { PendingReorderInputV1 } from '@happier-dev/protocol';
import { entityDragScopesEqualV1, type EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';

import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { resolvePendingReorderIds } from '@/sync/domains/pending/pendingReorder';
import { t } from '@/text';
import {
    EntityFlatReorderList, EntityFlatReorderRow, entityReorderPreview, entityReorderRefused,
    executeEntityReorderAction, type EntityFlatReorderBinding,
} from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';

export type PendingMessagesDragReorderListProps = Readonly<{
    scope: EntityDragScopeV1 | null;
    sessionId: string;
    recipient: PendingReorderInputV1['recipient'];
    messages: ReadonlyArray<PendingMessage>;
    scrollRef?: React.RefObject<ScrollView | null>;
    onScrollToOffset?: ((y: number) => void) | null;
    viewportHeightPx?: number | null;
    contentHeightPx?: number | null;
    scrollOffsetY?: number | null;
    renderItem: (args: {
        message: PendingMessage;
        index: number;
        isDragging: boolean;
        renderDragHandle: (args: Readonly<{ children: React.ReactNode; testID?: string; accessibilityLabel?: string }>) => React.ReactNode;
    }) => React.ReactNode;
}>;

function durableId(message: PendingMessage): string { return message.localId ?? message.id; }

/** Rows stay in normal flow: the shared realm owns carry feedback, measurement and cancellation. */
export const PendingMessagesDragReorderList = React.memo<PendingMessagesDragReorderListProps>((props) => {
    const binding: EntityFlatReorderBinding = React.useMemo(() => {
        const { scope, sessionId, recipient, messages } = props;
        const items = messages.map(message => ({ id: durableId(message), title: String(message.displayText ?? message.text ?? '') }));
        return {
            scope, kind: 'pending-input', items,
            getItem: id => scope && messages.some(message => durableId(message) === id)
                ? { kind: 'pending-input', scope, address: { serverId: scope.serverId, sessionId }, localId: id } : null,
            getSourceId: item => item.kind === 'pending-input' && scope
                && entityDragScopesEqualV1(item.scope, scope)
                && item.address.serverId === scope.serverId && item.address.sessionId === sessionId
                ? item.localId : null,
            resolve: (sourceId, position) => {
                if (!scope) return entityReorderRefused('pending_reorder_unavailable');
                const input = { scope, sessionId, recipient, sourceId, position };
                const order = resolvePendingReorderIds(messages, input);
                if (!order) return entityReorderRefused('pending_reorder_stale');
                const eligibleIds = new Set(order);
                const current = items.filter(item => eligibleIds.has(item.id));
                if (order.every((id, index) => current[index]?.id === id)) return entityReorderRefused('same-position');
                return { status: 'allowed', effect: { actionId: 'session.pending.reorder', input,
                    preview: entityReorderPreview(position, items) } };
            },
            execute: effect => scope ? executeEntityReorderAction(effect, scope)
                : Promise.resolve({ status: 'refused', reason: { code: 'pending_reorder_unavailable', message: t('entityDragDrop.reasons.gone') } }),
        };
    }, [props.scope, props.sessionId, props.recipient, props.messages]);

    return (
        <EntityFlatReorderList binding={binding} testID="pendingMessages.reorder"
            scrollRef={props.scrollRef} viewportHeightPx={props.viewportHeightPx}
            contentHeightPx={props.contentHeightPx} scrollOffsetY={props.scrollOffsetY}
            onScrollToOffset={props.onScrollToOffset ?? undefined}>
            {props.messages.map((message, index) => (
                <EntityFlatReorderRow key={durableId(message)} id={durableId(message)}>
                    {({ renderHandle, isDragging }) => props.renderItem({ message, index, isDragging,
                        renderDragHandle: args => renderHandle(args.testID) })}
                </EntityFlatReorderRow>
            ))}
        </EntityFlatReorderList>
    );
});
