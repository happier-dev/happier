import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';

import { WorkflowKindCardLabelTrack } from './WorkflowStepDataEditor';
import { workflowEditorStyles } from './workflowEditorStyles';

/**
 * A typed step's card (lab `.uwe-kind`, `editor-S6`): the frame an Action and a
 * Run a workflow step share with the document's composer card. Its header names
 * what runs — mark, name, provenance — with one action at its end ("Open ›");
 * its body is label/value rows (`WorkflowBindingRow`); its foot says what kind
 * of step this is and holds Step options. Two kinds, one anatomy.
 */
export function WorkflowKindCard(props: Readonly<{
    mark: React.ReactNode;
    title: string;
    /** Where it comes from ("Built-in", "Happier", "Discord plugin"). */
    source?: string;
    /** The header's one action ("Open ›"). */
    headerAction?: React.ReactNode;
    /** What kind of step this is ("Runs another workflow · its steps show in this run"). */
    note: string;
    /** The foot's control (Step options). */
    footAccessory?: React.ReactNode;
    /**
     * `false` while the block's heading carries this card's identity (an unnamed block,
     * `resolveWorkflowUnnamedHeading` → `card`): the card is its rows and foot, so the title is said once.
     */
    header?: boolean;
    children?: React.ReactNode;
    testID: string;
}>): React.ReactElement {
    // One label track for every row of this card: the widest label's natural width (bounded by the
    // row's own min/max), so values start on one column (lab S6).
    const [trackWidth, setTrackWidth] = React.useState<number | null>(null);
    const reported = React.useRef(new Map<string, number>());
    const track = React.useMemo(() => ({
        width: trackWidth,
        report: (rowKey: string, width: number) => {
            reported.current.set(rowKey, width);
            const widest = Math.ceil(Math.max(...reported.current.values()));
            setTrackWidth((current) => (current === null || widest > current ? widest : current));
        },
    }), [trackWidth]);
    return (
        <WorkflowKindCardLabelTrack.Provider value={track}>
        <View testID={props.testID} style={workflowEditorStyles.kindCard}>
            {props.header === false ? null : <View style={workflowEditorStyles.kindCardHeader}>
                <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{props.mark}</View>
                <Text testID={`${props.testID}-title`} numberOfLines={1} style={workflowEditorStyles.headingName}>{props.title}</Text>
                {props.source === undefined ? null
                    : <Text numberOfLines={1} style={workflowEditorStyles.kindCardSource}>{'· '}{props.source}</Text>}
                {props.headerAction === undefined ? null : <View style={workflowEditorStyles.headingActions}>{props.headerAction}</View>}
            </View>}
            {props.children === undefined || props.children === null ? null
                : <View style={workflowEditorStyles.kindCardBody}>{props.children}</View>}
            <View style={workflowEditorStyles.kindCardFoot}>
                <Text style={workflowEditorStyles.kindCardNote}>{props.note}</Text>
                {props.footAccessory ?? null}
            </View>
        </View>
        </WorkflowKindCardLabelTrack.Provider>
    );
}
