import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from './_registry';
import { ToolSectionView } from '../../tools/ToolSectionView';

export interface Todo {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    priority?: 'high' | 'medium' | 'low';
    id?: string;
}

export const TodoView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    if (tool.state !== 'completed') return null;

    const listFromResult = Array.isArray((tool.result as any)?.todos) ? ((tool.result as any).todos as Todo[]) : null;
    const listFromLegacyResult = Array.isArray((tool.result as any)?.newTodos) ? ((tool.result as any).newTodos as Todo[]) : null;
    const listFromInput = Array.isArray((tool.input as any)?.todos) ? ((tool.input as any).todos as Todo[]) : null;

    const todosList = listFromResult ?? listFromLegacyResult ?? listFromInput ?? [];
    if (todosList.length === 0) return null;

    const isFullView = detailLevel === 'full';
    const shown = todosList.slice(0, isFullView ? 50 : 6);
    const more = todosList.length - shown.length;

    return (
        <ToolSectionView fullWidth={isFullView}>
            <View style={styles.container}>
                {shown.map((todo, index) => {
                    const isCompleted = todo.status === 'completed';
                    const isInProgress = todo.status === 'in_progress';
                    const isPending = todo.status === 'pending';

                    let textStyle: any = styles.todoText;
                    let icon = '☐';

                    if (isCompleted) {
                        textStyle = [styles.todoText, styles.completedText];
                        icon = '☑';
                    } else if (isInProgress) {
                        textStyle = [styles.todoText, styles.inProgressText];
                        icon = '☐';
                    } else if (isPending) {
                        textStyle = [styles.todoText, styles.pendingText];
                    }

                    return (
                        <View key={todo.id || `todo-${index}`} style={styles.todoItem}>
                            <Text style={textStyle} numberOfLines={isFullView ? 3 : 2}>
                                {icon} {todo.content}
                            </Text>
                        </View>
                    );
                })}
                {more > 0 ? <Text style={styles.more}>+{more} more</Text> : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
        gap: 6,
    },
    todoItem: {
        paddingVertical: 2,
    },
    todoText: {
        fontSize: 14,
        color: theme.colors.text,
        flex: 1,
    },
    completedText: {
        color: theme.colors.success,
        textDecorationLine: 'line-through',
    },
    inProgressText: {
        color: theme.colors.text,
    },
    pendingText: {
        color: theme.colors.textSecondary,
    },
    more: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'Menlo',
    },
}));
