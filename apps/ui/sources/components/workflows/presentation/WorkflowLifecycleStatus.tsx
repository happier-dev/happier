import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { StatusPill } from '@/components/ui/status/StatusPill';

import {
    describeWorkflowInvocationLifecycle,
    describeWorkflowRunState,
    type WorkflowLifecycleMarker,
    type WorkflowInvocationLifecycleContext,
} from './workflowLifecyclePresentation';

import type {
    WorkflowInvocationLifecycleV1,
    WorkflowRunStateV1,
    WorkflowRunSummaryV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';

/**
 * The managed Workflow status, rendered once.
 *
 * Icon plus label together, through the canonical `StatusPill`, so the state
 * survives monochrome, increased-contrast and colour-blind reading. The
 * in-flight marker is the app's existing `ActivitySpinner`, which already
 * honours the shared reduced-motion preference; no workflow-local motion,
 * colour or typography is introduced here.
 */

function WorkflowStatusMarker(props: Readonly<{
    marker: WorkflowLifecycleMarker;
    color: string;
    size: number;
    testID?: string;
}>): React.ReactElement {
    return (
        <View {...(props.testID === undefined ? {} : { testID: props.testID })}>
            {props.marker.kind === 'activity'
                ? <ActivitySpinner size={iconMatchedSpinnerSize(props.size)} color={props.color} />
                : <Icon name={props.marker.icon} size={props.size} color={props.color} />}
        </View>
    );
}

const PLAIN_STATUS_SHRINKS = { flexShrink: 1, minWidth: 0 } as const;

export function WorkflowLifecycleStatus(props: Readonly<{
    lifecycle: WorkflowInvocationLifecycleV1;
    /** The authored block's kind, when known, so a held Wait-for-you step reads its own word. */
    blockKind?: string | null;
    context?: WorkflowInvocationLifecycleContext;
    chrome?: 'pill' | 'plain';
    /**
     * Only the marker, for a place where healthy state is quiet (a finished Map node). The word stays
     * the marker's accessible name, so the state is still said once.
     */
    markerOnly?: boolean;
    testID?: string;
    accessibilityLabel?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const presentation = describeWorkflowInvocationLifecycle(props.lifecycle, { ...props.context, blockKind: props.blockKind });
    if (props.markerOnly === true || presentation.inheritsRunStop) {
        return (
            <View
                {...(props.testID === undefined ? {} : { testID: props.testID })}
                accessible
                accessibilityRole="text"
                accessibilityLabel={props.accessibilityLabel ?? presentation.label}
            >
                <WorkflowStatusMarker
                    marker={presentation.marker}
                    color={theme.colors.state[presentation.variant].foreground}
                    size={ICON_SIZE.xs}
                    {...(props.testID === undefined ? {} : { testID: `${props.testID}-marker` })}
                />
            </View>
        );
    }
    // Healthy state is quiet: only a state that needs the person or failed draws a pill (lab run-A_steps).
    const chrome = props.chrome ?? (presentation.variant === 'neutral' ? 'plain' : 'pill');
    return (
        <StatusPill
            {...(props.testID === undefined ? {} : { testID: props.testID })}
            {...(props.accessibilityLabel === undefined
                ? {}
                : { accessibilityLabel: props.accessibilityLabel })}
            variant={presentation.variant}
            label={presentation.label}
            labelVariant="phrase"
            chrome={chrome}
            // A plain status beside a title can be a sentence ("Stops when ubuntu-01 reconnects"): it wraps
            // inside the room its slot gives it rather than running past the card's edge (DESIGN-17 live).
            {...(chrome === 'plain' ? { labelNumberOfLines: 2, style: PLAIN_STATUS_SHRINKS } : {})}
            leading={(
                <WorkflowStatusMarker
                    marker={presentation.marker}
                    color={theme.colors.state[presentation.variant].foreground}
                    size={ICON_SIZE.xs}
                    {...(props.testID === undefined ? {} : { testID: `${props.testID}-marker` })}
                />
            )}
        />
    );
}

export function WorkflowRunStateStatus(props: Readonly<{
    state: WorkflowRunStateV1;
    workflowCustodyState?: WorkflowRunSummaryV1['workflowCustodyState'];
    /** A composed terminal outcome label, when real child coverage warrants one. */
    label?: string;
    chrome?: 'pill' | 'plain';
    testID?: string;
    accessibilityLabel?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const presentation = describeWorkflowRunState(props.state, { workflowCustodyState: props.workflowCustodyState });
    return (
        <StatusPill
            {...(props.testID === undefined ? {} : { testID: props.testID })}
            {...(props.accessibilityLabel === undefined
                ? {}
                : { accessibilityLabel: props.accessibilityLabel })}
            variant={presentation.variant}
            label={props.label ?? presentation.label}
            labelVariant="phrase"
            chrome={props.chrome ?? 'pill'}
            leading={(
                <WorkflowStatusMarker
                    marker={presentation.marker}
                    color={theme.colors.state[presentation.variant].foreground}
                    size={ICON_SIZE.xs}
                    {...(props.testID === undefined ? {} : { testID: `${props.testID}-marker` })}
                />
            )}
        />
    );
}

/**
 * The Run's state as its mark alone, leading the outcome sentence that already says the word (lab
 * `uwr-halo`). Decorative: the sentence is the accessible statement.
 */
export function WorkflowRunStateMark(props: Readonly<{
    state: WorkflowRunStateV1;
    inAttentionWindow?: boolean;
    context?: Parameters<typeof describeWorkflowRunState>[1];
    /** The mark's size where it stands in a quiet meta line (a Discussion run's end row); the outcome line's by default. */
    size?: number;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const presentation = describeWorkflowRunState(props.state, { ...props.context, inAttentionWindow: props.inAttentionWindow });
    return (
        <View
            {...(props.testID === undefined ? {} : { testID: props.testID })}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
        >
            <WorkflowStatusMarker
                marker={presentation.marker}
                color={theme.colors.state[presentation.variant].foreground}
                size={props.size ?? ICON_SIZE.md}
            />
        </View>
    );
}
