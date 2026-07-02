import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text, TextInput } from '@/components/ui/text/Text';
import {
    TokenUsageRing,
    formatTokenUsageCount,
    formatTokenUsagePercent,
    resolveTokenUsageProgressRatio,
} from '@/components/sessions/usage';
import { t } from '@/text';
import type { SessionWorkStateItem } from '@/sync/domains/session/workState/sessionWorkStateTypes';

import { formatGoalTimeUsed } from './goalUsageFormatting';

export function GoalUsageSummary(props: Readonly<{
    goal: SessionWorkStateItem | null;
    editing: boolean;
    busy?: boolean;
    budgetEnabled: boolean;
    draftBudget: string;
    budgetError: boolean;
    onBudgetEnabledChange: (enabled: boolean) => void;
    onDraftBudgetChange: (value: string) => void;
}>) {
    const { theme } = useUnistyles();
    const usedTokens = props.goal?.tokensUsed ?? 0;
    const tokenBudget = props.goal?.tokenBudget;
    const hasTokenBudget = typeof tokenBudget === 'number' && Number.isFinite(tokenBudget);
    const tokenUsageLabel = hasTokenBudget
        ? t('session.workState.goal.budgetProgress', {
            used: formatTokenUsageCount(usedTokens),
            budget: formatTokenUsageCount(tokenBudget),
        })
        : formatTokenUsageCount(usedTokens);
    const tokenUsageRingValue = hasTokenBudget
        ? formatTokenUsagePercent(resolveTokenUsageProgressRatio({ used: usedTokens, limit: tokenBudget }) * 100)
        : '';
    const tokenMetricLabel = hasTokenBudget
        ? t('session.workState.goal.tokenBudget')
        : t('session.workState.goal.tokensUsed');

    return (
        <>
            <View style={styles.usageGrid}>
                <View style={[
                    styles.usageCell,
                    {
                        borderColor: theme.colors.border.default,
                        backgroundColor: theme.colors.surface.elevated,
                    },
                ]}>
                    <Text style={[styles.metaLabel, { color: theme.colors.text.secondary }]}>
                        {t('session.workState.goal.timeUsed')}
                    </Text>
                    <Text style={[styles.metaValue, { color: theme.colors.text.primary }]}>
                        {formatGoalTimeUsed(props.goal?.timeUsedSeconds)}
                    </Text>
                </View>
                <View style={[
                    styles.usageCell,
                    {
                        borderColor: theme.colors.border.default,
                        backgroundColor: theme.colors.surface.elevated,
                    },
                ]}>
                    <Text style={[styles.metaLabel, { color: theme.colors.text.secondary }]}>
                        {tokenMetricLabel}
                    </Text>
                    <View style={styles.budgetSummaryRow}>
                        {hasTokenBudget ? (
                            <TokenUsageRing
                                used={usedTokens}
                                limit={tokenBudget}
                                label={tokenUsageLabel}
                                value={tokenUsageRingValue}
                                size={32}
                                strokeWidth={2.5}
                                testID="session-goal-token-usage"
                                valueTestID="session-goal-token-usage-value"
                                progressTestID="session-goal-token-usage-progress"
                            />
                        ) : null}
                        <Text testID="session-goal-budget-summary" style={[styles.metaValue, { color: theme.colors.text.primary }]}>
                            {tokenUsageLabel}
                        </Text>
                    </View>
                </View>
            </View>
            {props.editing ? (
                <View style={styles.budgetEditor}>
                    <View style={styles.budgetHeaderRow}>
                        <Text style={[styles.metaLabel, { color: theme.colors.text.secondary }]}>
                            {t('session.workState.goal.budgetToggle')}
                        </Text>
                        <View style={styles.budgetToggleGroup}>
                            <Pressable
                                testID="session-goal-budget-no-limit-button"
                                accessibilityRole="button"
                                onPress={() => props.onBudgetEnabledChange(false)}
                                disabled={props.busy}
                                style={[
                                    styles.budgetToggle,
                                    {
                                        backgroundColor: props.budgetEnabled ? theme.colors.surface.inset : theme.colors.surface.selected,
                                    },
                                ]}
                            >
                                <Text style={[styles.secondaryActionText, { color: theme.colors.text.secondary }]}>
                                    {t('session.workState.goal.clearBudget')}
                                </Text>
                            </Pressable>
                            <Pressable
                                testID="session-goal-budget-limit-button"
                                accessibilityRole="button"
                                onPress={() => props.onBudgetEnabledChange(true)}
                                disabled={props.busy}
                                style={[
                                    styles.budgetToggle,
                                    {
                                        backgroundColor: props.budgetEnabled ? theme.colors.surface.selected : theme.colors.surface.inset,
                                    },
                                ]}
                            >
                                <Text style={[styles.secondaryActionText, { color: theme.colors.text.secondary }]}>
                                    {t('session.workState.goal.tokenBudget')}
                                </Text>
                            </Pressable>
                        </View>
                    </View>
                    {props.budgetEnabled ? (
                        <TextInput
                            testID="session-goal-budget-input"
                            value={props.draftBudget}
                            onChangeText={props.onDraftBudgetChange}
                            keyboardType="number-pad"
                            placeholder={t('session.workState.goal.budgetPlaceholder')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            style={[
                                styles.budgetInput,
                                {
                                    color: theme.colors.text.primary,
                                    borderColor: props.budgetError ? theme.colors.state.danger.foreground : theme.colors.border.default,
                                    backgroundColor: theme.colors.surface.inset,
                                },
                            ]}
                        />
                    ) : null}
                    {props.budgetError ? (
                        <Text testID="session-goal-budget-error" style={[styles.errorText, { color: theme.colors.state.danger.foreground }]}>
                            {t('session.workState.goal.invalidBudget')}
                        </Text>
                    ) : null}
                </View>
            ) : null}
        </>
    );
}

const styles = StyleSheet.create(() => ({
    usageGrid: {
        flexDirection: 'row',
        gap: 8,
    },
    usageCell: {
        flex: 1,
        minHeight: 56,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 9,
        paddingHorizontal: 10,
        paddingVertical: 8,
        justifyContent: 'center',
        gap: 3,
    },
    metaLabel: {
        fontSize: 10,
        fontWeight: '700',
        textTransform: 'uppercase',
    },
    metaValue: {
        fontSize: 12,
        fontWeight: '500',
    },
    budgetSummaryRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
    },
    budgetEditor: {
        gap: 8,
    },
    budgetHeaderRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
    },
    budgetToggleGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    budgetToggle: {
        minHeight: 32,
        borderRadius: 8,
        paddingHorizontal: 10,
        justifyContent: 'center',
    },
    budgetInput: {
        minHeight: 38,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 9,
        paddingHorizontal: 10,
        fontSize: 13,
    },
    errorText: {
        fontSize: 11,
        fontWeight: '600',
    },
    secondaryActionText: {
        fontSize: 12,
        fontWeight: '700',
    },
}));
