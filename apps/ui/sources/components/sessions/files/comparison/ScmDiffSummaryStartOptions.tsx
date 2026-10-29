import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ScmDiffSummaryModelPicker } from '@/components/settings/sourceControl/ScmDiffSummaryModelPicker';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import type { ScmDiffSummaryFailurePresentation } from '@/sync/domains/scm/diffSummary/state';
import { t } from '@/text';
import { SESSION_EXECUTION_RUN_LAUNCH_UNAVAILABLE_KEYS } from '@/hooks/session/useSessionExecutionRunLaunchability';

import type { useScmDiffSummaryBinding } from './useScmDiffSummaryBinding';

/**
 * The copy of a refused or failed generation, from the diff-summary store's typed presentation: one sentence and,
 * for every reason but a plain retry (Start is the retry), the next step. Codes never reach the person. A next step
 * that is an action (choose a model, turn Explain changes on) is `action`, offered only where there is something to
 * press; a next step with nothing to press (update the machine, reconnect it) is `nextStep`, a sentence of its own.
 */
export function describeScmDiffSummaryFailure(failure: ScmDiffSummaryFailurePresentation): Readonly<{
    message: string;
    nextStep: string | null;
    action: string | null;
    nextAction: ScmDiffSummaryFailurePresentation['nextAction'];
}> {
    const next = failure.nextAction === 'retry' ? null : t(failure.nextActionKey);
    const pressable = failure.nextAction === 'chooseModel' || failure.nextAction === 'enableExplain';
    return {
        message: t(failure.messageKey),
        nextStep: pressable ? null : next,
        action: pressable ? next : null,
        nextAction: failure.nextAction,
    };
}

/** Room for the message and its next step, so a refusal appearing or clearing never moves the state around it. */
const REFUSAL_LINES = 2;

/** The model choice of a start action: the shared picker's props, from the generation binding. */
type StartModel = Readonly<{
    value: string;
    onChange: (value: string) => void;
    modelChoices?: React.ComponentProps<typeof ScmDiffSummaryModelPicker>['modelChoices'];
    machineId?: string | null;
    serverId?: string | null;
    /** What an unset choice runs on (a Session's own model), so it never reads as a step still to take. */
    unsetLabel?: string | null;
    testID: string;
}>;

/**
 * What belongs with a start action (Start walkthrough, Propose commits) in the empty state: the model it will use,
 * as one quiet line, and under it the one reason it did not start with its next step. The refusal's room is
 * reserved, so nothing jumps when it arrives or clears.
 */
