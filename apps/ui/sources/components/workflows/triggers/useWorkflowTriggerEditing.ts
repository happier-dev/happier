import * as React from 'react';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import type { AutomationTriggerId, WorkflowProjectTargetV1, WorkflowTriggerSetV1 } from '@happier-dev/protocol';

import {
    addWorkflowTrigger,
    removeWorkflowTrigger,
    updateWorkflowTrigger,
} from '@/sync/domains/workflows/workflowTriggerActions';

import { formatTriggerSetSummary } from './formatTriggerSummary';
import {
    EMPTY_WORKFLOW_TRIGGER_DRAFT,
    WorkflowTriggerSnapshotRestoreError,
    captureWorkflowTriggerSnapshot,
    isWorkflowTriggerDraftDirty,
    projectWorkflowTriggerRows,
    restoreWorkflowTriggerSnapshot,
    saveWorkflowTriggerDraft,
    type WorkflowTriggerDraft,
    type WorkflowTriggerSnapshot,
    type WorkflowTriggerSnapshotIdentity,
    type WorkflowTriggerWriter,
} from './workflowTriggerDraft';
import { useWorkflowTriggerSets } from './useWorkflowTriggerSets';

const WORKFLOW_TRIGGER_WRITER: WorkflowTriggerWriter = {
    add: (request) => addWorkflowTrigger(request),
    update: (request) => updateWorkflowTrigger(request),
    remove: (request) => removeWorkflowTrigger(request),
};

export type WorkflowTriggerEditing = Readonly<{
    set: WorkflowTriggerSetV1 | null;
    draft: WorkflowTriggerDraft;
    setDraft: (next: WorkflowTriggerDraft) => void;
    captureSnapshot: (draftOverride?: WorkflowTriggerDraft) => WorkflowTriggerSnapshot;
    restoreSnapshot: (snapshot: WorkflowTriggerSnapshot) => void;
    dirty: boolean;
    status: 'loading' | 'ready' | 'failed';
    retry: () => void;
    /** The one summary the header chip and the section both show (04 §9.1). */
    summary: string;
    /**
     * Writes the pending trigger delta after the definition was saved (03 §5.3 "Save ordering").
     * `failed` keeps exactly the edits that were not applied.
     */
    save: (workflow: string, isCurrent: () => boolean) => Promise<'saved' | 'failed' | 'stale'>;
}>;

/**
 * The editor's trigger draft (FIN 04 §5.4): this Account's set on the saved workflow, read through
 * `workflow.trigger.list`, and the edits held until Save. Nothing is written while editing.
 */
