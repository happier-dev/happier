export { activate } from './activate.js';
export { TRIAGE_DISPLAY_NAME } from './displayName.js';
export {
  PLUGIN_MANIFEST,
  PLUGIN_MANIFEST as manifest,
  TRIAGE_PLUGIN,
  TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
  // The executable half of the declared Account Collections. The host projects
  // it against the parsed manifest declarations before a candidate may load, so
  // it is produced by the same `definePlugin` owner rather than by a second
  // hand-maintained map beside the definitions.
  collectionMigrations,
} from './manifest.js';
