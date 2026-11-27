export { LINEAR_PLUGIN, PLUGIN_MANIFEST, PLUGIN_MANIFEST as manifest } from './manifest.js';
export { LINEAR_ACTIONS, LINEAR_PLUGIN_ID, LINEAR_SOURCE_ID } from './contracts.js';
import { LINEAR_PLUGIN } from './manifest.js';
export const activate = LINEAR_PLUGIN.activate;
