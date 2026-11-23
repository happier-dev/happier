import { WORKFLOW_AUTHORING_ACTION_ID } from '@happier-dev/protocol/actions/workflowAuthoringActionIds';
import * as React from 'react';
import { randomUUID } from '@/platform/randomUUID';
import { WorkflowDefinitionV1Schema, type WorkflowActionFieldBindingV1, type WorkflowActionLeafV1 } from '@happier-dev/protocol/workflows/workflowV1';
import { WorkflowDraftEditInputV1Schema, WorkflowMountedDraftV1Schema, type WorkflowDraftMutationResultV1 } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import { applyWorkflowDefinitionEditsV1, walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { buildWorkflowDefinitionCandidate, buildWorkflowEditorDraftFromDefinition, validateWorkflowEditorDraft } from '@/sync/domains/workflows/workflowAuthoring';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { callWorkflowAction, type WorkflowActionCallerContext, type WorkflowActionOperation } from '@/sync/domains/workflows/callWorkflowAction';
import type { WorkflowMountedDraftActions } from '@/sync/ops/actions/workflowAuthoringAction';
import { createWorkflowEditorDraft, type WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { t } from '@/text';
import { formatWorkflowProblemMessage } from '../presentation/workflowProblemPresentation';
import { formatWorkflowSummaryLine } from '../presentation/workflowSummaryLine';
import { useWorkflowEditorAccountMemory } from '../screens/useWorkflowEditorAccountMemory';
import { createWorkflowEditorReadable, type WorkflowEditorDraftStore } from '../editor/workflowEditorDraftStore';
import { useWorkflowEditorHistory, workflowEditorSnapshotsEqual, type WorkflowEditorHistoryControls } from '../editor/useWorkflowEditorHistory';
import { parseMountedWorkflowDraftMutation, saveMountedWorkflowDraft, saveWorkflowEditorDefinition, type PendingWorkflowDefinitionCreate, type WorkflowEditorSavedRevision } from '../editor/saveWorkflowEditorDefinition';
import { useWorkflowTriggerEditing, type WorkflowTriggerEditing } from '../triggers/useWorkflowTriggerEditing';
import { editWorkflowTriggerDraft, EMPTY_WORKFLOW_TRIGGER_DRAFT, WorkflowTriggerSnapshotRestoreError, type WorkflowTriggerSnapshot } from '../triggers/workflowTriggerDraft';
import { createWorkflowTriggerIncompleteSeed } from '../triggers/workflowTriggerStarts';
import { formatTriggerSetSentence, type TriggerSummaryContext, type TriggerSummarySource } from '../triggers/formatTriggerSummary';
import { prepareWorkflowSentenceEditorEntry, type WorkflowSentenceEditorIntent } from './workflowSentenceAuthoring';

export type WorkflowSentenceDraft = Readonly<{
    startContext: WorkflowSentenceEditorIntent['startContext'];
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
    save: (caller?: WorkflowActionCallerContext) => Promise<WorkflowDraftMutationResultV1>;
    saveFromUi: () => Promise<void>;
    discardFromUi: () => Promise<void>;
    draftActions: WorkflowMountedDraftActions;
    saving: boolean;
    failed: string | null;
    saved: WorkflowEditorSavedRevision | null;
    openInEditor: () => ReturnType<typeof prepareWorkflowSentenceEditorEntry>;
}>;

type SentenceSettings = Readonly<{ description: string; executionTarget: 'session' | 'detached_run' }>;
type SentenceSnapshot = SentenceSettings & Readonly<{
    draft: WorkflowEditorDraft; projectTarget: WorkflowProjectTargetV1 | null;
    triggers: WorkflowTriggerSnapshot; nameEdited: boolean;
}>;

function withSentenceName(draft: WorkflowEditorDraft, triggers: readonly TriggerSummarySource[], context?: TriggerSummaryContext): WorkflowEditorDraft {
    const name = formatWorkflowSummaryLine(draft, {
        trigger: triggers.length === 0 ? null : formatTriggerSetSentence(triggers, { ...context, form: 'clause' }),
    });
    return name === null || name === draft.name ? draft : { ...draft, name };
}

/** One mounted intent: dismiss/remount for another source; rerenders never replace authored operands. */
export function useWorkflowSentenceDraft(intent: WorkflowSentenceEditorIntent,
    accountLifetime?: ServerAccountScopeLifetime | null, onRequestClose?: () => void): WorkflowSentenceDraft {
    const [source] = React.useState(() => {
        const draftId = randomUUID();
        const lifetime = accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : accountLifetime;
        const definition = intent.step === undefined ? intent.definition
            : WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [intent.step] });
        const draft = definition === undefined ? createWorkflowEditorDraft({ draftId, name: intent.name, blocks: [] })
            : buildWorkflowEditorDraftFromDefinition({ draftId, name: intent.name, definition });
        return { intent, lifetime,
            store: createWorkflowEditorReadable(withSentenceName(draft, intent.trigger === undefined ? [] : [intent.trigger],
                { machineId: intent.project?.machineId, serverId: lifetime?.scope.serverId })),
            incomplete: createWorkflowTriggerIncompleteSeed(intent) };
    });
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const [project, setProject] = React.useState<WorkflowProjectTargetV1 | null>(intent.project ?? null);
    const projectRef = React.useRef(project);
    projectRef.current = project;
    const [settings, setSettings] = React.useState<SentenceSettings>({ description: intent.description ?? '', executionTarget: intent.executionTarget ?? 'session' });
    const settingsRef = React.useRef(settings);
    settingsRef.current = settings;
    const [saved, setSaved] = React.useState<WorkflowEditorSavedRevision | null>(null);
    const savedRef = React.useRef(saved);
    const baseline = React.useRef<{ draft: WorkflowEditorDraft | null; description: string }>({ draft: null, description: '' });
    const pendingCreate = React.useRef<PendingWorkflowDefinitionCreate | null>(null);
    const savingRef = React.useRef(false);
    const [saving, setSaving] = React.useState(false);
    const [failed, setFailed] = React.useState<string | null>(null);
    const accountMemory = useWorkflowEditorAccountMemory(source.lifetime, { workspaceRefs: false });
    // Draft-local authorship belongs in Undo/Redo, never in the saved workflow's schema.
    const nameEdited = React.useRef(false);
    const triggers = useWorkflowTriggerEditing({ definitionId: saved?.definitionId ?? null,
        sourceKey: source.store.get().draftId, projectTarget: project,
        ...(source.intent.lifetimeSession === undefined ? {} : { lifetimeSession: source.intent.lifetimeSession }),
        ...(source.intent.startContext?.session === undefined ? {} : { sessionIntake: source.intent.startContext.session }),
        accountLifetime: source.lifetime, ...(source.incomplete === undefined ? {} : { initialIncomplete: source.incomplete }) });
    React.useEffect(() => {
        if (source.intent.trigger === undefined) return;
        triggers.setDraft(editWorkflowTriggerDraft(EMPTY_WORKFLOW_TRIGGER_DRAFT, { kind: 'add', clientId: randomUUID(),
            trigger: source.intent.trigger, ...(source.intent.payloadSchema === undefined ? {} : { payloadSchema: source.intent.payloadSchema }) }));
    }, [source, triggers.setDraft]);
    const applySnapshot = (snapshot: SentenceSnapshot) => {
        nameEdited.current = snapshot.nameEdited;
        projectRef.current = snapshot.projectTarget;
        setProject(snapshot.projectTarget);
        settingsRef.current = { description: snapshot.description, executionTarget: snapshot.executionTarget };
        setSettings(settingsRef.current);
        source.store.set(snapshot.draft);
    };
    const history = useWorkflowEditorHistory<SentenceSnapshot>(source.store.get().draftId, snapshot => {
        triggers.restoreSnapshot(snapshot.triggers);
        applySnapshot(snapshot);
    });
    const readSnapshot = (): SentenceSnapshot => ({ ...settingsRef.current, projectTarget: projectRef.current,
        draft: source.store.get(), triggers: triggers.captureSnapshot(), nameEdited: nameEdited.current });
    const nameForTriggers = React.useCallback((draft: WorkflowEditorDraft, snapshot: WorkflowTriggerSnapshot) => withSentenceName(draft,
        snapshot.rows.flatMap(row => row.trigger === null ? [] : [row.trigger]),
        { machineId: projectRef.current?.machineId, serverId: source.lifetime?.scope.serverId }), [source]);
    const onChange = React.useCallback((draft: WorkflowEditorDraft, label = t('workflows.editor.history.edited')) => {
        const snapshot = readSnapshot();
        const edited = snapshot.nameEdited || draft.name !== snapshot.draft.name;
        const next = edited ? draft : nameForTriggers(draft, snapshot.triggers);
        if (history.record(snapshot, { ...snapshot, draft: next, nameEdited: edited }, label)) {
            nameEdited.current = edited;
            source.store.set(next);
        }
    }, [history.record, source, triggers.captureSnapshot, nameForTriggers]);
    const readStep = () => { const block = source.store.get().blocks[0]; return block?.kind === 'action' ? block : null; };
    const changeStep = (step: WorkflowActionLeafV1) => {
        const current = source.store.get();
        onChange({ ...current, blocks: [step, ...current.blocks.slice(1)] });
    };
    const changeOperand = (name: string, binding: WorkflowActionFieldBindingV1) => {
        const step = readStep();
        if (step !== null) changeStep({ ...step, input: { ...step.input, [name]: binding } });
    };
    const save = async (caller?: WorkflowActionCallerContext, operation?: WorkflowActionOperation): Promise<WorkflowDraftMutationResultV1> => {
        const lifetime = source.lifetime;
        const isCurrent = () => mounted.current && lifetime?.isCurrent() === true;
        if (!isCurrent() || lifetime === null) return { status: 'unavailable' };
        if (savingRef.current) return { status: 'refused', reason: 'save_pending' };
        if (!triggers.complete) return { status: 'refused', reason: 'invalid_workflow' };
        const draft = source.store.get();
        const description = settingsRef.current.description;
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
                    retainCreate: (pending) => { pendingCreate.current = pending; }, accountLifetime: lifetime, caller, operation, isCurrent,
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
            const outcome = await triggers.save(persisted.definitionId, isCurrent, caller, operation);
            if (!isCurrent()) return { status: 'refused', reason: 'draft_retired' };
            if (typeof outcome === 'object') { setFailed(outcome.message); return { status: 'refused', reason: outcome.code ?? 'trigger_save_failed' }; }
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
    const saveFromUi = async (): Promise<void> => {
        const lifetime = source.lifetime;
        if (!mounted.current || !lifetime?.isCurrent() || savingRef.current) return;
        setFailed(null);
        try {
            const outcome = await saveMountedWorkflowDraft(lifetime, source.store.get().draftId);
            if (mounted.current && lifetime.isCurrent() && 'status' in outcome && outcome.status === 'unavailable') {
                setFailed(t('workflows.save.failedBody'));
            }
        } catch (error) {
            if (mounted.current && lifetime.isCurrent()) setFailed(`${formatWorkflowProblemMessage(error)} ${t('workflows.save.failedBody')}`);
        }
    };
    const discardFromUi = async (): Promise<void> => {
        const lifetime = source.lifetime;
        if (!mounted.current) return;
        if (!lifetime?.isCurrent()) {
            onRequestClose?.();
            return;
        }
        setFailed(null);
        try {
            const outcome = await callWorkflowAction({ actionId: WORKFLOW_AUTHORING_ACTION_ID.draftDiscard, accountLifetime: lifetime,
                input: { scope: lifetime.scope, draftId: source.store.get().draftId }, parseResult: parseMountedWorkflowDraftMutation });
            if (!mounted.current || !lifetime.isCurrent() || !('status' in outcome)) return;
            const reason = outcome.status === 'refused' ? outcome.reason
                : outcome.status === 'unavailable' ? 'workflow_draft_unavailable' : null;
            if (reason && reason !== 'cancelled') setFailed(formatWorkflowProblemMessage(new WorkflowActionError({ message: reason, rawCode: reason })));
        } catch (error) {
            if (mounted.current && lifetime.isCurrent()) setFailed(formatWorkflowProblemMessage(error));
        }
    };
    const draftActions: WorkflowMountedDraftActions = {
        getSnapshot: () => {
            if (!mounted.current || !source.lifetime?.isCurrent()) return null;
            const current = readSnapshot();
            const validation = validateWorkflowEditorDraft(current.draft, { triggerEvents: triggers.triggerEvents });
            return WorkflowMountedDraftV1Schema.parse({ scope: source.lifetime.scope, draftId: current.draft.draftId,
                name: current.draft.name, definition: projectNativeJsonValueForTransport(buildWorkflowDefinitionCandidate(current.draft)),
                blockLabels: walkWorkflowBlocks(current.draft.blocks).map(block => ({ id: block.id, label: workflowBlockReferenceLabel(block) })),
                settings: { description: current.description, projectTarget: current.projectTarget, executionTarget: current.executionTarget,
                    triggers: projectNativeJsonValueForTransport(current.triggers) }, validationIssues: validation.issues,
                dirty: !workflowEditorSnapshotsEqual(current.draft, baseline.current.draft)
                    || current.description !== baseline.current.description || triggers.dirty, draftRevision: history.getRevision() });
        },
        execute: async (actionId, input, signal, caller) => {
            if (signal?.aborted) return { status: 'refused', reason: 'cancelled' };
            if (!mounted.current || !source.lifetime?.isCurrent()) return { status: 'unavailable' };
            if (actionId === WORKFLOW_AUTHORING_ACTION_ID.draftSave) {
                const outcome = await save(caller, { signal, operationProgress: caller?.operationProgress });
                if (outcome.status === 'applied' || outcome.status === 'unchanged') onRequestClose?.();
                return outcome;
            }
            if (actionId === WORKFLOW_AUTHORING_ACTION_ID.draftDiscard) {
                if (!onRequestClose) return { status: 'unavailable' };
                onRequestClose();
                return { status: 'applied' };
            }
            const revision = history.getRevision();
            if (actionId === WORKFLOW_AUTHORING_ACTION_ID.draftEdit) {
                const parsed = WorkflowDraftEditInputV1Schema.safeParse(input);
                if (!parsed.success || parsed.data.triggerEdit !== undefined) {
                    return { status: 'refused', reason: 'invalid_parameters' };
                }
                if (parsed.data.expectedDraftRevision !== revision) return { status: 'refused', reason: 'stale_draft_revision', draftRevision: revision };
                const before = readSnapshot();
                const result = applyWorkflowDefinitionEditsV1(before.draft, parsed.data.ops ?? []);
                if (!result.ok) return { status: 'refused', reason: result.issue.code, draftRevision: revision };
                const edited = before.nameEdited || result.draft.name !== before.draft.name;
                let nextTriggers = before.triggers;
                try {
                    if (parsed.data.settings?.triggers !== undefined) {
                        const restored = triggers.restoreSnapshot(parsed.data.settings.triggers);
                        if (restored === null) return { status: 'refused', reason: 'draft_retired', draftRevision: revision };
                        nextTriggers = restored;
                    }
                } catch (error) {
                    return { status: 'refused', reason: error instanceof WorkflowTriggerSnapshotRestoreError
                        ? error.code : 'invalid_trigger_snapshot', draftRevision: revision };
                }
                const after: SentenceSnapshot = { ...before, ...parsed.data.settings, triggers: nextTriggers,
                    draft: edited ? result.draft : nameForTriggers(result.draft, nextTriggers), nameEdited: edited };
                if (!history.record(before, after, t('workflows.editor.history.agent'))) return { status: 'unchanged', draftRevision: revision };
                applySnapshot(after);
                return { status: 'applied', draftRevision: history.getRevision(), changedBlockIds: [...result.changedBlockIds] };
            }
            try {
                if (actionId === WORKFLOW_AUTHORING_ACTION_ID.draftUndo) history.controls.undo();
                else if (actionId === WORKFLOW_AUTHORING_ACTION_ID.draftRedo) history.controls.redo();
                else return { status: 'unavailable' };
            } catch (error) {
                return { status: 'refused', reason: error instanceof WorkflowTriggerSnapshotRestoreError
                    ? error.code : 'history_restore_failed', draftRevision: history.getRevision() };
            }
            return { status: history.getRevision() === revision ? 'unchanged' : 'applied', draftRevision: history.getRevision() };
        },
    };
    return { startContext: source.intent.startContext, draftStore: source.store, onChange, get step() { return readStep(); }, get operands() { return readStep()?.input ?? {}; },
        changeStep, changeOperand, project, changeProject: next => {
            const before = readSnapshot();
            if (history.record(before, { ...before, projectTarget: next }, t('workflows.editor.history.edited'))) {
                projectRef.current = next;
                setProject(next);
            }
        }, triggers: { ...triggers, setDraft: next => {
            const before = readSnapshot();
            const snapshot = triggers.captureSnapshot(next);
            const after = { ...before, triggers: snapshot, draft: before.nameEdited ? before.draft : nameForTriggers(before.draft, snapshot) };
            if (history.record(before, after, t('workflows.editor.history.edited'))) {
                triggers.setDraft(next);
                source.store.set(after.draft);
            }
        } }, history: history.controls, save, saveFromUi, discardFromUi, draftActions, saving, failed, saved,
        openInEditor: () => {
            if (source.lifetime === null) return null;
            const { step: _step, definition: _definition, project: _project, trigger: _trigger, eventSeed: _eventSeed, nativeEvent: _nativeEvent, payloadSchema: _payloadSchema,
                lifetimeSession: _lifetimeSession, ...seed } = source.intent;
            return prepareWorkflowSentenceEditorEntry({ ...seed, ...(projectRef.current === null ? {} : { project: projectRef.current }),
                ...(triggers.lifetimeSession === undefined ? {} : { lifetimeSession: triggers.lifetimeSession }),
                ...settingsRef.current, name: source.store.get().name }, source.lifetime, { draft: source.store.get(),
                triggers: triggers.captureSnapshot(), incompleteTriggers: triggers.incomplete });
        } };
}