export function ScmDiffSummaryStartOptions(props: Readonly<{
    /** Absent when the action takes no model (adding to an existing walkthrough). */
    model?: StartModel;
    /** The typed refusal or failure of the last start. */
    failure: ScmDiffSummaryFailurePresentation | null;
    /** An incidental error, or why the action cannot run at all; a typed `failure` replaces it. */
    message: string | null;
    onChooseModel?: () => void;
    onEnableExplain?: () => void;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const failure = props.failure ? describeScmDiffSummaryFailure(props.failure) : null;
    const message = failure?.message ?? props.message;
    return (
        <View style={styles.group}>
            {props.model ? (
                <ScmDiffSummaryModelPicker
                    presentation="inline"
                    value={props.model.value}
                    onChange={props.model.onChange}
                    modelChoices={props.model.modelChoices}
                    machineId={props.model.machineId}
                    serverId={props.model.serverId}
                    unsetLabel={props.model.unsetLabel}
                    testID={props.model.testID}
                />
            ) : null}
            <View testID={`${props.testID}-refusal`} style={styles.refusal} accessibilityLiveRegion="polite">
                {message ? (
                    <>
                        <View style={styles.messageLine}>
                            <Icon name="warning" size={14} color={theme.colors.state.warning.foreground} />
                            <Text style={styles.message}>{message}</Text>
                        </View>
                        {failure?.nextAction === 'chooseModel' && props.onChooseModel ? (
                            <View style={styles.nextStepLink}>
                                <TextLinkButton testID={`${props.testID}-choose-model`} tone="strong" label={failure.action!} onPress={props.onChooseModel} />
                            </View>
                        ) : failure?.nextAction === 'enableExplain' && props.onEnableExplain ? (
                            <View style={styles.nextStepLink}>
                                <TextLinkButton testID={`${props.testID}-enable-explain`} tone="strong" label={failure.action!} onPress={props.onEnableExplain} />
                            </View>
                        ) : failure?.nextStep ? <Text style={styles.nextStep}>{failure.nextStep}</Text> : null}
                    </>
                ) : null}
            </View>
        </View>
    );
}

/**
 * The model choice of a surface that already shows a result: the picker is not on screen until the person is sent
 * to it (a refusal's "Choose model", a refresh with no usable model), and then it opens with its choices showing.
 */
export function useSummaryModelChoice(modelChoices: Readonly<{ setOpen: (open: boolean) => void }>): Readonly<{ choosing: boolean; choose: () => void }> {
    const [choosing, setChoosing] = React.useState(false);
    const { setOpen } = modelChoices;
    const choose = React.useCallback(() => { setChoosing(true); setOpen(true); }, [setOpen]);
    return { choosing, choose };
}

/** Opens the setting that turns Explain changes on: the next step of a refusal for it being off. */
export function useOpenExplainChangesSetting(): () => void {
    const router = useRouter();
    return React.useCallback(() => { router.push(SETTINGS_ROUTES.sourceControl as never); }, [router]);
}

/**
 * Why a start (Start walkthrough, Propose commits) cannot run, as its one cause and next step: the Machine being away
 * first, then what the host's launch owner says, then the model. Null when it can run. A cause with no clearer words
 * keeps the general sentence.
 */
export function scmDiffSummaryPrerequisiteOf(bound: Pick<ReturnType<typeof useScmDiffSummaryBinding>, 'machineReachability' | 'modelAvailable' | 'canSend' | 'launch'>): string | null {
    const reason = bound.launch.launchUnavailableReason ?? null;
    if (bound.machineReachability === 'unreachable') return t('walkthroughStart.machineOffline');
    // The launch owner can refuse unknown presence too; only confirmed absence means offline.
    if (reason === 'machineOffline') return t('walkthroughStart.unavailable');
    if (reason) return t(SESSION_EXECUTION_RUN_LAUNCH_UNAVAILABLE_KEYS[reason]);
    if (!bound.modelAvailable) return t('walkthroughStart.chooseModel');
    return bound.canSend && bound.launch.canLaunchExecutionRuns ? null : t('walkthroughStart.unavailable');
}

/** The options a binding gives its start action: its model, its typed failure and what else to say. */
export function scmDiffSummaryStartOptionsOf(
    bound: ReturnType<typeof useScmDiffSummaryBinding>,
    input: Readonly<{ testID: string; modelTestID?: string; prerequisite: string | null; onEnableExplain: () => void }>,
): React.ComponentProps<typeof ScmDiffSummaryStartOptions> {
    return {
        testID: input.testID,
        // Start cannot run while Explain changes is off; that outranks whatever the last start was refused for.
        failure: bound.startBlocker ?? bound.generationFailure,
        onEnableExplain: input.onEnableExplain,
        message: bound.error ?? input.prerequisite,
        ...(input.modelTestID ? {
            model: { value: bound.model, onChange: bound.setModel, modelChoices: bound.modelChoices,
                machineId: bound.machine?.machineId, serverId: bound.serverId, testID: input.modelTestID,
                // A Session-hosted start with no choice runs on that Session's model (the binding sends no override).
                unsetLabel: 'sessionId' in bound.host && bound.host.sessionId ? t('walkthroughSettings.sessionModel') : null },
            onChooseModel: () => bound.modelChoices.setOpen(true),
        } : {}),
    };
}

const styles = StyleSheet.create((theme) => ({
    group: { alignSelf: 'stretch', alignItems: 'center', gap: theme.space.s6, marginTop: theme.space.s8 },
    refusal: {
        alignSelf: 'stretch',
        alignItems: 'center',
        gap: theme.space.s2,
        minHeight: REFUSAL_LINES * Typography.variant('body').lineHeight + theme.space.s2,
        paddingHorizontal: theme.space.s16,
    },
    messageLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: theme.space.s6, maxWidth: 560 },
    message: { ...Typography.variant('body'), color: theme.colors.text.secondary, textAlign: 'center', flexShrink: 1 },
    nextStepLink: { alignSelf: 'center' },
    nextStep: { ...Typography.variant('body'), color: theme.colors.text.secondary, textAlign: 'center' },
}));
