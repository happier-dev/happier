import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The warm cache is the only store that holds session names, summaries, paths and hostnames after
 * decryption, so these tests are about what ends up on disk, not about caching behaviour:
 *
 * - on a native build nothing decrypted may be written through an unencrypted MMKV instance;
 * - the plaintext bytes previous native builds already wrote must be deleted, not merely orphaned;
 * - a device that cannot produce the key must degrade to a cold boot rather than throw;
 * - and on web the cache must still persist and rehydrate, because there the encryption would be
 *   decorative (see `resolveWarmCacheStoragePlacement`) and its absence costs every page load a
 *   blank list and a full re-decrypt.
 *
 * The two directions are asserted separately and on purpose: making web encrypted again reinstates
 * the cold-boot regression, and making native plaintext reinstates the at-rest exposure.
 *
 * The MMKV boundary is faked locally (rather than through the shared stub) because the contract
 * under test is the *construction* of the store — which instance, with which `encryptionKey` — and
 * the shared stub is deliberately a single flat map that ignores instance configuration.
 */

type MmkvConfig = Readonly<{ id?: string; encryptionKey?: string }>;

type MmkvInstanceRecord = Readonly<{
    config: MmkvConfig | undefined;
    writes: string[];
    deletes: string[];
}>;

const instances: MmkvInstanceRecord[] = [];
const stores = new Map<string, Map<string, string>>();
const trimCounts = new Map<string, number>();
const storageOperations: string[] = [];

function storeIdFor(config: MmkvConfig | undefined): string {
    return config?.id ?? 'mmkv.default';
}

function storeFor(config: MmkvConfig | undefined): Map<string, string> {
    const id = storeIdFor(config);
    const existing = stores.get(id);
    if (existing) return existing;
    const created = new Map<string, string>();
    stores.set(id, created);
    return created;
}

vi.mock('react-native-mmkv', () => {
    class MMKV {
        private readonly store: Map<string, string>;
        private readonly record: MmkvInstanceRecord;

        private readonly config: MmkvConfig | undefined;

        constructor(config?: MmkvConfig) {
            this.config = config;
            this.store = storeFor(config);
            this.record = { config, writes: [], deletes: [] };
            instances.push(this.record);
        }

        getString(key: string): string | undefined {
            return this.store.get(key);
        }

        set(key: string, value: string): void {
            this.record.writes.push(key);
            storageOperations.push(`set:${storeIdFor(this.config)}:${key}:${value.length}`);
            this.store.set(key, value);
        }

        delete(key: string): void {
            this.record.deletes.push(key);
            storageOperations.push(`delete:${storeIdFor(this.config)}:${key}`);
            this.store.delete(key);
        }

        getAllKeys(): string[] {
            return [...this.store.keys()];
        }

        // A `Map` has nothing to compact, so this only records that compaction was asked for. That is
        // the most any in-process test can establish: the tombstone this call exists to defeat is a
        // property of MMKV's append-only file, which no stub reproduces.
        trim(): void {
            const id = storeIdFor(this.config);
            storageOperations.push(`trim:${id}`);
            trimCounts.set(id, (trimCounts.get(id) ?? 0) + 1);
        }
    }

    return { MMKV };
});

const SESSION_LIST_KEY = 'session-list-warm-cache-v1:server-a:account-a';
const MACHINE_KEY = 'machine-display-warm-cache-v1:server-a:account-a';
const UNRELATED_KEY = 'device-analytics-id-v1';

const SESSION_ENTRY = {
    sessionId: 's1',
    metadataVersion: 1,
    agentStateVersion: 1,
    updatedAt: 20,
    createdAt: 10,
    active: true,
    activeAt: 20,
    archivedAt: null,
    name: 'Secret project name',
    summaryText: 'Summary that must not sit on disk in the clear',
    path: '/home/u/secret-repo',
    homeDir: '/home/u',
    host: 'leeroy-mbp',
} as const;

async function importWarmCachePersistence() {
    return await import('./warmCachePersistence');
}

async function importWarmCacheEncryptionKey() {
    return await import('./warmCacheEncryptionKey');
}

function legacyPlaintextStore(): Map<string, string> {
    return storeFor(undefined);
}

function legacyPlaintextTrimCount(): number {
    return trimCounts.get('mmkv.default') ?? 0;
}

/**
 * The same predicate the module uses: React Native defines `window` but never `document`, so a DOM
 * document is what separates the browser and Tauri desktop bundles from a native build.
 */
function stubWebRuntime(): void {
    vi.stubGlobal('window', globalThis as unknown as Window & typeof globalThis);
    vi.stubGlobal('document', {} as Document);
}

