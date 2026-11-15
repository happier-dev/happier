import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionInputV1Schema,
    PluginAvailabilityIntentReadActionOutputV1Schema, PluginAvailabilityIntentsListActionInputV1Schema,
    PluginAvailabilityIntentsListActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';

/** A Home with no Account-selected releases still returns explicit reads for caller-known bundled plugins. */
export function absentAccountPluginAvailabilityHttpResponse(url: string, body: unknown) {
    const read = () => PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
        hostingCapability: { enabled: false },
        intent: null, release: null, uiArtifacts: [], packageAssets: [] });
    const path = new URL(url).pathname;
    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
        const input = PluginAvailabilityIntentsListActionInputV1Schema.parse(body);
        return { status: 200, data: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1,
            pluginIds: [], intentReads: (input.knownPluginIds ?? []).map(pluginId => ({ pluginId, response: read() })),
            failedPluginIds: [] }) };
    }
    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) {
        PluginAvailabilityIntentReadActionInputV1Schema.parse(body);
        return { status: 200, data: read() };
    }
    return undefined;
}
