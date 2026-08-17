/**
 * The shared forge adapter.
 *
 * It owns ONLY what four independently built forge sources — GitHub, GitLab, Bitbucket
 * Cloud and Azure DevOps — were each found to enforce identically, where a per-source
 * copy is a place the rule can silently drift:
 *
 *  - exact-bound-account HTTP-header materialization;
 *  - the credential-disclosure gate on any absolute URL a source did not build;
 *  - RFC 8288 `Link` header parsing, for the forges that paginate that way;
 *  - the paged-detail-panel state machine, whose four outcomes — provider-stated
 *    empty, first read failed, later page failed over visible rows, and walk
 *    stopped short — must stay apart on every forge. Its failure vocabulary,
 *    cursor bytes and short-walk reason remain per-source type parameters.
 *
 * It deliberately owns NONE of the query semantics the four genuinely differ on. Lane
 * sets, pagination geometry, continuation shape, identity, routing evidence, row
 * decoding, and status-to-failure classification stay with each source, because those
 * differences are correct: Bitbucket discovers lanes DURING a walk, Azure DevOps scopes
 * by an organization path, GitLab's keyset links are not GitHub's, and a `403` is a
 * permission answer on one forge and a secondary rate limit on another. Centralizing
 * those would produce the abstraction the next forge fights.
 */

export {
  materializeForgeAuthorization,
  readForgeAuthorization,
  type ForgeAuthorization,
  type ForgeAuthorizationFailureReason,
  type ForgeAuthorizationOutcome,
  type ForgeAuthorizationReadOutcome,
  type ForgeListedAccountMaterializer,
} from './authorization/forgeAuthorization.js';
export {
  forgePagedInitialState,
  forgePagedReducer,
  type ForgePagedEventV1,
  type ForgePagedPageV1,
  type ForgePagedStateV1,
} from './detail/pagedPanel.js';
export { admitForgeRequestUrl } from './http/forgeRequestUrl.js';
export { parseForgeLinkHeader, readForgeLinkHeaderValue } from './http/linkHeader.js';
