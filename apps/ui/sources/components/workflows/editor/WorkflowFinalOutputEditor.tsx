import * as React from 'react';
import { View } from 'react-native';

import type { WorkflowAuthoredResultReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';

import { FieldItem } from '@/components/ui/forms/FieldItem';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { listWorkflowFinalOutputOptions } from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import { formatWorkflowValueReference, WorkflowResultFieldPathInput } from './WorkflowStepDataEditor';

export function WorkflowFinalOutputEditor(props: Readonly<{
    draft: WorkflowEditorDraft;
    onChange: (value: WorkflowAuthoredResultReference | null) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    const options = React.useMemo(() => listWorkflowFinalOutputOptions(props.draft), [props.draft]);
    const selected = props.draft.finalOutput;
    const unavailable = selected !== undefined && !options.some(option => option.blockId === selected.producer.blockId);
    return (
        <View testID={`${props.testIDPrefix}-final-output-editor`}>
            <DropdownMenu
                testID={`${props.testIDPrefix}-final-output-select`}
                open={open}
                onOpenChange={setOpen}
                selectedId={selected === undefined ? 'none' : `result:${selected.producer.blockId}`}
                items={[
                    { id: 'none', title: t('workflows.finalOutput.none'), testID: `${props.testIDPrefix}-final-output-clear` },
                    ...options.map(option => ({ id: `result:${option.blockId}`, title: option.label,
                        testID: `${props.testIDPrefix}-final-output-option-${option.blockId}` })),
                    ...(unavailable && selected ? [{ id: `result:${selected.producer.blockId}`, title: t('workflows.contentUnavailable'), disabled: true }] : []),
                ]}
                itemTrigger={{
                    title: t('workflows.finalOutput.title'), subtitle: t('workflows.finalOutput.explain'),
                    showSelectedSubtitle: false, field: { invalid: unavailable },
                    detailFormatter: () => selected === undefined ? t('workflows.finalOutput.none') : formatWorkflowValueReference(props.draft, selected),
                    itemProps: { accessoryLayout: 'stacked', testID: `${props.testIDPrefix}-final-output-trigger` },
                }}
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
                        testID={`${props.testIDPrefix}-final-output-path`}
                        reference={selected}
                        onChange={props.onChange}
                    />
                </FieldItem>}
            />
        </View>
    );
}
