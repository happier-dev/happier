import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { WorkflowRunContent, type WorkflowRunDetailView } from '@/components/workflows/run/WorkflowRunContent';
import { buildDemoWorkflowRun } from '@/demoMode/world/workflowRun';

import type { StageDevice } from '../DeviceFrame';

export function WorkflowRunStageSurface(_props: Readonly<{ device?: StageDevice }> = {}): React.ReactElement {
    const [data] = React.useState(buildDemoWorkflowRun);
    const [selectedInvocationId, setSelectedInvocationId] = React.useState<string | null>(null);
    const [view, setView] = React.useState<WorkflowRunDetailView>('steps');

    return (
        <View testID="demo-stage-workflow-run" style={styles.root}>
            <WorkflowRunContent
                active={false}
                title={data.title}
                run={data.run}
                machineName="MacBook Pro"
                machineReachable
                definition={data.definition}
                materializedLeaves={data.materializedLeaves}
                invocations={data.invocations}
                invocationsLoaded
                invocationHistoryComplete
                firstFailedInvocationId={null}
                firstFailedInvocationResolution="resolved"
                selectedInvocationId={selectedInvocationId}
                selectedInvocationProgress={selectedInvocationId === null ? null : data.progressById.get(selectedInvocationId) ?? null}
                invocationProgressById={data.progressById}
                onSelectInvocation={setSelectedInvocationId}
                onDeselectInvocation={() => setSelectedInvocationId(null)}
                view={view}
                onChangeView={setView}
            />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, minHeight: 0, minWidth: 0, backgroundColor: theme.colors.surface.base },
}));
