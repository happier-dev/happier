import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, HEALTH_CHECK_KINDS_V1,
    type HealthCheckKindV1, type PluginContributionRef } from '@happier-dev/plugin-sdk';

export function savedBuiltinHealthCheckActionId(kind: HealthCheckKindV1): `health/${HealthCheckKindV1}` {
    return `health/${kind}`;
}

export function readSavedBuiltinHealthCheckAction(kind: PluginContributionRef): PluginContributionRef | null {
    if (kind.pluginId !== HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1) return null;
    const builtin = HEALTH_CHECK_KINDS_V1.find(id => id === kind.localId);
    return builtin ? { pluginId: kind.pluginId, localId: savedBuiltinHealthCheckActionId(builtin) } : null;
}

export const HEALTH_REMOVE_ACTION_ID = 'health/remove';
export const HEALTH_REMOVE_ACTION_REF = { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: HEALTH_REMOVE_ACTION_ID } as const;

/** Retained Account reads, distinct from Actions that execute a fresh health probe. */
export const HEALTH_RESULTS_ACTION_ID = 'health/results';
export const HEALTH_RESULTS_ACTION_REF = { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: HEALTH_RESULTS_ACTION_ID } as const;
