import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1 } from '@happier-dev/plugin-sdk';

/** Retained Account reads, distinct from Actions that execute a fresh health probe. */
export const HEALTH_RESULTS_ACTION_ID = 'health/results';
export const HEALTH_RESULTS_ACTION_REF = { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: HEALTH_RESULTS_ACTION_ID } as const;
