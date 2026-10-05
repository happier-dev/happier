import { describe, expect, it } from 'vitest';
import { AutomationTriggerIdSchema, WorkflowTriggerSetV1Schema, type WorkflowTriggerSetV1 } from '@happier-dev/protocol';

import {
    EMPTY_WORKFLOW_TRIGGER_DRAFT,
    captureWorkflowTriggerSnapshot,
    editWorkflowTriggerDraft,
    isWorkflowTriggerDraftDirty,
    projectWorkflowTriggerRows,
    restoreWorkflowTriggerSnapshot,
    saveWorkflowTriggerDraft,
    type WorkflowTriggerDraft,
    type WorkflowTriggerWriter,
} from './workflowTriggerDraft';

const PROJECT = { machineId: 'machine-1', directory: '/src/happier' } as unknown as NonNullable<WorkflowTriggerSetV1['project']>;

function schedule(scheduleExpr: string) {
    return { kind: 'schedule', schedule: { kind: 'cron', scheduleExpr, everyMs: null, timezone: 'Europe/Zurich' } } as const;
}

function savedTrigger(id: string, scheduleExpr: string, enabled = true) {
    return { id: AutomationTriggerIdSchema.parse(id), revision: 1, enabled, createdAt: 1, updatedAt: 1, nextRunAt: null, triggerDefinitionEnvelope: null, ...schedule(scheduleExpr) };
}

function triggerSet(revision: number, triggers: ReturnType<typeof savedTrigger>[]): WorkflowTriggerSetV1 {
    return { automationId: 'set-1', revision, enabled: true, health: 'available', project: PROJECT, triggers } as unknown as WorkflowTriggerSetV1;
}

/** The Action transport as the owner answers it: every write returns the set at its next revision. */
function recordingWriter(options: Readonly<{ failOn?: 'add' | 'update' | 'remove' }> = {}) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    let revision = 7;
    const answer = (kind: 'add' | 'update' | 'remove') => async (request: object) => {
        calls.push([kind, request as Record<string, unknown>]);
        if (options.failOn === kind) throw Object.assign(new Error('currentness_conflict'), { code: 'currentness_conflict' });
        revision += 1;
        return { set: triggerSet(revision, []) };
    };
    const writer: WorkflowTriggerWriter = { add: answer('add'), update: answer('update'), remove: answer('remove') };
    return { writer, calls };
}

