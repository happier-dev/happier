import { describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentMoveToRepositoryInputV1Schema } from '@happier-dev/protocol/deployments/deploymentMoveToRepositoryV1';
import { normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import { createDeploymentMoveToRepositoryForHost } from './moveToRepository';

describe('Move definition pre-effect refusal', () => {
  it.each(['source', 'authority'] as const)('preserves the typed %s refusal before repository work', async boundary => {
    const base = createDeploymentEnvironmentDetailV1();
    const definition = await normalizeStoredComposeDefinitionInput({ from: 'compose',
      document: 'services: {app: {image: nginx:1}}', profiles: [], services: ['app'] });
    const refusal = { ok: false as const, errorCode: 'action_forbidden', error: 'action_forbidden',
      requestId: 'move-source-refusal', failureCause: { phase: 'deployment.source.read',
        errorClass: 'Error' as const, errorCode: 'action_forbidden', httpStatus: 403 } };
    const unexpected = async (): Promise<never> => { throw new Error('Repository work must not start'); };
    // Source reads and authority acquisition are host boundaries; definition admission remains real.
    const move = createDeploymentMoveToRepositoryForHost({ serverId: 'home', machineId: 'machine',
      assertCurrent: async () => {},
      requireDefinitionManage: async () => {
        if (boundary === 'authority') throw Object.assign(new Error(refusal.errorCode, { cause: refusal }), { code: refusal.errorCode });
      },
      readEnvironment: async () => ({ environment: base.environment, content: { ...base.content, definition } }),
      readSource: async () => refusal, readWorkspaceRows: unexpected, repositoryFiles: () => { throw new Error('Unexpected repository work'); },
      createContent: unexpected,
    });
    const input = DeploymentMoveToRepositoryInputV1Schema.parse({ mode: 'apply', serverId: 'home',
      environmentId: base.environment.id, definition: { contentRevision: definition.contentRevision, composeDigest: definition.composeDigest },
      path: 'deploy/compose.yaml', workspace: { kind: 'workspace-ref', serverId: 'home', id: 'workspace' },
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repo' },
      baseCommit: 'a'.repeat(40), baseBranch: 'main' });
    expect(await move(input, {}, unexpected)).toMatchObject(refusal);
  });
});
