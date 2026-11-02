import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionInputV1Schema,
    PluginAvailabilityIntentReadActionOutputV1Schema, PluginAvailabilityIntentsListActionInputV1Schema,
    PluginAvailabilityIntentsListActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';

/** Home boundary with no Account override; the real selector admits the bundled release. */
export function readBundledPluginAvailabilityHttpFixture(path: string, body: unknown) {
    const response = () => PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
        hostingCapability: { enabled: false }, intent: null, release: null, uiArtifacts: [], packageAssets: [] });
    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) {
        PluginAvailabilityIntentReadActionInputV1Schema.parse(body);
        return response();
    }
    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
        const input = PluginAvailabilityIntentsListActionInputV1Schema.parse(body);
        const pluginIds = input.knownPluginIds ?? [];
        return PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1,
            pluginIds, intentReads: pluginIds.map(pluginId => ({ pluginId, response: response() })), failedPluginIds: [] });
    }
    return undefined;
}
