import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import {
    AGENT_INPUT_CHIP_ICON_SIZE_PX,
    AGENT_INPUT_MENU_ICON_SIZE_PX,
} from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';
import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { workflowEditorStyles, workflowPressFeedbackStyle } from './workflowEditorStyles';

type StepOptionsChipProps = Readonly<{
    /** "Workflow defaults", or what this step changes ("Fresh · Reviews before continuing"). */
    label: string;
    /** Bordered when the step changes something, quiet when it inherits (04 §4.3). */
    changed: boolean;
    onOpen: (anchorRef: React.RefObject<View | null>) => void;
    testID: string;
    labelTestID: string;
}>;

const styles = StyleSheet.create((theme) => ({
    chipChanged: {
        borderColor: theme.colors.border.strong,
    },
    chipFrame: {
        borderWidth: 1,
        borderColor: 'transparent',
    },
    footChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.xs,
        paddingHorizontal: theme.margins.sm,
        borderRadius: theme.borderRadius.md,
    },
}));

/**
 * The Step options control of one step (07 S7, 04 §4.3): a chip in the step's own composer chip
 * row, beside the engine and attach controls. It reads "Workflow defaults" or the step's
 * differences, and opens the Step options popover anchored to itself. An Action step has no
 * composer, so its card foot renders the same control through {@link WorkflowStepOptionsFootChip}.
 */
export function useWorkflowStepOptionsChip(props: StepOptionsChipProps): AgentInputExtraActionChip {
    const latestRef = React.useRef(props.onOpen);
    latestRef.current = props.onOpen;
    const { label, changed, testID, labelTestID } = props;
    return React.useMemo<AgentInputExtraActionChip>(() => {
        const fallbackAnchorRef: React.RefObject<View | null> = { current: null };
        return {
            key: 'workflow-step-options',
            stabilityKey: `${label}\u0000${changed ? 1 : 0}`,
            collapsedAction: ({ tint, dismiss }) => ({
                id: 'workflow-step-options',
                label: `${t('workflows.page.inspector.stepOptions')} · ${label}`,
                icon: <Icon name="sliders-horizontal" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />,
                onPress: () => {
                    dismiss();
                    latestRef.current(fallbackAnchorRef);
                },
            }),
            render: (ctx) => (
                <StepOptionsComposerChip
                    label={label}
                    changed={changed}
                    testID={testID}
                    labelTestID={labelTestID}
                    onOpen={(anchorRef) => latestRef.current(anchorRef)}
                    chipStyle={ctx.chipStyle}
                    textStyle={ctx.textStyle}
                    iconColor={ctx.iconColor}
                    showLabel={ctx.showLabel}
                />
            ),
        };
    }, [changed, label, labelTestID, testID]);
}

function StepOptionsComposerChip(props: StepOptionsChipProps & Readonly<{
    chipStyle: (pressed: boolean) => unknown;
    textStyle: unknown;
    iconColor: string;
    showLabel: boolean;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View>(null);
    return (
        <View ref={anchorRef} collapsable={false}>
            <HappierPressable
                testID={props.testID}
                accessibilityRole="button"
                accessibilityLabel={`${t('workflows.page.inspector.stepOptions')}: ${props.label}`}
                hasPopup="dialog"
                onPress={() => props.onOpen(anchorRef)}
                style={(state) => [
                    props.chipStyle(state.pressed) as never,
                    styles.chipFrame,
                    props.changed ? styles.chipChanged : null,
                    focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                ]}
            >
                <Icon name="sliders-horizontal" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={props.iconColor} />
                {props.showLabel ? (
                    <Text testID={props.labelTestID} numberOfLines={1} style={props.textStyle as never}>{props.label}</Text>
                ) : null}
            </HappierPressable>
        </View>
    );
}

/** The same Step options control at the foot of a card with no composer (an Action step). */
export function WorkflowStepOptionsFootChip(props: StepOptionsChipProps): React.ReactElement {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View>(null);
    return (
        <View ref={anchorRef} collapsable={false}>
            <HappierPressable
                testID={props.testID}
                accessibilityRole="button"
                accessibilityLabel={`${t('workflows.page.inspector.stepOptions')}: ${props.label}`}
                hasPopup="dialog"
                onPress={() => props.onOpen(anchorRef)}
                style={(state) => [
                    workflowEditorStyles.actionTarget,
                    styles.footChip,
                    props.changed ? styles.chipChanged : null,
                    workflowPressFeedbackStyle(state, theme.colors.border.focus),
                ]}
            >
                <Icon name="sliders-horizontal" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={theme.colors.text.secondary} />
                <Text testID={props.labelTestID} numberOfLines={1} style={workflowEditorStyles.metaText}>{props.label}</Text>
            </HappierPressable>
        </View>
    );
}
