import { describe, expect, it, vi } from 'vitest';
import { WorkflowTriggerSetV1Schema, type WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { WorkflowDefinitionListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const { describeAccountWorkflowLibraryRecord, projectWorkflowLibraryRecords } = await import('./workflowLibraryCollection');

const schedule = (id: string, hour: number) => ({ id, revision: 1, enabled: true, createdAt: 1, updatedAt: 1, kind: 'schedule',
    triggerDefinitionEnvelope: null, nextRunAt: null,
    schedule: { kind: 'cron', scheduleExpr: `0 ${hour} * * *`, everyMs: null, timezone: null } });
function set(automationId: string, overrides: Record<string, unknown>): WorkflowTriggerSetV1 {
    return WorkflowTriggerSetV1Schema.parse({ automationId, revision: 1, enabled: true, health: 'available', triggers: [schedule('t1', 9)], ...overrides });
}
const project = (accountTriggers: readonly WorkflowTriggerSetV1[]) => projectWorkflowLibraryRecords({
    definitions: { library: [], sharedWithYou: [] }, accountTriggers, summaries: null, automationSummaries: null });

describe('retained triggers whose Workflow is gone', () => {
    it('presents deployment observer identity names as Events while retaining each distinct enrollment', () => {
        // Account C/#164: each Environment has separate failed/succeeded observation-only definitions.
        const observers = ['cmwg2ttqc01hwmcswcfldvi20', 'cmwg2l6dk01efmcswm2v53btb'].flatMap(environmentId =>
            ['deployment-failed', 'deployment-succeeded'].map(localId => set(`${environmentId}-${localId}`, {
                name: environmentId,
                observationOnly: { kind: 'observationOnly', templateVersion: 1,
                    deploymentEnvironment: { serverId: 'home', projectSourceId: 'project', environmentId } },
                triggers: [{ id: `${environmentId}-${localId}`, revision: 0, enabled: true, createdAt: 1, updatedAt: 1,
                    kind: 'pluginEvent', eventRef: { pluginId: 'happier.machine.services', localId },
                    sourceSelectorId: '00000000-0000-4000-8000-000000000002', sourceContractVersion: 1,
                    observation: { kind: 'checkpointedPull', watcher: null }, sourceStatus: null, sourceCatalogStatus: null,
                    // Opaque persisted Event content is not opened by the Library projection.
                    triggerDefinitionEnvelope: 'retained-event-envelope' }],
            })));
        const authored = set('authored', { ...observers[0], automationId: 'authored', name: 'Production alerts' });
        const rows = project([...observers, authored]);
        expect(rows).toHaveLength(5);
        expect(rows.filter(row => row.key !== 'account-trigger:authored').map(row => row.name))
            .toEqual(Array(4).fill('workflows.triggers.kind.pluginEvent'));
        expect(rows.find(row => row.key === 'account-trigger:authored')?.name).toBe('Production alerts');
    });

    it('lists a definition once across list sources and presents unreadable earlier-build content', () => {
        const definitionId = 'cmwg2ttqc01hwmcswcfldvi20';
        const { definitions } = WorkflowDefinitionListResultV1Schema.parse({ definitions: [{
            kind: 'workflow-definition.v1', definitionId, revision: null, metadata: { title: definitionId },
            triggers: [], nextRunAt: null, contentStatus: 'unavailable', stepCount: null,
            contentUnavailableReason: 'history_not_readable',
        }] });
        const rows = projectWorkflowLibraryRecords({ definitions: { library: definitions, sharedWithYou: definitions },
            accountTriggers: [], summaries: null, automationSummaries: null });
        expect(rows.map(row => row.name)).toEqual(['workflows.readState.historyTitle']);
    });
    it('lists overlapping trigger sources once', () => {
        const trigger = set('overlap', { name: 'Morning digest' });
        expect(project([trigger, trigger])).toHaveLength(1);
    });

    it('publishes the first count only after both inventories have settled', () => {
        const input = { definitions: { library: [], sharedWithYou: [] },
            accountTriggers: [set('digest', { name: 'Morning digest' })], summaries: null, automationSummaries: null };
        expect(projectWorkflowLibraryRecords({ ...input, inventoryPending: true })).toEqual([]);
        const settled = projectWorkflowLibraryRecords(input);
        expect(projectWorkflowLibraryRecords({ ...input, inventoryPending: true, previous: settled })).toBe(settled);
        expect(projectWorkflowLibraryRecords(input))
            .toMatchObject([{ key: 'account-trigger:digest', group: 'library' }]);
    });

    it('names an unnamed standalone Action and describes its before trigger without a saved Workflow', () => {
        const standalone = set('action-only', {
            target: { kind: 'inline', definition: { version: 1, inputs: [], blocks: [
                { kind: 'action', id: 'notify', actionId: 'notifications.notify_me',
                    input: { message: { kind: 'literal', value: 'The review is ready' } } },
            ] } },
            triggers: [{ id: 'before', kind: 'action', phase: 'before', actionIds: ['machines.command.run'],
                mode: 'wait', enabled: true, revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        expect(describeAccountWorkflowLibraryRecord(standalone)).toMatchObject({
            name: 'workflows.triggers.then.notifyMe',
            triggerSummary: expect.stringContaining('workflows.triggers.link.beforeAction'),
        });
    });

    it('reserves the linked Workflow row until its definition supplies the name', () => {
        const definitionId = '11111111-1111-4111-8111-111111111111';
        const input = { definitions: { library: [], sharedWithYou: [] },
            accountTriggers: Array.from({ length: 63 }, (_, index) => set(`linked-${index}`, {
                target: { kind: 'workflow', ref: definitionId },
            })), summaries: null, automationSummaries: null };
        expect(projectWorkflowLibraryRecords({ ...input, savedLibraryIncomplete: true })).toEqual([]);
        const { definitions } = WorkflowDefinitionListResultV1Schema.parse({ definitions: [{
            kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
            metadata: { title: 'Deploy verification' }, triggers: [], nextRunAt: null,
            contentStatus: 'available', stepCount: 1,
        }] });
        expect(projectWorkflowLibraryRecords({ ...input, definitions: { library: definitions, sharedWithYou: [] } }))
            .toMatchObject([{ key: definitionId, group: 'library', name: 'Deploy verification' }]);
    });

    it('labels an unreadable legacy record by its state rather than its stored identity', () => {
        const legacy = set('cmwg2ttqc01hwmcswcfldvi20', { name: 'cmwg2ttqc01hwmcswcfldvi20',
            health: 'source_unavailable', legacy: { editable: false, reason: 'created_in_0_2', lockedReason: 'decryption_failed' } });
        const rows = project([legacy]);
        expect(rows[0]?.name).toBe('workflows.triggers.row.templateDecryptionFailed');
    });
    it('reads the same for a deleted and a revoked Workflow: nothing tells the two apart', () => {
        const row = (automationId: string) => {
            const [record] = project([set(automationId, { health: 'source_unavailable' })]);
            if (!record || !('accountTrigger' in record)) throw new Error('Expected a retained trigger row');
            const { key: _key, accountTrigger: _set, openTarget, triggerOpenTargets, ...shown } = record;
            return { ...shown, triggerIds: [openTarget.triggerId, ...triggerOpenTargets.map(target => target.triggerId)] };
        };
        expect(row('deleted-source')).toEqual(row('revoked-source'));
        expect(row('deleted-source')).toMatchObject({ name: 'workflows.triggers.row.workflowUnavailable', group: 'library' });
    });

    it('is one row that removes the whole retained set, however many triggers it held', () => {
        const [record] = project([set('gone', { health: 'source_unavailable', triggers: [schedule('t1', 9), schedule('t2', 19)] })]);
        if (!record || !('accountTrigger' in record)) throw new Error('Expected a retained trigger row');
        expect(record.triggerOpenTargets).toEqual([{ kind: 'accountTrigger', automationId: 'gone', triggerId: null }]);
        expect(record.openTarget).toEqual({ kind: 'accountTrigger', automationId: 'gone', triggerId: null });
    });

    it('never renames a healthy trigger or a retained 0.2 automation', () => {
        const named = project([
            set('healthy', { name: 'Morning digest', target: { kind: 'workflow', ref: '11111111-1111-4111-8111-111111111111' } }),
            set('legacy', { name: 'Old cleanup', health: 'source_unavailable', legacy: { editable: false, reason: 'created_in_0_2', lockedReason: 'review_required' } }),
        ]);
        expect(named.map(row => row.name).sort()).toEqual(['Morning digest', 'Old cleanup']);
    });
});
