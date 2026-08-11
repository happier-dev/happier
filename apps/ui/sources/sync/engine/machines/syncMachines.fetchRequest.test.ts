import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { MachineDataKeyCacheEntry } from './syncMachines';

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
    createdAt: number;
    updatedAt: number;
};

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function createEncryptionHarness() {
    const decryptEncryptionKeys = vi.fn(
        async (values: readonly string[]): Promise<Array<Uint8Array | null>> => values.map(() => new Uint8Array([1, 2, 3])),
    );
    const initialized = new Set<string>();
    const initializeMachines = vi.fn(async (machineKeys: Map<string, Uint8Array | null>) => {
        for (const machineId of machineKeys.keys()) {
            initialized.add(machineId);
        }
    });
    const decryptMetadata = vi.fn(async (_version: number, value: string) => ({ decrypted: value }));
    const decryptDaemonState = vi.fn(async (_version: number, value: string | null) => {
        if (!value) return null;
        return { decrypted: value };
    });
    return {
        decryptEncryptionKeys,
        initializeMachines,
        decryptMetadata,
        decryptDaemonState,
        getMachineEncryption: (machineId: string) => {
            if (!initialized.has(machineId)) return null;
            return { decryptMetadata, decryptDaemonState };
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

async function flushAsyncWork(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

describe('fetchAndApplyMachines request override', () => {
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

        const encryption = createEncryptionHarness();
        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();
        const applied: unknown[][] = [];

        await fetchAndApplyMachines({
            credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
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

    it('applies machine replacement fields from machine fetch responses', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const requestSpy = vi.fn(async (_path: string, _init?: RequestInit) =>
            jsonResponse([
                {
                    id: 'm_old',
                    metadata: 'meta-old',
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                    dataEncryptionKey: null,
                    seq: 1,
                    active: false,
                    activeAt: 10,
                    revokedAt: null,
                    replacedByMachineId: 'm_new',
                    replacedAt: 20,
                    replacementReason: 'reauth',
                    replacementSource: 'automatic',
                    replacementActorUserId: null,
                    createdAt: 1,
                    updatedAt: 20,
                } satisfies RawMachine,
            ]),
        );

        const encryption = createEncryptionHarness();
        const applied: unknown[][] = [];

        await fetchAndApplyMachines({
            credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
            encryption,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: requestSpy,
            applyMachines: (machines) => {
                applied.push(machines);
            },
        });

        expect(applied).toHaveLength(1);
        expect((applied[0] as any[])[0]).toMatchObject({
            id: 'm_old',
            replacedByMachineId: 'm_new',
            replacedAt: 20,
            replacementReason: 'reauth',
            replacementSource: 'automatic',
            replacementActorUserId: null,
        });
    });

    it('reuses warm cache machine display data when metadata version matches', async () => {
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

        const encryption = createEncryptionHarness();
        const applyMachines = vi.fn();
        const applyMachineDisplayEntries = vi.fn();

        await fetchAndApplyMachines({
            credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
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

        expect(encryption.decryptMetadata).not.toHaveBeenCalled();
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

        const encryption = createEncryptionHarness();
        const applyMachines = vi.fn();
        const applyMachineDisplayEntries = vi.fn();

        await fetchAndApplyMachines({
            credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
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

        const encryption = createEncryptionHarness();
        encryption.decryptMetadata.mockImplementation(async () => new Promise<never>(() => {}));
        encryption.decryptDaemonState.mockImplementation(async () => new Promise<never>(() => {}));
        const applyMachines = vi.fn();
        const applyMachineDisplayEntries = vi.fn();

        const fetchPromise = fetchAndApplyMachines({
            credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
            encryption,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: requestSpy,
            applyMachines,
            getExistingMachine: (machineId: string) => machineId === 'm_cached'
                ? ({
                    id: 'm_cached',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 9,
                    active: true,
                    activeAt: 9,
                    revokedAt: null,
                    metadata: { displayName: 'Existing machine', host: 'mbp', homeDir: '/home/u' },
                    metadataVersion: 5,
                    daemonState: { healthy: true },
                    daemonStateVersion: 7,
                } as any)
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
                daemonState: { healthy: true },
            }),
        ], false);
    });

    it('clears existing daemonState immediately when the fetched row no longer carries daemonState', async () => {
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

        const encryption = createEncryptionHarness();
        const applyMachines = vi.fn();
        const applyMachineDisplayEntries = vi.fn();

        await fetchAndApplyMachines({
            credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
            encryption,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: requestSpy,
            applyMachines,
            getExistingMachine: (machineId: string) => machineId === 'm_cached'
                ? ({
                    id: 'm_cached',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 9,
                    active: true,
                    activeAt: 9,
                    revokedAt: null,
                    metadata: { displayName: 'Existing machine', host: 'mbp', homeDir: '/home/u' },
                    metadataVersion: 5,
                    daemonState: { healthy: true },
                    daemonStateVersion: 7,
                } as any)
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
                daemonStateVersion: 0,
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

        const encryption = createEncryptionHarness();
        encryption.decryptMetadata.mockImplementation(async () => new Promise<never>(() => {}));
        encryption.decryptDaemonState.mockImplementation(async () => new Promise<never>(() => {}));
        const applyMachines = vi.fn();
        const applyMachineDisplayEntries = vi.fn();

        const fetchPromise = fetchAndApplyMachines({
            credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
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

    it('caps and batches cold machine display hydration work', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const rows = Array.from({ length: 6 }, (_, index) => ({
            id: `m_cold_${index}`,
            metadata: `encrypted-meta-${index}`,
            metadataVersion: 5,
            daemonState: `encrypted-daemon-${index}`,
            daemonStateVersion: 7,
            dataEncryptionKey: `key-${index}`,
            seq: index + 1,
            active: index % 2 === 0,
            activeAt: 10 + index,
            revokedAt: null,
            createdAt: 1,
            updatedAt: 10 + index,
        } satisfies RawMachine));
        const requestSpy = vi.fn(async (_path: string, _init?: RequestInit) => jsonResponse(rows));

        const encryption = createEncryptionHarness();
        const applyMachines = vi.fn();
        const applyMachineDisplayEntries = vi.fn();

        await fetchAndApplyMachines({
            credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
            encryption,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: requestSpy,
            applyMachines,
            applyMachineDisplayEntries,
            cachedMachineDisplayEntries: {},
            machineDisplayHydrationConcurrencyLimit: 2,
            machineDisplayEagerHydrationCount: 2,
            machineDisplayBackgroundHydrationMaxRows: 0,
            machineDisplayBackgroundHydrationApplyBatchSize: 2,
        } as any);
        await flushAsyncWork();

        expect(encryption.decryptMetadata).toHaveBeenCalledTimes(2);
        expect(encryption.decryptDaemonState).toHaveBeenCalledTimes(2);
        expect(applyMachines).toHaveBeenCalledTimes(2);
        expect(applyMachines.mock.calls[1]?.[0]).toHaveLength(2);
        expect(applyMachines.mock.calls[1]?.[1]).toBe(false);
    });

    it('does not throw when the request transport fails (e.g. network error)', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const requestSpy = vi.fn(async () => {
                throw new TypeError('Failed to fetch');
            });

            const encryption = createEncryptionHarness();
            const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();
            const applyMachines = vi.fn();

            await expect(
                fetchAndApplyMachines({
                    credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
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

    it('does not drop machines when dataEncryptionKey cannot be decrypted (fallback to legacy machine encryption)', async () => {
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

        const encryption = createEncryptionHarness();
        encryption.decryptEncryptionKeys.mockResolvedValueOnce([null]);

        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();
        const applied: unknown[][] = [];

        await fetchAndApplyMachines({
            credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
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

        const encryption = createEncryptionHarness();
        encryption.decryptEncryptionKeys.mockImplementation(async (values: readonly string[]) => values.map(() => null));

        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();

        await fetchAndApplyMachines({
            credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
            encryption,
            machineDataKeys,
            request: requestSpy,
            applyMachines: () => {},
        });
        await fetchAndApplyMachines({
            credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
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

        const encryption = createEncryptionHarness();
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
            credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
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

        const encryption = createEncryptionHarness();
        const applyMachines = vi.fn();
        const applyMachineDisplayEntries = vi.fn();

        await fetchAndApplyMachines({
            credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
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
