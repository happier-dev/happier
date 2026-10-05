import * as React from 'react';
import { View, type StyleProp, type TextStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';


export interface Todo {
    content: string;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    priority?: 'high' | 'medium' | 'low';
    id?: string;
}

function readTodoList(value: unknown, key: string): Todo[] | null {
    if (!value || typeof value !== 'object') return null;
    const list = (value as Record<string, unknown>)[key];
    if (!Array.isArray(list)) return null;
    return list as Todo[];
}

function resolveTodos(tool: ToolViewProps['tool']): Todo[] {
    return readTodoList(tool.result, 'todos') ?? readTodoList(tool.result, 'newTodos') ?? readTodoList(tool.input, 'todos') ?? [];
}

function formatTodo(todo: Todo): string {
    const icon = todo.status === 'completed' ? '☑' : todo.status === 'cancelled' ? '☒' : '☐';
    return `${icon} ${todo.content ?? ''}`;
}

export const projectTodoDisplayText: ToolDisplayTextProjector = (tool) => tool.state === 'completed'
    ? resolveTodos(tool).flatMap((todo, index) => toolTextBlock(`tool-todo-${index}`, formatTodo(todo)))
    : [];

export const TodoView = React.memo<ToolViewProps>(({ tool, detailLevel, messageId }) => {
    const find = useToolFindState(messageId);
    if (tool.state !== 'completed') return null;

    const todosList = resolveTodos(tool);
    if (todosList.length === 0) return null;

    const isFullView = detailLevel === 'full';
    const shown = find.active ? todosList : todosList.slice(0, isFullView ? 50 : 6);
    const more = todosList.length - shown.length;

    return (
        <ToolSectionView fullWidth={isFullView}>
            <View style={styles.container}>
                {shown.map((todo, index) => {
                    const isCompleted = todo.status === 'completed';
                    const isInProgress = todo.status === 'in_progress';
                    const isPending = todo.status === 'pending';
                    const isCancelled = todo.status === 'cancelled';

                    let textStyle: StyleProp<TextStyle> = styles.todoText;

                    if (isCompleted) {
                        textStyle = [styles.todoText, styles.completedText];
                    } else if (isCancelled) {
                        textStyle = [styles.todoText, styles.cancelledText];
                    } else if (isInProgress) {
                        textStyle = [styles.todoText, styles.inProgressText];
                    } else if (isPending) {
                        textStyle = [styles.todoText, styles.pendingText];
                    }

                    return (
                        <View key={todo.id || `todo-${index}`} style={styles.todoItem}>
                            <ToolFindText messageId={messageId} blockId={`tool-todo-${index}`} text={formatTodo(todo)} style={textStyle} numberOfLines={isFullView ? 3 : 2} />
                        </View>
                    );
                })}
                {more > 0 ? <Text style={styles.more}>{t('tools.structuredResult.more', { count: more })}</Text> : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.inset,
        gap: 6,
    },
    todoItem: {
        paddingVertical: 2,
    },
    todoText: {
        fontSize: 14,
        color: theme.colors.text.primary,
        flex: 1,
    },
    completedText: {
        color: theme.colors.state.success.foreground,
        textDecorationLine: 'line-through',
    },
    inProgressText: {
        color: theme.colors.text.primary,
    },
    pendingText: {
        color: theme.colors.text.secondary,
    },
    cancelledText: {
        color: theme.colors.text.secondary,
        textDecorationLine: 'line-through',
    },
    more: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
}));
