import * as React from 'react';
import { readableMessageText } from '@/components/sessions/transcript/messageDisplayText';
import type { ScrollView } from 'react-native';
import type { PendingReorderInputV1 } from '@happier-dev/protocol/actions/listReorderAction';
import { entityDragScopesEqualV1, type EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';

import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { resolvePendingReorderIds } from '@/sync/domains/pending/pendingReorder';
import { resolvePendingMessagesPresentation } from './pendingMessageVisualState';
import { t } from '@/text';
import {
    EntityFlatReorderList, EntityFlatReorderRow, entityReorderPreview, entityReorderRefused,
    useEntityReorderAction, type EntityFlatReorderBinding,
} from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';

export type PendingMessagesDragReorderListProps = Readonly<{
    scope: EntityDragScopeV1 | null;
    sessionId: string;
    recipient: PendingReorderInputV1['recipient'];
    messages: ReadonlyArray<PendingMessage>;
    presentation?: ReturnType<typeof resolvePendingMessagesPresentation>;
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
    const executeReorder = useEntityReorderAction(props.scope);
    const presentation = React.useMemo(() => props.presentation ?? resolvePendingMessagesPresentation(props.messages),
        [props.presentation, props.messages]);
    const binding: EntityFlatReorderBinding = React.useMemo(() => {
        const { scope, sessionId, recipient, messages } = props;
        const reorderableIds = presentation.reorderableIds;
        const items = presentation.shownRows.filter(row => row.canReorder).map(({ message }) => ({ id: durableId(message), title: readableMessageText(String(message.displayText ?? message.text ?? ''), message.rawRecord?.meta) }));
        return {
            scope, kind: 'pending-input', items,
            getItem: id => scope && reorderableIds.has(id)
                ? { kind: 'pending-input', scope, address: { serverId: scope.serverId, sessionId }, localId: id } : null,
            getSourceId: item => item.kind === 'pending-input' && scope
                && entityDragScopesEqualV1(item.scope, scope)
                && item.address.serverId === scope.serverId && item.address.sessionId === sessionId
                && reorderableIds.has(item.localId)
                ? item.localId : null,
            resolve: (sourceId, position) => {
                if (!scope) return entityReorderRefused('pending_reorder_unavailable');
                if (!reorderableIds.has(sourceId) || (position.anchorId !== null && !reorderableIds.has(position.anchorId))) {
                    return entityReorderRefused('pending_reorder_unavailable');
                }
                const input = { scope, sessionId, recipient, sourceId, position };
                const order = resolvePendingReorderIds(messages, input);
                if (!order) return entityReorderRefused('pending_reorder_stale');
                const eligibleIds = new Set(order);
                const current = messages.filter(message => eligibleIds.has(durableId(message)));
                if (order.every((id, index) => current[index] && durableId(current[index]!) === id)) return entityReorderRefused('same-position');
                return { status: 'allowed', effect: { actionId: 'session.pending.reorder', input,
                    preview: entityReorderPreview(position, items) } };
            },
            execute: effect => scope ? executeReorder(effect)
                : Promise.resolve({ status: 'refused', reason: { code: 'pending_reorder_unavailable', message: t('entityDragDrop.reasons.gone') } }),
        };
    }, [props.scope, props.sessionId, props.recipient, props.messages, presentation, executeReorder]);

    return (
        <EntityFlatReorderList binding={binding} testID="pendingMessages.reorder"
            scrollRef={props.scrollRef} viewportHeightPx={props.viewportHeightPx}
            contentHeightPx={props.contentHeightPx} scrollOffsetY={props.scrollOffsetY}
            onScrollToOffset={props.onScrollToOffset ?? undefined}>
            {presentation.shownRows.map(({ message, index, canReorder }) => (
                <EntityFlatReorderRow key={durableId(message)} id={durableId(message)} reorderable={canReorder}>
                    {({ renderHandle, isDragging }) => props.renderItem({ message, index, isDragging,
                        renderDragHandle: args => renderHandle(args.testID) })}
                </EntityFlatReorderRow>
            ))}
        </EntityFlatReorderList>
    );
});
