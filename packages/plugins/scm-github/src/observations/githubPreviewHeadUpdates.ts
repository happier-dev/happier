import { computeCanonicalDomainSeparatedDigest, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import { deploymentPreviewHeadNeedsRedeployV1 } from '@happier-dev/plugin-sdk/protocol';
import { normalizeScmHostingRepositoryIdentity, sameScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import { GithubCiReadError } from '../actions/reads.js';
import { decodeGithubJsonResponse, type GithubApiClientV1 } from './githubApiClient.js';
import type { GithubRepositorySourceConfigV1 } from './githubProviderContracts.js';
import { githubRepositoryUrl } from './githubRepositoryResolution.js';
import { classifyGithubResponseFailure } from './githubResponseFailure.js';
import { normalizeGithubPullRequestLifecycle } from './githubWebhookNormalization.js';

import type { GithubAutomationEventSourceDefinitionV1 } from './githubAutomationEventObserver.js';

type Template = NonNullable<GithubAutomationEventSourceDefinitionV1['deploymentPreview']>;
type HeadUpdate = Readonly<{
  pullRequest: NonNullable<ReturnType<typeof normalizeGithubPullRequestLifecycle>>;
  occurrenceId: string;
}>;

/** The current pull attempt owns all of these reads. Ordinary repository Event sources do not have a template. */
export async function readGithubPreviewHeadUpdates(input: Readonly<{
  context: PluginInvocationContext;
  client: GithubApiClientV1;
  repository: GithubRepositorySourceConfigV1;
  templates: readonly Template[];
}>): Promise<ReadonlyMap<string, readonly HeadUpdate[]>> {
  const { context, repository, client } = input;
  const updates = new Map<string, HeadUpdate[]>();
  if (!input.templates.length) return updates;
  const identity = normalizeScmHostingRepositoryIdentity({
    kind: 'github', deployment: 'https://github.com', repository: repository.nameWithOwner,
  });
  if (identity === null) return updates;
  const templates = new Map(input.templates.map(template => [JSON.stringify([template.serverId, template.environmentId]), template]));
  const requests = new Map<number, ReturnType<typeof readPullRequest>>();
  async function readPullRequest(number: number) {
    const response = await client.request({ url: `${githubRepositoryUrl(repository)}/pulls/${number}` });
    if (response.status !== 200) throw new GithubCiReadError(classifyGithubResponseFailure(response, Date.now()));
    const value = decodeGithubJsonResponse(response);
    if (typeof value !== 'object' || value === null || !('state' in value) || value.state !== 'open') return null;
    return normalizeGithubPullRequestLifecycle(value, 'synchronize');
  }
  for (const [key, template] of templates) {
    const observations: HeadUpdate[] = [];
    let cursor: string | undefined;
    do {
      const page = await context.services.actions.execute('deployments.environments.list', {
        serverId: template.serverId, previewTemplateEnvironmentId: template.environmentId,
        ...(cursor ? { cursor } : {}),
      }, { signal: context.signal });
      if (isPluginActionApprovalRequestCreated(page)) throw new Error('deployment_access_denied');
      if (!page.ok) throw new Error(page.error);
      if (page.coverage === 'partial') throw new Error('deployment_unavailable');
      const servingByEnvironment = new Map(page.servingDeployments?.map(receipt => [receipt.environmentId, receipt]));
      for (const child of page.items) {
        const serving = servingByEnvironment.get(child.id);
        if (child.purpose !== 'preview' || child.deletedAtMs !== undefined || child.serverId !== template.serverId
          || child.previewTemplateEnvironmentId !== template.environmentId || !serving || serving.state !== 'succeeded'
          || serving.operation === 'teardown' || serving.targetLinkId !== child.runtimeTargetLinkId || !serving.contentArtifactId) continue;
        const result = await context.services.actions.execute('deployments.receipts.get', {
          serverId: template.serverId, environmentId: child.id, deploymentId: serving.id, projection: 'previewHead',
        }, { signal: context.signal });
        if (isPluginActionApprovalRequestCreated(result)) throw new Error('deployment_access_denied');
        if (!result.ok) throw new Error(result.error);
        const head = result.previewHead;
        if (!head || head.templateEnvironmentId !== template.environmentId || head.pullRequestId !== child.previewPullRequestId
          || !sameScmHostingRepositoryIdentity(head.repository, identity)) continue;
        const number = head.pullRequestNumber;
        const request = requests.get(number) ?? readPullRequest(number);
        requests.set(number, request);
        const pullRequest = await request;
        if (!pullRequest || pullRequest.id !== head.pullRequestId || pullRequest.number !== number
          || !sameScmHostingRepositoryIdentity(pullRequest.baseRepository, identity)
          || !deploymentPreviewHeadNeedsRedeployV1(head.deployedSha, pullRequest.headSha)) continue;
        // Repeat the same occurrence until the serving Receipt changes. A later force-push
        // back to a previously used SHA is a new occurrence against the new serving Receipt.
        observations.push({ pullRequest, occurrenceId: computeCanonicalDomainSeparatedDigest('happier.github.preview-sync.v1',
          [repository.repositoryId, pullRequest.id, child.id, serving.id, pullRequest.headSha]) });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    updates.set(key, observations);
  }
  return updates;
}
