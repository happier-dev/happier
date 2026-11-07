import type { ScmHostingRepositoryIdentityV1, ScmWorkingSnapshot } from '@happier-dev/plugin-sdk/scm';
import { sameScmHostingRepositoryIdentity as sameRepository } from '@happier-dev/plugin-sdk/scm';
import type { ForgeCiActionInputByOperationV1, ForgeCiRunV1 } from '@happier-dev/triage-protocol/ci/v1';
import { GithubWorkflowShaV1Schema } from '../../actions/identity.js';
import { LocalActRunSeedV1Schema, type LocalActRunSeedV1, type LocalActRunFormInput } from '../../actions/local/contracts.js';

export type GithubCiSurfaceContextV1 =
  | Readonly<{ kind: 'ready'; scope: 'session' | 'overview'; input: ForgeCiActionInputByOperationV1['listRuns'] }>
  | Readonly<{ kind: 'detached' | 'unpushed' | 'unknown' }>;
const DETACHED = Object.freeze({ kind: 'detached' } as const);
const UNPUSHED = Object.freeze({ kind: 'unpushed' } as const);
const UNKNOWN = Object.freeze({ kind: 'unknown' } as const);

function ready(previous: GithubCiSurfaceContextV1 | null, repository: ScmHostingRepositoryIdentityV1, branch: string, headSha: string, scope: 'session' | 'overview'): GithubCiSurfaceContextV1 {
  if (repository.kind !== 'github' || repository.deployment !== 'https://github.com') return UNKNOWN;
  if (previous?.kind === 'ready' && previous.scope === scope && sameRepository(previous.input.repository, repository)
    && previous.input.filters.branch === branch && previous.input.filters.headSha === headSha) return previous;
  if (!GithubWorkflowShaV1Schema.safeParse(headSha).success) return UNKNOWN;
  return { kind: 'ready', scope, input: { repository, filters: { branch, headSha } } };
}

/** Only accepted SCM facts are consumed here; this projection performs no IO. */
export function projectGithubSessionCiContextV1(previous: GithubCiSurfaceContextV1 | null, input: Readonly<{
  repository: ScmHostingRepositoryIdentityV1 | null;
  branch: ScmWorkingSnapshot['branch'] | null;
}>): GithubCiSurfaceContextV1 {
  if (!input.repository || !input.branch) return UNKNOWN;
  const branch = input.branch;
  if (branch.detached) return DETACHED;
  if (!branch.head || !branch.headOid) return UNKNOWN;
  if (!branch.upstream || branch.ahead > 0) return UNPUSHED;
  return ready(previous, input.repository, branch.head, branch.headOid, 'session');
}

/** A caller must supply the admitted default-branch HEAD, never a Session SHA. */
export function projectGithubOverviewCiContextV1(previous: GithubCiSurfaceContextV1 | null, input: Readonly<{
  repository: ScmHostingRepositoryIdentityV1 | null;
  defaultBranch: string | null;
  headSha: string | null;
}>): GithubCiSurfaceContextV1 {
  if (!input.repository || !input.defaultBranch || !input.headSha) return UNKNOWN;
  return ready(previous, input.repository, input.defaultBranch, input.headSha, 'overview');
}

/** Capture the a6 failure subject; constructing this intent performs zero reads or starts. */
export function githubRailLocalRunIntentV1(context: GithubCiSurfaceContextV1, run: ForgeCiRunV1 | null,
  workspace: LocalActRunSeedV1['workspace'] | null, sessionId: string): Extract<LocalActRunFormInput, { operation: { kind: 'open' } }> | null {
  if (context.kind !== 'ready' || context.scope !== 'session' || !workspace || !run
    || run.state.outcomeBucket !== 'failed' || run.headSha !== context.input.filters.headSha
    || run.headRef !== context.input.filters.branch || !sameRepository(run.ref.repository, context.input.repository)) return null;
  const seed = LocalActRunSeedV1Schema.parse({ target: { kind: 'session', sessionId }, workspace,
    ...(run.workflow?.path === undefined ? {} : { workflowPath: run.workflow.path }), sourceHeadSha: run.headSha });
  return { operation: { kind: 'open', seed } };
}
