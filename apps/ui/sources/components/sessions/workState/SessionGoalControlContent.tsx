import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { SessionWorkStateItem } from '@/sync/domains/session/workState/sessionWorkStateTypes';

import { GoalUsageSummary } from './GoalUsageSummary';
import { canPauseOrResumeGoal, resolveGoalStatusLabelKey } from './goalActionVisibility';

type GoalSaveBudgetDraft = Readonly<{
    tokenBudgetChanged: boolean;
    tokenBudget?: number | null;
}>;

export function SessionGoalControlContent(props: Readonly<{
    goal: SessionWorkStateItem | null;
    draftObjective: string;
    onDraftObjectiveChange: (value: string) => void;
    onSave: (budgetDraft: GoalSaveBudgetDraft) => void;
    onPause: () => void;
    onResume: () => void;
    onComplete: () => void;
    onClear: () => void;
    busy?: boolean;
}>) {
    const { theme } = useUnistyles();
    const isPaused = props.goal?.status === 'paused';
    const canComplete = Boolean(props.goal && props.goal.status !== 'complete' && props.goal.statusReason !== 'budgetLimited');
    const [editing, setEditing] = React.useState(!props.goal);
    const [budgetEnabled, setBudgetEnabled] = React.useState(typeof props.goal?.tokenBudget === 'number');
    const [draftBudget, setDraftBudget] = React.useState(
        typeof props.goal?.tokenBudget === 'number' ? String(Math.trunc(props.goal.tokenBudget)) : '',
    );
    const [budgetError, setBudgetError] = React.useState(false);

    React.useEffect(() => {
        setEditing(!props.goal);
    }, [props.goal?.id]);

    React.useEffect(() => {
        setBudgetEnabled(typeof props.goal?.tokenBudget === 'number');
        setDraftBudget(typeof props.goal?.tokenBudget === 'number' ? String(Math.trunc(props.goal.tokenBudget)) : '');
        setBudgetError(false);
    }, [props.goal?.id, props.goal?.tokenBudget]);

    const statusText = t(resolveGoalStatusLabelKey(props.goal));
    const canSave = props.draftObjective.trim().length > 0 && !props.busy;
    const cancelEdit = React.useCallback(() => {
        props.onDraftObjectiveChange(props.goal?.title ?? '');
        setBudgetEnabled(typeof props.goal?.tokenBudget === 'number');
        setDraftBudget(typeof props.goal?.tokenBudget === 'number' ? String(Math.trunc(props.goal.tokenBudget)) : '');
        setBudgetError(false);
        if (props.goal) setEditing(false);
    }, [props]);
    const budgetChanged = React.useMemo(() => {
        const currentBudget = typeof props.goal?.tokenBudget === 'number' ? Math.trunc(props.goal.tokenBudget) : null;
        if (!budgetEnabled) return currentBudget !== null;
        const trimmedBudget = draftBudget.trim();
        if (!trimmedBudget) return currentBudget !== null;
        const parsedBudget = Number(trimmedBudget);
        return currentBudget !== parsedBudget;
    }, [budgetEnabled, draftBudget, props.goal?.tokenBudget]);
    const save = React.useCallback(() => {
        setBudgetError(false);
        if (!canSave) return;
        if (!budgetEnabled) {
            props.onSave({
                tokenBudgetChanged: budgetChanged,
                ...(budgetChanged ? { tokenBudget: null } : {}),
            });
            return;
        }
        const trimmedBudget = draftBudget.trim();
        if (!/^\d+$/.test(trimmedBudget)) {
            setBudgetError(true);
            return;
        }
        const parsedBudget = Number(trimmedBudget);
        if (!Number.isSafeInteger(parsedBudget) || parsedBudget <= 0) {
            setBudgetError(true);
            return;
        }
        props.onSave({
            tokenBudgetChanged: budgetChanged,
            ...(budgetChanged ? { tokenBudget: parsedBudget } : {}),
        });
    }, [budgetChanged, budgetEnabled, canSave, draftBudget, props]);
    const saveButton = (
        <Pressable
            testID="session-goal-save-button"
            accessibilityRole="button"
            onPress={save}
            disabled={!canSave}
            style={({ pressed }) => [
                styles.primaryButton,
                {
                    backgroundColor: theme.colors.button.primary.background,
                    opacity: !canSave ? 0.42 : (pressed ? 0.88 : 1),
                },
            ]}
        >
            <Text style={[styles.actionText, { color: theme.colors.button.primary.tint }]}>
                {props.goal ? t('common.save') : t('session.workState.goal.set')}
            </Text>
        </Pressable>
    );
    return (
        <View style={styles.root}>
            <View style={styles.header}>
                <View style={styles.heading}>
                    <Text style={[styles.title, { color: theme.colors.text.primary }]}>
                        {t('session.workState.goal.title')}
                    </Text>
                    {props.goal ? (
                        <View style={[
                            styles.statusPill,
                            { backgroundColor: theme.colors.surface.selected },
                        ]}>
                            <Text style={[styles.statusText, { color: theme.colors.text.secondary }]}>
                                {statusText}
                            </Text>
                        </View>
                    ) : null}
                </View>
                {props.goal ? (
                    <View style={styles.headerActions}>
                        {editing ? (
                            <>
                                <Pressable
                                    testID="session-goal-cancel-edit-button"
                                    accessibilityRole="button"
                                    onPress={cancelEdit}
                                    disabled={props.busy}
                                    style={styles.secondaryButton}
                                >
                                    <Text style={[styles.secondaryActionText, { color: theme.colors.text.secondary }]}>
                                        {t('common.cancel')}
                                    </Text>
                                </Pressable>
                                {saveButton}
                            </>
                        ) : (
                            <>
                                {canPauseOrResumeGoal(props.goal) ? (
                                    <Pressable
                                        testID="session-goal-pause-resume-button"
                                        accessibilityRole="button"
                                        onPress={isPaused ? props.onResume : props.onPause}
                                        disabled={props.busy}
                                        style={styles.headerActionButton}
                                    >
                                        <Text style={[styles.secondaryActionText, { color: theme.colors.text.secondary }]}>
                                            {isPaused ? t('session.workState.goal.resume') : t('session.workState.goal.pause')}
                                        </Text>
                                    </Pressable>
                                ) : null}
                                {canComplete ? (
                                    <Pressable
                                        testID="session-goal-complete-button"
                                        accessibilityRole="button"
                                        onPress={props.onComplete}
                                        disabled={props.busy}
                                        style={styles.headerActionButton}
                                    >
                                        <Text style={[styles.secondaryActionText, { color: theme.colors.text.secondary }]}>
                                            {t('session.workState.goal.statusComplete')}
                                        </Text>
                                    </Pressable>
                                ) : null}
                                <Pressable
                                    testID="session-goal-clear-button"
                                    accessibilityRole="button"
                                    onPress={props.onClear}
                                    disabled={props.busy}
                                    style={styles.headerActionButton}
                                >
                                    <Text style={[styles.secondaryActionText, { color: theme.colors.state.danger.foreground }]}>
                                        {t('session.workState.goal.clear')}
                                    </Text>
                                </Pressable>
                                <Pressable
                                    testID="session-goal-edit-button"
                                    accessibilityRole="button"
                                    onPress={() => setEditing(true)}
                                    disabled={props.busy}
                                    style={styles.secondaryButton}
                                >
                                    <Text style={[styles.secondaryActionText, { color: theme.colors.text.secondary }]}>
                                        {t('common.edit')}
                                    </Text>
                                </Pressable>
                            </>
                        )}
                    </View>
                ) : null}
            </View>
            {editing ? (
                <TextInput
                    testID="session-goal-objective-input"
                    value={props.draftObjective}
                    onChangeText={props.onDraftObjectiveChange}
                    multiline
                    placeholder={t('session.workState.goal.placeholder')}
                    placeholderTextColor={theme.colors.input.placeholder}
                    style={[
                        styles.input,
                        {
                            color: theme.colors.text.primary,
                            borderColor: theme.colors.border.default,
                            backgroundColor: theme.colors.surface.inset,
                        },
                    ]}
                />
            ) : props.goal ? (
                <View style={[
                    styles.goalReadout,
                    {
                        borderColor: theme.colors.border.default,
                        backgroundColor: theme.colors.surface.inset,
                    },
                ]}>
                    <Text style={[styles.goalReadoutText, { color: theme.colors.text.primary }]} numberOfLines={4}>
                        {props.goal.title}
                    </Text>
                </View>
            ) : null}
            <GoalUsageSummary
                goal={props.goal}
                editing={editing}
                busy={props.busy}
                budgetEnabled={budgetEnabled}
                draftBudget={draftBudget}
                budgetError={budgetError}
                onBudgetEnabledChange={(enabled) => {
                    setBudgetEnabled(enabled);
                    setBudgetError(false);
                }}
                onDraftBudgetChange={(value) => {
                    setDraftBudget(value);
                    setBudgetError(false);
                }}
            />
            {!props.goal && editing ? (
                <View style={styles.footerActions}>
                    {saveButton}
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    root: {
        gap: 12,
        minWidth: 0,
        maxWidth: '100%',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
    },
    heading: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flex: 1,
    },
    title: {
        fontSize: 14,
        fontWeight: '700',
    },
    statusPill: {
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 3,
    },
    statusText: {
        fontSize: 11,
        fontWeight: '700',
    },
    goalReadout: {
        minHeight: 104,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    goalReadoutText: {
        fontSize: 14,
        fontWeight: '400',
    },
    input: {
        height: 104,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        textAlignVertical: 'top',
        fontSize: 14,
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        flexShrink: 0,
        flexWrap: 'wrap',
    },
    headerActionButton: {
        minHeight: 34,
        justifyContent: 'center',
    },
    footerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 12,
        minHeight: 36,
    },
    primaryButton: {
        minHeight: 36,
        minWidth: 92,
        borderRadius: 9,
        paddingHorizontal: 14,
        justifyContent: 'center',
        alignItems: 'center',
    },
    secondaryButton: {
        minHeight: 34,
        justifyContent: 'center',
    },
    actionText: {
        fontSize: 12,
        fontWeight: '700',
    },
    secondaryActionText: {
        fontSize: 12,
        fontWeight: '700',
    },
}));
