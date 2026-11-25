import { expect, it } from 'vitest';

import { describeApprovalActionFields } from './actionApprovalPresentation.js';
import { getActionSpec } from './actionSpecs.js';
import { homeAccountApprovalReferenceForField } from './specs/homeDomainRow.js';
import { TEAM_CREATE_ACTION_ID_V1, TEAM_GROUP_UPDATE_ACTION_ID_V1, TEAM_SETUP_RUN_ACTION_ID_V1 } from '../teams/actionIdsV1.js';

const teamId = '3d703df7-5a51-4be7-91ec-dc877ae861ab';
const accountId = 'f20c797b-449e-4aa6-8b89-01fcfcaed022';
const sessionId = '67cffe92-bd4e-4b28-8512-706b1cc4ab77';

it('reviews the initial Team owner through the Home directory and keeps the request key out of Details', () => {
    const actionId = TEAM_CREATE_ACTION_ID_V1;
    const ownerPath = 'initialOwnerAccountId';
    const requestKey = 'create-research';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({
        v: 1, name: 'Research', initialOwnerAccountId: accountId, requestKey,
    });
    const { rows } = describeApprovalActionFields({ actionId, actionArgs });
    const owner = rows.find(field => field.kind === 'value' && !field.technical && field.path === ownerPath);
    expect(owner).toMatchObject({
        value: accountId,
        reference: homeAccountApprovalReferenceForField(ownerPath)(ownerPath, accountId),
    });
    expect(JSON.stringify(rows)).not.toContain(requestKey);
});

it.each([
    { actionId: 'session.access.context.set', actionArgs: { sessionId, primaryTeamId: teamId },
        path: 'primaryTeamId', row: { value: teamId, reference: { kind: 'team', id: teamId } } },
    { actionId: 'teams.update', actionArgs: { v: 1, teamId, description: null },
        path: 'description', row: { selectedOptions: [{ labelKey: 'common.none' }] } },
    { actionId: TEAM_GROUP_UPDATE_ACTION_ID_V1, actionArgs: { v: 1, teamId, groupId: accountId, description: null },
        path: 'description', row: { selectedOptions: [{ labelKey: 'common.none' }] } },
    { actionId: 'session.access.encryption.reprepare', actionArgs: { sessionId, recipientAccountId: accountId },
        path: 'recipientAccountId', row: { value: accountId, reference: { kind: 'account', id: accountId } } },
    { actionId: 'machines.pools.update', actionArgs: { poolId: teamId, expectedRevision: 1, name: 'Build farm', members: [] },
        path: 'description', row: { valueFormat: 'clear' } },
] as const)('projects the reviewed $path for $actionId', ({ actionId, actionArgs, path, row }) => {
    const fields = describeApprovalActionFields({ actionId, actionArgs: getActionSpec(actionId).inputSchema.parse(actionArgs) });
    const visible = fields.rows.find(field => field.kind === 'value' && !field.technical && field.path === path);
    expect(visible).toMatchObject(row);
});

it('reviews the selected Workspace without exposing the checkout correlation ID', () => {
    const actionId = TEAM_SETUP_RUN_ACTION_ID_V1;
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ serverId: teamId, homeId: teamId, machineId: accountId,
        repositories: [{ id: teamId, input: { serverId: teamId, machineId: accountId,
            source: { kind: 'workspace', workspaceId: sessionId, checkout: {
                v: 2, kind: 'managed', serverId: teamId, workspaceId: sessionId, rootPath: '/work/tree',
                managedId: accountId, controller: { machineId: accountId, installationId: teamId },
            } }, materialization: { kind: 'sync', targetPath: '/work/target',
                workspaceAction: { kind: 'relationship', relationshipId: teamId, flushBeforeCommit: true } },
        } }],
    });
    const row = describeApprovalActionFields({ actionId, actionArgs, status: 'open' }).rows.find(row => row.path === 'repositories');
    expect(row).toMatchObject({ kind: 'value', entries: expect.arrayContaining([
        expect.objectContaining({ label: 'Id', value: teamId, technical: true }),
        expect.objectContaining({ reference: { kind: 'workspace', id: sessionId, unavailableWithoutName: true } }),
        expect.objectContaining({ reference: { kind: 'managedMachine', id: accountId, homeId: teamId } }),
        expect.objectContaining({ reference: { kind: 'workspaceSyncRelationship', id: teamId } }),
        expect.objectContaining({ label: 'Installation id', value: teamId, technical: true }),
    ]) });
});

it('keeps Machine setup plan correlations out of the readable review', () => {
    const actionId = TEAM_SETUP_RUN_ACTION_ID_V1;
    const digest = 'a'.repeat(64);
    const actionArgs = getActionSpec(actionId).inputSchema.parse({
        serverId: teamId, homeId: teamId, machineId: accountId, repositories: [],
        machine: { homeId: teamId, machineId: accountId, targets: [{
            homeId: teamId, machineId: accountId, sources: [{ kind: 'direct', setup: {} }], desiredRevision: 1,
            recipePlans: [{ sourceIndex: 1, itemIndex: 1, plan: {
                v: 1, basis: { kind: 'bootstrap', managedId: accountId, operationId: teamId, admittedInputDigest: digest },
                steps: [{ id: sessionId, kind: 'user', username: 'setup-user' }],
                nativeFacts: [{ stepId: sessionId, status: 'satisfied', facts: {} }], planDigest: digest,
            } }],
        }] },
    });
    const row = describeApprovalActionFields({ actionId, actionArgs, status: 'open' }).rows.find(row => row.path === 'machine');
    expect(row).toMatchObject({ kind: 'value', entries: expect.arrayContaining([
        expect.objectContaining({ label: 'Operation id', value: teamId, technical: true }),
        expect.objectContaining({ label: 'Id', value: sessionId, technical: true }),
        expect.objectContaining({ label: 'Step id', value: sessionId, technical: true }),
        expect.objectContaining({ label: 'Username', value: 'setup-user' }),
    ]) });
});
