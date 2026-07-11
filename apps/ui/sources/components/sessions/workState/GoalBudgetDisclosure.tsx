import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';

/**
 * Optional token-budget editor shown inside the goal set/edit form. Budget is a disclosed advanced
 * option, not a competing primary decision: when no budget is enabled it collapses to a single
 * "+ Add a budget limit (optional)" affordance; expanded it shows the numeric field plus a
 * "Remove budget" action. Hidden entirely when the provider capability says budgets are not
 * configurable (e.g. Claude) — the gate is owned upstream via `budgetConfigurable`.
 * Ported from remote-dev by intent.
 */
export function GoalBudgetDisclosure(props: Readonly<{
    /** Whether the token-budget editor may be shown (capability-gated). Defaults to true. */
    budgetConfigurable?: boolean;
    budgetEnabled: boolean;
    draftBudget: string;
    budgetError: boolean;
    busy?: boolean;
    onBudgetEnabledChange: (enabled: boolean) => void;
    onDraftBudgetChange: (value: string) => void;
}>) {
    const { theme } = useUnistyles();
    if (props.budgetConfigurable === false) return null;

    if (!props.budgetEnabled) {
        return (
            <Pressable
                testID="session-goal-budget-disclosure"
                accessibilityRole="button"
                onPress={() => props.onBudgetEnabledChange(true)}
                disabled={props.busy}
                hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                style={styles.disclosureRow}
            >
                <Text style={[styles.disclosureText, { color: theme.colors.button.primary.background }]}>
                    {t('session.workState.goal.addBudget')}
                </Text>
            </Pressable>
        );
    }

    return (
        <View style={styles.editor}>
            <View style={styles.headerRow}>
                <Text style={[styles.label, { color: theme.colors.text.secondary }]}>
                    {t('session.workState.goal.tokenBudget')}
                </Text>
                <Pressable
                    testID="session-goal-budget-remove-button"
                    accessibilityRole="button"
                    onPress={() => props.onBudgetEnabledChange(false)}
                    disabled={props.busy}
                    hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                    style={styles.removeButton}
                >
                    <Text style={[styles.removeText, { color: theme.colors.text.secondary }]}>
                        {t('session.workState.goal.removeBudget')}
                    </Text>
                </Pressable>
            </View>
            <TextInput
                testID="session-goal-budget-input"
                value={props.draftBudget}
                onChangeText={props.onDraftBudgetChange}
                keyboardType="number-pad"
                placeholder={t('session.workState.goal.budgetPlaceholder')}
                placeholderTextColor={theme.colors.input.placeholder}
                style={[
                    styles.input,
                    {
                        color: theme.colors.text.primary,
                        borderColor: props.budgetError ? theme.colors.state.danger.foreground : theme.colors.border.default,
                    },
                ]}
            />
            {props.budgetError ? (
                <Text testID="session-goal-budget-error" style={[styles.errorText, { color: theme.colors.state.danger.foreground }]}>
                    {t('session.workState.goal.invalidBudget')}
                </Text>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    disclosureRow: {
        minHeight: 40,
        justifyContent: 'center',
        alignSelf: 'flex-start',
    },
    disclosureText: {
        fontSize: 13,
        fontWeight: '600',
    },
    editor: {
        gap: 8,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        minHeight: 24,
    },
    label: {
        fontSize: 12,
        fontWeight: '600',
    },
    removeButton: {
        minHeight: 32,
        justifyContent: 'center',
    },
    removeText: {
        fontSize: 12,
        fontWeight: '600',
    },
    input: {
        minHeight: 40,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 10,
        paddingHorizontal: 12,
        fontSize: 14,
        fontVariant: ['tabular-nums'],
    },
    errorText: {
        fontSize: 11,
        fontWeight: '600',
    },
}));
