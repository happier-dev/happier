import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginDynamicResourceRuntime, PluginResourceContextV1 } from '@happier-dev/plugin-sdk/resources';
import { createForgeCiAdapterV1, createForgeCiBranchCountsV1, createForgeCiReadsV1 } from '@happier-dev/forge-ci/runtime';
import { GITHUB_CI_ACTION_REFS_V1 } from '../ui/actions/model.js';
import { sameScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import type { ForgeCiActionInputByOperationV1 } from '@happier-dev/triage-protocol/ci/v1';
import { GithubWorkflowShaV1Schema } from './identity.js';

/** The contextual Resource owner supplies accepted SCM facts; this projection performs no IO. */
export function projectGithubCiBranchCountInputV1(context: PluginResourceContextV1,
  previous: ForgeCiActionInputByOperationV1['listRuns'] | null = null): ForgeCiActionInputByOperationV1['listRuns'] | null {
  if (context.kind === 'global' || context.target === undefined) return null;
  const target = context.target;
  if (target.kind !== 'project' && target.kind !== 'session') return null;
  if (!target.repository || !target.branch || target.repository.kind !== 'github'
    || target.repository.deployment !== 'https://github.com') return null;
  let headSha: string | undefined;
  if (target.kind === 'session') {
    if (context.kind === 'session' && target.sessionId !== context.sessionId) return null;
    const head = GithubWorkflowShaV1Schema.safeParse(target.headOid);
    if (!head.success) return null;
    headSha = head.data;
  } else if (context.kind !== 'surface') {
    return null;
  }
  if (previous && sameScmHostingRepositoryIdentity(previous.repository, target.repository)
    && previous.filters.branch === target.branch && previous.filters.headSha === headSha) return previous;
  return { repository: target.repository, filters: { branch: target.branch, ...(headSha === undefined ? {} : { headSha }) } };
}

function unavailableProducerLifetime(): never {
  throw new PluginError({ code: 'plugin_resource_producer_lifetime_unavailable', message: 'CI counts require an admitted daemon Resource context' });
}

/** One controller per admitted daemon context; query demand owns its polling. */
export const githubCiBranchCountsResourceV1: PluginDynamicResourceRuntime = {
  read: unavailableProducerLifetime,
  observe: unavailableProducerLifetime,
  async createProducer({ context, signal, readAction, observeAction }) {
    const input = projectGithubCiBranchCountInputV1(context);
    if (input === null) return { ...createForgeCiBranchCountsV1({ acquire: () => null }), dispose() {} };
    const adapter = createForgeCiAdapterV1({
      actionRefs: GITHUB_CI_ACTION_REFS_V1,
      async invoke(ref, operands, options) {
        const result = await readAction(ref, operands, options);
        if (!result.ok) throw new PluginError({ code: result.errorCode, message: result.error });
        return result.result;
      },
    });
    const reads = createForgeCiReadsV1({ adapter, scopeKey: 'github/daemon-ci-context/v1' });
    const retire = () => reads.retire();
    signal.addEventListener('abort', retire, { once: true });
    if (signal.aborted) retire();
    let dependency: Awaited<ReturnType<typeof observeAction>>;
    try {
      dependency = await observeAction(GITHUB_CI_ACTION_REFS_V1.listRuns, input,
        () => reads.invalidate('listRuns'), { signal });
    } catch (error) {
      signal.removeEventListener('abort', retire);
      reads.retire();
      throw error;
    }
    return {
      ...createForgeCiBranchCountsV1({ acquire: () => ({ reads, input }) }),
      async dispose() {
        signal.removeEventListener('abort', retire);
        reads.retire();
        await dependency.dispose();
      },
    };
  },
};
