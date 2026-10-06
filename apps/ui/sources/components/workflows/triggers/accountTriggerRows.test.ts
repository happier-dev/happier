import { describe, expect, it, vi } from 'vitest';
import { normalizeWorkflowIngress, type WorkflowTriggerSetV1 } from '@happier-dev/protocol';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const { projectAccountTriggerRows } = await import('./accountTriggerRows');

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
    return { automationId, revision: 1, enabled: true, health: 'available', triggers: [], ...overrides } as unknown as WorkflowTriggerSetV1;
}

describe('projectAccountTriggerRows', () => {
    it('names an inline document with declared inputs without flattening it to a form preset', () => {
        const base = inline([{ kind: 'step', id: 'digest',
            document: { text: 'Morning digest\nInclude open issues', references: [], attachments: [] },
            input: [], result: { kind: 'text' } }]);
        const target = { ...base, definition: { ...base.definition,
            inputs: [{ name: 'topic', valueType: 'string' as const, required: false }] } };
        const rows = projectAccountTriggerRows({ resolveWorkflowTitle: () => null,
            sets: [set('digest', { target, triggers: [] })] });
        expect(rows[0]?.subtitle).toBe('Morning digest');
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
        expect(rows[1]?.subtitle).not.toContain('workflows.triggers.row.workflowDeleted');
        expect(rows[1]?.off).toBe(false);
    });
    it('reads each Account inline set as "{when}" over what it runs, from the trigger owner\'s list', () => {
        const rows = projectAccountTriggerRows({
            resolveWorkflowTitle: () => null,
            sets: [
                set('digest', { target: inline(['Morning digest']), triggers: [daily('t1', '0 7 * * *'), daily('t2', '0 19 * * *')] }),
                set('off', { target: inline(['Weekly report']), triggers: [daily('t3', '0 9 * * 1', false)] }),
                set('gone', { health: 'source_unavailable', triggers: [daily('t4', '0 8 * * *')] }),
            ],
        });
        expect(rows).toEqual([
            {
                automationId: 'digest',
                triggerId: 't1',
                title: 'workflows.triggers.summary.everyDayAt(time=07:00)',
                glyph: 'clock',
                subtitle: 'Morning digest',
                off: false,
            },
            expect.objectContaining({ automationId: 'digest', triggerId: 't2', title: 'workflows.triggers.summary.everyDayAt(time=19:00)' }),
            // Off when every trigger of the set is off, not only when the set is.
            expect.objectContaining({ automationId: 'off', off: true }),
            expect.objectContaining({ automationId: 'gone', subtitle: 'workflows.triggers.row.workflowDeleted' }),
        ]);
    });
});
