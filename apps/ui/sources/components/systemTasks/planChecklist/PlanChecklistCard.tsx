import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PlanChecklistRow } from './PlanChecklistRow';
import type {
    PlanChecklistExecutionState,
    PlanChecklistItem,
    PlanChecklistPhase,
    PlanChecklistVariant,
} from './types';

const stylesheet = StyleSheet.create((theme) => ({
    card: {
        width: '100%',
        borderRadius: theme.borderRadius.modalCard,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
    },
    footer: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
        paddingHorizontal: 16,
        paddingVertical: 14,
        backgroundColor: theme.colors.surface,
    },
    rowSeparator: {
        height: 1,
        backgroundColor: theme.colors.divider,
    },
}));

export type PlanChecklistCardProps = Readonly<{
    testID?: string;
    items: readonly PlanChecklistItem[];
    phase: PlanChecklistPhase;
    variant?: PlanChecklistVariant;
    selectedIds: readonly string[];
    executionById?: Readonly<Record<string, PlanChecklistExecutionState>>;
    expandedIds?: readonly string[];
    expandedId?: string | null;
    onToggleItem?: (itemId: string) => void;
    onToggleExpanded?: (itemId: string) => void;
    onCopyDiagnostics?: (item: PlanChecklistItem) => void | Promise<void>;
    header?: React.ReactNode;
    footer?: React.ReactNode;
    style?: StyleProp<ViewStyle>;
}>;

function buildIdSet(ids: readonly string[]): ReadonlySet<string> {
    return new Set(ids);
}

function hasSelectedDescendant(item: PlanChecklistItem, selectedSet: ReadonlySet<string>): boolean {
    if (item.children && item.children.length > 0) {
        return item.children.some((child) => hasSelectedDescendant(child, selectedSet));
    }
    return selectedSet.has(item.id);
}

function buildLeafExecutionState(
    item: PlanChecklistItem,
    phase: PlanChecklistPhase,
    selectedSet: ReadonlySet<string>,
    executionById?: Readonly<Record<string, PlanChecklistExecutionState>>,
): PlanChecklistExecutionState {
    const selected = selectedSet.has(item.id);
    const execution = executionById?.[item.id];
    if (phase === 'select') {
        return {
            status: item.satisfied
                ? (selected || item.disabled ? 'done' : 'idle')
                : (selected ? 'queued' : 'idle'),
            logs: execution?.logs ?? [],
            error: execution?.error,
        };
    }
    return {
        status: execution?.status ?? (item.satisfied ? 'done' : (selected ? 'queued' : 'idle')),
        logs: execution?.logs ?? [],
        error: execution?.error,
    };
}

function aggregateExecutionStates(states: readonly PlanChecklistExecutionState[]): PlanChecklistExecutionState {
    const status = states.some((state) => state.status === 'error')
        ? 'error'
        : states.some((state) => state.status === 'running')
            ? 'running'
            : states.some((state) => state.status === 'queued')
                ? 'queued'
                : states.every((state) => state.status === 'done')
                    ? 'done'
                    : states.some((state) => state.status === 'done')
                        ? 'running'
                        : 'idle';
    return {
        status,
        logs: [],
        error: states.find((state) => state.error)?.error,
    };
}

function resolveExecutionState(
    item: PlanChecklistItem,
    phase: PlanChecklistPhase,
    selectedSet: ReadonlySet<string>,
    executionById?: Readonly<Record<string, PlanChecklistExecutionState>>,
): PlanChecklistExecutionState | undefined {
    if (!item.children || item.children.length === 0) {
        return executionById?.[item.id];
    }
    return aggregateExecutionStates(item.children.map((child) => (
        resolveExecutionState(child, phase, selectedSet, executionById)
        ?? buildLeafExecutionState(child, phase, selectedSet, executionById)
    )));
}

export const PlanChecklistCard = React.memo(function PlanChecklistCard(props: PlanChecklistCardProps) {
    useUnistyles();
    const styles = stylesheet;
    const selectedSet = React.useMemo(() => buildIdSet(props.selectedIds), [props.selectedIds]);
    const expandedIds = props.expandedIds ?? (props.expandedId ? [props.expandedId] : []);
    const expandedSet = React.useMemo(() => buildIdSet(expandedIds), [expandedIds]);

    return (
        <View testID={props.testID} style={[styles.card, props.style]}>
            {props.header ? (
                <View>{props.header}</View>
            ) : null}

            <View>
                {props.items.map((item, index) => {
                    const execution = resolveExecutionState(item, props.phase, selectedSet, props.executionById);
                    const selected = hasSelectedDescendant(item, selectedSet);
                    const childrenCard = item.children && item.children.length > 0 ? (
                        <PlanChecklistCard
                            testID={props.testID ? `${props.testID}-row-${item.id}-children` : undefined}
                            items={item.children}
                            phase={props.phase}
                            variant={props.variant}
                            selectedIds={props.selectedIds}
                            executionById={props.executionById}
                            expandedIds={expandedIds}
                            onToggleItem={props.onToggleItem}
                            onToggleExpanded={props.onToggleExpanded}
                            onCopyDiagnostics={props.onCopyDiagnostics}
                            style={{
                                borderRadius: 12,
                                overflow: 'hidden',
                            }}
                        />
                    ) : null;
                    return (
                        <View key={item.id}>
                            {index > 0 ? (
                                <View style={styles.rowSeparator} />
                            ) : null}
                            <PlanChecklistRow
                                testID={props.testID ? `${props.testID}-row-${item.id}` : undefined}
                                item={item}
                                variant={props.variant ?? 'default'}
                                phase={props.phase}
                                selected={selected}
                                execution={execution}
                                expanded={expandedSet.has(item.id)}
                                childrenContent={childrenCard}
                                onToggle={() => props.onToggleItem?.(item.id)}
                                onToggleExpanded={() => props.onToggleExpanded?.(item.id)}
                                onCopyDiagnostics={props.onCopyDiagnostics ? () => props.onCopyDiagnostics?.(item) : undefined}
                            />
                        </View>
                    );
                })}
            </View>

            {props.footer ? (
                <View style={styles.footer}>
                    {props.footer}
                </View>
            ) : null}
        </View>
    );
});
