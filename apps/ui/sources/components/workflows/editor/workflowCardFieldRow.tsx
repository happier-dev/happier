import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { FIELD_BOX_METRICS } from '@/components/ui/forms/fieldBox';

import { WorkflowFieldPair } from './WorkflowStepDataEditor';
import { workflowEditorStyles } from './workflowEditorStyles';

const styles = StyleSheet.create({
    /** Field selects share one width, so a card's column of controls reads as one edge (round 1116). */
    field: {
        alignSelf: 'stretch',
        maxWidth: FIELD_BOX_METRICS.triggerMaxWidthPx,
    },
});

/**
 * One labelled row on a first card's label track (How and where it runs: Machine, Folder, Workspace and
 * More settings' fields), its control at the shared field width.
 */
export function renderWorkflowCardFieldRow(key: string, label: string, control: React.ReactNode): React.ReactElement {
    return (
        <View key={key} style={workflowEditorStyles.actionFieldRow}>
            <WorkflowFieldPair label={label} trackKey={key}>
                <View style={styles.field}>{control}</View>
            </WorkflowFieldPair>
        </View>
    );
}
