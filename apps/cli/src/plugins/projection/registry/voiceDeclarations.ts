import {
    buildQualifiedPluginContributionKey,
    createRecipientContractDigestV1,
    createVoiceProviderRecipientContractV1,
    type PluginVoiceProviderContributionV1,
} from '@happier-dev/protocol';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

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
            const definition = entry.definition as PluginVoiceProviderContributionV1;
            const accountMediation = definition.kind === 'conversation'
                ? definition.accountMediation
                : undefined;
            const sourceSpec = entry.sourceSpec;
            const bundled = entry.provenance === 'first_party' && entry.source.kind === 'bundled';
            const recipientContract = accountMediation
                ? createVoiceProviderRecipientContractV1({
                    package: {
                        pluginId: entry.pluginId,
                        source: {
                            kind: entry.source.kind,
                            locator: sourceSpec?.locator ?? entry.pluginId,
                        },
                    },
                    publisher: bundled
                        ? { trust: 'bundled', identity: 'happier.dev:first-party-bundle' }
                        : {
                            trust: 'verified',
                            identity: [
                                sourceSpec?.kind ?? entry.source.kind,
                                sourceSpec?.locator ?? entry.pluginId,
                                sourceSpec?.trustPolicy ?? 'committed-registry',
                            ].join(':'),
                        },
                    contribution: entry.identity,
                    accountMediation,
                    presentation: { title: definition.title },
                })
                : null;
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
