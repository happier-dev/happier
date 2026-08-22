import { CHANNELS_PLUGIN } from './manifest.js';

/**
 * The single Channels registration spine.
 *
 * It is projected from the one `definePlugin` owner rather than hand-written,
 * so a declared Action, Resource or background service can never drift from a
 * registered implementation in either direction. C2 setup, the normal
 * management Resources and the caller-scoped reconciliation readers all arrive
 * from the same declarations the manifest ships.
 */
export const activate = CHANNELS_PLUGIN.activate;
