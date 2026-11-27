import { expect, it } from 'vitest';
import { createDeploymentEnvironmentHeaderV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PROJECT_SOURCE_MOVE_TO_TEAM_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { createDeploymentEnvironmentDetailV1 } from '../testing/v1.js';
import { createProjectSourceTeamMovePreparationV1 } from './projectSourceTeamMove.js';

const homeRefusal = {
    ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied', effectAttempted: false,
    failureCause: { phase: 'requester.home_read', errorClass: 'HttpStatusError',
        errorCode: 'credential_scope_denied', httpStatus: 403 },
} as const;

it('preserves the typed Home refusal when preparing reviewed Source move children', async () => {
    const unexpectedRead = async (): Promise<never> => { throw new Error('Read after Source refusal'); };
    const preparation = createProjectSourceTeamMovePreparationV1({
        accountId: 'account', credentialAuthorityKind: 'account', assertCurrent: () => {},
    }, {
        projectSourcesRead: async () => { throw createActionExecuteFailureError(homeRefusal); },
        deploymentAction: unexpectedRead, workflowAction: unexpectedRead, machineAccessAction: unexpectedRead,
        readDefaults: unexpectedRead, readArtifactContents: unexpectedRead, readApiTokens: unexpectedRead,
        isSameHome: (left, right) => left === right,
    });
    expect(await preparation.prepareHostReviewedChildren({
        actionId: PROJECT_SOURCE_MOVE_TO_TEAM_ACTION_ID_V1,
        input: { serverId: 'home', sourceId: 'source', teamId: 'team', expectedRevision: 2, requestKey: 'source-move', clientId: 'answering-app' },
        context: {},
    })).toEqual(homeRefusal);
});

it.each([
    {
        name: 'missing',
        opened: { status: 'fulfilled', value: null },
        expected: {
            ok: false, errorCode: 'deployment_content_unavailable', error: 'deployment_content_unavailable',
            failureCause: {
                phase: 'deployment.artifact.missing', errorCode: 'deployment_content_unavailable', errorClass: 'TypeError', httpStatus: null,
            },
        },
    },
    {
        name: 'refused by the Home',
        opened: { status: 'rejected', reason: createActionExecuteFailureError(homeRefusal) },
        expected: homeRefusal,
    },
] as const)('keeps the typed cause when the Environment Artifact for a Source move is $name', async ({ opened, expected }) => {
    const accountId = 'account';
    const input = { serverId: 'home', sourceId: 'source', teamId: 'team', expectedRevision: 2, requestKey: 'source-move' };
    const environment = createDeploymentEnvironmentHeaderV1({ serverId: input.serverId, projectSourceId: input.sourceId });
    const unexpectedRead = async (): Promise<never> => { throw new Error('Read after Environment refusal'); };
    const preparation = createProjectSourceTeamMovePreparationV1({
        accountId, credentialAuthorityKind: 'account', assertCurrent: () => {},
    }, {
        projectSourcesRead: async () => ProjectSourcesReadOutputV1Schema.parse({
            ok: true, canManage: true, source: {
                id: input.sourceId, revision: input.expectedRevision, name: 'Source',
                owner: { kind: 'account', accountId }, audience: [], createdByAccountId: accountId,
            },
        }),
        deploymentAction: async (actionId) => {
            if (actionId === 'deployments.environments.list') return { ok: true, items: [environment], nextCursor: null };
            if (actionId === 'deployments.environments.get') return {
                ok: true, environment, targetLinks: [], retainedTargetLinkCleanupCompleteIds: [],
            };
            if (actionId === 'deployments.receipts.list') return { ok: true, items: [], nextCursor: null };
            return unexpectedRead();
        },
        workflowAction: unexpectedRead, machineAccessAction: unexpectedRead, readApiTokens: unexpectedRead,
        readDefaults: async () => ({
            ok: true, projectSourceId: input.sourceId, sourceRevision: input.expectedRevision, revision: 0, content: null,
        }),
        readArtifactContents: async (ids) => ids.map(() => opened),
        isSameHome: (left, right) => left === right,
    });
    expect(await preparation.prepareHostReviewedChildren({
        actionId: PROJECT_SOURCE_MOVE_TO_TEAM_ACTION_ID_V1, input, context: {},
    })).toEqual(expected);
});

it('refuses a foreign Environment receipt before reading Artifacts for Source Move', async () => {
    const accountId = 'account';
    const input = { serverId: 'home', sourceId: 'source', teamId: 'team', expectedRevision: 2, requestKey: 'source-move' };
    const environment = createDeploymentEnvironmentHeaderV1({ serverId: input.serverId, projectSourceId: input.sourceId });
    const unexpectedRead = async (): Promise<never> => { throw new Error('Read after history refusal'); };
    const preparation = createProjectSourceTeamMovePreparationV1({
        accountId, credentialAuthorityKind: 'account', assertCurrent: () => {},
    }, {
        projectSourcesRead: async () => ProjectSourcesReadOutputV1Schema.parse({
            ok: true, canManage: true, source: {
                id: input.sourceId, revision: input.expectedRevision, name: 'Source',
                owner: { kind: 'account', accountId }, audience: [], createdByAccountId: accountId,
            },
        }),
        deploymentAction: async actionId => {
            if (actionId === 'deployments.environments.list') return { ok: true, items: [environment], nextCursor: null };
            if (actionId === 'deployments.environments.get') return {
                ok: true, environment, targetLinks: [], retainedTargetLinkCleanupCompleteIds: [],
            };
            if (actionId === 'deployments.receipts.list') return { ok: true, items: [
                createDeploymentReceiptHeaderV1({ environmentId: environment.id }),
                createDeploymentReceiptHeaderV1({ id: 'foreign-receipt', environmentId: 'foreign-environment' }),
            ], nextCursor: null };
            return unexpectedRead();
        },
        workflowAction: unexpectedRead, machineAccessAction: unexpectedRead, readApiTokens: unexpectedRead,
        readDefaults: unexpectedRead, readArtifactContents: unexpectedRead, isSameHome: (left, right) => left === right,
    });
    expect(await preparation.prepareHostReviewedChildren({
        actionId: PROJECT_SOURCE_MOVE_TO_TEAM_ACTION_ID_V1, input, context: {},
    })).toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
});

it.each(['Machine access', 'Workflows'] as const)('preserves the typed %s inventory refusal during Source Move review', async (port) => {
    const accountId = 'account';
    const input = { serverId: 'home', sourceId: 'source', teamId: 'team', expectedRevision: 2, requestKey: 'source-move' };
    const environment = createDeploymentEnvironmentHeaderV1({ serverId: input.serverId, projectSourceId: input.sourceId,
        ...(port === 'Workflows' ? { deletedAtMs: 2000 } : {}) });
    const { content } = createDeploymentEnvironmentDetailV1({ environment });
    const artifact = {
        artifactId: environment.contentArtifactId, revision: { headerVersion: 1, bodyVersion: 1 },
        header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Staging' }, body: JSON.stringify(content),
    };
    const workflowRefusal = { ...homeRefusal, errorCode: 'run_access_denied', error: 'Workflow reads are denied' } as const;
    const unexpectedRead = async (): Promise<never> => { throw new Error('Read after inventory refusal'); };
    const preparation = createProjectSourceTeamMovePreparationV1({
        accountId, credentialAuthorityKind: 'account', assertCurrent: () => {},
    }, {
        projectSourcesRead: async () => ProjectSourcesReadOutputV1Schema.parse({
            ok: true, canManage: true, source: {
                id: input.sourceId, revision: input.expectedRevision, name: 'Source',
                owner: { kind: 'account', accountId }, audience: [], createdByAccountId: accountId,
            },
        }),
        deploymentAction: async (actionId) => {
            if (actionId === 'deployments.environments.list') return { ok: true, items: [environment], nextCursor: null };
            if (actionId === 'deployments.environments.get') return {
                ok: true, environment, targetLinks: [], retainedTargetLinkCleanupCompleteIds: [],
            };
            if (actionId === 'deployments.receipts.list') return { ok: true, items: [], nextCursor: null };
            return unexpectedRead();
        },
        machineAccessAction: port === 'Machine access' ? async () => homeRefusal : unexpectedRead,
        workflowAction: async () => workflowRefusal,
        readApiTokens: async () => [],
        readDefaults: async () => ({
            ok: true, projectSourceId: input.sourceId, sourceRevision: input.expectedRevision, revision: 0, content: null,
        }),
        readArtifactContents: async ids => ids.map(() => ({ status: 'fulfilled', value: artifact })),
        isSameHome: (left, right) => left === right,
    });
    expect(await preparation.prepareHostReviewedChildren({
        actionId: PROJECT_SOURCE_MOVE_TO_TEAM_ACTION_ID_V1, input, context: {},
    }), port).toEqual(port === 'Machine access' ? homeRefusal : workflowRefusal);
});
