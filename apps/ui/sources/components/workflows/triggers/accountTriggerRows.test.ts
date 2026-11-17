import { describe, expect, it, vi } from 'vitest';
import { normalizeWorkflowIngress} from '@happier-dev/protocol/workflows/workflowValidationV1';
import { WorkflowAttachedTriggerPageV1Schema, WorkflowTriggerSetV1Schema, type WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { AutomationActionTriggerSchema } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const { projectAccountTriggerRows, accountTriggerRemoval } = await import('./accountTriggerRows');
const { formatClockTime } = await import('./triggerSchedule');

function daily(id: string, scheduleExpr: string, enabled = true) {
    return {
        id, revision: 1, enabled, createdAt: 1, updatedAt: 1, kind: 'schedule', triggerDefinitionEnvelope: null, nextRunAt: null,
        schedule: { kind: 'cron', scheduleExpr, everyMs: null, timezone: null },
    };
}

function inline(blocks: unknown[]) {
    const outcome = normalizeWorkflowIngress({ version: 1, blocks });
    if (outcome.kind !== 'parsed') throw new Error('fixture must normalize');
    return { kind: 'inline' as const, definition: outcome.definition };
}

function set(automationId: string, overrides: Record<string, unknown>): WorkflowTriggerSetV1 {
    return WorkflowTriggerSetV1Schema.parse({ automationId, revision: 1, enabled: true, health: 'available', triggers: [], ...overrides });
}

describe('projectAccountTriggerRows', () => {
    it('marks direct rows authored by this Account yours and presents other or context rows read only', () => {
        const attachedPage = WorkflowAttachedTriggerPageV1Schema.parse({ attached: [
            { automationId: 'own-direct', triggerId: 't1', workflowDefinitionId: null, relation: 'direct',
                enabled: true, revision: 1, summary: { kind: 'schedule', schedule: daily('t1', '0 7 * * *').schedule },
                setUpBy: { accountId: 'viewer', displayName: null } },
            { automationId: 'other-direct', triggerId: 't2', workflowDefinitionId: null, relation: 'direct',
                enabled: true, revision: 1, summary: { kind: 'schedule', schedule: daily('t2', '0 7 * * *').schedule },
                setUpBy: { accountId: 'other', displayName: null } },
            { automationId: 'own-context', triggerId: 't3', workflowDefinitionId: null, relation: 'context',
                enabled: true, revision: 1, summary: { kind: 'schedule', schedule: daily('t3', '0 7 * * *').schedule },
                setUpBy: { accountId: 'viewer', displayName: null } },
        ], nextCursor: null, skippedNotSharedCount: 0 });
        expect(projectAccountTriggerRows({ sets: [], attachedPage, accountId: 'viewer', resolveWorkflowTitle: () => null }))
            .toMatchObject([{ yours: true, readOnly: false }, { yours: false, readOnly: true }, { yours: true, readOnly: true }]);
    });
    it('projects a saved Action attachment through the ordinary trigger row owner', () => {
        const trigger = AutomationActionTriggerSchema.parse({ kind: 'action', phase: 'before', mode: 'wait', onFailure: 'ask',
            actionIds: ['machines.command.run'] });
        const rows = projectAccountTriggerRows({ resolveWorkflowTitle: () => 'Shared check', sets: [
            set('action-check', { target: { kind: 'workflow', ref: '00000000-0000-4000-8000-000000000001' },
                triggers: [{ ...trigger, id: 'action-trigger', revision: 1, enabled: true, createdAt: 1, updatedAt: 1 }] }),
        ] });
        expect(rows).toMatchObject([{ automationId: 'action-check', triggerId: 'action-trigger', subtitle: 'Shared check', off: false }]);
    });
    it('keeps every selected saved and inline attachment independently of execution placement', () => {
        const workflow = '00000000-0000-4000-8000-000000000001';
        const attachedPage = WorkflowAttachedTriggerPageV1Schema.parse({
            attached: [
                { automationId: 'saved', triggerId: 'saved-direct', workflowDefinitionId: workflow,
                    relation: 'direct', enabled: false, revision: 2,
                    summary: { kind: 'schedule', schedule: daily('saved-direct', '0 7 * * *').schedule },
                    setUpBy: { accountId: 'owner', displayName: 'Owner' } },
                { automationId: 'inline', triggerId: 'inline-context', workflowDefinitionId: null,
                    relation: 'context', enabled: true, revision: 3,
                    summary: { kind: 'schedule', schedule: daily('inline-context', '0 19 * * *').schedule },
                    setUpBy: { accountId: 'member', displayName: null } },
            ], nextCursor: 'selected-next', skippedNotSharedCount: 4,
        });
        const input = { attachedPage, resolveWorkflowTitle: () => 'Saved workflow',
            subject: { kind: 'machine' as const, machineId: 'viewed-machine' },
            sets: [
                set('saved', { target: { kind: 'workflow', ref: workflow }, project: { machineId: 'elsewhere', directory: '~' },
                    triggers: [daily('saved-direct', '0 7 * * *', false)] }),
                set('inline', { target: inline(['Run here']), project: { machineId: 'elsewhere', directory: '~' },
                    triggers: [daily('inline-context', '0 19 * * *')] }),
                set('unselected', { target: inline(['Unrelated']), project: { machineId: 'viewed-machine', directory: '~' },
                    triggers: [daily('unselected-trigger', '0 9 * * *')] }),
            ] };
        const rows = projectAccountTriggerRows(input);
        expect(rows.map(row => row.triggerId)).toEqual(['saved-direct', 'inline-context']);
        expect(rows).toMatchObject([
            { subtitle: 'Saved workflow', off: true, relation: 'schedule', setUpBy: { accountId: 'owner', displayName: 'Owner' },
                attachment: attachedPage.attached[0] },
            { off: false, relation: 'schedule', setUpBy: { accountId: 'member', displayName: null }, attachment: attachedPage.attached[1] },
        ]);
    });
    it.each(['before', 'after'] as const)('retains %s Action and latest-started Run facts without an opened Workflow body', phase => {
        const startedAt = '2026-11-17T01:00:00.000Z';
        const attachedPage = WorkflowAttachedTriggerPageV1Schema.parse({ attached: [{
            automationId: 'shared-check', triggerId: 'shared-trigger',
            workflowDefinitionId: '00000000-0000-4000-8000-000000000001',
            workflowAccess: { ownerAccountId: 'author', access: 'view' },
            relation: 'context', enabled: true, revision: 3,
            summary: { kind: 'action', phase, actionIds: ['machines.command.run'] },
            setUpBy: { accountId: 'author', displayName: 'Author' },
            lastRun: { id: '00000000-0000-4000-8000-000000000002', state: 'running', workflowCustodyState: null,
                attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, createdAt: startedAt, startedAt },
        }], nextCursor: null, skippedNotSharedCount: 0 });
        const rows = projectAccountTriggerRows({ sets: [], attachedPage, resolveWorkflowTitle: () => 'Shared check' });
        expect(rows).toMatchObject([{ subtitle: 'Shared check', relation: phase,
            setUpBy: { accountId: 'author', displayName: 'Author' }, outcome: { state: 'running', atMs: Date.parse(startedAt) } }]);
        expect(rows[0]?.attachment).toBe(attachedPage.attached[0]);
    });
    it('names an inline document with declared inputs without flattening it to a form preset', () => {
        const base = inline([{ kind: 'step', id: 'digest', name: 'Morning digest',
            document: { text: 'Summarize project activity and include open issues.', references: [], attachments: [] },
            input: [], result: { kind: 'text' } }]);
        const target = { ...base, definition: { ...base.definition,
            inputs: [{ name: 'topic', valueType: 'string' as const, required: false }] } };
        const rows = projectAccountTriggerRows({ resolveWorkflowTitle: () => null,
            sets: [set('digest', { target, triggers: [] })] });
        // A manual set is told apart by what it runs, so that leads and "Manual" is the quiet line.
        expect(rows[0]?.title).toBe('Morning digest');
        expect(rows[0]?.subtitle).toBe('workflows.triggers.summary.manual');
    });
    it('shows the legacy prompt and retained placements in the column, including an unreadable legacy row', () => {
        const rows = projectAccountTriggerRows({ resolveWorkflowTitle: () => null, sets: [
            set('legacy', { legacy: { editable: false, reason: 'created_in_0_2', placements: [] },
                target: inline(['Review release\nInclude changelog']), triggers: [daily('old', '0 9 * * *')] }),
            set('locked', { legacy: { editable: false, reason: 'created_in_0_2' }, health: 'source_unavailable', triggers: [] }),
        ] });
        expect(rows[0]?.subtitle).toContain('Review release\nInclude changelog');
        expect(rows[0]?.subtitle).toContain('workflows.triggers.row.legacyCreated');
        expect(rows[0]?.subtitle).toContain('workflows.triggers.row.machines(count=0)');
        expect(rows[1]?.subtitle).not.toContain('workflows.triggers.row.workflowUnavailable');
        expect(rows[1]?.off).toBe(false);
    });
    it('reads each Account inline set as "{when}" over what it runs, from the trigger owner\'s list', () => {
        const rows = projectAccountTriggerRows({
            resolveWorkflowTitle: () => null,
            sets: [
                set('digest', { target: inline([{ kind: 'step', id: 'digest', name: 'Morning digest',
                    document: { text: 'Summarize project activity and include open issues.' } }]),
                    triggers: [daily('t1', '0 7 * * *'), daily('t2', '0 19 * * *')] }),
                set('off', { target: inline(['Weekly report']), triggers: [daily('t3', '0 9 * * 1', false)] }),
                set('gone', { health: 'source_unavailable', triggers: [daily('t4', '0 8 * * *')] }),
            ],
        });
        expect(rows).toEqual([
            {
                automationId: 'digest',
                triggerId: 't1',
                title: `workflows.triggers.summary.everyDayAt(time=${formatClockTime({ hour: 7, minute: 0 })})`,
                glyph: 'clock',
                subtitle: 'Morning digest',
                off: false,
            },
            expect.objectContaining({ automationId: 'digest', triggerId: 't2', title: `workflows.triggers.summary.everyDayAt(time=${formatClockTime({ hour: 19, minute: 0 })})` }),
            // Off when every trigger of the set is off, not only when the set is.
            expect.objectContaining({ automationId: 'off', off: true }),
            expect.objectContaining({ automationId: 'gone', subtitle: 'workflows.triggers.row.workflowUnavailable' }),
        ]);
    });
});

describe('accountTriggerRemoval', () => {
    const steps = inline(['Look at the logs']);
    it('removes an inline Workflow with its only trigger, so no empty Manual Workflow remains', () => {
        expect(accountTriggerRemoval(set('a1', { target: steps, triggers: [daily('t1', '0 3 * * *')] }), AutomationTriggerIdSchema.parse('t1')))
            .toEqual({ automationId: 'a1' });
    });
    it('removes only the trigger while the inline Workflow keeps other triggers', () => {
        expect(accountTriggerRemoval(set('a1', { target: steps, triggers: [daily('t1', '0 3 * * *'), daily('t2', '0 4 * * *')] }), AutomationTriggerIdSchema.parse('t1')))
            .toEqual({ automationId: 'a1', triggerId: 't1' });
    });
    it('keeps a saved Workflow\'s Manual set when its last trigger is removed', () => {
        expect(accountTriggerRemoval(set('a1', { target: { kind: 'workflow', ref: '11111111-1111-4111-8111-111111111111' }, triggers: [daily('t1', '0 3 * * *')] }), AutomationTriggerIdSchema.parse('t1')))
            .toEqual({ automationId: 'a1', triggerId: 't1' });
    });
    it('removes the whole set for a Manual row with no trigger id', () => {
        expect(accountTriggerRemoval(set('a1', { target: steps }), null)).toEqual({ automationId: 'a1' });
    });
});
