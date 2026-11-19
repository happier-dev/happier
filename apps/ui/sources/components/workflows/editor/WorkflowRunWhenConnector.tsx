import * as React from 'react';
import { WorkflowRunWhenV1Schema, type WorkflowRunWhenV1 } from '@happier-dev/protocol/workflows/workflowV1';

import { View } from 'react-native';

import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { workflowEditorStyles } from './workflowEditorStyles';
import { WorkflowFieldPair } from './WorkflowStepDataEditor';

/**
 * A block's run-when edge (D9): which outcome of the previous step lets it run. The coordinator, not
 * this presentation, owns the outcome predicate.
 *
 * The default ("if it succeeds") is the document's reading order and says nothing (lab `editor-E1`);
 * only a block that runs after a failure, or either way, names its edge in the gap above it. The
 * choice itself is a step option, edited in Step options like every other step-level setting.
 */
function formatRunWhen(value: WorkflowRunWhenV1): string {
    return value === 'failure' ? t('workflows.runWhen.ifFailure')
        : value === 'always' ? t('workflows.runWhen.regardless') : t('workflows.runWhen.ifSuccess');
}

/** The gap's caption: nothing for the default edge, a quiet phrase otherwise. */
export function WorkflowRunWhenCaption(props: Readonly<{ value: WorkflowRunWhenV1 | undefined; testID: string }>): React.ReactElement | null {
    if (props.value === undefined || props.value === 'success') return null;
    return <Text testID={props.testID} numberOfLines={1} style={workflowEditorStyles.blockGapCaption}>{formatRunWhen(props.value)}</Text>;
}

/** Step options' Run when row: Success · Failure · Always, relative to the previous step. */
export function WorkflowRunWhenOption(props: Readonly<{
    value: WorkflowRunWhenV1 | undefined;
    onChange: (value: WorkflowRunWhenV1) => void;
    /** `item` (default): a settings row. `track`: its segments beside the label on the options' label track. */
    layout?: 'item' | 'track';
    testIDPrefix: string;
}>): React.ReactElement {
    const options = WorkflowRunWhenV1Schema.options.map(id => ({ id, label: id === 'failure' ? t('workflows.runWhen.failure')
        : id === 'always' ? t('workflows.runWhen.always') : t('workflows.runWhen.success') }));
    if (props.layout === 'track') return (
        <View style={workflowEditorStyles.actionFieldRow}>
            <WorkflowFieldPair label={t('workflows.runWhen.title')} trackKey="run-when" labelAlign="control"
                note={<Text testID={`${props.testIDPrefix}-note`} style={workflowEditorStyles.actionFieldNote}>{t('workflows.runWhen.previousStep')}</Text>}>
                <SegmentedTabBar<WorkflowRunWhenV1>
                    tabs={options}
                    activeTabId={props.value ?? 'success'}
                    onSelectTab={props.onChange}
                    segmentSizing="content"
                    accessibilityLabel={t('workflows.runWhen.title')}
                    role="radiogroup"
                    testIDPrefix={props.testIDPrefix}
                />
            </WorkflowFieldPair>
        </View>
    );
    return (
        <SegmentedChoiceItem<WorkflowRunWhenV1>
            title={t('workflows.runWhen.title')}
            subtitle={t('workflows.runWhen.previousStep')}
            value={props.value ?? 'success'}
            testIDPrefix={props.testIDPrefix}
            options={options}
            onChange={props.onChange}
        />
    );
}