describe('warmCachePersistence at-rest encryption', () => {
    beforeEach(() => {
        vi.resetModules();
        instances.length = 0;
        stores.clear();
        trimCounts.clear();
        storageOperations.length = 0;
    });

    it('writes decrypted session content only through an encrypted MMKV instance', async () => {
        await (await importWarmCacheEncryptionKey()).prepareWarmCacheEncryptionKey();
        const persistence = await importWarmCachePersistence();

        persistence.saveSessionListWarmCacheEntries('server-a', 'account-a', { s1: { ...SESSION_ENTRY } });
        persistence.saveMachineDisplayWarmCacheEntries('server-a', 'account-a', {
            m1: { machineId: 'm1', metadataVersion: 1, updatedAt: 5, active: true, activeAt: 5, revokedAt: null, host: 'leeroy-mbp' },
        });

        const writingInstances = instances.filter((instance) => instance.writes.length > 0);
        expect(writingInstances.length).toBeGreaterThan(0);
        for (const instance of writingInstances) {
            expect(instance.config?.encryptionKey ?? '').not.toBe('');
        }
    });

    it('leaves no decrypted session content in the unencrypted default instance', async () => {
        await (await importWarmCacheEncryptionKey()).prepareWarmCacheEncryptionKey();
        const persistence = await importWarmCachePersistence();

        persistence.saveSessionListWarmCacheEntries('server-a', 'account-a', { s1: { ...SESSION_ENTRY } });

        const plaintextBytes = [...legacyPlaintextStore().values()].join('\n');
        expect(plaintextBytes).not.toContain(SESSION_ENTRY.name);
        expect(plaintextBytes).not.toContain(SESSION_ENTRY.summaryText);
        expect(plaintextBytes).not.toContain(SESSION_ENTRY.path);
        expect(plaintextBytes).not.toContain(SESSION_ENTRY.host);
    });

    it('deletes warm-cache keys previous builds wrote in plaintext, and nothing else', async () => {
        const legacy = legacyPlaintextStore();
        legacy.set(SESSION_LIST_KEY, JSON.stringify({ s1: { ...SESSION_ENTRY } }));
        legacy.set(MACHINE_KEY, JSON.stringify({ m1: { host: 'leeroy-mbp' } }));
        legacy.set(UNRELATED_KEY, 'keep-me');

        await (await importWarmCacheEncryptionKey()).prepareWarmCacheEncryptionKey();
        const persistence = await importWarmCachePersistence();
        persistence.loadSessionListWarmCacheEntries('server-a', 'account-a');

        expect([...legacy.keys()]).toEqual([UNRELATED_KEY]);
    });

    /**
     * Deleting the keys is not the same as retiring the bytes.
     *
     * MMKV's file is append-only: `delete` writes a tombstone and the previous value's bytes stay in
     * the mmap until the file is compacted. For an ordinary cache that is invisible, but here those
     * previous values ARE the thing being retired — decrypted names, summaries, paths and hostnames —
     * so a purge that stops at `delete` is cosmetic and leaves the plaintext exactly where it was.
     *
     * This asserts the compaction call because it is the contract, not an incidental interaction: it
     * is the whole of what the application can do about bytes already written. Its limit is stated
     * plainly rather than papered over — a `Map`-backed stub deletes for real, so no test at this
     * layer can observe the tombstone it is guarding against. Physical erasure is a device check
     * (install-over-existing on iOS and Android), and that gate is still open.
     */
    it('forces a full rewrite before compacting the legacy store, so deleted plaintext cannot survive as a tombstone', async () => {
        const legacy = legacyPlaintextStore();
        legacy.set(SESSION_LIST_KEY, JSON.stringify({ s1: { ...SESSION_ENTRY } }));

        const persistence = await importWarmCachePersistence();
        persistence.loadSessionListWarmCacheEntries('server-a', 'account-a');

        const legacyOperations = storageOperations.filter((operation) => operation.includes(':mmkv.default'));
        expect(legacyOperations).toEqual([
            `delete:mmkv.default:${SESSION_LIST_KEY}`,
            expect.stringMatching(/^set:mmkv\.default:warm-cache-plaintext-purge-compaction-v1:\d{5,}$/),
            'trim:mmkv.default',
            'delete:mmkv.default:warm-cache-plaintext-purge-compaction-v1',
            'trim:mmkv.default',
        ]);
        expect(legacyPlaintextTrimCount()).toBe(2);
        expect([...legacy.keys()]).toEqual([]);
    });

    it('does not compact when there was no plaintext to purge', async () => {
        legacyPlaintextStore().set(UNRELATED_KEY, 'keep-me');

        const persistence = await importWarmCachePersistence();
        persistence.loadSessionListWarmCacheEntries('server-a', 'account-a');

        expect(legacyPlaintextTrimCount()).toBe(0);
    });

    it('purges the plaintext keys even when no key is available, since nothing will replace them', async () => {
        const legacy = legacyPlaintextStore();
        legacy.set(SESSION_LIST_KEY, JSON.stringify({ s1: { ...SESSION_ENTRY } }));
        legacy.set(UNRELATED_KEY, 'keep-me');

        const persistence = await importWarmCachePersistence();
        persistence.loadSessionListWarmCacheEntries('server-a', 'account-a');

        expect([...legacy.keys()]).toEqual([UNRELATED_KEY]);
    });

    it('purges the plaintext keys at boot, on a boot that never reads the cache at all', async () => {
        // A signed-out boot never reaches a warm-cache read, and that is precisely the boot where
        // the retired plaintext would otherwise stay on disk indefinitely.
        const legacy = legacyPlaintextStore();
        legacy.set(SESSION_LIST_KEY, JSON.stringify({ s1: { ...SESSION_ENTRY } }));
        legacy.set(MACHINE_KEY, JSON.stringify({ m1: { host: 'leeroy-mbp' } }));
        legacy.set(UNRELATED_KEY, 'keep-me');

        const persistence = await importWarmCachePersistence();
        await persistence.prepareWarmCacheStorage();

        expect([...legacy.keys()]).toEqual([UNRELATED_KEY]);
    });

    it('degrades to a cold boot instead of throwing when the key is unavailable', async () => {
        const persistence = await importWarmCachePersistence();

        expect(() => persistence.loadSessionListWarmCacheEntries('server-a', 'account-a')).not.toThrow();
        expect(persistence.loadSessionListWarmCacheEntries('server-a', 'account-a')).toEqual({});
        expect(persistence.loadMachineDisplayWarmCacheEntries('server-a', 'account-a')).toEqual({});
        expect(() => persistence.saveSessionListWarmCacheEntries('server-a', 'account-a', { s1: { ...SESSION_ENTRY } })).not.toThrow();

        expect(instances.every((instance) => instance.writes.length === 0)).toBe(true);
    });

    it('starts persisting once the key lands after a boot that raced ahead of it', async () => {
        const persistence = await importWarmCachePersistence();
        expect(persistence.loadSessionListWarmCacheEntries('server-a', 'account-a')).toEqual({});

        await (await importWarmCacheEncryptionKey()).prepareWarmCacheEncryptionKey();
        persistence.saveSessionListWarmCacheEntries('server-a', 'account-a', { s1: { ...SESSION_ENTRY } });

        const writingInstances = instances.filter((instance) => instance.writes.length > 0);
        expect(writingInstances.length).toBe(1);
        expect(writingInstances[0]?.config?.encryptionKey ?? '').not.toBe('');
    });
});

