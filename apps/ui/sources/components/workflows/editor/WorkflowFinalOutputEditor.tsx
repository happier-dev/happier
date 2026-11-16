import * as React from 'react';
import { View } from 'react-native';

import type { WorkflowAuthoredResultReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';

import { SessionAuthoringFieldSelectTrigger } from '@/components/sessions/authoring/controls/SessionAuthoringFieldSelectTrigger';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { listWorkflowFinalOutputOptions } from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import { formatWorkflowValueReference } from '../presentation/workflowValuePresentation';
import { WorkflowResultFieldPathInput } from './WorkflowStepDataEditor';

/**
 * What the workflow returns: the page-foot Result row's field select (round 1116), its menu listing the
 * producing steps, and a chosen step's field path beneath them.
 */
export function WorkflowFinalOutputEditor(props: Readonly<{
    draft: WorkflowEditorDraft;
    onChange: (value: WorkflowAuthoredResultReference | null) => void;
    /** Absent or true: chosen here; false: the choice is shown, not changed. */
    editable?: boolean;
    testIDPrefix: string;
}>): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ComponentRef<typeof View> | null>(null);
    const options = React.useMemo(() => listWorkflowFinalOutputOptions(props.draft), [props.draft]);
    const selected = props.draft.finalOutput;
    const unavailable = selected !== undefined && !options.some(option => option.blockId === selected.producer.blockId);
    const selectedId = selected === undefined ? 'none' : `result:${selected.producer.blockId}`;
    return (
        <View testID={`${props.testIDPrefix}-final-output-editor`}>
            <DropdownMenu
                testID={`${props.testIDPrefix}-final-output-select`}
                open={open}
                onOpenChange={setOpen}
                selectedId={selectedId}
                // The field select names the value, so the menu checks it among its rows.
                items={[
                    { id: 'none', title: t('workflows.finalOutput.none'), checked: selectedId === 'none', testID: `${props.testIDPrefix}-final-output-clear` },
                    ...options.map(option => ({ id: `result:${option.blockId}`, title: option.label, checked: selectedId === `result:${option.blockId}`,
                        testID: `${props.testIDPrefix}-final-output-option-${option.blockId}` })),
                    ...(unavailable && selected ? [{ id: `result:${selected.producer.blockId}`, title: t('workflows.contentUnavailable'), disabled: true }] : []),
                ]}
                trigger={({ toggle }) => (
                    <SessionAuthoringFieldSelectTrigger
                        anchorRef={anchorRef}
                        title={t('workflows.finalOutput.reports')}
                        label={selected === undefined ? t('workflows.finalOutput.none') : formatWorkflowValueReference(props.draft, selected)}
                        accessibilityHint={t('workflows.finalOutput.explain')}
                        open={open}
                        disabled={props.editable === false}
                        onPress={toggle}
                        testID={`${props.testIDPrefix}-final-output-trigger`}
                    />
                )}
                onSelect={(id) => {
                    setOpen(false);
                    if (id === 'none') props.onChange(null);
                    else {
                        const option = options.find(option => `result:${option.blockId}` === id);
                        if (option === undefined) return;
                        props.onChange({
                            kind: 'result',
                            producer: { blockId: option.blockId, scope: option.scope },
                            path: selected?.producer.blockId === option.blockId ? selected.path : [],
                        });
                    }
                }}
                footer={selected === undefined ? null : <FieldItem label={t('workflows.finalOutput.fieldPath')}>
                    <WorkflowResultFieldPathInput
                        draft={props.draft}
                        testID={`${props.testIDPrefix}-final-output-path`}
                        reference={selected}
                        onChange={props.onChange}
                    />
                </FieldItem>}
            />
        </View>
    );
}
