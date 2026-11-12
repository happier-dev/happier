import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ProjectDeploymentDefaultsOutputV1Schema } from '@happier-dev/protocol/projects/projectDeploymentDefaultsV1';
import { createProjectSourceTeamMovePreparationV1, moveFailure } from '@happier-dev/deployment-protocol/v1';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { requestHomeDomain } from '@/sync/api/home/homeServerActionTransport';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { createProjectSourceActionDeps } from './projectSourceActions';
import { readProjectSourceTeamApiTokens } from './projectSourceTeamAuthority';

export { moveFailure, ProjectSourceTeamMoveReadFailure } from '@happier-dev/deployment-protocol/v1';
export type ProjectSourceTeamMoveReadPorts = Required<Pick<ActionExecutorDeps,
    'deploymentAction' | 'workflowAction' | 'machineAccessAction'>>;

/** App transport supplies opened Account content to the shared Source-move preparation owner. */
export function createProjectSourceTeamMovePreparation(account: LazyActionAccountContext, ports: ProjectSourceTeamMoveReadPorts) {
    return createProjectSourceTeamMovePreparationV1(account, {
        ...ports, projectSourcesRead: createProjectSourceActionDeps(account).projectSourcesRead,
        isSameHome: areServerProfileIdentifiersEquivalent,
        readDefaults: async (sourceId, context) => {
            const response = await requestHomeDomain({ scope: account.accountLifetime.scope,
                path: `/v1/projects/${encodeURIComponent(sourceId)}/deployment-defaults?serverId=${encodeURIComponent(account.serverIdentityId ?? account.serverId)}`,
                method: 'GET', input: undefined, schema: ProjectDeploymentDefaultsOutputV1Schema,
                effect: 'read', signal: context.signal, requestAuthority: account });
            return response.ok ? response.value : moveFailure(homeDomainFailureCode(response.failure));
        },
        readArtifactContents: (ids, context) => account.readArtifactContents(ids, { signal: context.signal }),
        readApiTokens: async (environmentIds, context) => {
            const response = await readProjectSourceTeamApiTokens({ account, environmentIds, context });
            return 'errorCode' in response ? response : response.tokens;
        },
    });
}
