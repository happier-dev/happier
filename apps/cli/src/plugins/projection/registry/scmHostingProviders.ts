import { ScmHostingProviderCapabilitiesSchema } from '@happier-dev/protocol/scm/pullRequests';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

function readProjectedTitle(definition: object): string | undefined {
    return readProjectedText(Reflect.get(definition, 'title') ?? Reflect.get(definition, 'displayName'));
}

function readProjectedText(value: unknown): string | undefined {
    return resolvePluginLocalizedStringV2Text(value).trim() || undefined;
}

function projectAuthService(
    pluginId: string | undefined,
    authService: unknown,
): Readonly<{ pluginId: string; localId: string }> | undefined {
    if (typeof authService === 'string') {
        return pluginId ? { pluginId, localId: authService } : undefined;
    }
    if (!authService || typeof authService !== 'object' || Array.isArray(authService)) return undefined;
    const referencedPluginId = Reflect.get(authService, 'pluginId');
    const localId = Reflect.get(authService, 'localId');
    return typeof referencedPluginId === 'string' && typeof localId === 'string'
        ? { pluginId: referencedPluginId, localId }
        : undefined;
}

function projectCapabilities(definition: object) {
    const raw = Reflect.get(definition, 'capabilities');
    if (!Array.isArray(raw)) {
        return ScmHostingProviderCapabilitiesSchema.parse(raw ?? {});
    }
    const operations = new Set(raw.filter((value): value is string => typeof value === 'string'));
    const pullRequest = operations.has('pullRequest');
    return ScmHostingProviderCapabilitiesSchema.parse({
        pullRequests: {
            list: pullRequest,
            get: pullRequest,
            create: pullRequest,
        },
    });
}

export const scmHostingProviderProjectionFamily = definePluginProjectionFamilyV2({
    family: 'scmHostingProviders',
    project({ registry }) {
        return {
            family: 'scmHostingProviders',
            entriesById: Object.fromEntries(
                [...(registry.scmHostingProviders ?? [])]
                    .map((provider) => ({
                        provider,
                        key: provider.pluginId
                            ? buildQualifiedPluginContributionKey({
                                pluginId: provider.pluginId,
                                localId: provider.id,
                            })
                            : provider.id,
                    }))
                    .sort((left, right) => left.key.localeCompare(right.key))
                    .map(({ provider, key }) => [
                        key,
                        {
                            id: key,
                            localId: provider.id,
                            pluginId: provider.pluginId,
                            kind: provider.definition.kind,
                            displayName: readProjectedTitle(provider.definition),
                            description: readProjectedText(Reflect.get(provider.definition, 'description')),
                            baseUrl: Reflect.get(provider.definition, 'baseUrl'),
                            urlSafety: Reflect.get(provider.definition, 'urlSafety'),
                            capabilities: projectCapabilities(provider.definition),
                            operations: Reflect.get(provider.definition, 'capabilities'),
                            authService: projectAuthService(
                                provider.pluginId,
                                Reflect.get(provider.definition, 'authService'),
                            ),
                            metadata: Reflect.get(provider.definition, 'metadata'),
                        },
                    ]),
            ),
        };
    },
});
