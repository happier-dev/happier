import type { PluginWorkflowContributionV1 } from '@happier-dev/plugin-sdk';

import { GITHUB_PLUGIN_ID } from '../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from './contribution.js';
import { GithubPullRequestPreviewStatusInputV1Schema } from './mutations/contracts.js';

export const GITHUB_PREVIEW_STATUS_WORKFLOW_ID_V1 = 'preview-status';

/** Observe the current receipt on the selected controller, then publish or
 * retry its status. Forge alone validates the requested status and provenance. */
export const GITHUB_PREVIEW_STATUS_WORKFLOW_V1: Omit<PluginWorkflowContributionV1, 'id'> = {
  title: 'Publish preview status',
  description: 'Read a preview deployment receipt and publish its status without deploying again.',
  definition: {
    version: 1,
    inputs: [{ name: 'publication', valueType: 'json', required: true,
      description: 'Configured pull request, exact head and preview deployment receipt to publish.' }],
    defaults: {},
    blocks: [{
      kind: 'action', id: 'receipt', actionId: 'deployments.receipts.get',
      input: {
        serverId: { kind: 'input', name: 'publication', path: ['serverId'] },
        deploymentId: { kind: 'input', name: 'publication', path: ['deploymentId'] },
      },
    }, {
      kind: 'action', id: 'publish',
      actionId: `${GITHUB_PLUGIN_ID}/actions/${GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestPreviewStatus}`,
      input: {
        ...Object.fromEntries(Object.keys(GithubPullRequestPreviewStatusInputV1Schema.jsonSchema.properties!)
          .map(field => [field, { kind: 'input' as const, name: 'publication', path: [field] }])),
        deploymentId: { kind: 'result', producer: { blockId: 'receipt', scope: { kind: 'current' } }, path: ['deployment', 'id'] },
        environmentId: { kind: 'result', producer: { blockId: 'receipt', scope: { kind: 'current' } }, path: ['deployment', 'environmentId'] },
        targetLinkId: { kind: 'result', producer: { blockId: 'receipt', scope: { kind: 'current' } }, path: ['deployment', 'targetLinkId'] },
      },
    }],
  },
};
