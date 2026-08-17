import type { PluginUiIconTokenV1 } from '@happier-dev/plugin-sdk/ui';

/**
 * The one place the PRs & Issues UI contribution identities live.
 *
 * A renderer id, the artifact it mounts and the view that names the renderer are
 * three different identifiers that a manifest, a build config and a host resolve
 * separately, and a drift between any two of them passes contribution
 * conformance and then fails at mount with nothing on screen. Declaring them
 * once here means the manifest cannot name a renderer no view uses, and
 * `uiBuildConfig.test.ts` binds these artifact ids to the `.mjs` build inputs
 * that actually produce the bundles.
 *
 * The build config's `rendererId` field is the manifest's `renderers[].artifact`
 * — not the renderer id. That mis-naming has already silently broken sibling
 * packages, so the artifact constants below are the ones the `.mjs` half must
 * repeat.
 */

/** The mounted aggregate list page. */
export const TRIAGE_LIST_PAGE_RENDERER_ID_V1 = 'list-page';
export const TRIAGE_LIST_PAGE_ARTIFACT_ID_V1 = 'triage-list-page-native';

/** The Composer `entry` attachment picker. */
export const TRIAGE_ENTRY_PICKER_RENDERER_ID_V1 = 'entry-picker';
export const TRIAGE_ENTRY_PICKER_ARTIFACT_ID_V1 = 'triage-entry-picker-native';

/** The compact label of the `entries` Composer control. */
export const TRIAGE_ENTRIES_COMPACT_RENDERER_ID_V1 = 'entries-compact';
export const TRIAGE_ENTRIES_COMPACT_ARTIFACT_ID_V1 = 'triage-entries-compact-native';

/** The Session-targeted linked-entries panel. */
export const TRIAGE_SESSION_ENTRIES_RENDERER_ID_V1 = 'session-entries-panel';
export const TRIAGE_SESSION_ENTRIES_ARTIFACT_ID_V1 = 'triage-session-entries-native';

/** The one Session-targeted view local id. */
export const TRIAGE_SESSION_ENTRIES_VIEW_ID_V1 = 'session-entries';

/**
 * The declared icon of the `entries` Composer control.
 *
 * `inbox` is not an admitted `PluginUiIconTokenV1` — the token vocabulary is a
 * closed enum with no inbox — and `action` is the closest admitted token for a
 * queue of things waiting on you. It lives here rather than beside the compact
 * renderer because the manifest declares it: importing it from a `.tsx` module
 * would drag React into the daemon manifest graph and close an import cycle
 * through `TRIAGE_DISPLAY_NAME`.
 */
export const TRIAGE_ENTRIES_CONTROL_ICON_V1: PluginUiIconTokenV1 = 'action';
