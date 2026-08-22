export { activate } from './activate.js';
export {
  CHANNELS_PLUGIN,
  PLUGIN_MANIFEST,
  PLUGIN_MANIFEST as manifest,
  // The executable half of the declared Account Collections. The host projects
  // it against the parsed manifest declarations before a candidate may load, so
  // it is produced by the same `definePlugin` owner as the declarations.
  collectionMigrations,
} from './manifest.js';
