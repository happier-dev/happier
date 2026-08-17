/**
 * The build-side half of every PRs & Issues surface identity.
 *
 * Each `*_ARTIFACT_ID` here must equal the matching constant in
 * `src/ui/contributions.ts`: the manifest's `renderers[].artifact` is what the
 * host looks up in the staged `dist/happier-plugin-ui` graph, so a drift
 * between this `.mjs` build input and the TypeScript manifest passes
 * contribution conformance and then fails at mount with an empty surface.
 * `src/uiBuildConfig.test.ts` is the check that keeps the two halves together.
 *
 * The build config field that carries these is spelled `rendererId`, but the
 * value it wants is the ARTIFACT id. That mis-naming has silently broken
 * sibling packages; the names below say artifact so the mistake cannot be made
 * quietly here.
 */

export const TRIAGE_UI_BUILD_OUT_DIR = 'node_modules/.cache/happier-plugin-ui';

export const TRIAGE_LIST_PAGE_ARTIFACT_ID = 'triage-list-page-native';
export const TRIAGE_LIST_PAGE_SOURCE_ENTRY = 'src/ui/surface.tsx';
export const TRIAGE_LIST_PAGE_REPACK_MODULE_IDENTITY = Object.freeze({
  containerName: 'happier_triage_triage_list_page_native',
  modulePath: './surface',
  exportName: 'renderSurface',
});

export const TRIAGE_ENTRY_PICKER_ARTIFACT_ID = 'triage-entry-picker-native';
export const TRIAGE_ENTRY_PICKER_SOURCE_ENTRY = 'src/composer/entryPicker.tsx';
export const TRIAGE_ENTRY_PICKER_REPACK_MODULE_IDENTITY = Object.freeze({
  containerName: 'happier_triage_triage_entry_picker_native',
  modulePath: './entryPicker',
  exportName: 'renderSurface',
});

export const TRIAGE_ENTRIES_COMPACT_ARTIFACT_ID = 'triage-entries-compact-native';
export const TRIAGE_ENTRIES_COMPACT_SOURCE_ENTRY = 'src/composer/controlCompact.tsx';
export const TRIAGE_ENTRIES_COMPACT_REPACK_MODULE_IDENTITY = Object.freeze({
  containerName: 'happier_triage_triage_entries_compact_native',
  modulePath: './controlCompact',
  exportName: 'renderSurface',
});

export const TRIAGE_SESSION_ENTRIES_ARTIFACT_ID = 'triage-session-entries-native';
export const TRIAGE_SESSION_ENTRIES_SOURCE_ENTRY = 'src/sessions/cockpit/sessionLinkedEntriesSurface.tsx';
export const TRIAGE_SESSION_ENTRIES_REPACK_MODULE_IDENTITY = Object.freeze({
  containerName: 'happier_triage_triage_session_entries_native',
  modulePath: './sessionLinkedEntriesSurface',
  exportName: 'renderSurface',
});
