import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

export const providerProjectionFamily = definePluginProjectionFamilyV2({
    family: 'providers',
    project: ({ registry, generation }) => ({
        family: 'providers',
        entriesById: Object.freeze(Object.fromEntries(
            (registry.providers ?? []).map((provider) => {
                const contributionKey = buildQualifiedPluginContributionKey(provider.identity);
                return [
                    contributionKey,
                    Object.freeze({
                        id: contributionKey,
                        pluginId: provider.pluginId,
                        generation,
                        contributionKey,
                        definition: provider.definition,
                    }),
                ];
            }),
        )),
    }),
});
