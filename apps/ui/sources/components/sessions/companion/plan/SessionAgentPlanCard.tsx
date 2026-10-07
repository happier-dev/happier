import * as React from 'react';
import { View } from 'react-native';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { WidgetFrame, type WidgetFrameStyle } from '@/components/widgets/frame/WidgetFrame';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { SessionAgentPlan, SessionAgentPlanStep } from './sessionAgentPlan';

/**
 * The agent's Plan as its own Companion item (lab CA, built-in `agent_plan`):
 * progress segments and the steps, with the one the agent is on marked as
 * working or, while it waits for you, held. Read-only; the transcript's
 * TodoWrite card stays the record.
 */

const stylesheet = StyleSheet.create((theme) => ({
    meta: { ...Typography.default(), ...Typography.tabular(), color: theme.colors.text.tertiary, fontSize: 12 },
    progress: { flexDirection: 'row', gap: 3, marginTop: 2, marginBottom: 8 },
    segment: { flex: 1, height: 4, borderRadius: 2, backgroundColor: theme.colors.border.default },
    segmentDone: { backgroundColor: theme.colors.text.secondary },
    segmentHeld: { backgroundColor: theme.colors.state.warning.foreground },
    segmentWorking: { backgroundColor: theme.colors.text.tertiary },
    step: { flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 23 },
    marker: { width: 13, alignItems: 'center', justifyContent: 'center' },
    open: {
        width: 9,
        height: 9,
        borderRadius: 5,
        borderWidth: 1.5,
        borderColor: theme.colors.text.tertiary,
        opacity: 0.6,
    },
    stepText: { ...Typography.default(), color: theme.colors.text.primary, fontSize: 12.5, lineHeight: 17, flexShrink: 1 },
    stepDone: { color: theme.colors.text.secondary },
    stepCurrent: { ...Typography.default('semiBold') },
}));

export type SessionAgentPlanActivity = 'working' | 'held' | 'idle';

const PlanStepRow = React.memo(function PlanStepRow(props: Readonly<{
    step: SessionAgentPlanStep;
    activity: SessionAgentPlanActivity;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const { step } = props;
    const marker = step.status === 'done' ? (
        <Icon name="check" size={13} color={theme.colors.text.tertiary} />
    ) : step.status === 'current' && props.activity !== 'idle' ? (
        <StatusDot
            size={9}
            color={props.activity === 'held' ? theme.colors.state.warning.foreground : theme.colors.state.info.foreground}
            isPulsing={props.activity === 'working'}
        />
    ) : (
        <View style={stylesheet.open} />
    );
    const stateLabel = step.status === 'done'
        ? t('sessionCompanion.plan.stepDone')
        : step.status === 'current' ? t('sessionCompanion.plan.stepCurrent') : null;
    return (
        <View
            testID={props.testID}
            style={stylesheet.step}
            accessibilityLabel={stateLabel ? `${step.text}, ${stateLabel}` : step.text}
        >
            <View style={stylesheet.marker}>{marker}</View>
            <Text
                style={[
                    stylesheet.stepText,
                    step.status === 'done' ? stylesheet.stepDone : null,
                    step.status === 'current' ? stylesheet.stepCurrent : null,
                ]}
                numberOfLines={2}
            >
                {step.text}
            </Text>
        </View>
    );
});

export const SessionAgentPlanCard = React.memo(function SessionAgentPlanCard(props: Readonly<{
    plan: SessionAgentPlan | null;
    agentLabel: string | null;
    activity: SessionAgentPlanActivity;
    headerAccessory?: React.ReactNode;
    /** Card or plain, resolved by the Companion (the item's override, else its default). */
    frameStyle?: WidgetFrameStyle;
    presentation?: 'frame' | 'body';
    testID: string;
}>) {
    const { plan } = props;
    const widgetPresentation = useWidgetPresentation();
    // A short viewport leads with what the agent is doing, retaining the complete plan below.
    // Richer bodies keep the transcript's source order; reflow changes neither data nor identity.
    const steps = React.useMemo(() => {
        if (!plan || widgetPresentation?.footprint.height !== 'compact') return plan?.steps ?? [];
        const current = plan.currentStep ?? plan.nextStep;
        if (current === null) return plan.steps;
        const lead = plan.steps[current - 1];
        return lead ? [lead, ...plan.steps.filter(step => step !== lead)] : plan.steps;
    }, [plan, widgetPresentation?.footprint.height]);
    const agent = props.agentLabel ?? t('sessionCompanion.status.agentFallback');
    return (
        <WidgetFrame
            presentation={props.presentation}
            testID={props.testID}
            frameStyle={props.frameStyle ?? 'plain'}
            placement="companion"
            mark="list-checks"
            title={t('sessionCompanion.plan.title')}
            source={agent}
            accessibilityLabel={t('sessionCompanion.plan.description', { agent })}
            meta={plan ? (
                <Text
                    testID={`${props.testID}-progress`}
                    style={stylesheet.meta}
                    accessibilityLabel={t('sessionCompanion.plan.progressA11y', { done: plan.doneCount, total: plan.total })}
                >
                    {t('sessionCompanion.plan.progress', { done: plan.doneCount, total: plan.total })}
                </Text>
            ) : null}
            menu={props.headerAccessory}
            body={{
                kind: 'content',
                children: plan ? (
                    <>
                        <View style={stylesheet.progress} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                            {plan.steps.map((step) => (
                                <View
                                    key={step.id}
                                    style={[
                                        stylesheet.segment,
                                        step.status === 'done' ? stylesheet.segmentDone : null,
                                        step.status === 'current' && props.activity === 'held' ? stylesheet.segmentHeld : null,
                                        step.status === 'current' && props.activity === 'working' ? stylesheet.segmentWorking : null,
                                    ]}
                                />
                            ))}
                        </View>
                        {steps.map((step) => (
                            <PlanStepRow
                                key={step.id}
                                step={step}
                                activity={props.activity}
                                testID={`${props.testID}-step-${step.id}`}
                            />
                        ))}
                    </>
                ) : (
                    <SurfaceStateCard
                        size="line"
                        kind="empty"
                        testID={`${props.testID}-empty`}
                        title={t('sessionCompanion.plan.emptyTitle')}
                        reason={t('sessionCompanion.plan.emptyReason')}
                    />
                ),
            }}
        />
    );
});
