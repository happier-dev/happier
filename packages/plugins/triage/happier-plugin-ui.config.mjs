import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';

import {
  TRIAGE_ENTRIES_COMPACT_ARTIFACT_ID,
  TRIAGE_ENTRIES_COMPACT_REPACK_MODULE_IDENTITY,
  TRIAGE_ENTRIES_COMPACT_SOURCE_ENTRY,
  TRIAGE_ENTRY_PICKER_ARTIFACT_ID,
  TRIAGE_ENTRY_PICKER_REPACK_MODULE_IDENTITY,
  TRIAGE_ENTRY_PICKER_SOURCE_ENTRY,
  TRIAGE_LIST_PAGE_ARTIFACT_ID,
  TRIAGE_LIST_PAGE_REPACK_MODULE_IDENTITY,
  TRIAGE_LIST_PAGE_SOURCE_ENTRY,
  TRIAGE_SESSION_ENTRIES_ARTIFACT_ID,
  TRIAGE_SESSION_ENTRIES_REPACK_MODULE_IDENTITY,
  TRIAGE_SESSION_ENTRIES_SOURCE_ENTRY,
  TRIAGE_UI_BUILD_OUT_DIR,
} from './uiBuildIdentity.mjs';

/**
 * Four React Native surfaces, four artifacts, one build owner.
 *
 * They are separate artifacts because they are separate mounts with separate
 * host contexts: the app page, the Composer attachment picker, the Composer
 * control's compact label and the Session-targeted panel. Collapsing them into
 * one bundle would need a Triage-owned mount seam that decided which surface a
 * host meant, which is exactly the second dispatcher the surface contract
 * forbids.
 *
 * `rendererId` is the field's name; the value is the manifest's
 * `renderers[].artifact`.
 */
export const pluginUiBuildConfig = defineBuildConfig({
  projectRoot: '.',
  outDir: TRIAGE_UI_BUILD_OUT_DIR,
  targets: [{
    rendererId: TRIAGE_LIST_PAGE_ARTIFACT_ID,
    entry: TRIAGE_LIST_PAGE_SOURCE_ENTRY,
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: TRIAGE_LIST_PAGE_REPACK_MODULE_IDENTITY,
  }, {
    rendererId: TRIAGE_ENTRY_PICKER_ARTIFACT_ID,
    entry: TRIAGE_ENTRY_PICKER_SOURCE_ENTRY,
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: TRIAGE_ENTRY_PICKER_REPACK_MODULE_IDENTITY,
  }, {
    rendererId: TRIAGE_ENTRIES_COMPACT_ARTIFACT_ID,
    entry: TRIAGE_ENTRIES_COMPACT_SOURCE_ENTRY,
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: TRIAGE_ENTRIES_COMPACT_REPACK_MODULE_IDENTITY,
  }, {
    rendererId: TRIAGE_SESSION_ENTRIES_ARTIFACT_ID,
    entry: TRIAGE_SESSION_ENTRIES_SOURCE_ENTRY,
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: TRIAGE_SESSION_ENTRIES_REPACK_MODULE_IDENTITY,
  }],
});

export default pluginUiBuildConfig;
