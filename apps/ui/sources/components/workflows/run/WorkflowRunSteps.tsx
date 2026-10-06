import * as React from 'react';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import type { WorkflowDefinitionV1, WorkflowRunInvocationIndexV1 } from '@happier-dev/protocol';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

import { useWorkflowAuthoringComposerCustody } from '@/components/sessions/authoring/authoringComposerCustody';
import { WorkflowBlockListEditor, type WorkflowDocumentPresentation } from '@/components/workflows/editor/WorkflowBlockListEditor';
import { WorkflowLifecycleStatus } from '@/components/workflows/presentation/WorkflowLifecycleStatus';
import {
    WORKFLOW_ATTENTION_LIFECYCLES,
    describeWorkflowInvocationAttempt,
} from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { Text } from '@/components/ui/text/Text';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { buildWorkflowEditorDraftFromDefinition, validateWorkflowEditorDraft } from '@/sync/domains/workflows/workflowAuthoring';
import { t } from '@/text';
import { resolveWorkflowFlowScopedNodeId } from '@/components/workflows/flow/workflowFlowProjection';

import type { WorkflowInvocationStructureEntry } from './workflowInvocationStructure';
import { workflowRunStyles as styles } from './workflowRunStyles';

function WorkflowRunOccurrenceSelector(props: Readonly<{
    invocations: readonly WorkflowRunInvocationIndexV1[];
    selectedInvocationId: string | null;
    onSelectInvocation: (id: string) => void;
    label: (invocation: WorkflowRunInvocationIndexV1) => string;
    blockKind: string | null;
    testIDPrefix: string;
}>): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    const items = props.invocations.map((invocation) => ({
        id: invocation.id,
        testID: `${props.testIDPrefix}-occurrence-${invocation.id}`,
        title: props.label(invocation),
        checked: invocation.id === props.selectedInvocationId,
        rightElement: <WorkflowLifecycleStatus lifecycle={invocation.lifecycle} blockKind={props.blockKind} chrome="plain" />,
    }));
    return <DropdownMenu open={open} onOpenChange={setOpen} items={items}
        selectedId={props.selectedInvocationId}
        onSelect={(id) => { setOpen(false); props.onSelectInvocation(id); }}
        search
        trigger={({ toggle, selectedItem }) => <HappierPressable
            testID={`${props.testIDPrefix}-select-occurrence`} accessibilityRole="button"
            expanded={open} onPress={toggle}
            style={({ pressed }) => [styles.actionTarget, pressed ? styles.pressed : null]}>
            <Text style={styles.action}>{selectedItem?.title ?? t('workflows.run.selectOccurrence')}</Text>
        </HappierPressable>}
    />;
}

/**
 * What a step's footer link opens, in the words of what is there: a held step is reviewed, an agent
 * step is its conversation, a workflow call is its own run, and an Action or Wait its details.
 */
function describeWorkflowOpenWorkLabel(input: Readonly<{
    lifecycle: WorkflowRunInvocationIndexV1['lifecycle'];
    blockKind: string | null;
    selected: boolean;
}>): string {
    if (WORKFLOW_ATTENTION_LIFECYCLES.includes(input.lifecycle)) {
        return input.selected ? t('workflows.run.reviewing') : t('workflows.run.review');
    }
    if (input.blockKind === 'step') return t('workflows.run.openConversation');
    if (input.blockKind === 'workflow') return t('workflows.run.openChildRun');
    return t('workflows.run.openStepDetails');
}

