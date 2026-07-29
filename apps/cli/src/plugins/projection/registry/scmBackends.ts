import {
    buildQualifiedPluginContributionKey,
} from '@happier-dev/protocol';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

function readProjectedText(value: unknown): string | undefined {
    if (typeof value === 'string') return value.trim() || undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const fallback = Reflect.get(value, 'fallback');
    return typeof fallback === 'string' ? fallback.trim() || undefined : undefined;
}

export const scmBackendProjectionFamily = definePluginProjectionFamilyV2({
    family: 'scmBackends',
    project({ registry, scmRuntimeAvailability }) {
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
                    .filter(({ key }) => (
                        scmRuntimeAvailability === undefined
                        || scmRuntimeAvailability.backendIds.has(key)
                    ))
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
