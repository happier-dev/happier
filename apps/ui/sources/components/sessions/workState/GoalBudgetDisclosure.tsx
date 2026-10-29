import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

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
            <HappierPressable
                testID="session-goal-budget-disclosure"
                accessibilityRole="button"
                onPress={() => props.onBudgetEnabledChange(true)}
                disabled={props.busy}
                style={styles.disclosureRow}
            >
                <Text style={[styles.disclosureText, { color: theme.colors.button.primary.background }]}>
                    {t('session.workState.goal.addBudget')}
                </Text>
            </HappierPressable>
        );
    }

    return (
        <View style={styles.editor}>
            <View style={styles.headerRow}>
                <Text style={[styles.label, { color: theme.colors.text.secondary }]}>
                    {t('session.workState.goal.tokenBudget')}
                </Text>
                <HappierPressable
                    testID="session-goal-budget-remove-button"
                    accessibilityRole="button"
                    onPress={() => props.onBudgetEnabledChange(false)}
                    disabled={props.busy}
                    style={styles.removeButton}
                >
                    <Text style={[styles.removeText, { color: theme.colors.text.secondary }]}>
                        {t('session.workState.goal.removeBudget')}
                    </Text>
                </HappierPressable>
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
        ...Typography.variant('body', 'semiBold'),
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
        ...Typography.variant('meta', 'semiBold'),
    },
    removeButton: {
        minHeight: 32,
        justifyContent: 'center',
    },
    removeText: {
        ...Typography.variant('meta', 'semiBold'),
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
        ...Typography.variant('micro', 'semiBold'),
    },
}));
