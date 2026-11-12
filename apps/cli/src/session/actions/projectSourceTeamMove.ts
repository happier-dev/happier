import { PROJECT_SOURCE_MOVE_TO_TEAM_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import axios from '@/api/client/credentialAxios';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ProjectSourcesMoveToTeamInputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { ProjectDeploymentDefaultsOutputV1Schema } from '@happier-dev/protocol/projects/projectDeploymentDefaultsV1';
import { AccountApiTokensListActionOutputV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { createProjectSourceTeamMovePreparationV1, selectProjectSourceTeamMoveApiTokensV1, moveFailure, type DeploymentArtifactDocumentV1 } from '@happier-dev/deployment-protocol/v1';

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
        readDefaults: async (sourceId, context) => {
            const homeId = context.externalActionExecutionAuthorization?.binding.serverIdentityId ?? host.homeId;
            const path = `/v1/projects/${encodeURIComponent(sourceId)}/deployment-defaults?serverId=${encodeURIComponent(homeId)}`;
            const headers = await host.headers(context, 'projects.sources.moveToTeam', { method: 'GET', path });
            if (!headers) return moveFailure('project_requester_authority_unavailable');
            const response = await axios.request<unknown>({ method: 'GET', url: `${host.serverHttpBaseUrl}${path}`,
                headers, signal: context.signal, validateStatus: () => true });
            return ProjectDeploymentDefaultsOutputV1Schema.parse(response.data);
        },
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
