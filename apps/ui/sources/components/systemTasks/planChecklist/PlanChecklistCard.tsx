import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PlanChecklistRow } from './PlanChecklistRow';
import type {
    PlanChecklistExecutionState,
    PlanChecklistItem,
    PlanChecklistPhase,
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
                    const execution = props.executionById?.[item.id];
                    return (
                        <View key={item.id}>
                            {index > 0 ? (
                                <View style={styles.rowSeparator} />
                            ) : null}
                            <PlanChecklistRow
                                testID={props.testID ? `${props.testID}-row-${item.id}` : undefined}
                                item={item}
                                phase={props.phase}
                                selected={selectedSet.has(item.id)}
                                execution={execution}
                                expanded={expandedSet.has(item.id)}
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
