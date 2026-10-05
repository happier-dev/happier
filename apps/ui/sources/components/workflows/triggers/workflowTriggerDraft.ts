import {
    AutomationTriggerIdSchema,
    sameStrictJsonValue,
    type AutomationTriggerId,
    type AutomationTriggerDefinition,
    type AutomationTriggerDefinitionInput,
    type JsonValue,
    type WorkflowProjectTargetV1,
    type WorkflowTriggerAddRequestV1,
    type WorkflowTriggerRemoveRequestV1,
    type WorkflowTriggerSetV1,
    type WorkflowTriggerUpdateRequestV1,
} from '@happier-dev/protocol';

import type { WorkflowTriggerWriteResult } from '@/sync/domains/workflows/workflowTriggerActions';

import type { TriggerSummarySource } from './formatTriggerSummary';

/**
 * A workflow's trigger edits while its editor is open (FIN 04 §5.4 "Save"; 07 S4): trigger edits are
 * part of the draft. Nothing is written while editing; Save writes the definition first, then this
 * delta through `workflow.trigger.remove | update | add`, each reporting its own result. A write
 * that fails leaves exactly the edits it did not apply, so **Try again** resumes from there.
 */
export type WorkflowTriggerDraftAdd = Readonly<{ clientId: string; trigger: AutomationTriggerDefinitionInput }>;
export type WorkflowTriggerDraftUpdate = Readonly<{ trigger?: AutomationTriggerDefinition; enabled?: boolean }>;

/**
 * The trigger set's own context, the same for every trigger of this workflow (04 §5.4): its Runs on
 * machine and folder and its constant input values (03 §5.3 "Inputs").
 */
export type WorkflowTriggerSetContextDraft = Readonly<{
    project?: WorkflowProjectTargetV1;
    inputs?: Readonly<Record<string, JsonValue>>;
}>;

export type WorkflowTriggerDraft = Readonly<{
    adds: readonly WorkflowTriggerDraftAdd[];
    updates: Readonly<Record<string, WorkflowTriggerDraftUpdate>>;
    removes: readonly AutomationTriggerId[];
    /** Pending set-level edits; absent when unchanged. */
    context?: WorkflowTriggerSetContextDraft;
}>;

export const EMPTY_WORKFLOW_TRIGGER_DRAFT: WorkflowTriggerDraft = { adds: [], updates: {}, removes: [] };

/** Local row identity shared by history snapshots; only Save updates the persisted id. */
export type WorkflowTriggerSnapshotIdentity = { clientId: string; triggerId?: AutomationTriggerId };
export type WorkflowTriggerSnapshot = Readonly<{
    rows: readonly Readonly<{
        identity: WorkflowTriggerSnapshotIdentity;
        /** Event projections do not expose the private configuration needed to recreate them. */
        trigger: AutomationTriggerDefinitionInput | null;
        enabled: boolean;
    }>[];
    project: WorkflowProjectTargetV1 | null;
    inputs: Readonly<Record<string, JsonValue>>;
}>;

export class WorkflowTriggerSnapshotRestoreError extends Error {
    readonly code = 'workflow_trigger_restore_requires_setup';

    constructor() {
        super('workflow_trigger_restore_requires_setup');
        this.name = 'WorkflowTriggerSnapshotRestoreError';
    }
}

function readSavedTriggerDefinition(saved: WorkflowTriggerSetV1['triggers'][number]): AutomationTriggerDefinitionInput | null {
    switch (saved.kind) {
        case 'schedule': return { kind: saved.kind, schedule: saved.schedule, enabled: saved.enabled };
        case 'sessionLifecycle': return { kind: saved.kind, sourceSessionId: saved.sourceSessionId, events: saved.events,
            policy: saved.policy, enabled: saved.enabled };
        case 'runLifecycle': return { kind: saved.kind, source: saved.source, condition: saved.condition, enabled: saved.enabled };
        case 'prComment':
        case 'ciFailed': return { kind: saved.kind, pullRequest: saved.pullRequest, enabled: saved.enabled };
        case 'pluginEvent': return null;
    }
}