export function useWorkflowTriggerEditing(params: Readonly<{
    /** The saved workflow, or `null` for a draft never saved (its first Save creates it, then its triggers). */
    definitionId: string | null;
    /** Stable editor source identity, including distinct unsaved workflow seeds. */
    sourceKey: string;
    /** The editor's Where, which seeds the set's one machine when its first trigger is added. */
    projectTarget: WorkflowProjectTargetV1 | null;
}>): WorkflowTriggerEditing {
    const request = React.useMemo(() => params.definitionId === null ? null : { workflow: params.definitionId }, [params.definitionId]);
    const { sets, status, retry } = useWorkflowTriggerSets(request);
    const listedSet = params.definitionId === null ? null : sets[0] ?? null;
    const scope = useActiveServerAccountScope();
    const scopeKey = scope ? serverAccountScopeKeySuffix(scope) : null;
    const identity = React.useMemo(() => ({}), [params.sourceKey, scopeKey]);
    const identityRef = React.useRef(identity);
    identityRef.current = identity;
    // The first trigger write can finish before the newly created definition id reaches these props.
    const acknowledgedSetRef = React.useRef<Readonly<{ identity: object; set: WorkflowTriggerSetV1 | null }>>({ identity, set: null });
    const set = params.definitionId === null && acknowledgedSetRef.current.identity === identity ? acknowledgedSetRef.current.set : listedSet;
    const pendingSave = React.useRef<Readonly<{ identity: object; draft: WorkflowTriggerDraft }> | null>(null);
    const [state, setState] = React.useState(() => ({ identity, draft: EMPTY_WORKFLOW_TRIGGER_DRAFT }));
    const draft = state.identity === identity ? state.draft : EMPTY_WORKFLOW_TRIGGER_DRAFT;
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const setDraft = React.useCallback((next: WorkflowTriggerDraft) => {
        if (identityRef.current === identity) setState({ identity, draft: next });
    }, [identity]);
    const stateRef = React.useRef({ identity, set, draft, projectTarget: params.projectTarget });
    stateRef.current = { identity, set, draft, projectTarget: params.projectTarget };
    const rowIdentities = React.useMemo(() => ({
        clients: new Map<string, WorkflowTriggerSnapshotIdentity>(),
        saved: new Map<AutomationTriggerId, WorkflowTriggerSnapshotIdentity>(),
    }), [identity]);
    const identify = React.useCallback((clientId: string, triggerId?: AutomationTriggerId) => {
        const existing = (triggerId ? rowIdentities.saved.get(triggerId) : undefined) ?? rowIdentities.clients.get(clientId);
        if (existing) return existing;
        const row = { clientId, ...(triggerId ? { triggerId } : {}) };
        rowIdentities.clients.set(clientId, row);
        if (triggerId) rowIdentities.saved.set(triggerId, row);
        return row;
    }, [rowIdentities]);
    const captureSnapshot = React.useCallback((draftOverride?: WorkflowTriggerDraft) => {
        const latest = stateRef.current;
        return captureWorkflowTriggerSnapshot(latest.set, draftOverride ?? latest.draft, identify);
    }, [identify]);
    const restoreSnapshot = React.useCallback((snapshot: WorkflowTriggerSnapshot) => {
        if (identityRef.current !== identity) return;
        const pending = pendingSave.current;
        if (pending?.identity === identity && snapshot.rows.some((row) => row.trigger === null
            && row.identity.triggerId !== undefined && pending.draft.removes.includes(row.identity.triggerId))) {
            throw new WorkflowTriggerSnapshotRestoreError();
        }
        setDraft(restoreWorkflowTriggerSnapshot(stateRef.current.set, snapshot));
    }, [identity, setDraft]);
    const identitiesRef = React.useRef({ rowIdentities, identify });
    identitiesRef.current = { rowIdentities, identify };

    const save = React.useCallback<WorkflowTriggerEditing['save']>(async (workflow, isCurrent) => {
        const captured = stateRef.current;
        const capturedIdentities = identitiesRef.current;
        const lifetime = captureActiveServerAccountScopeCurrentness();
        const current = () => mounted.current && identityRef.current === captured.identity && lifetime.isCurrent() && isCurrent();
        if (!current()) return 'stale';
        if (!isWorkflowTriggerDraftDirty(captured.draft)) return 'saved';
        let previousSet = captured.set;
        const pending = { identity: captured.identity, draft: captured.draft };
        pendingSave.current = pending;
        const outcome = await saveWorkflowTriggerDraft({
            workflow,
            project: captured.projectTarget,
            set: captured.set,
            draft: captured.draft,
            writer: WORKFLOW_TRIGGER_WRITER,
            isCurrent: current,
            onAcknowledged: (edit, triggerId, acknowledgedSet) => {
                if (!current()) return;
                const beforeSet = previousSet;
                previousSet = acknowledgedSet;
                // This is the existing Action receipt, not a separate source of trigger facts.
                acknowledgedSetRef.current = { identity: captured.identity, set: acknowledgedSet };
                if (edit.kind === 'add' && triggerId) {
                    const row = capturedIdentities.identify(edit.clientId);
                    row.triggerId = triggerId;
                    capturedIdentities.rowIdentities.saved.set(triggerId, row);
                }
                setState((latest) => latest.identity === captured.identity
                    ? { ...latest, draft: restoreWorkflowTriggerSnapshot(acknowledgedSet,
                        captureWorkflowTriggerSnapshot(beforeSet, latest.draft, capturedIdentities.identify)) }
                    : latest);
            },
        }).finally(() => { if (pendingSave.current === pending) pendingSave.current = null; });
        if (!current()) return 'stale';
        return outcome.kind;
    }, []);

    const summary = React.useMemo(
        () => {
            const rows = projectWorkflowTriggerRows(set, draft);
            return rows.length > 0 || status === 'ready' ? formatTriggerSetSummary(rows.map((row) => row.trigger))
                : status === 'failed' ? t('workflows.triggers.section.loadFailed') : t('common.loading');
        },
        [draft, set, status],
    );
    return { set, draft, setDraft, captureSnapshot, restoreSnapshot, status, retry, dirty: isWorkflowTriggerDraftDirty(draft), summary, save };
}
