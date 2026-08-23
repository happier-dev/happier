import {
  TriageSourceDescriptorV1Schema,
  type TriageSourceDescriptorV1,
} from '@happier-dev/triage-protocol/v1';

import { GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../observations/githubProviderContracts.js';

import type { GithubTriageKindIdV1 } from './types.js';

/**
 * The GitHub Triage source declaration.
 *
 * `kindId` is source-local and named in GitHub's own vocabulary: `pull-request`
 * and `issue`. It is never flattened into another forge's spelling, and the
 * schema-legal spelling is the hyphenated one — `pullRequest` is illegal under
 * `PluginContributionLocalIdSchema`.
 */

/** The contribution's local id inside `contributesTo['happier.triage'].sources`. */
export const GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 = 'github-forge';

/** The three Action ids the contribution's operation roles bind to. */
export const GITHUB_TRIAGE_ACTION_IDS_V1 = Object.freeze({
  listInstances: 'triage/list-github-instances',
  scan: 'triage/scan-github',
  get: 'triage/get-github-entry',
});

/**
 * The four source-native detail Action ids.
 *
 * They bind to no Triage operation role. A mounted Plugin UI surface holds
 * `PluginUiHostApi`, which has no storage member and no transport of its own, so
 * an Action is the ONLY way this source's detail body can reach GitHub at all.
 * They are declared separately from the role-bound three above precisely because
 * they are not roles: the aggregate never invokes them, and only this plugin's
 * own detail renderer does.
 */
export const GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 = Object.freeze({
  listTimeline: 'triage/list-github-timeline',
  listChangedFiles: 'triage/list-github-changed-files',
  listComments: 'triage/list-github-comments',
  readChecks: 'triage/read-github-checks',
});

/**
 * The GitHub pull-request mutation Action ids, spelled exactly as SCM.md 3.8
 * names them.
 *
 * They are declared separately from every read above because they are a
 * different kind of thing: each is ONE exact externally visible write with its
 * own strict input and its own confirmation presentation, and none of them
 * declares `agent` or `mcp` so no agent or MCP caller can reach it at all. There
 * is no generic `mutate({ operation, payload })` Action here and there will not
 * be one.
 *
 * The two reviewer ids are a pair of exact DELTAS and never one "set reviewers"
 * id with a direction field. A single id would put the direction in the payload,
 * where the manifest cannot classify it, cannot confirm withdrawal differently
 * from a summons, and cannot state which of the two a user is about to do.
 *
 * SCM.md 3.8 also names `submit-review`, `review-comment-create`,
 * `thread-reply` and `issue/comment`. They are absent here on purpose: they are
 * blocked behind the Reviews dispatch barrier (SCM.md 3.9.3a) and a registered
 * Action is a reachable external write, so declaring one early would make the
 * barrier decorative. `thread-resolution` is NOT one of them and is declared: it
 * publishes nothing, so it needs no dispatch barrier — it converges an existing
 * thread on a resolution state GitHub already models.
 */
export const GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 = Object.freeze({
  pullRequestMerge: 'github/pull-request/merge',
  pullRequestClose: 'github/pull-request/close',
  pullRequestReopen: 'github/pull-request/reopen',
  pullRequestMarkReady: 'github/pull-request/mark-ready',
  pullRequestUpdateBranch: 'github/pull-request/update-branch',
  pullRequestAddReviewers: 'github/pull-request/add-reviewers',
  pullRequestRemoveReviewers: 'github/pull-request/remove-reviewers',
  pullRequestThreadResolution: 'github/pull-request/thread-resolution',
  issueClose: 'github/issue/close',
  issueReopen: 'github/issue/reopen',
  issueAssigneeAdd: 'github/issue/assignee-add',
  issueAssigneeRemove: 'github/issue/assignee-remove',
  issueLabelAdd: 'github/issue/label-add',
  issueLabelRemove: 'github/issue/label-remove',
});

/**
 * The same-plugin renderer bound to the required source-owned detail role, and the UI
 * artifact it mounts.
 *
 * These are two different identities and they are NOT interchangeable: the manifest's
 * `renderers[].artifact` is what the host looks up in the staged `dist/happier-plugin-ui`
 * graph, while `renderers[].id` is what the contribution's `surfaces.detail` binds. The
 * build config's `rendererId` names the ARTIFACT. `src/uiBuildConfig.test.ts` keeps the
 * `.mjs` build input and this TypeScript identity from drifting apart.
 */
export const GITHUB_TRIAGE_DETAIL_RENDERER_ID_V1 = 'github-detail';
export const GITHUB_TRIAGE_DETAIL_ARTIFACT_ID_V1 = 'github-detail-native';

/**
 * The source-owned Settings page a person uses to put GitHub into PRs & Issues,
 * and the artifact that mounts it.
 *
 * It is a plain Settings contribution rather than anything Triage-specific: the
 * generic Settings catalog owns the group, route and availability decision, and
 * this source supplies one page and one renderer. The page is the only
 * production caller of the target-owned `happier.triage/sources/administer-v1`
 * Action for this source, and without it every configured-instance path in this
 * package is unreachable from the product.
 */
export const GITHUB_TRIAGE_SETTINGS_GROUP_ID_V1 = 'github-triage';
export const GITHUB_TRIAGE_SETTINGS_PAGE_ID_V1 = 'triage-sources';
export const GITHUB_TRIAGE_SETTINGS_RENDERER_ID_V1 = 'github-triage-sources';
export const GITHUB_TRIAGE_SETTINGS_ARTIFACT_ID_V1 = 'github-triage-sources-native';

/** The one declared kind vocabulary; every emitted local ref is validated against it. */
export const GITHUB_TRIAGE_KIND_IDS_V1: readonly GithubTriageKindIdV1[] =
  Object.freeze(['pull-request', 'issue']);

/**
 * Parsed through the published descriptor schema at module load, so a descriptor that
 * drifts from the contract fails at import rather than at host admission.
 */
export const GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1: TriageSourceDescriptorV1 =
  TriageSourceDescriptorV1Schema.parse({
  v: 1,
  // The declared Connected Account purpose is the source's only account authority
  // vocabulary: discovery, reauthorization and materialization all use this exact
  // string, and a candidate binding that named another purpose would be rejected.
  purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  // The page this source's own Settings contribution ships, so the PRs & Issues
  // surface can offer a working Configure action instead of naming Settings and
  // leaving the reader to find it. A BARE local id: the target qualifies it with
  // the contributor identity the host already admitted, so a descriptor can never
  // name another plugin's page.
  settingsPageId: GITHUB_TRIAGE_SETTINGS_PAGE_ID_V1,
  displayName: 'GitHub',
  kinds: Object.freeze([
    Object.freeze({
      id: 'pull-request',
      workflowSubject: 'pullRequest',
      displayName: 'Pull request',
      pluralDisplayName: 'Pull requests',
    }),
    Object.freeze({
      id: 'issue',
      workflowSubject: 'issue',
      displayName: 'Issue',
      pluralDisplayName: 'Issues',
    }),
  ]),
  });

/** Narrows an inbound public local-ref kind to this source's declared vocabulary. */
export function readGithubTriageKindId(value: unknown): GithubTriageKindIdV1 | null {
  return GITHUB_TRIAGE_KIND_IDS_V1.find((kindId) => kindId === value) ?? null;
}
