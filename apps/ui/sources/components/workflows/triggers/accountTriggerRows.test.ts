import { describe, expect, it, vi } from 'vitest';
import { normalizeWorkflowIngress} from '@happier-dev/protocol/workflows/workflowValidationV1';
import { WorkflowTriggerSetV1Schema, type WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
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
    it('projects a saved Action attachment through the ordinary trigger row owner', () => {
        const trigger = AutomationActionTriggerSchema.parse({ kind: 'action', phase: 'before', mode: 'wait', onFailure: 'ask',
            actionIds: ['machines.command.run'] });
        const rows = projectAccountTriggerRows({ resolveWorkflowTitle: () => 'Shared check', sets: [
            set('action-check', { target: { kind: 'workflow', ref: '00000000-0000-4000-8000-000000000001' },
                triggers: [{ ...trigger, id: 'action-trigger', revision: 1, enabled: true, createdAt: 1, updatedAt: 1 }] }),
        ] });
        expect(rows).toMatchObject([{ automationId: 'action-check', triggerId: 'action-trigger', subtitle: 'Shared check', off: false }]);
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

describe('projectAccountTriggerRows subject', () => {
    it('keeps saved repository deployment triggers with their fixed destination Environment', () => {
        const triggerId = 'repository-push';
        const push = set('push', { project: { machineId: 'controller', directory: '~' },
            target: inline([{ kind: 'action', id: 'deploy', actionId: 'deployments.deploy', input: {} }]),
            context: { workspace: { directory: '~' }, executionTarget: { kind: 'detached_run' },
                inputs: { serverId: 'home', environmentId: 'staging', targetLinkId: 'runtime' },
                deploymentTriggers: [{ triggerId }] },
            triggers: [{ id: triggerId, revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
                kind: 'pluginEvent', triggerDefinitionEnvelope: 'private',
                sourceSelectorId: 'repository', sourceContractVersion: 1, observation: { kind: 'checkpointedPull', watcher: null },
                sourceStatus: null, sourceCatalogStatus: null,
                eventRef: { pluginId: 'happier.scm.forge.github', localId: 'automation/repository-pushed-v1' } }],
        });
        expect(projectAccountTriggerRows({ sets: [push], resolveWorkflowTitle: () => null,
            subject: { kind: 'environment', machineId: 'controller', environmentId: 'staging' },
        }).map(row => row.triggerId)).toEqual([triggerId]);
        expect(projectAccountTriggerRows({ sets: [push], resolveWorkflowTitle: () => null,
            subject: { kind: 'environment', machineId: 'controller', environmentId: 'production' },
        })).toEqual([]);
    });
    it('keeps scheduled service commands with their exact Environment and excludes unrelated schedules on the same Machine', () => {
        const command = set('app-job', { project: { machineId: 'app-host', directory: '~' },
            target: inline([{ kind: 'action', id: 'job', actionId: 'machines.services.exec', input: {
                serverId: { kind: 'literal', value: 'home' }, machineId: { kind: 'literal', value: 'app-host' },
                target: { kind: 'literal', value: { kind: 'current', serviceId: 'instance/web', expectedGeneration: 'release' } },
                mode: { kind: 'literal', value: 'exec' }, argv: { kind: 'literal', value: ['task', 'run'] },
            } }]), triggers: [daily('job-schedule', '0 3 * * *')] });
        const unrelated = set('other', { project: command.project, target: inline(['Investigate']),
            triggers: [daily('unrelated-schedule', '0 3 * * *')] });
        const rows = projectAccountTriggerRows({ sets: [command, unrelated], resolveWorkflowTitle: () => null,
            subject: { kind: 'environment', machineId: 'controller', environmentId: 'production' },
            services: [{ machineId: 'app-host', serviceId: 'instance/web' }],
        });
        expect(rows.map(row => row.triggerId)).toEqual(['job-schedule']);
        expect(projectAccountTriggerRows({ sets: [command], resolveWorkflowTitle: () => null,
            subject: { kind: 'environment', machineId: 'controller', environmentId: 'staging' }, services: [],
        })).toEqual([]);
    });

    it('lists only each Event\'s exact Environment subject, independently of its execution Machine', () => {
        const event = (id: string) => set('fixture', { triggers: [{ id, revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
            kind: 'pluginEvent', eventRef: { pluginId: 'happier.machine.services', localId: 'deployment-failed' },
            sourceSelectorId: id, sourceContractVersion: 1, observation: { kind: 'checkpointedPull', watcher: null },
            sourceStatus: null, sourceCatalogStatus: null, triggerDefinitionEnvelope: 'private' }] }).triggers[0]!;
        const sets = [{ ...set('mixed', { project: { machineId: 'controller', directory: '~' } }), triggers: [
            { ...event('production'), subject: { kind: 'environment' as const, environmentId: 'production' } },
            { ...event('staging'), subject: { kind: 'environment' as const, environmentId: 'staging' } },
            event('unknown'),
        ] }, set('unscoped', { project: { machineId: 'same-target', directory: '~' }, triggers: [daily('schedule', '0 9 * * *')] })];
        expect(projectAccountTriggerRows({ sets, resolveWorkflowTitle: () => null,
            subject: { kind: 'environment', machineId: 'same-target', environmentId: 'production' } })
            .map(row => row.triggerId)).toEqual(['production']);
        expect(projectAccountTriggerRows({ sets, resolveWorkflowTitle: () => null })
            .map(row => row.triggerId)).toEqual(['production', 'staging', 'unknown', 'schedule']);
        expect(projectAccountTriggerRows({ sets, resolveWorkflowTitle: () => null,
            subject: { kind: 'machine', machineId: 'controller' } }).map(row => row.triggerId))
            .toEqual(['production', 'staging', 'unknown']);
    });

    it("keeps only the sets that run on the subject Machine, by their project or any placement", () => {
        const rows = projectAccountTriggerRows({ resolveWorkflowTitle: () => null, subject: { kind: 'machine', machineId: 'm1' }, sets: [
            set('project-here', { project: { machineId: 'm1', directory: '~' }, triggers: [daily('a', '0 9 * * *')] }),
            set('placed-here', { placements: [{ machineId: 'm2', directory: '~' }, { machineId: 'm1', directory: '~/app' }], triggers: [] }),
            set('elsewhere', { project: { machineId: 'm2', directory: '~' }, triggers: [daily('b', '0 9 * * *')] }),
            set('nowhere', { triggers: [] }),
        ] });
        expect(rows.map((row) => row.automationId)).toEqual(['project-here', 'placed-here']);
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
