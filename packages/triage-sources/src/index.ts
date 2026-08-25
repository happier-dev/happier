/**
 * The one shared library every first-party Triage source consumes.
 *
 * It owns the two things all six sources genuinely share, and nothing else:
 *
 *  - the source-runtime authorization rules — authorized-account enumeration
 *    including the one distinction between an unbound purpose and a failed
 *    listing, exact-bound-account HTTP-header materialization, and the
 *    credential-disclosure gate on any absolute URL a source did not build —
 *    plus the RFC 8288 `Link` header parsing the sources that paginate that
 *    way share;
 *  - the single PRs & Issues settings page. A source contributes three identity
 *    facts and gets the whole page.
 *
 * Exact-bound authorization calls the live Connected Accounts service and
 * receives ephemeral credential material, so it is implementation code rather
 * than portable `triage-protocol` ABI. The portable paged-detail state machine
 * remains in the protocol package because it carries no runtime service
 * authority.
 *
 * It deliberately owns NONE of the query semantics the sources genuinely differ
 * on. Lane sets, pagination geometry, continuation shape, identity, routing
 * evidence, row decoding, and status-to-failure classification stay with each
 * source, because those differences are correct: Bitbucket discovers lanes
 * DURING a walk, Azure DevOps scopes by an organization path, GitLab's keyset
 * links are not GitHub's, and a `403` is a permission answer on one forge and a
 * secondary rate limit on another. Centralizing those would produce the
 * abstraction the next source fights.
 *
 * The settings page's row model stays private: a source that reached into it
 * would be a second owner of the decisions this package exists to make once.
 * Its copy is exported for the one thing a source genuinely must do with it — a
 * plugin UI surface resolves translation keys against the mounting plugin's own
 * declared bundle, never a merged catalogue, so each contributing source
 * spreads these messages into its manifest locale rows. That is a declaration,
 * not a decision; the sentences themselves stay owned here so six sources
 * cannot end up with six wordings.
 */

export * from './runtime.js';
export {
  createTriageSourceSettingsSurface,
  type TriageSourceSettingsDraftEditorPropsV1,
  type TriageSourceSettingsSurfaceIdentityV1,
} from './settings/surface.js';
export { TRIAGE_SOURCE_SETTINGS_TRANSLATIONS_V1 } from './settings/translations.js';
