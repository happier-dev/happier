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
