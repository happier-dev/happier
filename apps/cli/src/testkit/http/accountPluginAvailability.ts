import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionInputV1Schema,
    PluginAvailabilityIntentReadActionOutputV1Schema, PluginAvailabilityIntentsListActionInputV1Schema,
    PluginAvailabilityIntentsListActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';

/**
 * The plugin ids an `intents.list` request asks the Home to read: the exact
 * named set (`pluginIds`) or a census page's caller-known ids.
 */
export function readRequestedIntentPluginIds(body: unknown): string[] {
    const input = PluginAvailabilityIntentsListActionInputV1Schema.parse(body);
    return [...(input.pluginIds ?? input.knownPluginIds ?? [])];
}

/** A Home with no Account-selected releases still returns explicit reads for caller-known bundled plugins. */
export function absentAccountPluginAvailabilityHttpResponse(url: string, body: unknown) {
    const read = () => PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
        hostingCapability: { enabled: false },
        intent: null, release: null, uiArtifacts: [], packageAssets: [] });
    const path = new URL(url).pathname;
    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
        return { status: 200, data: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1,
            pluginIds: [], intentReads: readRequestedIntentPluginIds(body).map(pluginId => ({ pluginId, response: read() })),
            failedPluginIds: [] }) };
    }
    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) {
        PluginAvailabilityIntentReadActionInputV1Schema.parse(body);
        return { status: 200, data: read() };
    }
    return undefined;
}
