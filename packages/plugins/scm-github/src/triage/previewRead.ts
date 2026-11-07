import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import { admitGithubEntryInvocation } from './admission.js';
import { GithubPreviewInputV1Schema, type GithubPreviewResultV1 } from './detail/contracts.js';
import { GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1 } from './configuration.js';
import { readGithubPullRequest } from './get.js';
import { createGithubRepositoryReader } from './repositories.js';
import { classifyGithubPreviewReadFailure, readGithubPreviewDeployment } from './mutations/previewStatusAdmission.js';
import type { GithubTriageInvocationContext } from './invocation.js';

const unavailable = (code: string): GithubPreviewResultV1 => ({ kind: 'unavailable', failure: classifyGithubPreviewReadFailure(code) });

/** One public read; the list query selects this PR before private readiness is opened. */
export async function readGithubPreview(input: unknown, context: GithubTriageInvocationContext): Promise<GithubPreviewResultV1> {
  const parsed = GithubPreviewInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable('github_detail_input_invalid');
  const request = parsed.data;
  const admitted = await admitGithubEntryInvocation({ ...request, admissibleKinds: ['pull-request'] }, context);
  if (!admitted.ok) return { kind: 'unavailable', failure: admitted.failure };
  try {
    const dependencies = { client: admitted.client, now: Date.now, signal: context.signal };
    const current = await readGithubPullRequest(admitted.localRef, admitted.route,
      createGithubRepositoryReader(dependencies), dependencies);
    if (current.observation.kind === 'unresolved') return { kind: 'unavailable', failure: current.observation.failure };
    if (current.observation.kind !== 'present' || current.facts === null) return unavailable('github_entry_not_observed');
    const headSha = current.facts.headRevision;
    let cursor: string | undefined;
    const environmentIds: string[] = [];
    do {
      const previews = await context.services.actions.execute('deployments.environments.list', {
        serverId: request.serverId,
        previewRepository: { kind: 'github', deployment: GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1,
          repository: `${admitted.route.owner}/${admitted.route.name}` },
        previewPullRequestIds: [admitted.localRef.entryId], ...(cursor ? { cursor } : {}),
      }, { signal: context.signal });
      if (isPluginActionApprovalRequestCreated(previews)) return unavailable('deployment_unavailable');
      if (!previews.ok) return unavailable(previews.error);
      environmentIds.push(...previews.items.map(environment => environment.id));
      cursor = previews.nextCursor ?? undefined;
      if (previews.coverage === 'partial') return unavailable('deployment_unavailable');
    } while (cursor !== undefined);
    const previews = await Promise.all(environmentIds.map(async environmentId => {
      try {
        const preview = await readGithubPreviewDeployment({ serverId: request.serverId, environmentId }, admitted, context);
        if (preview.kind !== 'deployment') return { kind: 'unavailable' as const, environmentId,
          failure: preview.kind === 'failed' ? preview.failure : classifyGithubPreviewReadFailure(preview.reason) };
        const state = preview.servingSha !== headSha ? 'outdated' as const : preview.state;
        return { kind: 'preview' as const, operation: preview.deployment.operation, state, environmentId, deploymentId: preview.deployment.id,
          servingSha: preview.servingSha, targetUrl: state === 'ready' ? preview.targetUrl : null };
      } catch { context.signal.throwIfAborted(); return { kind: 'unavailable' as const, environmentId,
        failure: classifyGithubPreviewReadFailure('deployment_unavailable') }; }
    }));
    return { kind: 'preview', headSha, previews };
  } catch { context.signal.throwIfAborted(); return unavailable('deployment_unavailable'); }
}
