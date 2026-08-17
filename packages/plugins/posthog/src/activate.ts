import { POSTHOG_PLUGIN } from './manifest.js';

/**
 * The single PostHog registration spine, projected from the compiled definition so
 * declarations, handlers, and Connected Account activation cannot drift.
 */
export const activate = POSTHOG_PLUGIN.activate;
