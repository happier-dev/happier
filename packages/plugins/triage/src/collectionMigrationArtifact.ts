import { TRIAGE_PLUGIN } from './manifest.js';

/** The portable migration entry shares the plugin's declarations and callbacks. */
export function collectionMigrations() {
    return Object.freeze({
        manifest: TRIAGE_PLUGIN.manifest,
        collectionMigrations: TRIAGE_PLUGIN.collectionMigrations,
    });
}
