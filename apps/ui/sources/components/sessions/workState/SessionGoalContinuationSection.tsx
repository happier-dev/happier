import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { WorkflowNumberField } from '@/components/workflows/editor/WorkflowNumberField';
import { formatWorkflowProblemMessage } from '@/components/workflows/presentation/workflowProblemPresentation';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { resolveSessionGoalContinuationOwner } from './sessionGoalContinuation';
import type { SessionKeepGoingTrigger } from './useSessionKeepGoingTrigger';

/**
 * The Goal control's continuation row (07 S16c): one owner per session. With native goals the switch
 * drives the agent's own mode (pause/resume where the agent has one) and nothing else is shown; otherwise
 * it is Happier's Keep going with its prefilled limits, the optional second opinion and the budget line.
 * When native goals meet a Keep going trigger that is still attached, neither row is offered and the
 * existing typed refusal says why (X16).
 */
export function SessionGoalContinuationSection(props: Readonly<{
    nativeGoalOwner: boolean;
    agentLabel: string;
    keepGoing: SessionKeepGoingTrigger;
    /** The goal's token budget; null when the goal has none. */
    tokenBudget: number | null;
    /** Native mode: whether the agent is pursuing the goal now, and the pause/resume it offers (null: none). */
    nativeActive: boolean;
    onNativeChange: ((on: boolean) => void) | null;
    busy?: boolean;
}>) {
    const { theme } = useUnistyles();
    const { keepGoing } = props;
    // Until the list answers, a native session cannot know whether a stale Keep going is attached.
    const owner = resolveSessionGoalContinuationOwner({
        nativeGoalOwner: props.nativeGoalOwner,
        attachment: keepGoing.attachment,
    });
    const titleColor = { color: theme.colors.text.primary };
    const descriptionColor = { color: theme.colors.text.secondary };

    if (owner.kind === 'conflict') {
        return (
            <View style={styles.root}>
                <Text
                    testID="session-goal-continuation-failure"
                    accessibilityRole="alert"
                    style={[styles.description, descriptionColor]}
                >
                    {formatWorkflowProblemMessage(new WorkflowActionError({ message: 'native_goal_owner', rawCode: 'native_goal_owner' }))}
                </Text>
            </View>
        );
    }

    if (owner.kind === 'native') {
        return (
            <View style={styles.root}>
                <View style={styles.row}>
                    <View style={styles.rowText}>
                        <Text style={[styles.title, titleColor]}>{t('goalControl.keepGoing.title')}</Text>
                        <Text style={[styles.description, descriptionColor]}>
                            {t('goalControl.keepGoing.nativeDescription', { agent: props.agentLabel })}
                        </Text>
                    </View>
                    <Switch
                        testID="session-goal-keep-going-switch"
                        accessibilityLabel={t('goalControl.keepGoing.title')}
                        value={props.nativeActive}
                        disabled={props.busy === true || props.onNativeChange === null}
                        onValueChange={(on) => props.onNativeChange?.(on)}
                    />
                </View>
            </View>
        );
    }

    const loaded = keepGoing.phase === 'loaded';
    return (
        <View style={styles.root}>
            <View style={styles.row}>
                <View style={styles.rowText}>
                    <Text style={[styles.title, titleColor]}>{t('goalControl.keepGoing.title')}</Text>
                    <Text style={[styles.description, descriptionColor]}>
                        {t('goalControl.keepGoing.description')}
                    </Text>
                </View>
                <Switch
                    testID="session-goal-keep-going-switch"
                    accessibilityLabel={t('goalControl.keepGoing.title')}
                    value={keepGoing.on}
                    disabled={!loaded || keepGoing.busy || props.busy === true}
                    onValueChange={keepGoing.setOn}
                />
            </View>
            <View style={styles.fields}>
                <WorkflowNumberField
                    testID="session-goal-keep-going-rounds"
                    label={t('goalControl.keepGoing.roundsPrefix')}
                    suffix={t('goalControl.keepGoing.roundsSuffix')}
                    accessibilityLabel={t('goalControl.keepGoing.roundsLabel')}
                    required
                    value={keepGoing.inputs.maxRounds}
                    onChange={(maxRounds) => keepGoing.setInputs({ maxRounds })}
                />
                <WorkflowNumberField
                    testID="session-goal-keep-going-strikes"
                    label={t('goalControl.keepGoing.strikesPrefix')}
                    suffix={t('goalControl.keepGoing.strikesSuffix')}
                    accessibilityLabel={t('goalControl.keepGoing.strikesLabel')}
                    required
                    value={keepGoing.inputs.strikes}
                    onChange={(strikes) => keepGoing.setInputs({ strikes })}
                />
            </View>
            <View style={styles.row}>
                <View style={styles.rowText}>
                    <Text style={[styles.title, titleColor]}>{t('goalControl.keepGoing.secondOpinionTitle')}</Text>
                    <Text style={[styles.description, descriptionColor]}>
                        {t('goalControl.keepGoing.secondOpinionDescription')}
                    </Text>
                </View>
                <Switch
                    testID="session-goal-keep-going-second-opinion"
                    accessibilityLabel={t('goalControl.keepGoing.secondOpinionTitle')}
                    value={keepGoing.inputs.secondOpinion}
                    disabled={!loaded || props.busy === true}
                    onValueChange={(secondOpinion) => keepGoing.setInputs({ secondOpinion })}
                />
            </View>
            {props.tokenBudget !== null ? (
                // Which agents report usage has no named owner yet (LEAD-1, 08 §3.2), so the
                // budget line is the one that never over-promises.
                <Text testID="session-goal-keep-going-budget" style={[styles.description, descriptionColor]}>
                    {t('goalControl.keepGoing.budgetUnreported', { agent: props.agentLabel })}
                </Text>
            ) : null}
            {keepGoing.error ? (
                <Text
                    testID="session-goal-keep-going-error"
                    accessibilityRole="alert"
                    style={[styles.description, { color: theme.colors.state.danger.foreground }]}
                >
                    {keepGoing.error}
                </Text>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    root: {
        gap: 10,
        minWidth: 0,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    rowText: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    fields: {
        gap: 2,
    },
    title: {
        ...Typography.variant('label', 'semiBold'),
    },
    description: {
        ...Typography.variant('meta'),
    },
}));
