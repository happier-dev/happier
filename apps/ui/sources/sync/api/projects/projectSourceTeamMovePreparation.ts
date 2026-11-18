import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createProjectSourceTeamMovePreparationV1 } from '@happier-dev/deployment-protocol/v1';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createProjectSourceActionDeps } from './projectSourceActions';
import { readProjectSourceTeamApiTokens } from './projectSourceTeamAuthority';
import { readUiProjectDeploymentDefaults } from './projectDeploymentDefaultsRead';

export { moveFailure, ProjectSourceTeamMoveReadFailure } from '@happier-dev/deployment-protocol/v1';
export type ProjectSourceTeamMoveReadPorts = Required<Pick<ActionExecutorDeps,
    'deploymentAction' | 'workflowAction' | 'machineAccessAction'>>;

/** App transport supplies opened Account content to the shared Source-move preparation owner. */
export function createProjectSourceTeamMovePreparation(account: LazyActionAccountContext, ports: ProjectSourceTeamMoveReadPorts) {
    return createProjectSourceTeamMovePreparationV1(account, {
        ...ports, projectSourcesRead: createProjectSourceActionDeps(account).projectSourcesRead,
        isSameHome: areServerProfileIdentifiersEquivalent,
        readDefaults: (sourceId, context) => readUiProjectDeploymentDefaults(account, sourceId, context),
        readArtifactContents: (ids, context) => account.readArtifactContents(ids, { signal: context.signal }),
        readApiTokens: async (environmentIds, context) => {
            const response = await readProjectSourceTeamApiTokens({ account, environmentIds, context });
            return 'errorCode' in response ? response : response.tokens;
        },
    });
}