describe('workflow trigger draft', () => {
    const nightlyId = AutomationTriggerIdSchema.parse('nightly');
    const weeklyId = AutomationTriggerIdSchema.parse('weekly');
    it('keeps implicit Runs on implicit when restoring an untouched unsaved trigger snapshot', () => {
        const snapshot = captureWorkflowTriggerSnapshot(null, EMPTY_WORKFLOW_TRIGGER_DRAFT,
            (clientId, triggerId) => ({ clientId, triggerId }));
        expect(restoreWorkflowTriggerSnapshot(null, snapshot)).toEqual(EMPTY_WORKFLOW_TRIGGER_DRAFT);
    });
    it('refuses recreation of a deleted private Event without changing the desired history snapshot', () => {
        const { schedule: _schedule, nextRunAt: _nextRunAt, ...base } = savedTrigger('event', '0 2 * * *');
        const event = { ...base, kind: 'pluginEvent', eventRef: { pluginId: 'plugin', localId: 'event' },
            sourceSelectorId: 'source', sourceContractVersion: 1, observation: { kind: 'socket', watcher: null },
            sourceStatus: null, sourceCatalogStatus: null, triggerDefinitionEnvelope: 'sealed-private' } as const;
        const set = triggerSet(7, []);
        const eventSet = WorkflowTriggerSetV1Schema.parse({ ...set, triggers: [event] });
        const snapshot = captureWorkflowTriggerSnapshot(eventSet, EMPTY_WORKFLOW_TRIGGER_DRAFT,
            (clientId, triggerId) => ({ clientId, triggerId }));
        expect(restoreWorkflowTriggerSnapshot(eventSet, snapshot).removes).toEqual([]);
        expect(() => restoreWorkflowTriggerSnapshot(set, snapshot)).toThrowError(expect.objectContaining({ code: 'workflow_trigger_restore_requires_setup' }));
        expect(snapshot.rows).toHaveLength(1);
        expect(snapshot.rows[0]?.trigger).toBeNull();
    });
    it('shows edits in place without writing: a changed trigger, a removed one gone, a new one last', () => {
        const set = triggerSet(7, [savedTrigger('nightly', '0 2 * * *'), savedTrigger('weekly', '0 9 * * 1')]);
        let draft: WorkflowTriggerDraft = EMPTY_WORKFLOW_TRIGGER_DRAFT;
        expect(isWorkflowTriggerDraftDirty(draft)).toBe(false);
        draft = editWorkflowTriggerDraft(draft, { kind: 'update', triggerId: nightlyId, trigger: schedule('0 3 * * *') });
        draft = editWorkflowTriggerDraft(draft, { kind: 'update', triggerId: nightlyId, enabled: false });
        draft = editWorkflowTriggerDraft(draft, { kind: 'remove', triggerId: weeklyId });
        draft = editWorkflowTriggerDraft(draft, { kind: 'add', clientId: 'c1', trigger: { ...schedule('0 7 * * *'), enabled: true } });

        const rows = projectWorkflowTriggerRows(set, draft);
        expect(rows.map((row) => [row.kind, row.enabled, row.schedule?.schedule.scheduleExpr])).toEqual([
            ['saved', false, '0 3 * * *'],
            ['new', true, '0 7 * * *'],
        ]);
        expect(rows[0]).toMatchObject({ changed: true });

        // Discarding a new trigger before Save leaves nothing to write for it.
        const discarded = editWorkflowTriggerDraft(draft, { kind: 'discardAdd', clientId: 'c1' });
        expect(discarded.adds).toEqual([]);
    });

    it('writes removals, then changes, then additions, each on the revision the previous write returned', async () => {
        const set = triggerSet(7, [savedTrigger('nightly', '0 2 * * *'), savedTrigger('weekly', '0 9 * * 1')]);
        let draft: WorkflowTriggerDraft = EMPTY_WORKFLOW_TRIGGER_DRAFT;
        draft = editWorkflowTriggerDraft(draft, { kind: 'add', clientId: 'c1', trigger: { ...schedule('0 7 * * *'), enabled: true } });
        draft = editWorkflowTriggerDraft(draft, { kind: 'update', triggerId: nightlyId, enabled: false });
        draft = editWorkflowTriggerDraft(draft, { kind: 'remove', triggerId: weeklyId });
        const { writer, calls } = recordingWriter();

        const result = await saveWorkflowTriggerDraft({ workflow: 'wf-1', project: null, set, draft, writer });

        expect(result.kind).toBe('saved');
        expect(calls).toEqual([
            ['remove', { automationId: 'set-1', triggerId: 'weekly' }],
            ['update', { automationId: 'set-1', triggerId: 'nightly', expectedRevision: 8, patch: { enabled: false } }],
            // The set's own machine and folder, not the editor's: one machine per trigger set.
            ['add', { workflow: 'wf-1', project: PROJECT, trigger: { ...schedule('0 7 * * *'), enabled: true } }],
        ]);
    });

    it('creates the set on the editor Where for a workflow without triggers', async () => {
        const draft = editWorkflowTriggerDraft(EMPTY_WORKFLOW_TRIGGER_DRAFT, { kind: 'add', clientId: 'c1', trigger: { ...schedule('0 7 * * *'), enabled: true } });
        const { writer, calls } = recordingWriter();
        await saveWorkflowTriggerDraft({ workflow: 'wf-1', project: PROJECT, set: null, draft, writer });
        expect(calls).toEqual([['add', { workflow: 'wf-1', project: PROJECT, trigger: { ...schedule('0 7 * * *'), enabled: true } }]]);
    });

    it('stops captured writes when the editor lifetime changes during an acknowledged write', async () => {
        let current = true;
        const requests: unknown[] = [];
        const writer: WorkflowTriggerWriter = {
            ...recordingWriter().writer,
            add: async (request) => {
                requests.push(request);
                current = false;
                return { set: triggerSet(8, []), triggerId: 'written' };
            },
        };
        let draft = editWorkflowTriggerDraft(EMPTY_WORKFLOW_TRIGGER_DRAFT, { kind: 'add', clientId: 'first', trigger: { ...schedule('0 7 * * *'), enabled: true } });
        draft = editWorkflowTriggerDraft(draft, { kind: 'add', clientId: 'second', trigger: { ...schedule('0 8 * * *'), enabled: true } });
        const result = await saveWorkflowTriggerDraft({ workflow: 'wf-1', project: PROJECT, set: null, draft, writer, isCurrent: () => current });
        expect(requests).toHaveLength(1);
        expect(result.kind).toBe('stale');
    });

    it('keeps exactly the edits a failed write did not apply, so Try again resumes there', async () => {
        const set = triggerSet(7, [savedTrigger('nightly', '0 2 * * *'), savedTrigger('weekly', '0 9 * * 1')]);
        let draft: WorkflowTriggerDraft = EMPTY_WORKFLOW_TRIGGER_DRAFT;
        draft = editWorkflowTriggerDraft(draft, { kind: 'remove', triggerId: weeklyId });
        draft = editWorkflowTriggerDraft(draft, { kind: 'update', triggerId: nightlyId, enabled: false });
        draft = editWorkflowTriggerDraft(draft, { kind: 'add', clientId: 'c1', trigger: { ...schedule('0 7 * * *'), enabled: true } });
        const { writer } = recordingWriter({ failOn: 'update' });

        const result = await saveWorkflowTriggerDraft({ workflow: 'wf-1', project: null, set, draft, writer });

        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        expect(result.remaining.removes).toEqual([]);
        expect(result.remaining.updates).toEqual({ nightly: { enabled: false } });
        expect(result.remaining.adds.map((add) => add.clientId)).toEqual(['c1']);
        // The removal that did land is reflected in the returned set.
        expect(result.set?.revision).toBe(8);
    });

    it("writes the set's Runs on and constant inputs once for all triggers, and seeds a new set with them", async () => {
        const other = { ...PROJECT, directory: '/other' };
        let draft: WorkflowTriggerDraft = editWorkflowTriggerDraft(EMPTY_WORKFLOW_TRIGGER_DRAFT, { kind: 'setContext', context: { project: other } });
        draft = editWorkflowTriggerDraft(draft, { kind: 'setContext', context: { inputs: { version: '0.3' } } });
        expect(isWorkflowTriggerDraftDirty(draft)).toBe(true);

        // An existing set: one set-level update (no trigger id), before any addition.
        const existing = recordingWriter();
        await saveWorkflowTriggerDraft({ workflow: 'wf-1', project: PROJECT, set: triggerSet(7, []), draft, writer: existing.writer });
        expect(existing.calls).toEqual([['update', { automationId: 'set-1', expectedRevision: 7, patch: { project: other, inputs: { version: '0.3' } } }]]);

        // No set yet: the first trigger creates it on the chosen Runs on with the constants.
        const withAdd = editWorkflowTriggerDraft(draft, { kind: 'add', clientId: 'c1', trigger: { ...schedule('0 2 * * *'), enabled: true } });
        const created = recordingWriter();
        const result = await saveWorkflowTriggerDraft({ workflow: 'wf-1', project: PROJECT, set: null, draft: withAdd, writer: created.writer });
        expect(result.kind).toBe('saved');
        expect(created.calls).toEqual([['add', { workflow: 'wf-1', project: other, trigger: { ...schedule('0 2 * * *'), enabled: true }, inputs: { version: '0.3' } }]]);
    });
});