/** Capture desired rows and context, rather than the delta that a Save acknowledges. */
export function captureWorkflowTriggerSnapshot(
    set: WorkflowTriggerSetV1 | null,
    draft: WorkflowTriggerDraft,
    identify: (clientId: string, triggerId?: AutomationTriggerId) => WorkflowTriggerSnapshotIdentity,
): WorkflowTriggerSnapshot {
    const rows: WorkflowTriggerSnapshot['rows'][number][] = [];
    for (const saved of set?.triggers ?? []) {
        if (draft.removes.includes(saved.id)) continue;
        const update = draft.updates[saved.id];
        const enabled = update?.enabled ?? saved.enabled;
        const trigger = update?.trigger ? { ...update.trigger, enabled } : readSavedTriggerDefinition(saved);
        rows.push({ identity: identify(`saved:${saved.id}`, saved.id), trigger: trigger ? { ...trigger, enabled } : null, enabled });
    }
    for (const add of draft.adds) rows.push({ identity: identify(add.clientId), trigger: add.trigger, enabled: add.trigger.enabled });
    // Before a set exists, Where remains the editor's default; history must not turn it into an override.
    return { rows, project: draft.context?.project ?? set?.project ?? null, inputs: draft.context?.inputs ?? set?.context?.inputs ?? {} };
}

/** Rebase a history snapshot onto the current saved set after any successful writes. */
export function restoreWorkflowTriggerSnapshot(set: WorkflowTriggerSetV1 | null, snapshot: WorkflowTriggerSnapshot): WorkflowTriggerDraft {
    const adds: WorkflowTriggerDraftAdd[] = [];
    const updates: Record<string, WorkflowTriggerDraftUpdate> = {};
    const retained = new Set<AutomationTriggerId>();
    for (const row of snapshot.rows) {
        const saved = set?.triggers.find((candidate) => candidate.id === row.identity.triggerId);
        if (!saved) {
            if (!row.trigger) throw new WorkflowTriggerSnapshotRestoreError();
            adds.push({ clientId: row.identity.clientId, trigger: row.trigger });
            continue;
        }
        retained.add(saved.id);
        const update: { trigger?: AutomationTriggerDefinition; enabled?: boolean } = {};
        if (row.enabled !== saved.enabled) update.enabled = row.enabled;
        if (row.trigger) {
            const { enabled: _enabled, ...trigger } = row.trigger;
            const savedInput = readSavedTriggerDefinition(saved);
            const { enabled: _savedEnabled, ...savedDefinition } = savedInput ?? { enabled: saved.enabled };
            if (!sameStrictJsonValue(trigger, savedDefinition)) update.trigger = trigger;
        }
        if (Object.keys(update).length) updates[saved.id] = update;
    }
    const context: { project?: WorkflowProjectTargetV1; inputs?: Readonly<Record<string, JsonValue>> } = {};
    if (snapshot.project && !sameStrictJsonValue(snapshot.project, set?.project)) context.project = snapshot.project;
    if (!sameStrictJsonValue(snapshot.inputs, set?.context?.inputs ?? {})) context.inputs = snapshot.inputs;
    return { adds, updates, removes: (set?.triggers ?? []).filter((saved) => !retained.has(saved.id)).map((saved) => saved.id),
        ...(Object.keys(context).length ? { context } : {}) };
}

export function isWorkflowTriggerDraftDirty(draft: WorkflowTriggerDraft): boolean {
    return draft.adds.length > 0 || draft.removes.length > 0 || Object.keys(draft.updates).length > 0
        || draft.context !== undefined;
}

export type WorkflowTriggerDraftEdit =
    | Readonly<{ kind: 'add'; clientId: string; trigger: AutomationTriggerDefinitionInput }>
    | Readonly<{ kind: 'update'; triggerId: AutomationTriggerId; trigger?: AutomationTriggerDefinition; enabled?: boolean }>
    | Readonly<{ kind: 'remove'; triggerId: AutomationTriggerId }>
    | Readonly<{ kind: 'discardAdd'; clientId: string }>
    | Readonly<{ kind: 'setContext'; context: WorkflowTriggerSetContextDraft }>;

