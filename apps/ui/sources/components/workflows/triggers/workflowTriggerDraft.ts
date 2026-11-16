import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/publicTypes';
import type { WorkflowTriggerEventDeclarationV1 } from '@happier-dev/protocol/workflows/workflowTriggerEventReferenceV1';
import { AutomationTriggerIdSchema, type AutomationTriggerId } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { AutomationTriggerDefinition, AutomationTriggerDefinitionInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import type { WorkflowIntendedTriggerV1, WorkflowTriggerAddRequestV1, WorkflowTriggerRemoveRequestV1, WorkflowTriggerSetV1, WorkflowTriggerUpdateRequestV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import type { WorkflowTriggerWriteResult } from '@/sync/domains/workflows/workflowTriggerActions';
import type { WorkflowDraftTriggerSnapshotV1 } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import type { RoleOverrideV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';

/**
 * A workflow's trigger edits while its editor is open (FIN 04 §5.4 "Save"; 07 S4): trigger edits are
 * part of the draft. Nothing is written while editing; Save writes the definition first, then this
 * delta through `workflow.trigger.remove | update | add`, each reporting its own result. A write
 * that fails leaves exactly the edits it did not apply, so **Try again** resumes from there.
 */
export type WorkflowTriggerDraftAdd = Readonly<{ clientId: string; trigger: AutomationTriggerDefinitionInput; payloadSchema?: PluginJsonSchemaV2 | null }>;
export type WorkflowTriggerDraftUpdate = Readonly<{ trigger?: AutomationTriggerDefinition; enabled?: boolean; payloadSchema?: PluginJsonSchemaV2 | null }>;

/**
 * The trigger set's own context, the same for every trigger of this workflow (04 §5.4): its Runs on
 * machine and folder, constant input values, Roles and run visibility.
 */
export type WorkflowTriggerSetContextDraft = Readonly<{
    project?: WorkflowProjectTargetV1;
    inputs?: Readonly<Record<string, JsonValue>>;
    roleOverrides?: readonly RoleOverrideV1[];
    visibleTeamId?: string | null;
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
export type WorkflowTriggerSnapshot = Readonly<Omit<WorkflowDraftTriggerSnapshotV1, 'rows'> & {
    rows: readonly Readonly<WorkflowDraftTriggerSnapshotV1['rows'][number]>[];
}>;

/** Private inputs loaded or accepted in this editor, tied to the saved row they describe. */
export type WorkflowTriggerKnownDefinitions = ReadonlyMap<AutomationTriggerId, Readonly<{
    revision: number;
    trigger: AutomationTriggerDefinition;
}>>;

export class WorkflowTriggerSnapshotRestoreError extends Error {
    readonly code = 'workflow_trigger_restore_requires_setup';

    constructor() {
        super('workflow_trigger_restore_requires_setup');
        this.name = 'WorkflowTriggerSnapshotRestoreError';
    }
}

function readSavedTriggerDefinition(saved: WorkflowTriggerSetV1['triggers'][number],
    acknowledged?: WorkflowTriggerKnownDefinitions): AutomationTriggerDefinitionInput | null {
    switch (saved.kind) {
        case 'schedule': return { kind: saved.kind, schedule: saved.schedule, enabled: saved.enabled };
        case 'sessionLifecycle': return { kind: saved.kind, sourceSessionId: saved.sourceSessionId, events: saved.events,
            policy: saved.policy, enabled: saved.enabled };
        case 'runLifecycle': return { kind: saved.kind, source: saved.source, condition: saved.condition, enabled: saved.enabled };
        case 'prComment':
        case 'ciFailed': return { kind: saved.kind, pullRequest: saved.pullRequest, enabled: saved.enabled };
        case 'pluginEvent': {
            const accepted = acknowledged?.get(saved.id);
            return accepted?.revision === saved.revision ? { ...accepted.trigger, enabled: saved.enabled } : null;
        }
    }
}

/** Capture desired rows and context, rather than the delta that a Save acknowledges. */
export function captureWorkflowTriggerSnapshot(
    set: WorkflowTriggerSetV1 | null,
    draft: WorkflowTriggerDraft,
    identify: (clientId: string, triggerId?: AutomationTriggerId) => WorkflowTriggerSnapshotIdentity,
    acknowledged?: WorkflowTriggerKnownDefinitions,
): WorkflowTriggerSnapshot {
    const rows: WorkflowTriggerSnapshot['rows'][number][] = [];
    for (const saved of set?.triggers ?? []) {
        if (draft.removes.includes(saved.id)) continue;
        const update = draft.updates[saved.id];
        const enabled = update?.enabled ?? saved.enabled;
        const trigger = update?.trigger ? { ...update.trigger, enabled } : readSavedTriggerDefinition(saved, acknowledged);
        rows.push({ identity: identify(`saved:${saved.id}`, saved.id), trigger: trigger ? { ...trigger, enabled } : null, enabled,
            ...(update?.payloadSchema !== undefined ? { payloadSchema: update.payloadSchema }
                : saved.kind === 'pluginEvent' && (!update?.trigger || update.trigger.kind === 'pluginEvent'
                    && sameStrictJsonValue(update.trigger.eventRef, saved.eventRef)) ? { payloadSchema: saved.payloadSchema ?? null } : {}) });
    }
    for (const add of draft.adds) rows.push({ identity: identify(add.clientId), trigger: add.trigger, enabled: add.trigger.enabled,
        ...(add.payloadSchema === undefined ? {} : { payloadSchema: add.payloadSchema }) });
    // Before a set exists, Where remains the editor's default; history must not turn it into an override.
    const roleOverrides = draft.context?.roleOverrides ?? set?.context?.roleOverrides;
    const visibleTeamId = draft.context?.visibleTeamId === undefined ? set?.context?.visibleTeamId : draft.context.visibleTeamId;
    return { rows, project: draft.context?.project ?? set?.project ?? null, inputs: draft.context?.inputs ?? set?.context?.inputs ?? {},
        ...(roleOverrides === undefined ? {} : { roleOverrides: [...roleOverrides] }),
        ...(visibleTeamId === undefined ? {} : { visibleTeamId }) };
}

/** Rebase a history snapshot onto the current saved set after any successful writes. */
export function restoreWorkflowTriggerSnapshot(set: WorkflowTriggerSetV1 | null, snapshot: WorkflowTriggerSnapshot,
    acknowledged?: WorkflowTriggerKnownDefinitions): WorkflowTriggerDraft {
    const adds: WorkflowTriggerDraftAdd[] = [];
    const updates: Record<string, WorkflowTriggerDraftUpdate> = {};
    const retained = new Set<AutomationTriggerId>();
    for (const row of snapshot.rows) {
        const saved = set?.triggers.find((candidate) => candidate.id === row.identity.triggerId);
        if (!saved) {
            if (!row.trigger) throw new WorkflowTriggerSnapshotRestoreError();
            adds.push({ clientId: row.identity.clientId, trigger: row.trigger,
                ...(row.payloadSchema === undefined ? {} : { payloadSchema: row.payloadSchema }) });
            continue;
        }
        retained.add(saved.id);
        const update: { trigger?: AutomationTriggerDefinition; enabled?: boolean; payloadSchema?: PluginJsonSchemaV2 | null } = {};
        if (row.enabled !== saved.enabled) update.enabled = row.enabled;
        if (row.trigger) {
            const { enabled: _enabled, ...trigger } = row.trigger;
            const savedInput = readSavedTriggerDefinition(saved, acknowledged);
            const { enabled: _savedEnabled, ...savedDefinition } = savedInput ?? { enabled: saved.enabled };
            if (!sameStrictJsonValue(trigger, savedDefinition)) update.trigger = trigger;
        }
        if (update.trigger?.kind === 'pluginEvent' && row.payloadSchema !== undefined) update.payloadSchema = row.payloadSchema;
        if (Object.keys(update).length) updates[saved.id] = update;
    }
    const context: { project?: WorkflowProjectTargetV1; inputs?: Readonly<Record<string, JsonValue>>;
        roleOverrides?: readonly RoleOverrideV1[]; visibleTeamId?: string | null } = {};
    if (snapshot.project && !sameStrictJsonValue(snapshot.project, set?.project)) context.project = snapshot.project;
    if (!sameStrictJsonValue(snapshot.inputs, set?.context?.inputs ?? {})) context.inputs = snapshot.inputs;
    if (!sameStrictJsonValue(snapshot.roleOverrides ?? [], set?.context?.roleOverrides ?? [])) context.roleOverrides = snapshot.roleOverrides ?? [];
    if ((snapshot.visibleTeamId ?? null) !== (set?.context?.visibleTeamId ?? null)) context.visibleTeamId = snapshot.visibleTeamId ?? null;
    return { adds, updates, removes: (set?.triggers ?? []).filter((saved) => !retained.has(saved.id)).map((saved) => saved.id),
        ...(Object.keys(context).length ? { context } : {}) };
}

export function isWorkflowTriggerDraftDirty(draft: WorkflowTriggerDraft): boolean {
    return draft.adds.length > 0 || draft.removes.length > 0 || Object.keys(draft.updates).length > 0
        || draft.context !== undefined;
}

export type WorkflowTriggerDraftEdit =
    | Readonly<{ kind: 'add'; clientId: string; trigger: AutomationTriggerDefinitionInput; payloadSchema?: PluginJsonSchemaV2 | null }>
    | Readonly<{ kind: 'update'; triggerId: AutomationTriggerId; trigger?: AutomationTriggerDefinition; enabled?: boolean; payloadSchema?: PluginJsonSchemaV2 | null }>
    | Readonly<{ kind: 'remove'; triggerId: AutomationTriggerId }>
    | Readonly<{ kind: 'discardAdd'; clientId: string }>
    | Readonly<{ kind: 'setContext'; context: WorkflowTriggerSetContextDraft }>;

export function editWorkflowTriggerDraft(draft: WorkflowTriggerDraft, edit: WorkflowTriggerDraftEdit): WorkflowTriggerDraft {
    switch (edit.kind) {
        case 'add': {
            const previous = draft.adds.find((add) => add.clientId === edit.clientId);
            const payloadSchema = edit.payloadSchema !== undefined ? edit.payloadSchema
                : previous?.trigger.kind === 'pluginEvent' && edit.trigger.kind === 'pluginEvent'
                    && sameStrictJsonValue(previous.trigger.eventRef, edit.trigger.eventRef) ? previous.payloadSchema : undefined;
            const next = { clientId: edit.clientId, trigger: edit.trigger,
                ...(payloadSchema === undefined ? {} : { payloadSchema }) };
            return {
                ...draft,
                adds: previous
                    ? draft.adds.map((add) => (add.clientId === edit.clientId ? next : add))
                    : [...draft.adds, next],
            };
        }
        case 'discardAdd':
            return { ...draft, adds: draft.adds.filter((add) => add.clientId !== edit.clientId) };
        case 'setContext':
            return { ...draft, context: { ...draft.context, ...edit.context } };
        case 'update': {
            const previous = draft.updates[edit.triggerId] ?? {};
            const { payloadSchema: previousSchema, ...previousDefinition } = previous;
            const payloadSchema = edit.payloadSchema !== undefined ? edit.payloadSchema
                : edit.trigger === undefined || previous.trigger?.kind === 'pluginEvent' && edit.trigger.kind === 'pluginEvent'
                    && sameStrictJsonValue(previous.trigger.eventRef, edit.trigger.eventRef) ? previousSchema : undefined;
            return {
                ...draft,
                updates: {
                    ...draft.updates,
                    [edit.triggerId]: {
                        ...previousDefinition,
                        ...(payloadSchema === undefined ? {} : { payloadSchema }),
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
 * what the row reads; a saved plugin-event trigger keeps its private configuration in its envelope.
 * Its row editor reads that exact envelope and uses the canonical Event setup flow to reconfigure it.
 */
export type WorkflowTriggerRowModel =
    | Readonly<{ kind: 'saved'; key: string; triggerId: AutomationTriggerId; trigger: ScheduleCarrier; schedule: WorkflowScheduleTrigger | null; enabled: boolean; changed: boolean }>
    | Readonly<{ kind: 'new'; key: string; clientId: string; trigger: ScheduleCarrier; schedule: WorkflowScheduleTrigger | null; enabled: boolean }>;

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

/** One draft membership projection supplies both editor validation and save intent. */
export function projectWorkflowTriggerEvents(set: WorkflowTriggerSetV1 | null, draft: WorkflowTriggerDraft): Readonly<{
    triggerEvents: readonly WorkflowTriggerEventDeclarationV1[];
    intendedTriggers: readonly WorkflowIntendedTriggerV1[];
}> {
    const triggerEvents: WorkflowTriggerEventDeclarationV1[] = [];
    const intendedTriggers: WorkflowIntendedTriggerV1[] = [];
    const savedById = new Map(set?.triggers.map(trigger => [trigger.id, trigger]));
    const addedById = new Map(draft.adds.map(add => [add.clientId, add]));
    for (const row of projectWorkflowTriggerRows(set, draft)) {
        const trigger = row.trigger;
        if (trigger.kind !== 'pluginEvent') continue;
        const edit = row.kind === 'saved' ? draft.updates[row.triggerId] : addedById.get(row.clientId);
        const saved = row.kind === 'saved' ? savedById.get(row.triggerId) : undefined;
        triggerEvents.push({ event: trigger.eventRef, payloadSchema: edit?.payloadSchema !== undefined ? edit.payloadSchema
            : saved?.kind === 'pluginEvent' && sameStrictJsonValue(saved.eventRef, trigger.eventRef) ? saved.payloadSchema ?? null : null });
        if ('observationTransport' in trigger) {
            intendedTriggers.push({ kind: 'pluginEvent', eventRef: trigger.eventRef, observationTransport: trigger.observationTransport });
        } else if (row.kind === 'saved' && set) {
            intendedTriggers.push({ kind: 'pluginEvent', automationId: set.automationId, triggerId: row.triggerId, eventRef: trigger.eventRef });
        }
    }
    return { triggerEvents, intendedTriggers };
}

export type WorkflowTriggerWriter = Readonly<{
    add: (request: WorkflowTriggerAddRequestV1) => Promise<WorkflowTriggerWriteResult>;
    update: (request: WorkflowTriggerUpdateRequestV1) => Promise<WorkflowTriggerWriteResult>;
    remove: (request: WorkflowTriggerRemoveRequestV1 & Readonly<{ triggerId: AutomationTriggerId }>) => Promise<WorkflowTriggerWriteResult>;
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
                    ...(context.roleOverrides === undefined ? {} : { roleOverrides: [...context.roleOverrides] }),
                    ...(context.visibleTeamId === undefined ? {} : { visibleTeamId: context.visibleTeamId }),
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
                ...(set === null && context?.roleOverrides !== undefined ? { roleOverrides: [...context.roleOverrides] } : {}),
                ...(set === null && context?.visibleTeamId !== undefined ? { visibleTeamId: context.visibleTeamId } : {}),
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
