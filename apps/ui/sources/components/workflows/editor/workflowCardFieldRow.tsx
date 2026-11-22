import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { FIELD_BOX_METRICS } from '@/components/ui/forms/fieldBox';

import { WorkflowFieldPair, WorkflowKindCardLabelTrack } from './WorkflowStepDataEditor';
import { workflowEditorStyles } from './workflowEditorStyles';

const styles = StyleSheet.create({
    /** Field selects share one width, so a card's column of controls reads as one edge (round 1116). */
    field: {
        alignSelf: 'stretch',
        maxWidth: FIELD_BOX_METRICS.triggerMaxWidthPx,
    },
    /** Label above value (the phone sheet): the select spans the row, as the segmented controls beside it do. */
    fieldStacked: {
        alignSelf: 'stretch',
    },
});

function CardFieldControl(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
    const stacked = React.useContext(WorkflowKindCardLabelTrack)?.stacked === true;
    return <View style={stacked ? styles.fieldStacked : styles.field}>{props.children}</View>;
}

/**
 * One labelled row on a first card's label track (How and where it runs: Machine, Folder, Workspace and
 * More settings' fields), its control at the shared field width.
 */
export function renderWorkflowCardFieldRow(key: string, label: string, control: React.ReactNode): React.ReactElement {
    return (
        <View key={key} style={workflowEditorStyles.actionFieldRow}>
            <WorkflowFieldPair label={label} trackKey={key} labelAlign="control">
                <CardFieldControl>{control}</CardFieldControl>
            </WorkflowFieldPair>
        </View>
    );
}
