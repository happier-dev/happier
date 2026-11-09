import { describe, expect, it, vi } from 'vitest';
import { normalizeWorkflowIngress} from '@happier-dev/protocol/workflows/workflowValidationV1';
import { type WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { WORKFLOW_STARTER_EXAMPLES_V1, materializeWorkflowStarterExample } from '@happier-dev/protocol/workflows/builtins/examples';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const { projectSessionTriggerGroups, describeLegacyTriggerSet, describeTriggerTarget, isWorkflowTriggerSourceGone } = await import('./sessionTriggerGroups');
const { formatClockTime } = await import('./triggerSchedule');
const { buildTriggerTarget, readTriggerThen } = await import('./sessionTriggerForm');

function inline(blocks: unknown[]) {
    const outcome = normalizeWorkflowIngress({ version: 1, blocks });
    if (outcome.kind !== 'parsed') throw new Error('fixture must normalize');
    return { kind: 'inline' as const, definition: outcome.definition };
}

function lifecycle(id: string, events: string[], state = 'waiting', enabled = true) {
    return {
        id, revision: 1, enabled, createdAt: 1, updatedAt: 1, kind: 'sessionLifecycle', triggerDefinitionEnvelope: null,
        sourceSessionId: 'session-1', events, policy: { kind: 'everyMatch' }, remainingOccurrences: null,
        status: { state, runId: state === 'running' ? 'run-1' : null },
    };
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

describe('projectSessionTriggerGroups', () => {
    it('names unresolved workflow targets without displaying their private reference id', () => {
        const target = { kind: 'workflow' as const, ref: '2364abf8-14b8-4877-8f00-a11111111111' };
        expect(describeTriggerTarget(target, () => null)).toBe('workflows.triggers.then.runWorkflow');
        expect(describeTriggerTarget(target, () => 'Nightly review')).toBe('Nightly review');
        expect(describeTriggerTarget(undefined, () => null)).toBe('workflows.triggers.row.workflowUnavailable');
    });
    it('keeps an upkeep example named separately from its complete prompt through compact trigger editing', () => {
        const example = WORKFLOW_STARTER_EXAMPLES_V1.find((entry) => entry.key === 'memory-upkeep-in-session')!;
        const selection = materializeWorkflowStarterExample(example, {
            session: { sessionId: 'session-1', machineId: 'machine-1' }, timezone: 'Europe/Amsterdam',
        });
        if (selection.status !== 'ready') throw new Error('upkeep example must materialize');
        const target = buildTriggerTarget(readTriggerThen({ kind: 'inline', definition: selection.example.definition }));
        if (target?.kind !== 'inline') throw new Error('upkeep target must remain inline');
        const groups = projectSessionTriggerGroups({
            sets: [set('upkeep', { target, enabled: false, triggers: [daily('weekly', '0 9 * * 0')] })],
            lastRunAtByAutomationId: {}, resolveWorkflowTitle: () => null, formatAge: String,
        });
        expect(groups[0]?.rows[0]).toMatchObject({ title: 'Memory upkeep', enabled: false });
        expect(groups[0]?.title).toContain('workflows.triggers.summary.weeklyAt');
        expect(readTriggerThen(target)).toMatchObject({ kind: 'sendPrompt', prompt: example.definition.blocks[0]?.kind === 'step'
            ? example.definition.blocks[0].document.text : undefined });
    });
    it('uses authored prompt names and a generic title for unnamed prompts without deriving a title from the body', () => {
        const groups = projectSessionTriggerGroups({
            sets: [set('named', { target: inline([{ kind: 'step', id: 'prompt', name: '  Release review  ',
                document: { text: 'Review all release changes and produce a detailed report.' } }]), triggers: [daily('named', '0 9 * * *')] }),
            set('unnamed', { target: inline(['Review all release changes and produce a detailed report.']), triggers: [daily('unnamed', '0 9 * * *')] })],
            lastRunAtByAutomationId: {}, resolveWorkflowTitle: () => null, formatAge: String,
        });
        expect(groups[0]?.rows.map((row) => row.title)).toEqual(['Release review', 'workflows.triggers.then.sendPrompt']);
    });
    it.each([
        { failureUnseen: true, invocationAttentionRequired: false, attentionRequired: true, tone: 'danger' },
        { failureUnseen: false, invocationAttentionRequired: false, attentionRequired: false, tone: 'neutral' },
        { failureUnseen: false, invocationAttentionRequired: true, attentionRequired: true, tone: 'attention' },
    ] as const)('shows failed last-result attention from its owner: $tone', ({ tone, ...attention }) => {
        const groups = projectSessionTriggerGroups({ sets: [set('habit', { target: inline(['Digest']), triggers: [daily('daily', '0 9 * * *')] })],
            lastRunAtByAutomationId: { habit: 1000 }, lastRunsByAutomationId: { habit: createWorkflowRunSummaryFixture({ state: 'failed', ...attention }) },
            resolveWorkflowTitle: () => null, formatAge: String });
        expect(groups[0]?.rows[0]?.outcome).toMatchObject({ tone });
    });
    it('shows the scheduler-owned next occurrence on a current habit', () => {
        const groups = projectSessionTriggerGroups({
            sets: [set('habit', { target: inline(['Daily digest']), triggers: [{ ...daily('daily', '0 9 * * 1-5'), nextRunAt: Date.now() + 3_600_000 }] })],
            lastRunAtByAutomationId: {}, resolveWorkflowTitle: () => null, formatAge: String,
        });
        expect(groups[0]?.rows[0]?.qualifier).toContain('workflows.triggers.row.nextRun');
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
    it('keeps PR comments and CI failures grouped by their exact pull request, not just its number', () => {
        const groups = projectSessionTriggerGroups({
            sets: ['one/repo', 'other/repo'].flatMap((repository) => ['prComment', 'ciFailed'].map((kind) =>
                set(`${repository}:${kind}`, { target: inline(['Review']), triggers: [{
                    ...daily(`${repository}:${kind}`, '0 9 * * *'), kind,
                    pullRequest: { repository, number: 42 },
                }] }))),
            lastRunAtByAutomationId: {}, resolveWorkflowTitle: () => null, formatAge: String,
        });
        expect(groups).toHaveLength(4);
        expect(groups.every((group) => group.rows.length === 1)).toBe(true);
        expect(groups.map((group) => group.title)).toEqual(expect.arrayContaining([
            'workflows.triggers.kind.prComment · one/repo #42',
            'workflows.triggers.kind.ciFailed · other/repo #42',
        ]));
    });
    it('names an inline Action target instead of returning an undefined row title', () => {
        const groups = projectSessionTriggerGroups({
            sets: [set('action', { target: inline([{ kind: 'action', id: 'action-1', actionId: 'workflows.references.available', input: {} }]),
                triggers: [daily('action-trigger', '0 9 * * *')] })],
            lastRunAtByAutomationId: {}, resolveWorkflowTitle: () => null, formatAge: String,
        });
        expect(groups[0]?.rows[0]?.title).toBe('workflows.triggers.then.doAction');
    });
    it('keeps legacy content and placement visible without treating it as a deleted workflow', () => {
        const groups = projectSessionTriggerGroups({
            sets: [set('legacy', { legacy: { editable: false, reason: 'created_in_0_2', placements: [
                { machineId: 'm1', directory: '/repo' }, { machineId: 'm2', directory: '/repo' },
            ] }, target: inline(['Review release\nInclude the changelog']), triggers: [{ ...daily('old', '0 9 * * *'), nextRunAt: Date.now() + 3_600_000 }] }),
            set('locked', { legacy: { editable: false, reason: 'created_in_0_2' }, health: 'source_unavailable', triggers: [daily('locked', '0 9 * * *')] })],
            lastRunAtByAutomationId: {}, resolveWorkflowTitle: () => null, resolveMachineTitle: (id) => id === 'm1' ? 'Laptop' : null, formatAge: String,
        });
        const [legacy, locked] = groups[0]!.rows;
        expect(legacy).toMatchObject({ legacy: true, title: 'Review release\nInclude the changelog', sourceUnavailable: false });
        expect(legacy?.qualifier).toContain('Laptop · /repo');
        expect(legacy?.qualifier).toContain('m2 · /repo');
        expect(legacy?.qualifier).toContain('workflows.triggers.row.nextRun');
        expect(locked?.title).not.toBe('workflows.triggers.row.workflowUnavailable');
        expect(locked?.qualifier).not.toContain('workflows.triggers.row.machines(count=0)');
    });
    it('names each row by what it runs, one row per trigger under its event, turn events first', () => {
        const groups = projectSessionTriggerGroups({
            formatAge: (at) => `age:${at}`,
            lastRunAtByAutomationId: { ci: 1_000 },
            resolveWorkflowTitle: (ref) => (ref === 'builtin:review-and-converge' ? 'Review & converge' : null),
            sets: [
                set('ci', { target: inline(['Summarize overnight CI\nThen post it']), triggers: [daily('t-ci', '0 9 * * *')] }),
                set('review', { target: { kind: 'workflow', ref: 'builtin:review-and-converge' }, triggers: [lifecycle('t-review', ['parentTurnCompleted'], 'running')] }),
                set('notify', {
                    enabled: false,
                    target: inline([{ kind: 'action', id: 'notify', actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Done' } } }]),
                    triggers: [lifecycle('t-notify', ['parentTurnCompleted', 'parentTurnFailed'])],
                }),
                set('archive', { target: inline(['Post a summary']), triggers: [lifecycle('t-archive', ['sessionArchived'])] }),
                set('gone', { health: 'source_unavailable', triggers: [lifecycle('t-gone', ['userActionRequired'])] }),
            ],
        });

        expect(groups.map((group) => [group.id, group.glyph])).toEqual([
            ['lifecycle:turnEnds', 'arrows-clockwise'],
            ['lifecycle:needsYou', 'hand'],
            [`schedule:workflows.triggers.summary.everyDayAt(time=${formatClockTime({ hour: 9, minute: 0 })})`, 'clock'],
            ['lifecycle:sessionArchived', 'archive'],
        ]);
        expect(groups[0]!.rows.map((row) => [row.title, row.enabled, row.outcome?.text ?? null, row.revision])).toEqual([
            ['Review & converge', true, 'workflows.triggers.row.running', 3],
            // A turned-off set is off whatever its trigger says.
            ['workflows.triggers.then.notifyMe', false, null, 3],
        ]);
        expect(groups[1]!.rows[0]).toMatchObject({ title: 'workflows.triggers.row.workflowUnavailable', sourceUnavailable: true });
        expect(groups[2]!.rows[0]).toMatchObject({
            key: 'ci:t-ci', triggerId: 't-ci', title: 'workflows.triggers.then.sendPrompt',
            outcome: { text: 'workflows.triggers.row.ran(age=age:1000)', tone: 'neutral' },
        });
    });

    it('is empty for a session without triggers', () => {
        expect(projectSessionTriggerGroups({ sets: [], lastRunAtByAutomationId: {}, resolveWorkflowTitle: () => null, formatAge: String }))
            .toEqual([]);
    });
});
