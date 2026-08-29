import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { AccountKvService } from '@happier-dev/plugin-sdk/storage';

export type TriageCatalogSnapshotV1 = Readonly<{
    revision: string;
    value: JsonValue | undefined;
}>;

export type TriageCatalogStoreV1 = Readonly<{
    read(options?: Readonly<{ signal?: AbortSignal }>): Promise<TriageCatalogSnapshotV1>;
    write(
        value: JsonValue,
        options: Readonly<{ expectedRevision: string; signal?: AbortSignal }>,
    ): Promise<Readonly<{ revision: string }>>;
}>;

/**
 * Adapts the incumbent Account KV per-key CAS to the two Triage catalog owners.
 * The adapter owns no state: the KV row version is the catalog revision and the
 * catalog parser/mutator remains the sole semantic owner.
 */
export function createTriageAccountKvCatalogStore(
    kv: AccountKvService,
    key: string,
): TriageCatalogStoreV1 {
    return Object.freeze({
        async read(options) {
            const entry = await kv.get(key, options);
            if (entry === null) return { revision: 'absent', value: undefined };
            if ('deleted' in entry) return { revision: String(entry.version), value: undefined };
            return { revision: String(entry.version), value: entry.value };
        },
        async write(value, options) {
            const expectedVersion = options.expectedRevision === 'absent'
                ? 'absent' as const
                : Number(options.expectedRevision);
            if (expectedVersion !== 'absent' && !Number.isSafeInteger(expectedVersion)) {
                throw new Error('triage_catalog_revision_invalid');
            }
            const result = await kv.set(key, value, {
                expectedVersion,
                ...(options.signal ? { signal: options.signal } : {}),
            });
            return { revision: String(result.version) };
        },
    });
}