/**
 * Web (and the Tauri desktop shell that ships the same bundle) is the direction that regressed once
 * already: encrypting the warm cache there produced no store at all, so every page load painted an
 * empty list, refetched, and re-decrypted every row.
 */
describe('warmCachePersistence on web', () => {
    beforeEach(() => {
        vi.resetModules();
        instances.length = 0;
        stores.clear();
        trimCounts.clear();
    });

    it('persists and rehydrates across a page load, through the plain shared instance', async () => {
        stubWebRuntime();
        try {
            const persistence = await importWarmCachePersistence();
            await persistence.prepareWarmCacheStorage();
            persistence.saveSessionListWarmCacheEntries('server-a', 'account-a', { s1: { ...SESSION_ENTRY } });

            // A fresh module registry stands in for the next page load: the entries have to come
            // back from storage, not from this process's in-memory baseline.
            vi.resetModules();
            const reloaded = await importWarmCachePersistence();
            await reloaded.prepareWarmCacheStorage();

            expect(reloaded.loadSessionListWarmCacheEntries('server-a', 'account-a')).toEqual({
                s1: expect.objectContaining({ sessionId: 's1', name: SESSION_ENTRY.name }),
            });

            const writingInstances = instances.filter((instance) => instance.writes.length > 0);
            expect(writingInstances.length).toBeGreaterThan(0);
            for (const instance of writingInstances) {
                // Not a style preference: passing one at all makes MMKV throw on web.
                expect(instance.config?.encryptionKey).toBeUndefined();
            }
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('does not purge the keys it is still reading', async () => {
        // The purge retires the plaintext copy a native build left behind after moving to the
        // encrypted instance. On web there is no move and no copy: these bytes ARE the live cache.
        stubWebRuntime();
        try {
            const live = legacyPlaintextStore();
            live.set(SESSION_LIST_KEY, JSON.stringify({ s1: { ...SESSION_ENTRY } }));

            const persistence = await importWarmCachePersistence();
            await persistence.prepareWarmCacheStorage();

            expect(persistence.loadSessionListWarmCacheEntries('server-a', 'account-a')).toEqual({
                s1: expect.objectContaining({ sessionId: 's1' }),
            });
            expect(live.has(SESSION_LIST_KEY)).toBe(true);
            expect(legacyPlaintextTrimCount()).toBe(0);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('restores the machine displays too, not only the session list', async () => {
        stubWebRuntime();
        try {
            const persistence = await importWarmCachePersistence();
            await persistence.prepareWarmCacheStorage();
            persistence.saveMachineDisplayWarmCacheEntries('server-a', 'account-a', {
                m1: { machineId: 'm1', metadataVersion: 1, updatedAt: 5, active: true, activeAt: 5, revokedAt: null, host: 'leeroy-mbp' },
            });

            vi.resetModules();
            const reloaded = await importWarmCachePersistence();
            await reloaded.prepareWarmCacheStorage();

            expect(reloaded.loadMachineDisplayWarmCacheEntries('server-a', 'account-a')).toEqual({
                m1: expect.objectContaining({ machineId: 'm1', host: 'leeroy-mbp' }),
            });
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe('warmCacheEncryptionKey', () => {
    beforeEach(() => {
        vi.resetModules();
        instances.length = 0;
        stores.clear();
        trimCounts.clear();
    });

    it('produces a key MMKV can use in full, rather than one it silently truncates', async () => {
        const resolution = await (await importWarmCacheEncryptionKey()).prepareWarmCacheEncryptionKey();

        expect(resolution.kind).toBe('ready');
        if (resolution.kind !== 'ready') return;
        // MMKV reads at most 16 bytes; anything longer would be a longer string but the same key.
        expect(resolution.key).toHaveLength(16);
        expect(new TextEncoder().encode(resolution.key)).toHaveLength(16);
    });

    it('reuses the stored key across restarts instead of rotating it', async () => {
        const keystore = new Map<string, string>();
        vi.doMock('expo-secure-store', () => ({
            getItemAsync: async (key: string) => keystore.get(key) ?? null,
            setItemAsync: async (key: string, value: string) => {
                keystore.set(key, value);
            },
            deleteItemAsync: async (key: string) => {
                keystore.delete(key);
            },
        }));

        const firstRun = await (await importWarmCacheEncryptionKey()).prepareWarmCacheEncryptionKey();
        expect(firstRun.kind).toBe('ready');
        expect(keystore.size).toBe(1);

        // A fresh module registry is this process's stand-in for a restart: the key must come back
        // from the keystore, because a rotated key would silently orphan the encrypted cache.
        vi.resetModules();
        const restarted = await importWarmCacheEncryptionKey();
        const secondRun = await restarted.prepareWarmCacheEncryptionKey();

        expect(secondRun).toEqual(firstRun);
        expect(restarted.readResolvedWarmCacheEncryptionKey()).toBe(firstRun.kind === 'ready' ? firstRun.key : null);
        expect(keystore.size).toBe(1);
    });

    it('resolves no key on web and desktop, where MMKV rejects one and no keystore holds it', async () => {
        // MMKV throws on `encryptionKey` outright on web (`createMMKV.web.ts`) and there is no
        // keystore to hold one. What the warm cache does with that answer is asserted below.
        stubWebRuntime();
        try {
            const resolution = await (await importWarmCacheEncryptionKey()).prepareWarmCacheEncryptionKey();
            expect(resolution).toEqual({ kind: 'unavailable', reason: 'unsupported-platform' });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('reports unavailable rather than throwing when the keystore rejects the write', async () => {
        vi.doMock('expo-secure-store', () => ({
            getItemAsync: async () => null,
            setItemAsync: async () => {
                throw new Error('keystore unavailable');
            },
            deleteItemAsync: async () => {},
        }));

        const module = await importWarmCacheEncryptionKey();
        const resolution = await module.prepareWarmCacheEncryptionKey();

        expect(resolution).toEqual({ kind: 'unavailable', reason: 'keystore-unavailable' });
        expect(module.readResolvedWarmCacheEncryptionKey()).toBeNull();
    });
});
