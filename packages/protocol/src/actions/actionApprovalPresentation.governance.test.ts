import { expect, it } from 'vitest';

import { describeApprovalActionFields } from './actionApprovalPresentation.js';
import { getActionSpec } from './actionSpecs.js';
import { TEAM_CREATE_ACTION_ID_V1, TEAM_GROUP_UPDATE_ACTION_ID_V1 } from '../teams/actionIdsV1.js';

const teamId = '3d703df7-5a51-4be7-91ec-dc877ae861ab';
const accountId = 'f20c797b-449e-4aa6-8b89-01fcfcaed022';
const sessionId = '67cffe92-bd4e-4b28-8512-706b1cc4ab77';

it.each([
    { actionId: TEAM_CREATE_ACTION_ID_V1, actionArgs: { v: 1, name: 'Research', initialOwnerAccountId: accountId, requestKey: 'create' },
        path: 'initialOwnerAccountId', row: { value: accountId, reference: { kind: 'account', id: accountId } } },
    { actionId: 'session.access.context.set', actionArgs: { sessionId, primaryTeamId: teamId },
        path: 'primaryTeamId', row: { value: teamId, reference: { kind: 'team', id: teamId } } },
    { actionId: 'teams.update', actionArgs: { v: 1, teamId, description: null },
        path: 'description', row: { selectedOptions: [{ labelKey: 'common.none' }] } },
    { actionId: TEAM_GROUP_UPDATE_ACTION_ID_V1, actionArgs: { v: 1, teamId, groupId: accountId, description: null },
        path: 'description', row: { selectedOptions: [{ labelKey: 'common.none' }] } },
    { actionId: 'session.access.encryption.reprepare', actionArgs: { sessionId, recipientAccountId: accountId },
        path: 'recipientAccountId', row: { value: accountId, reference: { kind: 'account', id: accountId } } },
] as const)('projects the reviewed $path for $actionId', ({ actionId, actionArgs, path, row }) => {
    const fields = describeApprovalActionFields({ actionId, actionArgs: getActionSpec(actionId).inputSchema.parse(actionArgs) });
    const visible = fields.rows.find(field => field.kind === 'value' && !field.technical && field.path === path);
    expect(visible).toMatchObject(row);
});
