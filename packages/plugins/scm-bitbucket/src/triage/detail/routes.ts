import { BITBUCKET_CLOUD_API_BASE_URL } from '../apiClient.js';
import { encodeBitbucketPathSegment, isBitbucketEntryId } from '../identity.js';

/**
 * The three Bitbucket Cloud pull-request detail collections this vertical reads.
 *
 * Only the FIRST page of a walk is built here. Every following page is
 * Bitbucket's own `next`, byte-for-byte: Atlassian documents it as "an opaque
 * location that is not to be constructed by clients or even assumed to be
 * predictable", so a rebuilt page URL is not the page Bitbucket offered.
 *
 * The window literals differ per collection because the rows differ in size.
 * They are not one shared page policy, and each reader control names the count
 * it adds rather than claiming an order Bitbucket never promised.
 */

/**
 * `Comments` mounts the first 30 returned records in provider order.
 *
 * Bitbucket constrains `pagelen` to 10–100 and publishes no chronological
 * ordering contract for this collection, so 30 is this surface's window and the
 * control says `Show 30 more comments` rather than a false `earlier`.
 */
export const BITBUCKET_COMMENTS_PAGE_LENGTH_V1 = 30;
/** `Activity` mounts one page of the combined approval/update/comment stream. */
export const BITBUCKET_ACTIVITY_PAGE_LENGTH_V1 = 25;
/** `Builds` mounts one page of the pull request's own status collection. */
export const BITBUCKET_STATUSES_PAGE_LENGTH_V1 = 25;
/** Bitbucket's documented global maximum; one diffstat page never asks for more than it permits. */
export const BITBUCKET_DIFFSTAT_PAGE_LENGTH_V1 = 100;

export type BitbucketDetailRouteInputV1 = Readonly<{
  workspaceUuid: string;
  repositoryUuid: string;
  entryId: string;
}>;

function pullRequestPath(input: BitbucketDetailRouteInputV1, suffix: string): string {
  // The entry-id grammar has one owner. A second copy here is a second answer to which segments
  // may reach a Bitbucket URL, and the copy that drifted would be the one guarding a route.
  if (!isBitbucketEntryId(input.entryId)) {
    throw new Error('bitbucket_detail_entry_id_invalid');
  }
  const workspace = encodeBitbucketPathSegment(input.workspaceUuid);
  const repository = encodeBitbucketPathSegment(input.repositoryUuid);
  const entry = encodeBitbucketPathSegment(input.entryId);
  return `${BITBUCKET_CLOUD_API_BASE_URL}/repositories/${workspace}/${repository}`
    + `/pullrequests/${entry}${suffix}`;
}

/**
 * `GET …/pullrequests/{id}/activity`.
 *
 * One endpoint covering approvals, updates and comments. Bitbucket has no
 * separate approval or update collection, so reading only comments would lose
 * every approval and every branch update.
 */
export function buildBitbucketActivityUrl(input: BitbucketDetailRouteInputV1): string {
  return pullRequestPath(input, '/activity');
}

/**
 * `GET …/pullrequests/{id}/statuses`.
 *
 * The provider's own pull-request status collection — not a guessed
 * source-commit status route. Cross-fork status resolution is not asserted here
 * and no commit route is substituted for it.
 */
export function buildBitbucketStatusesUrl(input: BitbucketDetailRouteInputV1): string {
  return pullRequestPath(input, '/statuses');
}

/** `GET …/pullrequests/{id}/comments`. */
export function buildBitbucketCommentsUrl(input: BitbucketDetailRouteInputV1): string {
  return pullRequestPath(input, '/comments');
}

/** The authoritative pull-request self read used by Overview refresh. */
export function buildBitbucketOverviewUrl(input: BitbucketDetailRouteInputV1): string {
  return pullRequestPath(input, '');
}

/** The documented 302-to-raw-text diff resource. */
export function buildBitbucketDiffUrl(input: BitbucketDetailRouteInputV1): string {
  return pullRequestPath(input, '/diff');
}

/** The JSON file summary paired with the raw diff. */
export function buildBitbucketDiffstatUrl(input: BitbucketDetailRouteInputV1): string {
  return pullRequestPath(input, '/diffstat');
}
