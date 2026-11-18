import { describe, expect, it, vi } from 'vitest';
import { normalizeWorkflowIngress} from '@happier-dev/protocol/workflows/workflowValidationV1';
import { type WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { WORKFLOW_STARTER_EXAMPLES_V1, materializeWorkflowStarterExample } from '@happier-dev/protocol/workflows/builtins/examples';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const { describeLegacyTriggerSet, describeTriggerTarget, isWorkflowTriggerSourceGone } = await import('./sessionTriggerGroups');
const { buildTriggerTarget, readTriggerThen } = await import('./sessionTriggerForm');

function inline(blocks: unknown[]) {
    const outcome = normalizeWorkflowIngress({ version: 1, blocks });
    if (outcome.kind !== 'parsed') throw new Error('fixture must normalize');
    return { kind: 'inline' as const, definition: outcome.definition };
}

function daily(id: string, scheduleExpr: string) {
    return {
        id, revision: 1, enabled: true, createdAt: 1, updatedAt: 1, kind: 'schedule', triggerDefinitionEnvelope: null, nextRunAt: null,
        schedule: { kind: 'cron', scheduleExpr, everyMs: null, timezone: null },
    };
}

function set(automationId: string, overrides: Record<string, unknown>): WorkflowTriggerSetV1 {
    return { automationId, revision: 3, enabled: true, health: 'available', triggers: [], ...overrides } as unknown as WorkflowTriggerSetV1;
}

describe('isWorkflowTriggerSourceGone', () => {
    it('is the source-lookup result for a current trigger, and never for a retained 0.2 automation', () => {
        expect(isWorkflowTriggerSourceGone({ health: 'source_unavailable' })).toBe(true);
        expect(isWorkflowTriggerSourceGone({ health: 'available' })).toBe(false);
        expect(isWorkflowTriggerSourceGone({ health: 'source_unavailable', legacy: { editable: false, reason: 'created_in_0_2' } })).toBe(false);
    });
});

describe('trigger row naming', () => {
    it('names unresolved workflow targets without displaying their private reference id', () => {
        const target = { kind: 'workflow' as const, ref: '2364abf8-14b8-4877-8f00-a11111111111' };
        expect(describeTriggerTarget(target, () => null)).toBe('workflows.triggers.then.runWorkflow');
        expect(describeTriggerTarget(target, () => 'Nightly review')).toBe('Nightly review');
        expect(describeTriggerTarget(undefined, () => null)).toBe('workflows.triggers.row.workflowUnavailable');
    });
    it('keeps an upkeep example named separately from its complete prompt through compact trigger editing', () => {
        const example = WORKFLOW_STARTER_EXAMPLES_V1.find((entry) => entry.key === 'memory-upkeep-in-session')!;
        const selection = materializeWorkflowStarterExample(example, {
            session: { serverId: 'portable-home', sessionId: 'session-1', machineId: 'machine-1' }, timezone: 'Europe/Amsterdam',
        });
        if (selection.status !== 'ready') throw new Error('upkeep example must materialize');
        const target = buildTriggerTarget(readTriggerThen({ kind: 'inline', definition: selection.example.definition }));
        if (target?.kind !== 'inline') throw new Error('upkeep target must remain inline');
        expect(describeTriggerTarget(target, () => null)).toBe('Memory upkeep');
        expect(readTriggerThen(target)).toMatchObject({ kind: 'sendPrompt', prompt: example.definition.blocks[0]?.kind === 'step'
            ? example.definition.blocks[0].document.text : undefined });
    });
    it('uses authored prompt names and a generic title for unnamed prompts without deriving a title from the body', () => {
        expect(describeTriggerTarget(inline([{ kind: 'step', id: 'prompt', name: '  Release review  ',
            document: { text: 'Review all release changes and produce a detailed report.' } }]), () => null)).toBe('Release review');
        expect(describeTriggerTarget(inline(['Review all release changes and produce a detailed report.']), () => null))
            .toBe('workflows.triggers.then.sendPrompt');
    });
    it.each([
        ['session_key_required', 'workflows.triggers.row.sessionKeyRequired'],
        ['migration_required', 'workflows.triggers.row.templateRecoveryRequired'],
        ['decryption_failed', 'workflows.triggers.row.templateDecryptionFailed'],
    ] as const)('presents the typed %s legacy lock without calling it a deleted workflow', (lockedReason, title) => {
        const presentation = describeLegacyTriggerSet(set('locked', {
            legacy: { editable: false, reason: 'created_in_0_2', lockedReason },
            health: 'source_unavailable', triggers: [daily('locked', '0 9 * * *')],
        }));
        expect(presentation?.title).toBe(title);
        expect(presentation?.qualifier).toContain('workflows.triggers.row.legacyCreated');
    });
    it('names an inline Action target instead of returning an undefined row title', () => {
        expect(describeTriggerTarget(inline([{ kind: 'action', id: 'action-1', actionId: 'workflows.references.available', input: {} }]), () => null))
            .toBe('workflows.triggers.then.doAction');
    });
    it('keeps legacy content and placement visible without treating it as a deleted workflow', () => {
        const legacy = describeLegacyTriggerSet(set('legacy', { legacy: { editable: false, reason: 'created_in_0_2', placements: [
            { machineId: 'm1', directory: '/repo' }, { machineId: 'm2', directory: '/repo' },
        ] }, target: inline(['Review release\nInclude the changelog']), triggers: [{ ...daily('old', '0 9 * * *'), nextRunAt: Date.now() + 3_600_000 }] }),
        (id) => id === 'm1' ? 'Laptop' : null);
        const locked = describeLegacyTriggerSet(set('locked', { legacy: { editable: false, reason: 'created_in_0_2' },
            health: 'source_unavailable', triggers: [daily('locked', '0 9 * * *')] }));
        expect(legacy).toMatchObject({ title: 'Review release\nInclude the changelog' });
        expect(legacy?.qualifier).toContain('Laptop · /repo');
        expect(legacy?.qualifier).toContain('m2 · /repo');
        expect(legacy?.qualifier).toContain('workflows.triggers.row.nextRun');
        expect(locked?.title).not.toBe('workflows.triggers.row.workflowUnavailable');
        expect(locked?.qualifier).not.toContain('workflows.triggers.row.machines(count=0)');
    });
});
