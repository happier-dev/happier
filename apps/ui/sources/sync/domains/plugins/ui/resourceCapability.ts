import {
    PluginUiResourceBindingCapabilityV1Schema,
    type PluginUiResourceBindingCapabilityV1,
} from '@happier-dev/protocol';

import type { PluginUiSurfacePlacementProjection } from './projection';

const NO_PLUGIN_UI_RESOURCE_CAPABILITY = Object.freeze({
    readable: false,
    dynamic: false,
} satisfies PluginUiResourceBindingCapabilityV1);

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

/**
 * Read the Resource capability attached to one surface member that Admin has
 * already selected for this mount. This intentionally takes a member, not a
 * projection model, plugin id, origin, or generation: a sibling replica can
 * never raise the selected member's capabilities by being considered here.
 */
export function readSelectedPluginUiResourceCapability(
    selectedSurface: PluginUiSurfacePlacementProjection | null | undefined,
): PluginUiResourceBindingCapabilityV1 {
    const runtime = asRecord(selectedSurface?.runtime);
    const parsed = PluginUiResourceBindingCapabilityV1Schema.safeParse(
        runtime?.resourceCapability,
    );
    return parsed.success
        ? Object.freeze({ ...parsed.data })
        : NO_PLUGIN_UI_RESOURCE_CAPABILITY;
}
