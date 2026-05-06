import { z } from 'zod';
import {
    PetAssetMediaTypeV1Schema,
    PetPackageManifestV1Schema,
} from '@happier-dev/protocol';

import type { LocalPetSourceMetadata } from '@/sync/domains/pets/localPetSourceTypes';

import { getPersistenceStorage } from './persistenceStorage';

function localPetSourcesBySourceKeyKey(): string {
    return 'local-pet-sources-v1';
}

const SourceKeySchema = z.string().min(1).max(500);
const PackagePathSchema = z.string().min(1).max(10_000);

const LocalPetPackageSourceSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('detectedCodexHome'),
        homeKind: z.enum(['user', 'connectedService']),
        homePath: PackagePathSchema,
        packagePath: PackagePathSchema,
        sourceKey: SourceKeySchema,
    }).strip(),
    z.object({
        kind: z.literal('happierManagedLocal'),
        packagePath: PackagePathSchema,
        sourceKey: SourceKeySchema,
    }).strip(),
]);

const LocalPetSourceMetadataSchema = z.object({
    sourceKey: SourceKeySchema,
    source: LocalPetPackageSourceSchema,
    displayName: z.string().min(1).max(200),
    manifest: PetPackageManifestV1Schema,
    mediaType: PetAssetMediaTypeV1Schema,
    digest: z.string().min(1).max(500).nullable(),
    sizeBytes: z.number().int().min(0).nullable(),
    daemonTarget: z.object({
        serverId: z.string().min(1).max(500),
        machineId: z.string().min(1).max(500),
    }).strip(),
}).strip();

function parseLocalPetSourcesBySourceKey(input: unknown): Record<string, LocalPetSourceMetadata> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};

    const result: Record<string, LocalPetSourceMetadata> = {};
    for (const [sourceKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
        const parsed = LocalPetSourceMetadataSchema.safeParse(rawValue);
        if (!parsed.success) continue;
        if (parsed.data.sourceKey !== sourceKey) continue;
        if (parsed.data.source.sourceKey !== sourceKey) continue;
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
