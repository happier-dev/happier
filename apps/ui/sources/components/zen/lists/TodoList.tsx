import * as React from 'react';
import { View, type ScrollView } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import { resolveAnchoredListMoveV1 } from '@happier-dev/protocol/actions/anchoredListOrderV1';
import { entityDragScopesEqualV1, type EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';
import { t } from '@/text';

import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { TodoView } from '@/components/zen/views/TodoView';
import { EntityFlatReorderList, EntityFlatReorderRow, entityReorderPreview, entityReorderRefused, executeEntityReorderAction, type EntityFlatReorderBinding } from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';

export type TodoListProps = Readonly<{
    todos: readonly Readonly<{ id: string; title: string; done: boolean }>[];
    onToggleTodo?: (id: string) => void;
    scrollRef?: React.RefObject<ScrollView | null>;
    scrollMetrics?: Readonly<{ offsetY: SharedValue<number>; contentHeight: SharedValue<number> }>;
    /** Developer samples receive the same semantic effect at their local model boundary. */
    reorderFixture?: Readonly<{ scope: EntityDragScopeV1; execute: EntityFlatReorderBinding['execute'] }>;
}>;

/** Undone membership is live; completion never becomes a reorder/status-transfer operation. */
export const TodoList = React.memo<TodoListProps>(function TodoList(props) {
    const accountScope = useActiveServerAccountScope();
    const scope = props.reorderFixture?.scope ?? accountScope;
    const todos = props.todos.filter(todo => !todo.done);
    const binding: EntityFlatReorderBinding = {
        scope, kind: 'todo', items: todos,
        getItem: id => scope && todos.some(todo => todo.id === id) ? { kind: 'todo', scope, todoId: id } : null,
        getSourceId: item => item.kind === 'todo' && scope && entityDragScopesEqualV1(item.scope, scope) ? item.todoId : null,
        resolve: (sourceId, position) => {
            if (!scope) return entityReorderRefused('todo_scope_unavailable');
            const ids = todos.map(todo => todo.id);
            const next = resolveAnchoredListMoveV1(ids, sourceId, position);
            if (!next) return entityReorderRefused('todo_reorder_stale');
            if (next.every((id, index) => id === ids[index])) return entityReorderRefused('same-position');
            return { status: 'allowed', effect: {
                actionId: 'todos.reorder', input: { scope, sourceId, position },
                preview: entityReorderPreview(position, todos),
            } };
        },
        execute: effect => props.reorderFixture ? props.reorderFixture.execute(effect)
            : scope ? executeEntityReorderAction(effect, scope) : Promise.resolve({ status: 'refused', reason: { code: 'todo_scope_unavailable', message: t('entityDragDrop.reasons.gone') } }),
    };
    return <EntityFlatReorderList binding={binding} testID="zen.todos" scrollRef={props.scrollRef} scrollMetrics={props.scrollMetrics}>
        {todos.map(todo => <EntityFlatReorderRow key={todo.id} id={todo.id}>
            {({ renderHandle }) => <View style={{ marginHorizontal: 8, marginBottom: 12 }}>
                <TodoView id={todo.id} done={false} value={todo.title} onToggle={() => props.onToggleTodo?.(todo.id)} reorderHandle={renderHandle(`zen.todos.${todo.id}.move`)} />
            </View>}
        </EntityFlatReorderRow>)}
    </EntityFlatReorderList>;
});
