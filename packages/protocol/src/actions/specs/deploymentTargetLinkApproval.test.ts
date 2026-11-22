import { describe, expect, it } from 'vitest';
import { describeApprovalActionFields } from '../actionApprovalPresentation.js';
import { DeploymentApprovalReviewV1Schema } from '../../deployments/deploymentReviewV1.js';

const create = {
  serverId: 'home',
  environmentId: 'env-production-api',
  expectedRevision: 3,
  requestKey: 'create-request',
  targetId: 'runtime',
  targetKind: 'railway',
  role: 'runtime',
  machines: [],
  source: {
    kind: 'plugin',
    contribution: { pluginId: 'happier.deploy.railway', localId: 'runtime' },
  },
  providerCreate: {
    resourceName: 'checkout-api',
    productionBranch: 'release',
    repository: {
      kind: 'github',
      deployment: 'https://github.com',
      repository: 'acme/checkout',
    },
    providerAccountId: 'project-checkout',
    providerEnvironment: {
      kind: 'native',
      selection: {
        projectId: 'project-checkout',
        environmentId: 'railway-production',
      },
    },
  },
};

describe('deployment target link approval', () => {
  it('reads routing and provider ids under Technical details and keeps the Home by name', () => {
    const { rows } = describeApprovalActionFields({
      actionId: 'deployments.targets.link',
      actionArgs: create,
    });
    const byPath = new Map(
      rows.flatMap((row) =>
        row.kind === 'value' ? [[row.path, row] as const] : [],
      ),
    );
    for (const path of [
      'environmentId',
      'expectedRevision',
      'requestKey',
      'targetId',
      'role',
      'source',
      'targetKind',
      'machines',
    ]) {
      expect(byPath.get(path), path).toMatchObject({ technical: true });
    }
    expect(byPath.get('serverId')?.technical).not.toBe(true);
  });

  it('accepts a host create review that names the new resource without provider ids', () => {
    const parsed = DeploymentApprovalReviewV1Schema.safeParse({
      summary:
        'Create service checkout-api from acme/checkout on branch release.',
      platformCreate: {
        platformName: 'Railway',
        resourceName: 'checkout-api',
        repository: 'acme/checkout',
        productionBranch: 'release',
        followsBranch: true,
      },
    });
    expect(parsed.success).toBe(true);
  });
});
