import { admitGithubEntryInvocation } from './admission.js';
import { GithubPreviewInputV1Schema, type GithubPreviewResultV1 } from './detail/contracts.js';
import { readGithubPreviewEnvironments } from './previewEnvironments.js';
import { applyDeploymentPreviewHeadV1 } from '@happier-dev/plugin-sdk/protocol';
import { readGithubPullRequest } from './get.js';
import { createGithubRepositoryReader } from './repositories.js';
import { classifyGithubPreviewReadFailure, readGithubPreviewDeployment, readGithubPreviewPublicationStatus } from './mutations/previewStatusAdmission.js';
import type { GithubTriageInvocationContext } from './invocation.js';
import { readGithubPullRequestPreviewPublication } from './mutations/previewStatus.js';
import { GithubPullRequestPreviewStatusInputV1Schema } from './mutations/contracts.js';

const unavailable = (code: string, requestId?: string, cause?: unknown): GithubPreviewResultV1 => ({ kind: 'unavailable', failure: classifyGithubPreviewReadFailure(code, requestId, cause) });

/** One public read; the list query selects this PR before private readiness is opened. */
export async function readGithubPreview(input: unknown, context: GithubTriageInvocationContext): Promise<GithubPreviewResultV1> {
  const parsed = GithubPreviewInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable('github_detail_input_invalid', context.requestId);
  const request = parsed.data;
  const admitted = await admitGithubEntryInvocation({ ...request, admissibleKinds: ['pull-request'] }, context);
  if (!admitted.ok) return { kind: 'unavailable', failure: admitted.failure };
  try {
    const dependencies = { client: admitted.client, now: Date.now, signal: context.signal };
    const current = await readGithubPullRequest(admitted.localRef, admitted.route,
      createGithubRepositoryReader(dependencies), dependencies);
    if (current.observation.kind === 'unresolved') return { kind: 'unavailable', failure: current.observation.failure };
    if (current.observation.kind !== 'present' || current.facts === null) return unavailable('github_entry_not_observed', context.requestId);
    const headSha = current.facts.headRevision;
    const pullRequestId = current.facts.pullRequestId;
    if (headSha === null || pullRequestId === null) return unavailable('github_entry_not_observed', context.requestId);
    const environments = await readGithubPreviewEnvironments(request.serverId, admitted.route, pullRequestId, context);
    if (!environments.ok) return unavailable(environments.error, context.requestId);
    const previews = await Promise.all(environments.items.map(async ({ id: environmentId }) => {
      try {
        const preview = await readGithubPreviewDeployment({ serverId: request.serverId, environmentId }, admitted, context);
        if (preview.kind !== 'deployment') return { kind: 'unavailable' as const, environmentId,
          ...(preview.controller ? { controller: preview.controller } : {}),
          failure: preview.kind === 'failed' ? preview.failure : classifyGithubPreviewReadFailure(preview.reason, context.requestId) };
        const { state, targetUrl } = applyDeploymentPreviewHeadV1(preview, headSha);
        const status = state === 'outdated' ? null : readGithubPreviewPublicationStatus(preview);
        let publication;
        if (status !== null) {
          const publicationInput = GithubPullRequestPreviewStatusInputV1Schema.safeParse({ ...request,
            environmentId, templateEnvironmentId: preview.provenance.templateEnvironmentId,
            targetLinkId: preview.environment.runtimeTargetLinkId!, deploymentId: preview.deployment.id,
            expectedHeadSha: headSha, status, targetUrl });
          // The commit can serve the PR even when GitHub's exact revision cannot be offered for a status write.
          if (publicationInput.success) {
            const observed = await readGithubPullRequestPreviewPublication({ ...publicationInput.data,
              localRef: admitted.localRef, route: admitted.route, templateTargetLinkId: preview.provenance.runtimeTargetLinkId }, dependencies);
            publication = observed.kind === 'current' ? observed : { ...observed, input: publicationInput.data };
          }
        }
        return { kind: 'preview' as const, operation: preview.deployment.operation, state, environmentId, deploymentId: preview.deployment.id,
          ...(preview.controller ? { controller: preview.controller } : {}),
          servingSha: preview.servingSha, targetUrl,
          ...(publication ? { publication } : {}) };
      } catch (error) { context.signal.throwIfAborted(); return { kind: 'unavailable' as const, environmentId,
        failure: classifyGithubPreviewReadFailure('deployment_unavailable', context.requestId, error) }; }
    }));
    return { kind: 'preview', headSha, previews };
  } catch (error) { context.signal.throwIfAborted(); return unavailable('deployment_unavailable', context.requestId, error); }
}