export function editWorkflowTriggerDraft(draft: WorkflowTriggerDraft, edit: WorkflowTriggerDraftEdit): WorkflowTriggerDraft {
    switch (edit.kind) {
        case 'add': {
            const exists = draft.adds.some((add) => add.clientId === edit.clientId);
            return {
                ...draft,
                adds: exists
                    ? draft.adds.map((add) => (add.clientId === edit.clientId ? { clientId: edit.clientId, trigger: edit.trigger } : add))
                    : [...draft.adds, { clientId: edit.clientId, trigger: edit.trigger }],
            };
        }
        case 'discardAdd':
            return { ...draft, adds: draft.adds.filter((add) => add.clientId !== edit.clientId) };
        case 'setContext':
            return { ...draft, context: { ...draft.context, ...edit.context } };
        case 'update': {
            const previous = draft.updates[edit.triggerId] ?? {};
            return {
                ...draft,
                updates: {
                    ...draft.updates,
                    [edit.triggerId]: {
                        ...previous,
                        ...(edit.trigger === undefined ? {} : { trigger: edit.trigger }),
                        ...(edit.enabled === undefined ? {} : { enabled: edit.enabled }),
                    },
                },
            };
        }
        case 'remove': {
            const { [edit.triggerId]: _dropped, ...updates } = draft.updates;
            return {
                ...draft,
                updates,
                removes: draft.removes.includes(edit.triggerId) ? draft.removes : [...draft.removes, edit.triggerId],
            };
        }
    }
}

/**
 * One row of the Runs automatically section: a saved trigger as edited, or a new one. `trigger` is
 * what the row reads; a saved plugin-event trigger keeps its private configuration in its envelope
 * and is shown, turned on and off and deleted here, but not re-configured (its setup flow owns that).
 */
export type WorkflowTriggerRowModel =
    | Readonly<{ kind: 'saved'; key: string; triggerId: AutomationTriggerId; trigger: TriggerSummarySource; schedule: WorkflowScheduleTrigger | null; enabled: boolean; changed: boolean }>
    | Readonly<{ kind: 'new'; key: string; clientId: string; trigger: TriggerSummarySource; schedule: WorkflowScheduleTrigger | null; enabled: boolean }>;

export type WorkflowScheduleTrigger = Extract<AutomationTriggerDefinition, Readonly<{ kind: 'schedule' }>>;

type ScheduleCarrier = AutomationTriggerDefinitionInput | AutomationTriggerDefinition | WorkflowTriggerSetV1['triggers'][number];

function readSchedule(trigger: ScheduleCarrier): WorkflowScheduleTrigger | null {
    return trigger.kind === 'schedule' ? { kind: 'schedule', schedule: trigger.schedule } : null;
}

export function projectWorkflowTriggerRows(set: WorkflowTriggerSetV1 | null, draft: WorkflowTriggerDraft): readonly WorkflowTriggerRowModel[] {
    const rows: WorkflowTriggerRowModel[] = [];
    for (const saved of set?.triggers ?? []) {
        if (draft.removes.includes(saved.id)) continue;
        const update = draft.updates[saved.id];
        const source = update?.trigger ?? saved;
        rows.push({
            kind: 'saved',
            key: `saved:${saved.id}`,
            triggerId: saved.id,
            trigger: source,
            schedule: readSchedule(source),
            enabled: update?.enabled ?? saved.enabled,
            changed: update !== undefined,
        });
    }
    for (const add of draft.adds) {
        rows.push({
            kind: 'new',
            key: `new:${add.clientId}`,
            clientId: add.clientId,
            trigger: add.trigger,
            schedule: readSchedule(add.trigger),
            enabled: add.trigger.enabled,
        });
    }
    return rows;
}

export type WorkflowTriggerWriter = Readonly<{
    add: (request: WorkflowTriggerAddRequestV1) => Promise<WorkflowTriggerWriteResult>;
    update: (request: WorkflowTriggerUpdateRequestV1) => Promise<WorkflowTriggerWriteResult>;
    remove: (request: WorkflowTriggerRemoveRequestV1) => Promise<WorkflowTriggerWriteResult>;
}>;

export type WorkflowTriggerSaveResult =
    | Readonly<{ kind: 'saved'; set: WorkflowTriggerSetV1 | null }>
    | Readonly<{ kind: 'stale'; set: WorkflowTriggerSetV1 | null }>
    | Readonly<{ kind: 'failed'; set: WorkflowTriggerSetV1 | null; remaining: WorkflowTriggerDraft; error: unknown }>;

