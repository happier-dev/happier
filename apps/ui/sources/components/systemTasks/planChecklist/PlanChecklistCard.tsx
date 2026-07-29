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
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        overflow: 'hidden',
    },
    cardOnboarding: {
        borderRadius: 14,
        borderColor: theme.colors.border.modal,
    },
    footer: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        paddingHorizontal: 16,
        paddingVertical: 14,
        backgroundColor: theme.colors.surface.base,
    },
    rowSeparator: {
        height: 1,
        backgroundColor: theme.colors.border.default,
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
    onCopyDiagnostics?: (item: PlanChecklistItem) => boolean | void | Promise<boolean | void>;
    header?: React.ReactNode;
    footer?: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    depth?: number;
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
    const hasError = states.some((state) => state.status === 'error');
    const hasRunning = states.some((state) => state.status === 'running');
    const hasQueued = states.some((state) => state.status === 'queued');
    const hasDone = states.some((state) => state.status === 'done');
    const allDone = states.length > 0 && states.every((state) => state.status === 'done');
    const allIdle = states.every((state) => state.status === 'idle');

    const status = hasError
        ? 'error'
        : hasRunning
            ? 'running'
            : hasQueued
                ? 'queued'
                : allDone
                    ? 'done'
                    : allIdle
                        ? 'idle'
                        : hasDone
                            ? 'done'
                            : 'idle';
    return {
        status,
        logs: states.flatMap((state) => state.logs),
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
    const depth = props.depth ?? 0;

    return (
        <View
            testID={props.testID}
            style={[
                styles.card,
                props.variant === 'onboarding' ? styles.cardOnboarding : null,
                props.style,
            ]}
        >
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
                            depth={depth + 1}
                        />
                    ) : null;
                    return (
                        <View key={item.id}>
                            {props.variant !== 'onboarding' && index > 0 ? (
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
                                depth={depth}
                                positionIndex={index + 1}
                                isLast={index === props.items.length - 1}
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
