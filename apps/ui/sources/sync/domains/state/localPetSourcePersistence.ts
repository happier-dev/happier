import { z } from 'zod/mini';
import { DiscoveredPetPackageV1Schema } from '@happier-dev/protocol/pets/daemonRpc';

import type { LocalPetSourceMetadata } from '@/sync/domains/pets/localPetSourceTypes';

import { getPersistenceStorage } from './persistenceStorage';

function localPetSourcesBySourceKeyKey(): string {
    return 'local-pet-sources-v1';
}

const discoveryFields = DiscoveredPetPackageV1Schema.shape;

const LocalPetSourceMetadataSchema = z.object({
    sourceKey: discoveryFields.sourceKey,
    kind: z.enum(discoveryFields.kind.options.filter((kind) => kind === 'detectedCodexHome' || kind === 'happierManagedLocal')),
    displayName: discoveryFields.displayName,
    petId: discoveryFields.petId,
    mediaType: z.optional(discoveryFields.mediaType),
    spriteVersionNumber: discoveryFields.manifest.shape.spriteVersionNumber,
    digest: z.nullable(discoveryFields.digest),
    sizeBytes: z.nullable(discoveryFields.sizeBytes),
    daemonTarget: z.object({
        serverId: z.string().check(z.minLength(1), z.maxLength(500)),
        machineId: z.string().check(z.minLength(1), z.maxLength(500)),
    }),
});

function parseLocalPetSourcesBySourceKey(input: unknown): Record<string, LocalPetSourceMetadata> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};

    const result: Record<string, LocalPetSourceMetadata> = {};
    for (const [sourceKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
        // Retained 0.3 metadata stored daemon paths inside `source`. Read only
        // its existing kind/key and project away those paths on the next write.
        let candidate = rawValue;
        if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) && !('kind' in rawValue)) {
            const source = 'source' in rawValue ? rawValue.source : null;
            if (source && typeof source === 'object' && 'kind' in source && 'sourceKey' in source
                && source.sourceKey === sourceKey) {
                const manifest = 'manifest' in rawValue ? rawValue.manifest : null;
                candidate = { ...rawValue, kind: source.kind,
                    petId: manifest && typeof manifest === 'object' && 'id' in manifest ? manifest.id : undefined };
            }
        }
        const parsed = LocalPetSourceMetadataSchema.safeParse(candidate);
        if (!parsed.success) continue;
        if (parsed.data.sourceKey !== sourceKey) continue;
        result[sourceKey] = parsed.data;
    }

    return result;
}

export function loadLocalPetSourcesBySourceKey(): Record<string, LocalPetSourceMetadata> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(localPetSourcesBySourceKeyKey());
    if (!raw) return {};

    try {
        return parseLocalPetSourcesBySourceKey(JSON.parse(raw));
    } catch {
        return {};
    }
}

export function saveLocalPetSourcesBySourceKey(sources: Record<string, LocalPetSourceMetadata>): void {
    const mmkv = getPersistenceStorage();
    const parsed = parseLocalPetSourcesBySourceKey(sources);
    if (Object.keys(parsed).length === 0) {
        mmkv.delete(localPetSourcesBySourceKeyKey());
        return;
    }

    mmkv.set(localPetSourcesBySourceKeyKey(), JSON.stringify(parsed));
}
