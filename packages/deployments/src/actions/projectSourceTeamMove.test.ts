import { expect, it } from 'vitest';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PROJECT_SOURCE_MOVE_TO_TEAM_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { createProjectSourceTeamMovePreparationV1 } from './projectSourceTeamMove.js';

it('preserves the typed Home refusal when preparing reviewed Source move children', async () => {
    const refusal = {
        ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied', effectAttempted: false,
        failureCause: { phase: 'requester.home_read', errorClass: 'HttpStatusError',
            errorCode: 'credential_scope_denied', httpStatus: 403 },
    } as const;
    const unexpectedRead = async (): Promise<never> => { throw new Error('Read after Source refusal'); };
    const preparation = createProjectSourceTeamMovePreparationV1({
        accountId: 'account', credentialAuthorityKind: 'account', assertCurrent: () => {},
    }, {
        projectSourcesRead: async () => { throw createActionExecuteFailureError(refusal); },
        deploymentAction: unexpectedRead, workflowAction: unexpectedRead, machineAccessAction: unexpectedRead,
        readDefaults: unexpectedRead, readArtifactContents: unexpectedRead, readApiTokens: unexpectedRead,
        isSameHome: (left, right) => left === right,
    });
    expect(await preparation.prepareHostReviewedChildren({
        actionId: PROJECT_SOURCE_MOVE_TO_TEAM_ACTION_ID_V1,
        input: { serverId: 'home', sourceId: 'source', teamId: 'team', expectedRevision: 2, requestKey: 'source-move', clientId: 'answering-app' },
        context: {},
    })).toEqual(refusal);
});
