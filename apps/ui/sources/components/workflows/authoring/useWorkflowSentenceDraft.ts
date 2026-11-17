import * as React from 'react';
import { randomUUID } from 'expo-crypto';
import { WorkflowDefinitionV1Schema, type WorkflowActionFieldBindingV1, type WorkflowActionLeafV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowDraftMutationResultV1 } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { buildWorkflowEditorDraftFromDefinition, validateWorkflowEditorDraft } from '@/sync/domains/workflows/workflowAuthoring';
import { createWorkflowEditorDraft, type WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { t } from '@/text';
import { formatWorkflowProblemMessage } from '../presentation/workflowProblemPresentation';
import { useWorkflowEditorAccountMemory } from '../screens/useWorkflowEditorAccountMemory';
import { createWorkflowEditorReadable, type WorkflowEditorDraftStore } from '../editor/workflowEditorDraftStore';
import { useWorkflowEditorHistory, workflowEditorSnapshotsEqual, type WorkflowEditorHistoryControls } from '../editor/useWorkflowEditorHistory';
import { saveWorkflowEditorDefinition, type PendingWorkflowDefinitionCreate, type WorkflowEditorSavedRevision } from '../editor/saveWorkflowEditorDefinition';
import { useWorkflowTriggerEditing, type WorkflowTriggerEditing } from '../triggers/useWorkflowTriggerEditing';
import { editWorkflowTriggerDraft, EMPTY_WORKFLOW_TRIGGER_DRAFT, type WorkflowTriggerSnapshot } from '../triggers/workflowTriggerDraft';
import { prepareWorkflowSentenceEditorEntry, type WorkflowSentenceEditorIntent } from './workflowSentenceAuthoring';

export type WorkflowSentenceDraft = Readonly<{
    draftStore: WorkflowEditorDraftStore;
    onChange: (draft: WorkflowEditorDraft, label?: string) => void;
    readonly step: WorkflowActionLeafV1 | null;
    readonly operands: WorkflowActionLeafV1['input'];
    changeStep: (step: WorkflowActionLeafV1) => void;
    changeOperand: (name: string, binding: WorkflowActionFieldBindingV1) => void;
    /** Where it runs (the sentence's Machine and folder): the trigger set's one place and the saved workflow's target. */
    project: WorkflowProjectTargetV1 | null;
    changeProject: (project: WorkflowProjectTargetV1) => void;
    triggers: WorkflowTriggerEditing;
    history: WorkflowEditorHistoryControls;
    save: () => Promise<WorkflowDraftMutationResultV1>;
    saving: boolean;
    failed: string | null;
    saved: WorkflowEditorSavedRevision | null;
    openInEditor: () => ReturnType<typeof prepareWorkflowSentenceEditorEntry>;
}>;

/** One mounted intent: dismiss/remount for another source; rerenders never replace authored operands. */
export function useWorkflowSentenceDraft(intent: WorkflowSentenceEditorIntent,
    accountLifetime?: ServerAccountScopeLifetime | null): WorkflowSentenceDraft {
    const [source] = React.useState(() => {
        const draftId = randomUUID();
        const definition = intent.step === undefined ? intent.definition
            : WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [intent.step] });
        const draft = definition === undefined ? createWorkflowEditorDraft({ draftId, name: intent.name, blocks: [] })
            : buildWorkflowEditorDraftFromDefinition({ draftId, name: intent.name, definition });
        return { intent, lifetime: accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : accountLifetime,
            store: createWorkflowEditorReadable(draft),
            incomplete: intent.eventSeed === undefined ? undefined : { pending: [{ clientId: randomUUID(),
                when: { kind: 'pluginEvent' as const, value: null, eventRef: intent.eventSeed.eventRef }, eventSeed: intent.eventSeed }], edits: {} } };
    });
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const [project, setProject] = React.useState<WorkflowProjectTargetV1 | null>(intent.project ?? null);
    const projectRef = React.useRef(project);
    projectRef.current = project;
    const [saved, setSaved] = React.useState<WorkflowEditorSavedRevision | null>(null);
    const savedRef = React.useRef(saved);
    const baseline = React.useRef<{ draft: WorkflowEditorDraft | null; description: string }>({ draft: null, description: '' });
    const pendingCreate = React.useRef<PendingWorkflowDefinitionCreate | null>(null);
    const savingRef = React.useRef(false);
    const [saving, setSaving] = React.useState(false);
    const [failed, setFailed] = React.useState<string | null>(null);
    const accountMemory = useWorkflowEditorAccountMemory(source.lifetime, { workspaceRefs: false });
    const triggers = useWorkflowTriggerEditing({ definitionId: saved?.definitionId ?? null,
        sourceKey: source.store.get().draftId, projectTarget: project,
        accountLifetime: source.lifetime, ...(source.incomplete === undefined ? {} : { initialIncomplete: source.incomplete }) });
    React.useEffect(() => {
        if (source.intent.trigger === undefined) return;
        triggers.setDraft(editWorkflowTriggerDraft(EMPTY_WORKFLOW_TRIGGER_DRAFT, { kind: 'add', clientId: randomUUID(),
            trigger: source.intent.trigger, ...(source.intent.payloadSchema === undefined ? {} : { payloadSchema: source.intent.payloadSchema }) }));
    }, [source, triggers.setDraft]);
    const history = useWorkflowEditorHistory<{ draft: WorkflowEditorDraft; triggers: WorkflowTriggerSnapshot }>(source.store.get().draftId, snapshot => {
        triggers.restoreSnapshot(snapshot.triggers);
        source.store.set(snapshot.draft);
    });
    const onChange = React.useCallback((draft: WorkflowEditorDraft, label = t('workflows.editor.history.edited')) => {
        const snapshot = { draft: source.store.get(), triggers: triggers.captureSnapshot() };
        if (history.record(snapshot, { ...snapshot, draft }, label)) source.store.set(draft);
    }, [history.record, source, triggers.captureSnapshot]);
    const readStep = () => { const block = source.store.get().blocks[0]; return block?.kind === 'action' ? block : null; };
    const changeStep = (step: WorkflowActionLeafV1) => {
        const current = source.store.get();
        onChange({ ...current, blocks: [step, ...current.blocks.slice(1)] });
    };
    const changeOperand = (name: string, binding: WorkflowActionFieldBindingV1) => {
        const step = readStep();
        if (step !== null) changeStep({ ...step, input: { ...step.input, [name]: binding } });
    };
    const save = async (): Promise<WorkflowDraftMutationResultV1> => {
        const lifetime = source.lifetime;
        const isCurrent = () => mounted.current && lifetime?.isCurrent() === true;
        if (!isCurrent() || lifetime === null) return { status: 'unavailable' };
        if (savingRef.current) return { status: 'refused', reason: 'save_pending' };
        const draft = source.store.get();
        const description = source.intent.description ?? '';
        const changed = savedRef.current === null || !workflowEditorSnapshotsEqual(draft, baseline.current.draft)
            || description !== baseline.current.description;
        if (!changed && !triggers.dirty) return { status: 'unchanged' };
        const validation = validateWorkflowEditorDraft(draft, { triggerEvents: triggers.triggerEvents });
        if (!validation.valid || validation.normalizedDefinition === undefined) return { status: 'refused', reason: 'invalid_workflow' };
        history.commit();
        savingRef.current = true;
        setSaving(true);
        setFailed(null);
        try {
            if (changed) {
                const persisted = await saveWorkflowEditorDefinition({ draft, description, definition: validation.normalizedDefinition,
                    ...(triggers.intendedTriggers === undefined ? {} : { intendedTriggers: triggers.intendedTriggers }),
                    saved: savedRef.current, baseline: baseline.current, pendingCreate: pendingCreate.current,
                    retainCreate: (pending) => { pendingCreate.current = pending; }, accountLifetime: lifetime, isCurrent,
                    acknowledge: (result, acceptedDraft, acceptedDescription) => {
                        savedRef.current = { definitionId: result.definitionId, revision: result.revision };
                        baseline.current = { draft: acceptedDraft, description: acceptedDescription };
                        setSaved(savedRef.current);
                    } });
                if (persisted === null) return { status: 'refused', reason: 'draft_retired' };
            }
            const persisted = savedRef.current;
            if (persisted === null || !isCurrent()) return { status: 'refused', reason: 'draft_retired' };
            const savedProject = projectRef.current;
            if (savedProject !== null) accountMemory.remember({
                workflowProjectTargetsByDefinitionId: { [persisted.definitionId]: savedProject },
            });
            const outcome = await triggers.save(persisted.definitionId, isCurrent);
            if (!isCurrent()) return { status: 'refused', reason: 'draft_retired' };
            if (outcome === 'failed') { setFailed(t('workflows.triggers.editor.partialSave')); return { status: 'refused', reason: 'trigger_save_failed' }; }
            return { status: 'applied' };
        } catch (error) {
            if (!isCurrent()) return { status: 'refused', reason: 'draft_retired' };
            setFailed(`${formatWorkflowProblemMessage(error)} ${t('workflows.save.failedBody')}`);
            return { status: 'refused', reason: error instanceof WorkflowActionError ? error.code ?? 'save_failed' : 'save_failed' };
        } finally {
            savingRef.current = false;
            if (isCurrent()) setSaving(false);
        }
    };
    return { draftStore: source.store, onChange, get step() { return readStep(); }, get operands() { return readStep()?.input ?? {}; },
        changeStep, changeOperand, project, changeProject: setProject, triggers: { ...triggers, setDraft: next => {
            const before = { draft: source.store.get(), triggers: triggers.captureSnapshot() };
            const after = { ...before, triggers: triggers.captureSnapshot(next) };
            if (history.record(before, after, t('workflows.editor.history.edited'))) triggers.setDraft(next);
        } }, history: history.controls, save, saving, failed, saved,
        openInEditor: () => {
            if (source.lifetime === null) return null;
            const { step: _step, definition: _definition, trigger: _trigger, eventSeed: _eventSeed, payloadSchema: _payloadSchema, ...seed } = source.intent;
            return prepareWorkflowSentenceEditorEntry({ ...seed, ...(projectRef.current === null ? {} : { project: projectRef.current }),
                name: source.store.get().name }, source.lifetime, { draft: source.store.get(),
                triggers: triggers.captureSnapshot(), incompleteTriggers: triggers.incomplete });
        } };
}