/** Frozen Run document, presented by the same recursive owner as authoring. */
export function WorkflowRunSteps(props: Readonly<{
    runId: string;
    machineId: string;
    serverId?: string | null;
    definition: WorkflowDefinitionV1;
    frozenChildren?: Readonly<Record<string, WorkflowDefinitionV1>>;
    workflowPath?: readonly string[];
    invocations: readonly WorkflowRunInvocationIndexV1[];
    structure: ReadonlyMap<string, WorkflowInvocationStructureEntry>;
    selectedInvocationId: string | null;
    onSelectInvocation: (invocationId: string) => void;
    occurrenceLabel: (entry: WorkflowInvocationStructureEntry) => string | null;
    testIDPrefix: string;
}>): React.ReactElement {
    const workflowPath = props.workflowPath ?? [];
    const sourceKey = resolveWorkflowFlowScopedNodeId('$root', workflowPath);
    const draft = React.useMemo(() => buildWorkflowEditorDraftFromDefinition({
        draftId: `run:${props.runId}:${sourceKey}`, name: '', definition: props.definition,
    }), [props.definition, props.runId, sourceKey]);
    const blocksById = React.useMemo(() => new Map(walkWorkflowBlocks(draft.blocks).map((block) => [block.id, block])), [draft.blocks]);
    const blockIds = React.useMemo(() => [...blocksById.keys()], [blocksById]);
    const custody = useWorkflowAuthoringComposerCustody({ draftId: draft.draftId, blockIds });
    const validation = React.useMemo(() => validateWorkflowEditorDraft(draft), [draft]);
    const byBlock = React.useMemo(() => {
        const result = new Map<string, WorkflowRunInvocationIndexV1[]>();
        for (const invocation of props.invocations) {
            const blockId = props.structure.get(invocation.id)?.blockId;
            if (!blockId || blockId === '$root') continue;
            if (props.structure.get(invocation.id)?.nodeId !== resolveWorkflowFlowScopedNodeId(blockId, workflowPath)) continue;
            const entries = result.get(blockId) ?? [];
            entries.push(invocation);
            result.set(blockId, entries);
        }
        return result;
    }, [props.invocations, props.structure, sourceKey]);
    const selectedEntry = props.selectedInvocationId === null ? undefined : props.structure.get(props.selectedInvocationId);
    const selectedBlockId = selectedEntry?.blockId && selectedEntry.nodeId === resolveWorkflowFlowScopedNodeId(selectedEntry.blockId, workflowPath)
        ? selectedEntry.blockId : null;
    const presentation: WorkflowDocumentPresentation = {
        editable: false,
        note: workflowPath.length === 0 ? <Text style={styles.sectionLabel}>{t('workflows.run.frozenVersion')}</Text> : null,
        step: (blockId) => {
            const occurrences = byBlock.get(blockId) ?? [];
            const selected = occurrences.find((entry) => entry.id === props.selectedInvocationId);
            const block = blocksById.get(blockId);
            const child = block?.kind === 'workflow' ? props.frozenChildren?.[block.workflowRef] : undefined;
            // A first attempt is not worth naming; only a retry says which attempt it is.
            const label = (invocation: WorkflowRunInvocationIndexV1) => {
                const entry = props.structure.get(invocation.id);
                const attempt = describeWorkflowInvocationAttempt(invocation.attempt);
                return [entry ? props.occurrenceLabel(entry) : null, attempt.retried ? attempt.label : null].filter(Boolean).join(' · ')
                    || attempt.label;
            };
            const only = occurrences.length === 1 ? occurrences[0]! : null;
            const onlyEntry = only === null ? undefined : props.structure.get(only.id);
            const onlyAttempt = only === null ? null : describeWorkflowInvocationAttempt(only.attempt);
            // The single occurrence opens from the step's footer, worded for what it opens (lab
            // run-A_steps "Open conversation", "Review"), instead of a bare "Attempt 1" line.
            const onlyNeedsYou = only !== null && WORKFLOW_ATTENTION_LIFECYCLES.includes(only.lifecycle);
            const openWork = only === null ? null : <HappierPressable
                testID={`${props.testIDPrefix}-occurrence-${only.id}`}
                accessibilityRole="button"
                selected={only.id === props.selectedInvocationId}
                current={only.id === props.selectedInvocationId ? 'page' : undefined}
                onPress={() => props.onSelectInvocation(only.id)}
                style={({ pressed }) => [styles.actionTarget, pressed ? styles.pressed : null]}
            >
                <Text style={onlyNeedsYou ? styles.action : styles.quietAction}>{[
                    onlyEntry === undefined ? null : props.occurrenceLabel(onlyEntry),
                    onlyAttempt?.retried === true ? onlyAttempt.label : null,
                    describeWorkflowOpenWorkLabel({ lifecycle: only.lifecycle, blockKind: block?.kind ?? null, selected: only.id === props.selectedInvocationId }),
                ].filter(Boolean).join(' · ')}</Text>
            </HappierPressable>;
            return {
                ...(block?.kind === 'workflow' ? { nestedDefinition: child ?? null } : {}),
                state: selected || occurrences.length === 1 ? <WorkflowLifecycleStatus lifecycle={(selected ?? occurrences[0]!).lifecycle} blockKind={block?.kind ?? null} /> : null,
                occurrenceSelector: occurrences.length > 1 ? <WorkflowRunOccurrenceSelector
                    invocations={occurrences} selectedInvocationId={props.selectedInvocationId}
                    onSelectInvocation={props.onSelectInvocation} label={label} blockKind={block?.kind ?? null} testIDPrefix={`${props.testIDPrefix}-${blockId}`}
                /> : null,
                footer: child === undefined ? openWork : <>
                    {openWork}
                    <WorkflowRunSteps
                        {...props} definition={child} workflowPath={[...workflowPath, blockId]}
                        testIDPrefix={`${props.testIDPrefix}-${blockId}`} />
                </>,
            };
        },
    };
    return <WorkflowBlockListEditor
        draft={draft} list={{ kind: 'root' }} blocks={draft.blocks} depth={0}
        selectedBlockId={selectedBlockId} validation={validation}
        composerScope={{ kind: 'machine', machineId: props.machineId, ...(props.serverId ? { serverId: props.serverId } : {}) }}
        composerCustody={custody}
        onChange={() => {}} onCustomize={() => {}}
        onSelect={(blockId) => {
            // A repeated block has no implicit "latest" occurrence: its exact selector owns selection.
            const occurrences = blockId === null ? [] : byBlock.get(blockId) ?? [];
            if (occurrences.length === 1) props.onSelectInvocation(occurrences[0]!.id);
        }}
        presentation={presentation} testIDPrefix={props.testIDPrefix}
    />;
}
