import { z } from 'zod';
import { PluginUiInstanceKeyV1Schema, type PluginUiDestinationReferenceV1, type PluginUiInstanceKeyV1 } from '@happier-dev/protocol/plugins/ui';
import { PersistedPluginUiDestinationReferenceV1Schema } from '../../model/selectedPaneDestination';
import type { DetailsTab } from './detailsWorkspaceTypes';

/**
 * The only durable identity for a qualified plugin details destination.
 *
 * Runtime origin, target, launch input, and opaque content context are all
 * current mount facts. They must be resolved by the Details surface adapter
 * after restoration instead of becoming tab-resource persistence.
 */
export const PLUGIN_DETAILS_DESTINATION_RESOURCE_KIND = 'pluginDetailsDestination';

export type PluginDetailsDestinationResourceV1 = Readonly<{
    kind: typeof PLUGIN_DETAILS_DESTINATION_RESOURCE_KIND;
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
}>;

export const PluginDetailsDestinationResourceV1Schema = z.object({
    kind: z.literal(PLUGIN_DETAILS_DESTINATION_RESOURCE_KIND),
    destination: PersistedPluginUiDestinationReferenceV1Schema,
    instanceKey: PluginUiInstanceKeyV1Schema.optional(),
}).strip();

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether a resource claims the generic plugin-details namespace. */
export function isPluginDetailsDestinationResourceCandidate(value: unknown): boolean {
    return isRecord(value) && value.kind === PLUGIN_DETAILS_DESTINATION_RESOURCE_KIND;
}

/**
 * Parse and clone a durable resource at the Details persistence boundary.
 * Unknown fields deliberately do not survive the strict Protocol-owned shape.
 */
export function normalizePluginDetailsDestinationResource(
    value: unknown,
): PluginDetailsDestinationResourceV1 | null {
    const parsed = PluginDetailsDestinationResourceV1Schema.safeParse(value);
    if (!parsed.success) return null;
    return Object.freeze({
        kind: PLUGIN_DETAILS_DESTINATION_RESOURCE_KIND,
        destination: Object.freeze({ ...parsed.data.destination }),
        ...(parsed.data.instanceKey === undefined ? {} : { instanceKey: parsed.data.instanceKey }),
    });
}

export function createPluginDetailsDestinationResource(input: Readonly<{
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
}>): PluginDetailsDestinationResourceV1 {
    return Object.freeze({
        kind: PLUGIN_DETAILS_DESTINATION_RESOURCE_KIND,
        destination: Object.freeze({ ...input.destination }),
        ...(input.instanceKey === undefined ? {} : { instanceKey: input.instanceKey }),
    });
}

/**
 * Host tab identity is derived solely from the qualified destination and its
 * explicitly bounded instance discriminator. Delimited segments are encoded so
 * a plugin-provided identifier cannot collide with the host's key grammar.
 */
export function buildPluginDetailsDestinationTabKey(input: Readonly<{
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
}>): string {
    const instance = input.instanceKey === undefined
        ? 'singleton'
        : `instance-${encodeURIComponent(input.instanceKey)}`;
    return [
        'plugin-details',
        encodeURIComponent(input.destination.pluginId),
        encodeURIComponent(input.destination.localId),
        instance,
    ].join(':');
}

/**
 * Create the Details workspace's normal tab resource for an admitted plugin
 * destination. The opener supplies display text from the current placement;
 * no input, origin, target, or opaque resource context crosses this durable
 * boundary.
 */
export function createPluginDetailsDestinationTab(input: Readonly<{
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
    title: string;
    subtitle?: string | null;
}>): DetailsTab {
    const resource = createPluginDetailsDestinationResource(input);
    return Object.freeze({
        key: buildPluginDetailsDestinationTabKey(resource),
        kind: PLUGIN_DETAILS_DESTINATION_RESOURCE_KIND,
        title: input.title,
        ...(input.subtitle === undefined ? {} : { subtitle: input.subtitle }),
        resource,
    });
}
