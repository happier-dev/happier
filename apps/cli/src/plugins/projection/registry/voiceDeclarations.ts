import {
    buildQualifiedPluginContributionKey,
    createRecipientContractDigestV1,
    type VoiceProviderContribution,
} from '@happier-dev/protocol';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import {
    createVoiceProviderRecipientContract,
} from '@/plugins/voiceProviderRecipientContract';

function projectEntries<T extends Readonly<{
    pluginId: string;
    identity: Readonly<{ pluginId: string; localId: string }>;
    definition: unknown;
}>>(entries: readonly T[], generation: number): Readonly<Record<string, Readonly<{
    id: string;
    pluginId: string;
    [key: string]: unknown;
}>>> {
    return Object.freeze(Object.fromEntries(entries.map((entry) => {
        const contributionKey = buildQualifiedPluginContributionKey(entry.identity);
        return [contributionKey, Object.freeze({
            id: contributionKey,
            pluginId: entry.pluginId,
            generation,
            contributionKey,
            definition: entry.definition,
        })];
    })));
}

export const voiceModelPackProjectionFamily = definePluginProjectionFamilyV2({
    family: 'voiceModelPacks',
    project: ({ registry, generation }) => ({
        family: 'voiceModelPacks',
        entriesById: projectEntries(registry.voiceModelPacks ?? [], generation),
    }),
});

export const voiceProviderProjectionFamily = definePluginProjectionFamilyV2({
    family: 'voiceProviders',
    project: ({ registry, generation }) => ({
        family: 'voiceProviders',
        entriesById: Object.freeze(Object.fromEntries((registry.voiceProviders ?? []).map((entry) => {
            const contributionKey = buildQualifiedPluginContributionKey(entry.identity);
            const definition = entry.definition as VoiceProviderContribution;
            const recipientContract = createVoiceProviderRecipientContract({
                ...entry,
                definition,
            });
            return [contributionKey, Object.freeze({
                id: contributionKey,
                pluginId: entry.pluginId,
                generation,
                contributionKey,
                definition,
                ...(recipientContract
                    ? {
                        recipientContract,
                        recipientContractDigest: createRecipientContractDigestV1(recipientContract),
                    }
                    : {}),
            })];
        }))),
    }),
});