/**
 * Writes the delta, one Action at a time: removals, then changes, then additions. Each write
 * carries the set revision the previous one returned. The first addition to a workflow without a
 * set creates it on the editor's Where (`project`, 04 §5.4 Runs on); later ones join that set.
 */
export async function saveWorkflowTriggerDraft(params: Readonly<{
    workflow: string;
    project: WorkflowProjectTargetV1 | null;
    set: WorkflowTriggerSetV1 | null;
    draft: WorkflowTriggerDraft;
    writer: WorkflowTriggerWriter;
    isCurrent?: () => boolean;
    onAcknowledged?: (edit: WorkflowTriggerDraftEdit, triggerId: AutomationTriggerId | undefined, set: WorkflowTriggerSetV1 | null) => void;
}>): Promise<WorkflowTriggerSaveResult> {
    let set = params.set;
    let remaining = params.draft;
    try {
        for (const triggerId of params.draft.removes) {
            if (params.isCurrent?.() === false) return { kind: 'stale', set };
            if (set !== null) {
                set = (await params.writer.remove({ automationId: set.automationId, triggerId })).set;
            }
            remaining = { ...remaining, removes: remaining.removes.filter((id) => id !== triggerId) };
            params.onAcknowledged?.({ kind: 'remove', triggerId }, undefined, set);
        }
        for (const [triggerId, update] of Object.entries(params.draft.updates)) {
            if (params.isCurrent?.() === false) return { kind: 'stale', set };
            if (set !== null && (update.trigger !== undefined || update.enabled !== undefined)) {
                set = (await params.writer.update({
                    automationId: set.automationId,
                    triggerId: AutomationTriggerIdSchema.parse(triggerId),
                    expectedRevision: set.revision,
                    patch: {
                        ...(update.trigger === undefined ? {} : { trigger: update.trigger }),
                        ...(update.enabled === undefined ? {} : { enabled: update.enabled }),
                    },
                })).set;
            }
            const { [triggerId]: _applied, ...updates } = remaining.updates;
            remaining = { ...remaining, updates };
            params.onAcknowledged?.({ kind: 'update', triggerId: AutomationTriggerIdSchema.parse(triggerId), ...update }, undefined, set);
        }
        // The set's own context, for every trigger at once (no trigger id).
        const context = params.draft.context;
        if (context !== undefined && set !== null) {
            if (params.isCurrent?.() === false) return { kind: 'stale', set };
            set = (await params.writer.update({
                automationId: set.automationId,
                expectedRevision: set.revision,
                patch: {
                    ...(context.project === undefined ? {} : { project: context.project }),
                    ...(context.inputs === undefined ? {} : { inputs: { ...context.inputs } }),
                },
            })).set;
            const { context: _applied, ...rest } = remaining;
            remaining = rest;
            params.onAcknowledged?.({ kind: 'setContext', context }, undefined, set);
        }
        for (const add of params.draft.adds) {
            if (params.isCurrent?.() === false) return { kind: 'stale', set };
            // The first trigger creates the set on its Runs on (the editor's Where unless changed).
            const project = set?.project ?? context?.project ?? params.project;
            if (project === null || project === undefined) {
                throw Object.assign(new Error('trigger_project_required'), { code: 'trigger_project_required' });
            }
            const result = await params.writer.add({
                workflow: params.workflow,
                project,
                trigger: add.trigger,
                ...(set === null && context?.inputs !== undefined ? { inputs: { ...context.inputs } } : {}),
            });
            set = result.set;
            params.onAcknowledged?.({ kind: 'add', ...add }, result.triggerId === undefined ? undefined : AutomationTriggerIdSchema.parse(result.triggerId), set);
            remaining = { ...remaining, adds: remaining.adds.filter((item) => item.clientId !== add.clientId) };
            if (remaining.context !== undefined && set !== null) {
                const { context: _seeded, ...rest } = remaining;
                remaining = rest;
                if (context) params.onAcknowledged?.({ kind: 'setContext', context }, undefined, set);
            }
        }
        return { kind: 'saved', set };
    } catch (error) {
        return { kind: 'failed', set, remaining, error };
    }
}
