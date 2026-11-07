import { TRIAGE_PLUGIN } from './definition.js';

export { TRIAGE_DISPLAY_NAME, TRIAGE_PLUGIN, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from './definition.js';

/** The sole Triage plugin manifest, projected from the definition above. */
export const PLUGIN_MANIFEST = TRIAGE_PLUGIN.manifest;

/**
 * The executable half of `contributes.accountCollections`.
 *
 * The host projects this against the parsed manifest declarations before a
 * candidate may load, so it must travel with the manifest. It comes from the
 * same `definePlugin` owner as the declarations, which is what makes a future
 * schema-version bump add the callback beside its static identity instead of
 * leaving the two halves to a second hand-maintained map.
 */
export const collectionMigrations = TRIAGE_PLUGIN.collectionMigrations;
