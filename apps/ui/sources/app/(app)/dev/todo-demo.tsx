import * as React from 'react';
import { TodoView } from "@/components/zen/views/TodoView";
import { Button, ScrollView, TextInput, View } from 'react-native';
import { randomUUID } from '@/platform/randomUUID';
import { layout } from '@/components/ui/layout/layout';
import { TodoList } from '@/components/zen/lists/TodoList';
import { TodoReorderInputV1Schema, resolveAnchoredListMoveV1 } from '@happier-dev/protocol';
import { entityDragScopesEqualV1, type EntityDropEffectV1, type EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { useSharedValue } from 'react-native-reanimated';
import { t } from '@/text';

// This developer-only local model is isolated from every signed-in Account's todo queue.
const SAMPLE_SCOPE = { serverId: 'dev-todo-demo', accountId: 'local-samples' };

export default function TodoDemoScreen() {

    const [model, setModel] = React.useState<{ id: string, value: string, done: boolean }[]>([]);
    const [newTodo, setNewTodo] = React.useState('');
    const scrollRef = React.useRef<ScrollView>(null);
    const offsetY = useSharedValue(0);
    const contentHeight = useSharedValue(0);
    const scrollMetrics = React.useMemo(() => ({ offsetY, contentHeight }), [offsetY, contentHeight]);

    const executeSampleReorder = React.useCallback(async (effect: EntityDropEffectV1): Promise<EntityDropOutcomeV1> => {
        const parsed = TodoReorderInputV1Schema.safeParse(effect.input);
        if (effect.actionId !== 'todos.reorder' || !parsed.success || !entityDragScopesEqualV1(parsed.data.scope, SAMPLE_SCOPE)) {
            return { status: 'refused', reason: { code: 'sample_scope_mismatch', message: t('entityDragDrop.reasons.gone') } };
        }
        const undone = model.filter(todo => !todo.done);
        const next = resolveAnchoredListMoveV1(undone.map(todo => todo.id), parsed.data.sourceId, parsed.data.position);
        if (!next) return { status: 'refused', reason: { code: 'sample_reorder_stale', message: t('entityDragDrop.reasons.gone') } };
        const byId = new Map(undone.map(todo => [todo.id, todo]));
        let index = 0;
        setModel(model.map(todo => todo.done ? todo : byId.get(next[index++]!)!));
        return { status: 'applied' };
    }, [model]);
    const reorderFixture = React.useMemo(() => ({ scope: SAMPLE_SCOPE, execute: executeSampleReorder }), [executeSampleReorder]);
    const handleToggle = React.useCallback((id: string) => {
        setModel(current => current.map(item => item.id === id ? { ...item, done: !item.done } : item));
    }, []);
    const todos = React.useMemo(() => model.map(todo => ({ id: todo.id, title: todo.value, done: todo.done })), [model]);

    const shuffleTodos = () => {
        setModel(prev => {
            const shuffled = [...prev];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            return shuffled;
        });
    };

    return (
        <View style={{ flex: 1 }}>
            <TextInput value={newTodo} onChangeText={setNewTodo} />
            <Button title="Add" onPress={() => setModel([{ id: randomUUID(), value: newTodo, done: false }, ...model])} />
            <Button title="Shuffle" onPress={shuffleTodos} />
            <ScrollView ref={scrollRef} style={{ flex: 1 }}
                onScroll={event => { offsetY.value = event.nativeEvent.contentOffset.y; }}
                onContentSizeChange={(_width, height) => { contentHeight.value = height; }}>
                <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
                    <View style={{ maxWidth: layout.maxWidth, flex: 1 }}>
                        <TodoList todos={todos} onToggleTodo={handleToggle} scrollRef={scrollRef}
                            scrollMetrics={scrollMetrics} reorderFixture={reorderFixture} />
                        {model.filter(todo => todo.done).map(todo => <View key={todo.id} style={{ marginBottom: 12 }}>
                            <TodoView id={todo.id} value={todo.value} done onToggle={() => handleToggle(todo.id)} />
                        </View>)}
                    </View>
                </View>
            </ScrollView>
        </View>
    )
}
