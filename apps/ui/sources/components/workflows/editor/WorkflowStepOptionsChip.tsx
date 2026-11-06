import { getWorkflowStepOptionsChipPlacement } from '../workflowComposerControlPlacements';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import {
    AGENT_INPUT_CHIP_ICON_SIZE_PX,
    AGENT_INPUT_MENU_ICON_SIZE_PX,
} from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';
import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { WorkflowBlock } from '@happier-dev/protocol/workflows/workflowV1';

import { workflowEditorStyles } from './workflowEditorStyles';

/**
 * What a block's Step options chip reads (D-7): "Workflow defaults", or the names of the options
 * this block changes ("Fresh · Only run when"). The chip names options; their values read in the
 * document once (the condition sentence under the card, a run-when caption in the gap above it).
 */
export function formatWorkflowBlockOptionsSummary(
    block: WorkflowBlock,
    ownDifferences: readonly string[] = [],
): Readonly<{ label: string; changed: boolean }> {
    const differences = [
        ...ownDifferences,
        ...(block.kind !== 'if' && block.onlyWhen !== undefined ? [t('workflows.condition.onlyWhen')] : []),
    ];
    return {
        label: differences.length === 0 ? t('workflows.page.blocks.workflowDefaults') : differences.join(' · '),
        changed: differences.length > 0,
    };
}

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
        flexShrink: 1,
        minWidth: 0,
    },
    /**
     * The chip yields before it overflows: on a narrow card its label ends with an ellipsis inside the
     * card instead of running past its edge (phone, a long "Separate conversations · A background run").
     */
    chipAnchor: {
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
    },
    chipLabel: {
        flexShrink: 1,
    },
    footChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        paddingHorizontal: theme.space.s8,
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
            controlId: 'shortcuts',
            placement: getWorkflowStepOptionsChipPlacement(),
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
        <View ref={anchorRef} collapsable={false} style={styles.chipAnchor}>
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
                    <Text testID={props.labelTestID} numberOfLines={1} style={[props.textStyle as never, styles.chipLabel]}>{props.label}</Text>
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
        <View ref={anchorRef} collapsable={false} style={styles.chipAnchor}>
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
                    state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                ]}
            >
                <Icon name="sliders-horizontal" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={theme.colors.text.secondary} />
                <Text testID={props.labelTestID} numberOfLines={1} style={[workflowEditorStyles.metaText, styles.chipLabel]}>{props.label}</Text>
            </HappierPressable>
        </View>
    );
}
