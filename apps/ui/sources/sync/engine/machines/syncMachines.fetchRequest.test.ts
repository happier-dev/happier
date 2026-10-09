import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { MachineDataKeyCacheEntry } from './syncMachines';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { Encryption } from '@/sync/encryption/encryption';
import { buildMachineDisplayRenderableFromMachine, type MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';

const legacyCredentials = {
    token: `e30.${btoa(JSON.stringify({ sub: 'account-1' }))}.signature`,
    secret: btoa('a'.repeat(32)),
} satisfies AuthCredentials;

vi.mock('@/log', () => ({ log: { log: vi.fn() } }));

type RawMachine = {
    id: string;
    metadata: string;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: string | null;
    seq: number;
    active: boolean;
    activeAt: number;
    revokedAt: number | null;
    replacedByMachineId?: string | null;
    replacedAt?: number | null;
    replacementReason?: string | null;
    replacementSource?: string | null;
    replacementActorUserId?: string | null;
    installationId?: string | null;
    contentPublicKeyFingerprint?: string | null;
    createdAt: number;
    updatedAt: number;
};

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

async function createEncryptionHarness() {
    const contextOwner = await Encryption.create(new Uint8Array(32).fill(17));
    const decryptEncryptionKeys = vi.fn(async (values: readonly string[]): Promise<Array<Uint8Array | null>> =>
        values.map(() => new Uint8Array([1, 2, 3])));
    const initialized = new Set<string>();
    const initializeMachines = vi.fn(async (machineKeys: Map<string, Uint8Array | null>) => {
        for (const machineId of machineKeys.keys()) {
            initialized.add(machineId);
        }
    });
    const decryptMetadata = vi.fn(async (_version: number, value: string): Promise<unknown> => ({ decrypted: value }));
    const decryptDaemonState = vi.fn(async (_version: number, value: string | null) => {
        if (!value) return null;
        return { decrypted: value };
    });
    const machineEncryption = { decryptMetadata, decryptDaemonState };
    return {
        captureMachineEncryptionContext: contextOwner.captureMachineEncryptionContext.bind(contextOwner),
        captureMachineEncryptionContextRead: contextOwner.captureMachineEncryptionContextRead.bind(contextOwner),
        decryptEncryptionKeys,
        initializeMachines,
        decryptMetadata,
        decryptDaemonState,
        getMachineEncryption: (machineId: string) => {
            if (!initialized.has(machineId)) return null;
            return machineEncryption;
        },
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

beforeEach(() => {
    vi.resetModules();
});

async function loadFetchAndApplyMachines() {
    const mod = await import('./syncMachines');
    return mod.fetchAndApplyMachines;
}

describe('fetchAndApplyMachines request override', () => {
    it('retains the readable warm state and skips hydration for unchanged encrypted versions', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const existing = createMachineFixture({
            id: 'm_unchanged',
            kind: 'persistent',
            daemonState: { status: 'running' },
            daemonStateVersion: 7,
            storageMode: 'e2ee',
            availability: { kind: 'available' },
        });
        // Crypto and HTTP are external boundaries; fetch/hydration logic remains real.
        const encryption = await createEncryptionHarness();
        const applied: Machine[][] = [];
        const displayed: MachineDisplayRenderable[][] = [];
        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys: new Map(),
            request: async () => jsonResponse([{
                ...existing, metadata: 'unchanged-metadata', daemonState: 'unchanged-daemon', dataEncryptionKey: null,
            }]),
            getExistingMachine: () => existing,
            cachedMachineDisplayEntries: {},
            applyMachineDisplayEntries: (machines) => { displayed.push(machines); },
            applyMachines: (machines) => { applied.push(machines); },
        });
        expect(applied[0]?.[0]).toMatchObject({
            storageMode: 'e2ee', availability: { kind: 'available' },
            metadata: existing.metadata, daemonState: existing.daemonState, daemonStateVersion: 7,
        });
        expect(encryption.decryptMetadata).not.toHaveBeenCalled();
        expect(encryption.decryptDaemonState).not.toHaveBeenCalled();
        expect(displayed[0]).toEqual([buildMachineDisplayRenderableFromMachine(existing)]);
    });

    it('rehydrates an unchanged version when its machine data-key envelope changes', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const existing = createMachineFixture({
            id: 'm_rotated', storageMode: 'e2ee', availability: { kind: 'available' },
        });
        const encryption = await createEncryptionHarness();
        let current = existing;
        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys: new Map([[existing.id, { envelope: 'previous-key', dataKey: new Uint8Array([4, 5, 6]) }]]),
            request: async () => jsonResponse([{
                ...existing, metadata: 'rotated-metadata', dataEncryptionKey: 'next-key',
            }]),
            getExistingMachine: () => current,
            applyMachineDisplayEntries: () => {},
            applyMachines: (machines) => { current = machines[0]!; },
        });
        await vi.waitFor(() => expect(current.metadata).toEqual({ decrypted: 'rotated-metadata' }));
    });

    it('preserves terminal capabilities and their version until refreshed metadata is hydrated', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const existing = createMachineFixture({
            id: 'm_refresh',
            metadataVersion: 1,
            metadata: {
                ...createMachineFixture().metadata!,
                daemonTerminalSessionAttachSupported: true,
            },
        });
        const nextMetadata = { ...existing.metadata!, daemonTerminalSessionAttachSupported: false };
        let finishHydration!: (metadata: typeof nextMetadata) => void;
        const pendingMetadata = new Promise<typeof nextMetadata>((resolve) => { finishHydration = resolve; });
        const encryption = await createEncryptionHarness();
        encryption.decryptMetadata.mockImplementation(async () => pendingMetadata);
        let current: Machine = existing;

        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys: new Map(),
            request: async () => jsonResponse([{ ...existing, metadata: 'next-ciphertext', metadataVersion: 2, dataEncryptionKey: null }]),
            getExistingMachine: () => current,
            cachedMachineDisplayEntries: {},
            applyMachineDisplayEntries: () => {},
            applyMachines: (machines) => { current = machines[0]!; },
        });

        expect(current.metadata?.daemonTerminalSessionAttachSupported).toBe(true);
        expect(current.metadataVersion).toBe(1);
        finishHydration(nextMetadata);
        await vi.waitFor(() => expect(current.metadataVersion).toBe(2));
        expect(current.metadata?.daemonTerminalSessionAttachSupported).toBe(false);
    });


    it('uses injected request transport when provided', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const requestSpy = vi.fn(async (_path: string, _init?: RequestInit) =>
            jsonResponse([
                {
                    id: 'm1',
                    metadata: 'meta-1',
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                    dataEncryptionKey: null,
                    seq: 1,
                    active: true,
                    activeAt: 10,
                    revokedAt: null,
                    createdAt: 1,
                    updatedAt: 10,
                } satisfies RawMachine,
            ]),
        );

        const encryption = await createEncryptionHarness();
        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();
        const applied: unknown[][] = [];

        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys,
            request: requestSpy,
            applyMachines: (machines) => {
                applied.push(machines);
            },
        });

        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(applied).toHaveLength(1);
        expect((applied[0] as any[])[0]?.id).toBe('m1');
        expect((applied[0] as any[])[0]?.revokedAt).toBe(null);
    });

    it('hydrates full machine capabilities even when cached display metadata is fresh', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const requestSpy = vi.fn(async (_path: string, _init?: RequestInit) =>
            jsonResponse([
                {
                    id: 'm_cached',
                    metadata: 'encrypted-meta',
                    metadataVersion: 5,
                    daemonState: null,
                    daemonStateVersion: 0,
                    dataEncryptionKey: 'key-1',
                    seq: 1,
                    active: true,
                    activeAt: 10,
                    revokedAt: null,
                    createdAt: 1,
                    updatedAt: 10,
                } satisfies RawMachine,
            ]),
        );

        const encryption = await createEncryptionHarness();
        const applyMachines = vi.fn();
        const applyMachineDisplayEntries = vi.fn();

        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: requestSpy,
            applyMachines,
            ...( {
                cachedMachineDisplayEntries: {
                    m_cached: {
                        machineId: 'm_cached',
                        metadataVersion: 5,
                        updatedAt: 10,
                        active: true,
                        activeAt: 10,
                        revokedAt: null,
                        displayName: 'Cached machine',
                        host: 'mbp',
                        homeDir: '/home/u',
                    },
                },
                applyMachineDisplayEntries,
            } as any),
        } as any);

        await vi.waitFor(() => expect(applyMachines).toHaveBeenLastCalledWith([
            expect.objectContaining({ id: 'm_cached', metadata: { decrypted: 'encrypted-meta' } }),
        ], false));
        expect(applyMachines).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'm_cached',
                metadataVersion: 5,
                metadata: null,
            }),
        ], false);
        expect(applyMachineDisplayEntries).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'm_cached',
                metadataVersion: 5,
                metadata: expect.objectContaining({
                    displayName: 'Cached machine',
                    host: 'mbp',
                    homeDir: '/home/u',
                }),
            }),
        ], { replace: false });
    });

    it('hydrates every machine beyond the previous background row cutoff', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const rows = Array.from({ length: 70 }, (_, index) => ({
            id: `m_${index + 1}`,
            metadata: `encrypted-meta-${index + 1}`,
            metadataVersion: 2,
            daemonState: null,
            daemonStateVersion: 0,
            dataEncryptionKey: 'key-1',
            seq: index + 1,
            active: true,
            activeAt: 10 + index,
            revokedAt: null,
            createdAt: 1,
            updatedAt: 10 + index,
        } satisfies RawMachine));
        const requestSpy = vi.fn(async () => jsonResponse(rows));
        const encryption = await createEncryptionHarness();
        const applyMachines = vi.fn();
        const applyMachineDisplayEntries = vi.fn();
        const cachedMachineDisplayEntries = Object.fromEntries(rows.map((row) => [
            row.id,
            {
                machineId: row.id,
                metadataVersion: 1,
                updatedAt: row.updatedAt,
                active: row.active,
                activeAt: row.activeAt,
                revokedAt: null,
                displayName: `Cached ${row.id}`,
                host: 'mbp',
                homeDir: '/home/u',
            },
        ]));

        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: requestSpy,
            applyMachines,
            cachedMachineDisplayEntries,
            applyMachineDisplayEntries,
        } as any);
        await Promise.resolve();
        await Promise.resolve();

        await vi.waitFor(() => {
            const hydrated = applyMachines.mock.calls.slice(1).flatMap(([machines]) => machines as Machine[]);
            expect(hydrated.map((machine) => machine.id).sort()).toEqual(rows.map((row) => row.id).sort());
            expect(hydrated.every((machine) => machine.metadata !== null)).toBe(true);
        });
    });

    it('carries machine replacement metadata from fetched rows into applied machine state', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const requestSpy = vi.fn(async (_path: string, _init?: RequestInit) =>
            jsonResponse([
                {
                    id: 'm_replaced',
                    metadata: 'encrypted-meta',
                    metadataVersion: 5,
                    daemonState: null,
                    daemonStateVersion: 0,
                    dataEncryptionKey: 'key-1',
                    seq: 1,
                    active: false,
                    activeAt: 10,
                    revokedAt: null,
                    replacedByMachineId: 'm_current',
                    replacedAt: 11,
                    replacementReason: 'reauth',
                    replacementSource: 'automatic',
                    replacementActorUserId: 'user-1',
                    installationId: 'installation-1',
                    contentPublicKeyFingerprint: 'content-key-1',
                    createdAt: 1,
                    updatedAt: 12,
                } satisfies RawMachine,
            ]),
        );

        const encryption = await createEncryptionHarness();
        const applyMachines = vi.fn();
        const applyMachineDisplayEntries = vi.fn();

        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: requestSpy,
            applyMachines,
            ...( {
                applyMachineDisplayEntries,
            } as any),
        } as any);

        expect(applyMachines).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'm_replaced',
                replacedByMachineId: 'm_current',
                replacedAt: 11,
                replacementReason: 'reauth',
                replacementSource: 'automatic',
                replacementActorUserId: 'user-1',
                installationId: 'installation-1',
                contentPublicKeyFingerprint: 'content-key-1',
            }),
        ], false);
        expect(applyMachineDisplayEntries).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'm_replaced',
                replacedByMachineId: 'm_current',
                replacedAt: 11,
                replacementReason: 'reauth',
                replacementSource: 'automatic',
                replacementActorUserId: 'user-1',
            }),
        ], { replace: false });
    });

    it('still hydrates machine daemonState when cache-hit display metadata is fresh', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const requestSpy = vi.fn(async (_path: string, _init?: RequestInit) =>
            jsonResponse([
                {
                    id: 'm_cached',
                    metadata: 'encrypted-meta',
                    metadataVersion: 5,
                    daemonState: 'encrypted-daemon',
                    daemonStateVersion: 7,
                    dataEncryptionKey: 'key-1',
                    seq: 1,
                    active: true,
                    activeAt: 10,
                    revokedAt: null,
                    createdAt: 1,
                    updatedAt: 10,
                } satisfies RawMachine,
            ]),
        );

        const encryption = await createEncryptionHarness();
        const applyMachines = vi.fn();
        const applyMachineDisplayEntries = vi.fn();

        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: requestSpy,
            applyMachines,
            ...( {
                cachedMachineDisplayEntries: {
                    m_cached: {
                        machineId: 'm_cached',
                        metadataVersion: 5,
                        updatedAt: 10,
                        active: true,
                        activeAt: 10,
                        revokedAt: null,
                        displayName: 'Cached machine',
                        host: 'mbp',
                        homeDir: '/home/u',
                    },
                },
                applyMachineDisplayEntries,
            } as any),
        } as any);

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(encryption.decryptDaemonState).toHaveBeenCalledWith(7, 'encrypted-daemon');
        expect(applyMachines).toHaveBeenLastCalledWith([
            expect.objectContaining({
                id: 'm_cached',
                metadataVersion: 5,
                daemonStateVersion: 7,
                daemonState: { decrypted: 'encrypted-daemon' },
            }),
        ], false);
    });

    it('preserves existing daemonState while cache-hit machine hydration is still pending', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        // Match the store's stable row identity so the real read-currentness guard stays active.
        const existing = createMachineFixture({ id: 'm_cached', metadataVersion: 5,
            daemonState: { status: 'running' }, daemonStateVersion: 7,
            storageMode: 'e2ee', availability: { kind: 'available' } });
        const requestSpy = vi.fn(async (_path: string, _init?: RequestInit) =>
            jsonResponse([
                {
                    id: 'm_cached',
                    metadata: 'encrypted-meta',
                    metadataVersion: 5,
                    daemonState: 'encrypted-daemon',
                    daemonStateVersion: 7,
                    dataEncryptionKey: 'key-1',
                    seq: 1,
                    active: true,
                    activeAt: 10,
                    revokedAt: null,
                    createdAt: 1,
                    updatedAt: 10,
                } satisfies RawMachine,
            ]),
        );

        const encryption = await createEncryptionHarness();
        encryption.decryptMetadata.mockImplementation(async () => new Promise<never>(() => {}));
        encryption.decryptDaemonState.mockImplementation(async () => new Promise<never>(() => {}));
        const applyMachines = vi.fn();
        const applyMachineDisplayEntries = vi.fn();

        const fetchPromise = fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: requestSpy,
            applyMachines,
            getExistingMachine: (machineId: string) => machineId === 'm_cached'
                ? existing
                : null,
            ...( {
                cachedMachineDisplayEntries: {
                    m_cached: {
                        machineId: 'm_cached',
                        metadataVersion: 5,
                        updatedAt: 10,
                        active: true,
                        activeAt: 10,
                        revokedAt: null,
                        displayName: 'Cached machine',
                        host: 'mbp',
                        homeDir: '/home/u',
                    },
                },
                applyMachineDisplayEntries,
            } as any),
        } as any);

        const raceResult = await Promise.race([
            fetchPromise.then(() => 'resolved'),
            new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 25)),
        ]);

        expect(raceResult).toBe('resolved');
        expect(applyMachines).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'm_cached',
                metadataVersion: 5,
                daemonStateVersion: 7,
                daemonState: { status: 'running' },
            }),
        ], false);
    });

    it('clears existing daemonState immediately when the fetched row no longer carries daemonState', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        // Match the store's stable row identity so the real read-currentness guard stays active.
        const existing = createMachineFixture({ id: 'm_cached', metadataVersion: 5,
            daemonState: { status: 'running' }, daemonStateVersion: 7,
            storageMode: 'e2ee', availability: { kind: 'available' } });
        const requestSpy = vi.fn(async (_path: string, _init?: RequestInit) =>
            jsonResponse([
                {
                    id: 'm_cached',
                    metadata: 'encrypted-meta',
                    metadataVersion: 5,
                    daemonState: null,
                    daemonStateVersion: 8,
                    dataEncryptionKey: 'key-1',
                    seq: 1,
                    active: true,
                    activeAt: 10,
                    revokedAt: null,
                    createdAt: 1,
                    updatedAt: 10,
                } satisfies RawMachine,
            ]),
        );

        const encryption = await createEncryptionHarness();
        const applyMachines = vi.fn();
        const applyMachineDisplayEntries = vi.fn();

        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: requestSpy,
            applyMachines,
            getExistingMachine: (machineId: string) => machineId === 'm_cached'
                ? existing
                : null,
            ...( {
                cachedMachineDisplayEntries: {
                    m_cached: {
                        machineId: 'm_cached',
                        metadataVersion: 5,
                        updatedAt: 10,
                        active: true,
                        activeAt: 10,
                        revokedAt: null,
                        displayName: 'Cached machine',
                        host: 'mbp',
                        homeDir: '/home/u',
                    },
                },
                applyMachineDisplayEntries,
            } as any),
        } as any);

        expect(applyMachines).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'm_cached',
                daemonState: null,
                daemonStateVersion: 8,
            }),
        ], false);
    });

    it('renders placeholder machine displays immediately on empty cache and hydrates in the background', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const requestSpy = vi.fn(async (_path: string, _init?: RequestInit) =>
            jsonResponse([
                {
                    id: 'm_cold',
                    metadata: 'encrypted-meta',
                    metadataVersion: 5,
                    daemonState: null,
                    daemonStateVersion: 0,
                    dataEncryptionKey: 'key-1',
                    seq: 1,
                    active: true,
                    activeAt: 10,
                    revokedAt: null,
                    createdAt: 1,
                    updatedAt: 10,
                } satisfies RawMachine,
            ]),
        );

        const encryption = await createEncryptionHarness();
        encryption.decryptMetadata.mockImplementation(async () => new Promise<never>(() => {}));
        encryption.decryptDaemonState.mockImplementation(async () => new Promise<never>(() => {}));
        const applyMachines = vi.fn();
        const applyMachineDisplayEntries = vi.fn();

        const fetchPromise = fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: requestSpy,
            applyMachines,
            applyMachineDisplayEntries,
            cachedMachineDisplayEntries: {},
        });

        const raceResult = await Promise.race([
            fetchPromise.then(() => 'resolved'),
            new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 25)),
        ]);

        expect(raceResult).toBe('resolved');
        expect(applyMachineDisplayEntries).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'm_cold',
                metadataVersion: 5,
                metadata: null,
            }),
        ], { replace: false });
        expect(applyMachines).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'm_cold',
                metadataVersion: 5,
                metadata: null,
            }),
        ], false);
    });

    it('does not throw when the request transport fails (e.g. network error)', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const requestSpy = vi.fn(async () => {
                throw new TypeError('Failed to fetch');
            });

            const encryption = await createEncryptionHarness();
            const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();
            const applyMachines = vi.fn();

            await expect(
                fetchAndApplyMachines({
                    credentials: legacyCredentials,
            sourceServerId: 'home-1',
                    encryption,
                    machineDataKeys,
                    request: requestSpy,
                    applyMachines,
                }),
            ).resolves.toBeUndefined();

            expect(requestSpy).toHaveBeenCalledTimes(1);
            expect(applyMachines).not.toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
        }
    });

    it.each([
        ['a network error', async () => { throw new TypeError('Failed to fetch'); }],
        ['a 502 from the Home', async () => new Response('bad gateway', { status: 502 })],
    ] as const)('reports an unreadable machine list after %s so the list can end in a terminal state', async (_label, request) => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const applyMachines = vi.fn();
            const onListUnavailable = vi.fn();
            await fetchAndApplyMachines({
                credentials: legacyCredentials,
                sourceServerId: 'home-1',
                encryption: await createEncryptionHarness(),
                machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
                request: vi.fn(request),
                applyMachines,
                onListUnavailable,
            });
            expect(onListUnavailable).toHaveBeenCalledTimes(1);
            expect(applyMachines).not.toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
        }
    });

    it('keeps a locked machine row when dataEncryptionKey cannot be decrypted', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const requestSpy = vi.fn(async (_path: string, _init?: RequestInit) =>
            jsonResponse([
                {
                    id: 'm1',
                    metadata: 'meta-1',
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                    dataEncryptionKey: 'not-decryptable',
                    seq: 1,
                    active: true,
                    activeAt: 10,
                    revokedAt: null,
                    createdAt: 1,
                    updatedAt: 10,
                } satisfies RawMachine,
            ]),
        );

        const encryption = await createEncryptionHarness();
        encryption.decryptEncryptionKeys.mockResolvedValueOnce([null]);

        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();
        const applied: unknown[][] = [];

        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys,
            request: requestSpy,
            applyMachines: (machines) => {
                applied.push(machines);
            },
        });

        consoleError.mockRestore();
        consoleWarn.mockRestore();

        expect(applied).toHaveLength(1);
        expect((applied[0] as any[])).toHaveLength(1);
        expect((applied[0] as any[])[0]?.id).toBe('m1');
    });

    it('warns only once per machine when dataEncryptionKey decryption fails', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const requestSpy = vi.fn(async (_path: string, _init?: RequestInit) =>
            jsonResponse([
                {
                    id: 'm1',
                    metadata: 'meta-1',
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                    dataEncryptionKey: 'not-decryptable',
                    seq: 1,
                    active: true,
                    activeAt: 10,
                    revokedAt: null,
                    createdAt: 1,
                    updatedAt: 10,
                } satisfies RawMachine,
            ]),
        );

        const encryption = await createEncryptionHarness();
        encryption.decryptEncryptionKeys.mockResolvedValue([null]);

        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();

        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys,
            request: requestSpy,
            applyMachines: () => {},
        });
        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys,
            request: requestSpy,
            applyMachines: () => {},
        });

        expect(consoleWarn).toHaveBeenCalledTimes(1);

        consoleError.mockRestore();
        consoleWarn.mockRestore();
    });

    it('honors replace=false by not dropping machines missing from the fetch response', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const requestSpy = vi.fn(async (_path: string, _init?: RequestInit) =>
            jsonResponse([
                {
                    id: 'm1',
                    metadata: 'meta-1',
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                    dataEncryptionKey: null,
                    seq: 1,
                    active: true,
                    activeAt: 10,
                    revokedAt: null,
                    createdAt: 1,
                    updatedAt: 10,
                } satisfies RawMachine,
            ]),
        );

        const encryption = await createEncryptionHarness();
        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();

        const machineStateById: Record<string, any> = {
            m2: { id: 'm2' },
        };
        const applyMachines = (machines: any[], replace?: boolean) => {
            if (replace) {
                for (const key of Object.keys(machineStateById)) delete machineStateById[key];
            }
            for (const machine of machines) {
                machineStateById[String(machine.id)] = machine;
            }
        };

        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys,
            request: requestSpy,
            applyMachines,
            replace: false,
        });

        expect(Object.keys(machineStateById).sort()).toEqual(['m1', 'm2']);
    });

    it('skips applying machines when the caller scope is no longer active', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const requestSpy = vi.fn(async (_path: string, _init?: RequestInit) =>
            jsonResponse([
                {
                    id: 'm1',
                    metadata: 'encrypted-meta',
                    metadataVersion: 5,
                    daemonState: null,
                    daemonStateVersion: 0,
                    dataEncryptionKey: 'key-1',
                    seq: 1,
                    active: true,
                    activeAt: 10,
                    revokedAt: null,
                    createdAt: 1,
                    updatedAt: 10,
                } satisfies RawMachine,
            ]),
        );

        const encryption = await createEncryptionHarness();
        const applyMachines = vi.fn();
        const applyMachineDisplayEntries = vi.fn();

        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: requestSpy,
            applyMachines,
            applyMachineDisplayEntries,
            cachedMachineDisplayEntries: {},
            shouldContinue: () => false,
        } as any);

        expect(applyMachines).not.toHaveBeenCalled();
        expect(applyMachineDisplayEntries).not.toHaveBeenCalled();
    });
});
