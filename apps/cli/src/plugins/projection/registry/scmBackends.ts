import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

function readProjectedText(value: unknown): string | undefined {
    return resolvePluginLocalizedStringV2Text(value).trim() || undefined;
}

export const scmBackendProjectionFamily = definePluginProjectionFamilyV2({
    family: 'scmBackends',
    project({ registry }) {
        return {
            family: 'scmBackends',
            entriesById: Object.fromEntries(
                [...(registry.scmBackends ?? [])]
                    .map((backend) => ({
                        backend,
                        key: backend.pluginId
                            ? buildQualifiedPluginContributionKey({
                                pluginId: backend.pluginId,
                                localId: backend.id,
                            })
                            : backend.id,
                    }))
                    .sort((left, right) => left.key.localeCompare(right.key))
                    .map(({ backend, key }) => [
                        key,
                        {
                            id: key,
                            localId: backend.id,
                            pluginId: backend.pluginId,
                            title: backend.definition.title,
                            displayName: readProjectedText(backend.definition.title),
                            description: readProjectedText(backend.definition.description),
                            kind: backend.definition.kind,
                            capabilities: backend.definition.capabilities,
                            operations: backend.definition.capabilities,
                            metadata: backend.definition.metadata,
                        },
                    ]),
            ),
        };
    },
});
