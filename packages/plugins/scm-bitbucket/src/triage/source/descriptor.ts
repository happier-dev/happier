import { BITBUCKET_TRIAGE_SORT_FIELDS } from '../sort.js';
import { bitbucketDetailTabDeclaration } from '../../ui/detail/tabDeclarations.js';
import type { TriageSourceDescriptorV1 } from '@happier-dev/triage-protocol/v1';

import { BITBUCKET_MIN_PAGE_LENGTH } from '../pagination.js';

/**
 * The declared Connected Account purpose. It is the host-access request id, and it is the exact
 * argument this source passes to the generic Connected Accounts metadata listing and to every
 * materialization; it is never a second account identity carrier.
 */
export const BITBUCKET_CONNECTED_ACCOUNT_PURPOSE = 'bitbucket-connected-account';

/** The Connected Account service this source's purpose selects within. */
export const BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID = 'bitbucket-account';

/** The one source-local entry kind. */
export const BITBUCKET_PULL_REQUEST_KIND_ID = 'pull-request';

/** The plugin-local Action ids carrying this source's operation roles. */
export const BITBUCKET_TRIAGE_ACTION_IDS = Object.freeze({
  listInstances: 'triage-list-instances',
  scan: 'triage-scan',
  get: 'triage-get',
  prepareReviewWorkspace: 'triage-prepare-review-workspace',
  verifyReviewWorkspace: 'triage-verify-review-workspace',
});

/**
 * The same-plugin renderer bound to the required source-owned detail role, and the UI artifact it
 * mounts. The role is required, so this identity must not move once the source is admitted, and
 * The exact `./happier-plugin-ui/<artifactId>` package export must name the same artifact: a manifest that names an artifact no
 * build target produces passes conformance and then fails at mount.
 */
export const BITBUCKET_TRIAGE_DETAIL_RENDERER_ID = 'bitbucket-detail';
export const BITBUCKET_TRIAGE_DETAIL_ARTIFACT_ID = 'bitbucket-detail-native';
/**
 * The source-owned Settings page a person uses to put Bitbucket Cloud into PRs & Issues,
 * and the artifact that mounts it.
 *
 * It is a plain Settings contribution: the generic Settings catalog owns the
 * group, route and availability decision, and this source supplies one page and
 * one renderer. The page is the only production caller of the target-owned
 * `happier.triage/sources/administer-v1` Action for this source, and without it
 * every configured-instance path in this package is unreachable from the
 * product.
 */
export const BITBUCKET_TRIAGE_SETTINGS_GROUP_ID = 'bitbucket-triage';
export const BITBUCKET_TRIAGE_SETTINGS_PAGE_ID = 'triage-sources';
export const BITBUCKET_TRIAGE_SETTINGS_RENDERER_ID = 'bitbucket-triage-sources';
export const BITBUCKET_TRIAGE_SETTINGS_ARTIFACT_ID = 'bitbucket-triage-sources-native';


/**
 * The Bitbucket Cloud source descriptor.
 *
 * Exactly one kind is declared. Bitbucket Cloud Issues are out of scope: Atlassian is removing the
 * tracker and no longer lets a repository turn it on, so there is no durable product and no
 * new-user onboarding path to build against. Declaring an `issue` kind that resolves to nothing
 * would read to a user as a defect rather than as the deliberate exclusion it is.
 */
export const BITBUCKET_TRIAGE_DESCRIPTOR: TriageSourceDescriptorV1 = Object.freeze({
  v: 1,
  purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
  // The page this source's own Settings contribution ships, so the PRs & Issues
  // surface can offer a working Configure action rather than naming Settings and
  // leaving the reader to find it. A BARE local id: the target qualifies it with the
  // contributor identity the host already admitted.
  settingsPageId: BITBUCKET_TRIAGE_SETTINGS_PAGE_ID,
  displayName: 'Bitbucket Cloud',
  sortFields: BITBUCKET_TRIAGE_SORT_FIELDS,
  minimumScanPageSize: BITBUCKET_MIN_PAGE_LENGTH,
  kinds: Object.freeze([
    Object.freeze({
      id: BITBUCKET_PULL_REQUEST_KIND_ID,
      workflowSubject: 'pullRequest',
      displayName: 'Pull request',
      pluralDisplayName: 'Pull requests',
      // r0.42: the Triage detail frame draws these tabs and asks this source
      // for each as a panel; the writes render as the header `actions` panel.
      detailTabs: Object.freeze([
        Object.freeze({ kind: 'shared', id: 'overview', scrollOwner: bitbucketDetailTabDeclaration('overview').scrollOwner }),
        Object.freeze({ kind: 'shared', id: 'activity', scrollOwner: bitbucketDetailTabDeclaration('activity').scrollOwner }),
        Object.freeze({ kind: 'shared', id: 'files', scrollOwner: bitbucketDetailTabDeclaration('diff').scrollOwner }),
        Object.freeze({ kind: 'shared', id: 'checks', scrollOwner: bitbucketDetailTabDeclaration('builds').scrollOwner, summaryFact: 'bitbucket/builds' }),
      ]),
      detailActions: true,
    }),
  ]),
}) as TriageSourceDescriptorV1;
