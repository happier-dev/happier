import * as React from 'react';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import type { JsonValue} from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowDefinitionV1} from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowMaterializedLeafV1} from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import type { WorkflowProgressEnvelopeV1, WorkflowRunInvocationIndexV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { resolveWorkflowAcceptedStepSelectionV1, WorkflowStepSelectionErrorV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';

import { useWorkflowAuthoringComposerCustody } from '@/components/sessions/authoring/authoringComposerCustody';
import { resolveSessionAuthoringAgentId } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { useRoleEnginePresentation } from '@/components/roles/catalog/useRoleEnginePresentation';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { WorkflowBlockListEditor, type WorkflowDocumentPresentation } from '@/components/workflows/editor/WorkflowBlockListEditor';
import type { WorkflowDocumentStepSlots } from '@/components/workflows/editor/workflowDocumentPresentation';
import { WorkflowLifecycleStatus } from '@/components/workflows/presentation/WorkflowLifecycleStatus';
import { formatWorkflowInvocationElapsedLabel } from '@/components/workflows/presentation/workflowUsagePresentation';
import {
    WORKFLOW_ATTENTION_LIFECYCLES,
    describeWorkflowInvocationAttempt,
    workflowLifecycleAwaitsDecision,
    type WorkflowInvocationLifecycleContext,
} from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { isTerminalWorkflowInvocationLifecycle } from '@/components/work/status/resolveWorkStatusTone';
import { Text } from '@/components/ui/text/Text';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { buildWorkflowEditorDraftFromDefinition, validateWorkflowEditorDraft } from '@/sync/domains/workflows/workflowAuthoring';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { resolveWorkflowFlowScopedNodeId, listWorkflowFlowNotTakenNodeIds, type WorkflowFlowProjection, type WorkflowFlowNodeRunState } from '@/components/workflows/flow/workflowFlowProjection';
import { readWorkflowActionFieldRequests } from '@/components/workflows/presentation/workflowActionFieldRequests';
import { useActionFieldOptionsForMachine } from '@/components/sessions/actions/useSessionActionFieldOptions';

import type { WorkflowInvocationStructureEntry } from './workflowInvocationStructure';
import { readWorkflowLoopOccurrenceItem } from './workflowInvocationStructure';
import { workflowRunStyles as styles } from './workflowRunStyles';

type StepOccurrenceFact = Readonly<{
    invocation: WorkflowRunInvocationIndexV1;
    progress: WorkflowProgressEnvelopeV1 | undefined;
    label: string | null;
}>;

type StepPresentation = Readonly<{
    context: object;
    facts: readonly StepOccurrenceFact[];
    selectedInvocationId: string | null;
    notTaken: boolean;
    slots: WorkflowDocumentStepSlots;
}>;

const NO_OCCURRENCE_FACTS: readonly StepOccurrenceFact[] = [];
const NO_INVOCATIONS: readonly WorkflowRunInvocationIndexV1[] = [];
const ignoreDocumentEdit = () => {};

function WorkflowRunOccurrenceSelector(props: Readonly<{
    invocationStatusContext?: WorkflowInvocationLifecycleContext;
    invocations: readonly WorkflowRunInvocationIndexV1[];
    selectedInvocationId: string | null;
    onSelectInvocation: (id: string) => void;
    label: (invocation: WorkflowRunInvocationIndexV1) => string;
    blockKind: string | null;
    progressById?: ReadonlyMap<string, WorkflowProgressEnvelopeV1>;
    testIDPrefix: string;
}>): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    const items = props.invocations.map((invocation) => {
        const elapsed = formatWorkflowInvocationElapsedLabel(props.progressById?.get(invocation.id)?.timing);
        return {
            id: invocation.id,
            testID: `${props.testIDPrefix}-occurrence-${invocation.id}`,
            title: props.label(invocation),
            checked: invocation.id === props.selectedInvocationId,
            rightElement: <>{elapsed === null ? null : <Text style={styles.provenance}>{elapsed}</Text>}
                <WorkflowLifecycleStatus lifecycle={invocation.lifecycle} blockKind={props.blockKind} context={props.invocationStatusContext} chrome="plain" /></>,
        };
    });
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
    invocationStatusContext?: WorkflowInvocationLifecycleContext;
    runId: string;
    /** The Run owner's settled label for a leaf absent from complete history. */
    notStartedLabel?: string;
    machineId: string;
    serverId?: string | null;
    definition: WorkflowDefinitionV1;
    flowProjection?: WorkflowFlowProjection;
    flowRunStates?: ReadonlyMap<string, readonly WorkflowFlowNodeRunState[]>;
    frozenChildren?: Readonly<Record<string, WorkflowDefinitionV1>>;
    materializedLeaves?: readonly WorkflowMaterializedLeafV1[];
    inputs?: Readonly<Record<string, JsonValue>>;
    sessionDisplayLabelsById?: ReadonlyMap<string, string>;
    /** Accepted definition identity, distinct from this call site's occurrence path. */
    sourceKey?: string;
    workflowPath?: readonly string[];
    invocations: readonly WorkflowRunInvocationIndexV1[];
    progressById?: ReadonlyMap<string, WorkflowProgressEnvelopeV1>;
    structure: ReadonlyMap<string, WorkflowInvocationStructureEntry>;
    selectedInvocationId: string | null;
    onSelectInvocation: (invocationId: string) => void;
    occurrenceLabel: (entry: WorkflowInvocationStructureEntry) => string | null;
    testIDPrefix: string;
}>): React.ReactElement {
    const workflowPath = props.workflowPath ?? [];
    const scopeKey = resolveWorkflowFlowScopedNodeId('$root', workflowPath);
    const sourceKey = props.sourceKey ?? '$root';
    const presentEngine = useRoleEnginePresentation(props.serverId);
    const draft = React.useMemo(() => buildWorkflowEditorDraftFromDefinition({
        draftId: `run:${props.runId}:${scopeKey}`, name: '', definition: props.definition,
    }), [props.definition, props.runId, scopeKey]);
    const actionFieldRequests = React.useMemo(() => readWorkflowActionFieldRequests(draft), [draft]);
    const resolveActionFieldOptions = useActionFieldOptionsForMachine({ machineId: props.machineId,
        serverId: props.serverId ?? null, enabled: actionFieldRequests.hasActionBlocks, requests: actionFieldRequests.requests });
    const notTaken = React.useMemo(() => props.flowProjection === undefined ? undefined
        : listWorkflowFlowNotTakenNodeIds(props.flowProjection, props.flowRunStates), [props.flowProjection, props.flowRunStates]);
    const acceptedByBlockId = React.useMemo(() => new Map(props.materializedLeaves
        ?.filter(leaf => leaf.sourceKey === sourceKey).map(leaf => [leaf.blockId, leaf])), [props.materializedLeaves, sourceKey]);
    const blocksById = React.useMemo(() => new Map(walkWorkflowBlocks(draft.blocks).map((block) => [block.id, block])), [draft.blocks]);
    const blockIds = React.useMemo(() => [...blocksById.keys()], [blocksById]);
    const custody = useWorkflowAuthoringComposerCustody({ draftId: draft.draftId, blockIds });
    const validation = React.useMemo(() => validateWorkflowEditorDraft(draft), [draft]);
    const preferredLanguage = usePreferredLanguage();
    const selectInvocation = useEventCallback(props.onSelectInvocation);
    // A container consumes its descendants' live slots; a sibling does not.
    const ancestorsByBlock = React.useMemo(() => {
        const result = new Map<string, string[]>();
        for (const block of blocksById.values()) {
            for (const descendant of walkWorkflowBlocks([block])) {
                const ancestors = result.get(descendant.id) ?? [];
                ancestors.push(block.id);
                result.set(descendant.id, ancestors);
            }
        }
        return result;
    }, [blocksById]);
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
    }, [props.invocations, props.structure, scopeKey]);
    const selectedEntry = props.selectedInvocationId === null ? undefined : props.structure.get(props.selectedInvocationId);
    const selectedBlockId = selectedEntry?.blockId && selectedEntry.nodeId === resolveWorkflowFlowScopedNodeId(selectedEntry.blockId, workflowPath)
        ? selectedEntry.blockId : null;
    const presentationContext = React.useMemo(() => ({}), [draft, acceptedByBlockId, props.frozenChildren,
        props.inputs, props.sessionDisplayLabelsById, presentEngine, props.invocationStatusContext,
        props.runId, props.machineId, props.serverId, props.testIDPrefix, props.notStartedLabel, sourceKey, preferredLanguage]);
    const previousPresentations = React.useRef(new Map<string, StepPresentation>());
    const factsByBlock = new Map<string, StepOccurrenceFact[]>();
    for (const invocation of props.invocations) {
        const entry = props.structure.get(invocation.id);
        if (entry === undefined) continue;
        const path = entry.occurrence.filter(coordinate => coordinate.kind === 'workflow');
        if (!workflowPath.every((id, index) => path[index]?.blockId === id)) continue;
        const localBlockId = path.length > workflowPath.length ? path[workflowPath.length]?.blockId : entry.blockId;
        if (localBlockId == null) continue;
        const fact = { invocation, progress: props.progressById?.get(invocation.id), label: props.occurrenceLabel(entry) };
        for (const ancestor of ancestorsByBlock.get(localBlockId) ?? []) {
            const facts = factsByBlock.get(ancestor) ?? [];
            facts.push(fact);
            factsByBlock.set(ancestor, facts);
        }
    }
    const nextPresentations = new Map<string, StepPresentation>();
    const renderStep = (blockId: string): WorkflowDocumentStepSlots => {
            const facts = factsByBlock.get(blockId) ?? NO_OCCURRENCE_FACTS;
            const selectedInvocationId = facts.some(fact => fact.invocation.id === props.selectedInvocationId) ? props.selectedInvocationId : null;
            const blockNotTaken = notTaken?.has(resolveWorkflowFlowScopedNodeId(blockId, workflowPath)) === true;
            const previous = previousPresentations.current.get(blockId);
            if (previous?.context === presentationContext && previous.selectedInvocationId === selectedInvocationId
                && previous.notTaken === blockNotTaken
                && previous.facts.length === facts.length && facts.every((fact, index) => {
                    const before = previous.facts[index]!;
                    return before.invocation === fact.invocation && before.progress === fact.progress && before.label === fact.label;
                })) {
                nextPresentations.set(blockId, previous);
                return previous.slots;
            }
            const occurrences = byBlock.get(blockId) ?? NO_INVOCATIONS;
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
            const displayedOccurrence = selected ?? only;
            const leaf = block?.kind === 'step' ? acceptedByBlockId.get(blockId) : undefined;
            const progress = displayedOccurrence == null ? undefined : props.progressById?.get(displayedOccurrence.id);
            const execution = progress?.execution;
            const sessionId = execution?.kind === 'session' || execution?.kind === 'session_ready' ? execution.sessionId : null;
            const participantChoices = leaf?.participantBindings?.selections;
            let exactSelection: WorkflowMaterializedLeafV1 | undefined;
            if (leaf && progress) {
                // Scope coordinates select the frozen item, not a roster position: admission
                // deduplicates choices, and the same participant may occur several times.
                let item: JsonValue | undefined;
                const scope = progress.invocationPath.scope;
                let localStart = scope.length;
                while (localStart > 0 && scope[localStart - 1]?.kind !== 'workflow') localStart -= 1;
                const localScope = scope.slice(localStart);
                for (const coordinate of localScope) {
                    if (coordinate.kind !== 'iteration') continue;
                    const owner = blocksById.get(coordinate.blockId);
                    if (owner?.kind !== 'loop' || owner.repetition.kind !== 'items') continue;
                    item = readWorkflowLoopOccurrenceItem({ loop: owner, index: coordinate.index, inputs: props.inputs, outerItem: item });
                }
                try { exactSelection = resolveWorkflowAcceptedStepSelectionV1(leaf, item, props.inputs); }
                catch (error) { if (!(error instanceof WorkflowStepSelectionErrorV1)) throw error; }
            }
            const choices: readonly Pick<WorkflowMaterializedLeafV1, 'selection' | 'participant' | 'role'>[] = exactSelection
                ? [exactSelection] : progress && (leaf?.participantBindings || leaf?.engineBindings || leaf?.sessionBindings)
                    ? [] : participantChoices ?? leaf?.engineBindings?.selections ?? (leaf ? [leaf] : []);
            const identities = choices.map(choice => {
                const target = choice.selection.agentTarget;
                const engine = target == null ? null : presentEngine({ agentTargetKey: resolveBackendTargetKeyV2(target),
                    ...(choice.selection.modelSelection ? { modelId: choice.selection.modelSelection.ref.modelId } : {}) });
                const participant = choice.participant;
                const participantSessionLabel = participant?.kind === 'session'
                    ? (participant.session.serverId === props.serverId ? props.sessionDisplayLabelsById?.get(participant.session.sessionId) : undefined)
                        ?? t('session.collaboration.discussion.participants.session') : null;
                // A continued Session need not carry an Agent selection or a participant binding.
                // Its exact execution correspondence can still name the conversation that ran.
                const sessionLabel = participantSessionLabel ?? (choice.role === undefined && target == null && sessionId !== null
                    ? props.sessionDisplayLabelsById?.get(sessionId) : null);
                const name = sessionLabel ?? choice.role?.name ?? engine?.label ?? t('workflows.input.unavailable');
                return { selection: choice.selection, name,
                    label: sessionLabel ?? ([choice.role?.name, engine?.label].filter(Boolean).join(' · ') || name) };
            });
            const enginePresentation = leaf === undefined ? undefined : {
                agentType: identities.length === 1 ? resolveSessionAuthoringAgentId({ agentTarget: identities[0]!.selection.agentTarget }) ?? undefined : undefined,
                agentLabel: [...new Set(identities.map(identity => identity.name))].join(', ') || t('workflows.input.unavailable'),
                engineLabel: [...new Set(identities.map(identity => identity.label))].join(', ') || t('workflows.input.unavailable'),
                modelMode: identities.length === 1 ? identities[0]!.selection.modelSelection?.ref.modelId : undefined,
            };
            const elapsed = formatWorkflowInvocationElapsedLabel(displayedOccurrence === null
                ? undefined : props.progressById?.get(displayedOccurrence.id)?.timing);
            // The single occurrence opens from the step's footer, worded for what it opens (lab
            // run-A_steps "Open conversation", "Review"), instead of a bare "Attempt 1" line.
            const onlyNeedsYou = only !== null && WORKFLOW_ATTENTION_LIFECYCLES.includes(only.lifecycle);
            const openWork = only === null ? null : <HappierPressable
                testID={`${props.testIDPrefix}-occurrence-${only.id}`}
                accessibilityRole="button"
                selected={only.id === props.selectedInvocationId}
                current={only.id === props.selectedInvocationId ? 'page' : undefined}
                onPress={() => selectInvocation(only.id)}
                style={({ pressed }) => [styles.actionTarget, pressed ? styles.pressed : null]}
            >
                <Text style={onlyNeedsYou ? styles.action : styles.quietAction}>{[
                    onlyEntry === undefined ? null : props.occurrenceLabel(onlyEntry),
                    onlyAttempt?.retried === true ? onlyAttempt.label : null,
                    describeWorkflowOpenWorkLabel({ lifecycle: only.lifecycle, blockKind: block?.kind ?? null, selected: only.id === props.selectedInvocationId }),
                ].filter(Boolean).join(' · ')}</Text>
            </HappierPressable>;
            const slots: WorkflowDocumentStepSlots = {
                ...(enginePresentation === undefined ? {} : { enginePresentation }),
                ...(block?.kind === 'workflow' ? { nestedDefinition: child ?? null } : {}),
                settled: displayedOccurrence !== null && isTerminalWorkflowInvocationLifecycle(displayedOccurrence.lifecycle),
                state: displayedOccurrence === null
                    ? blockNotTaken
                        ? <Text style={styles.provenance}>{t('workflows.map.notTaken')}</Text>
                        : props.notStartedLabel === undefined ? null : <Text style={styles.provenance}>{props.notStartedLabel}</Text>
                    : <>
                    {elapsed === null ? null : <Text style={styles.provenance}>{elapsed}</Text>}
                    <WorkflowLifecycleStatus lifecycle={displayedOccurrence.lifecycle} blockKind={block?.kind ?? null} context={props.invocationStatusContext}
                        markerOnly={workflowLifecycleAwaitsDecision(displayedOccurrence.lifecycle)} />
                </>,
                occurrenceSelector: occurrences.length > 1 ? <WorkflowRunOccurrenceSelector
                    invocations={occurrences} selectedInvocationId={props.selectedInvocationId}
                    onSelectInvocation={selectInvocation} label={label} blockKind={block?.kind ?? null} testIDPrefix={`${props.testIDPrefix}-${blockId}`}
                    progressById={props.progressById}
                    invocationStatusContext={props.invocationStatusContext}
                /> : null,
                footer: child === undefined ? openWork : <>
                    {openWork}
                    <WorkflowRunSteps
                        {...props} definition={child} sourceKey={block?.kind === 'workflow' ? block.workflowRef : sourceKey} workflowPath={[...workflowPath, blockId]}
                        inputs={progress?.container?.kind === 'body' ? progress.container.frameInputs : undefined}
                        testIDPrefix={`${props.testIDPrefix}-${blockId}`} />
                </>,
            };
            nextPresentations.set(blockId, { context: presentationContext, facts, selectedInvocationId, notTaken: blockNotTaken, slots });
            return slots;
    };
    for (const blockId of blockIds) renderStep(blockId);
    previousPresentations.current = nextPresentations;
    const presentation: WorkflowDocumentPresentation = {
        editable: false,
        note: workflowPath.length === 0 ? <Text style={styles.sectionLabel}>{t('workflows.run.frozenVersion')}</Text> : null,
        step: blockId => nextPresentations.get(blockId)?.slots ?? null,
    };
    const selectBlock = React.useCallback((blockId: string | null) => {
        const occurrences = blockId === null ? NO_INVOCATIONS : byBlock.get(blockId) ?? NO_INVOCATIONS;
        if (occurrences.length === 1) selectInvocation(occurrences[0]!.id);
    }, [byBlock, selectInvocation]);
    return <WorkflowBlockListEditor
        draft={draft} list={{ kind: 'root' }} blocks={draft.blocks} depth={0}
        selectedBlockId={selectedBlockId} validation={validation}
        composerScope={{ kind: 'machine', machineId: props.machineId, ...(props.serverId ? { serverId: props.serverId } : {}) }}
        composerCustody={custody}
        onChange={ignoreDocumentEdit} onCustomize={ignoreDocumentEdit}
        onSelect={selectBlock}
        presentation={presentation} testIDPrefix={props.testIDPrefix}
        resolveActionFieldOptions={resolveActionFieldOptions}
    />;
}
