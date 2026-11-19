import { PROJECT_SOURCE_MOVE_TO_TEAM_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ProjectSourcesMoveToTeamInputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { readProjectDeploymentDefaultsForHost } from '@/deployments/readProjectDeploymentDefaultsForHost';
import { AccountApiTokensListActionOutputV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { type DeploymentArtifactDocumentV1 } from '@happier-dev/deployments';
import { createProjectSourceTeamMovePreparationV1, selectProjectSourceTeamMoveApiTokensV1, moveFailure } from '@happier-dev/deployments';

type Request = Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0];
/** CLI supplies its existing Account readers; review facts and child operands have one domain owner. */
export async function prepareCliProjectSourceTeamMove(request: Request, host: Readonly<{
    accountId: string | null;
    credentialAuthorityKind: string;
    homeId: string;
    serverHttpBaseUrl: string;
    readDeps(): ActionExecutorDeps;
    isSameHomeId(id: string): boolean;
    assertCurrent(context: ActionExecutorContext): Promise<void>;
    openArtifact(id: string, context: ActionExecutorContext): Promise<DeploymentArtifactDocumentV1 | null>;
    headers(context: ActionExecutorContext, effectActionId: string,
        request: Readonly<{ method: string; path: string; body?: unknown }>):
        Promise<Readonly<Record<string, string>> | null>;
}>) {
    if (request.actionId !== PROJECT_SOURCE_MOVE_TO_TEAM_ACTION_ID_V1) return null;
    if (!host.accountId) return moveFailure('not_authenticated');
    const deps = host.readDeps();
    if (!deps.projectSourcesRead || !deps.deploymentAction || !deps.machineAccessAction || !deps.workflowAction
        || !deps.accountApiTokensListAction) return moveFailure('admission_unavailable');
    const input = ProjectSourcesMoveToTeamInputV1Schema.parse(request.input);
    const preparation = createProjectSourceTeamMovePreparationV1({ accountId: host.accountId,
        credentialAuthorityKind: host.credentialAuthorityKind, invocationSignal: request.context.signal, assertCurrent: host.assertCurrent }, {
        projectSourcesRead: deps.projectSourcesRead, deploymentAction: deps.deploymentAction,
        machineAccessAction: deps.machineAccessAction, workflowAction: deps.workflowAction,
        isSameHome: (left, right) => host.isSameHomeId(left) && host.isSameHomeId(right),
        readArtifactContents: (ids, context) => Promise.allSettled(ids.map(id => host.openArtifact(id, context))),
        readDefaults: (sourceId, context) => readProjectDeploymentDefaultsForHost(host, sourceId, context, PROJECT_SOURCE_MOVE_TO_TEAM_ACTION_ID_V1),
        readApiTokens: async (environmentIds, context) => {
            const response = await deps.accountApiTokensListAction!({ input: { includeChildren: true }, context, signal: context.signal });
            const failure = readActionFailureEnvelope(response);
            return failure ?? selectProjectSourceTeamMoveApiTokensV1(AccountApiTokensListActionOutputV1Schema.parse(response).tokens, environmentIds);
        },
    });
    const children = await preparation.prepareHostReviewedChildren({ ...request, input });
    if (!children || 'ok' in children) return children;
    const preview = await preparation.buildApprovalPreview(input, request.context, {});
    const failure = readActionFailureEnvelope(preview);
    return failure ?? { ...children, approvalPreview: StrictJsonValueSchema.parse(preview) };
}
