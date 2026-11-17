import { describe, expect, it } from 'vitest';

import { createBackupVerifyWorkflowV1, createRestoreDrillWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/backupExamples';
import { WorkflowDefinitionV1Schema, type WorkflowActionLeafV1 } from '@happier-dev/protocol/workflows';
import { DeploymentBackupVerifyInputV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { DatabaseReadStatementInputV1Schema } from '@happier-dev/database-protocol';
import { DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';

import { resolveWorkflowActionFieldBinding, type WorkflowValueResolutionRuntime } from './input';

// Supplemental R6 input-owner proof only. D15/F4 still requires the real
// credentialed CLI -> Home Postgres -> daemon -> engine backup/restore journey.
async function bind(action: WorkflowActionLeafV1, inputs: WorkflowValueResolutionRuntime['inputs']) {
    const runtime: WorkflowValueResolutionRuntime = {
        inputs,
        async resolveResult() { throw new Error('These input bindings must not depend on another invocation'); },
        async resolveWorkspace() { throw new Error('These input bindings must not resolve a workspace'); },
    };
    return Object.fromEntries(await Promise.all(Object.entries(action.input)
        .map(async ([field, binding]) => [field, await resolveWorkflowActionFieldBinding(binding, runtime)])));
}

describe('saved backup Workflow semantic operands (R6)', () => {
    it('keeps exact backup verification identity after a saved-definition round trip', async () => {
        const saved = WorkflowDefinitionV1Schema.parse(JSON.parse(JSON.stringify(createBackupVerifyWorkflowV1())));
        const action = saved.blocks[0];
        if (action?.kind !== 'action') throw new Error('Backup verification starter must expose its native Action');
        const backupTarget = { serverId: 'home', environmentId: 'source-environment', machineId: 'source-machine',
            installationId: 'source-installation', expectedRevision: 4, targetLinkId: 'source-link',
            deploymentId: 'retained-source-deployment', configRevision: 2 };
        const expected = DeploymentBackupVerifyInputV1Schema.parse({ ...backupTarget,
            backupOperationId: 'retained-backup-operation', snapshotId: 'b'.repeat(64), level: 'manifestReadBack' });
        expect(DeploymentBackupVerifyInputV1Schema.parse(await bind(action, { backupTarget,
            backupOperationId: expected.backupOperationId, snapshotId: expected.snapshotId,
            verificationLevel: expected.level }))).toEqual(expected);
    });

    it('binds restored-data checks to the selected drill database with ordered lossless parameters', async () => {
        const saved = WorkflowDefinitionV1Schema.parse(JSON.parse(JSON.stringify(createRestoreDrillWorkflowV1())));
        const drill = saved.blocks.find(block => block.id === 'drill');
        if (drill?.kind !== 'parallel') throw new Error('Restore drill starter must retain its recovery branch');
        const branch = drill.branches.find(branch => branch.id === 'restoreAndCheck');
        const action = branch?.blocks.find(block => block.id === 'prepareRestore');
        if (action?.kind !== 'action') throw new Error('Restore drill starter must check restored data');
        const target = { kind: 'deployment_service', environment: { serverId: 'home', projectSourceId: 'drill-project',
            environmentId: 'drill-environment' }, targetLinkId: 'drill-link', deploymentId: 'retained-drill-deployment',
            serviceId: 'postgres', database: 'recovered' };
        const statement = { sql: 'SELECT $1::text, $2::text, $3::bigint, $4::text', parameters: [
            { type: 'text', value: 'last named parameter first' }, { type: 'null' },
            { type: 'integer', value: '9007199254740993' }, { type: 'text', value: '' },
        ] };
        const expected = DatabaseReadStatementInputV1Schema.parse({ operation: 'statement.run', mode: 'read', target, statement });
        expect(action.actionId).toBe(DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1);
        const operand = await bind(action, {
            backupTarget: { serverId: 'home', environmentId: 'source-environment', deploymentId: 'source-capture' },
            drillTarget: { serverId: 'home', projectSourceId: 'drill-project', environmentId: 'drill-environment',
                machineId: 'drill-machine', installationId: 'drill-installation',
                targetLinkId: 'drill-link', deploymentId: 'retained-drill-deployment', expectedRevision: 7 },
            restoreSource: { kind: 'repository', snapshotId: 'snapshot' },
            restoreDestination: { kind: 'database', service: 'postgres', database: 'recovered' },
            dataCheck: { target, statement },
        });
        expect(DatabaseReadStatementInputV1Schema.parse(operand.dataCheck)).toEqual(expected);
        expect(branch?.blocks.some(block => block.id === 'checkData')).toBe(false);
    });
});
