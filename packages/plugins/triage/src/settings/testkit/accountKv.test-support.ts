import { PluginError } from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
    AccountKvEntry,
    AccountKvListItem,
    AccountKvService,
    AccountKvTransaction,
} from '@happier-dev/plugin-sdk/storage';

import {
    createTriageAccountKvCatalogStore,
    type TriageCatalogStoreV1,
} from '../accountKvCatalogStore.js';

/** A faithful in-memory boundary for Account KV's per-key CAS contract. */
export type TestkitAccountKv = Readonly<{
    kv: AccountKvService;
    catalog(key: string): TriageCatalogStoreV1;
    /** Write as another Account client would. */
    seed(key: string, value: JsonValue): void;
    /** Land one competing write immediately before the next attempted write. */
    armConcurrentWrite(key: string, value: JsonValue): void;
    read(key: string): JsonValue | undefined;
    revision(key: string): string;
    setCallCount(): number;
    rejectedExpectedVersions(): readonly (number | 'absent')[];
}>;

export function createTestkitAccountKv(
    initial: Readonly<Record<string, JsonValue>> = {},
): TestkitAccountKv {
    const entries = new Map<string, AccountKvEntry>(
        Object.entries(initial).map(([key, value]) => [key, { version: 0, value }]),
    );
    let setCalls = 0;
    const rejected: (number | 'absent')[] = [];
    let armed: Readonly<{ key: string; value: JsonValue }> | null = null;

    const seed = (key: string, value: JsonValue): void => {
        const current = entries.get(key);
        entries.set(key, { version: current === undefined ? 0 : current.version + 1, value });
    };

    const transaction = {
        async get<TValue extends JsonValue = JsonValue>(key: string): Promise<AccountKvEntry<TValue> | null> {
            return (entries.get(key) ?? null) as AccountKvEntry<TValue> | null;
        },
        async set(
            key: string,
            value: JsonValue,
            options: Readonly<{ expectedVersion: number | 'absent' }>,
        ): Promise<Readonly<{ version: number }>> {
            setCalls += 1;
            if (armed !== null) {
                seed(armed.key, armed.value);
                armed = null;
            }
            const current = entries.get(key);
            const conflicts = options.expectedVersion === 'absent'
                ? current !== undefined
                : current === undefined || current.version !== options.expectedVersion;
            if (conflicts) {
                rejected.push(options.expectedVersion);
                throw new PluginError({
                    code: 'plugin_account_kv_conflict',
                    message: 'Plugin Account KV version does not match the current value.',
                    details: { currentVersion: current?.version ?? null },
                });
            }
            const version = current === undefined ? 0 : current.version + 1;
            entries.set(key, { version, value });
            return { version };
        },
        async delete(
            key: string,
            options: Readonly<{ expectedVersion: number }>,
        ): Promise<Readonly<{ version: number; deleted: true }>> {
            const current = entries.get(key);
            if (current === undefined || current.version !== options.expectedVersion) {
                rejected.push(options.expectedVersion);
                throw new PluginError({
                    code: 'plugin_account_kv_conflict',
                    message: 'Plugin Account KV version does not match the current value.',
                    details: { currentVersion: current?.version ?? null },
                });
            }
            const entry = { version: current.version + 1, deleted: true as const };
            entries.set(key, entry);
            return entry;
        },
    };

    const kv: AccountKvService = Object.freeze({
        ...transaction,
        async list(options?: Readonly<{
            cursor?: string;
            limit?: number;
            prefix?: string;
            signal?: AbortSignal;
        }>) {
            const items: AccountKvListItem[] = [];
            for (const [key, entry] of entries) {
                if (options?.prefix !== undefined && !key.startsWith(options.prefix)) continue;
                items.push({ key, ...entry });
            }
            return { items };
        },
        async transaction<T>(operation: (value: AccountKvTransaction) => Promise<T>) {
            return await operation(transaction);
        },
    });

    return Object.freeze({
        kv,
        catalog: (key) => createTriageAccountKvCatalogStore(kv, key),
        seed,
        armConcurrentWrite(key, value) {
            armed = { key, value };
        },
        read(key) {
            const entry = entries.get(key);
            return entry === undefined || 'deleted' in entry ? undefined : entry.value;
        },
        revision(key) {
            const entry = entries.get(key);
            return entry === undefined ? 'absent' : String(entry.version);
        },
        setCallCount: () => setCalls,
        rejectedExpectedVersions: () => [...rejected],
    });
}
