import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ServerFetchOptions } from '@/sync/http/client';
import type { FetchedMachineRow, MachineDataKeyCacheEntry } from './syncMachines';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { createMachineFixture, createPlainMachineRowFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { Encryption } from '@/sync/encryption/encryption';
import { buildMachineDisplayRenderableFromMachine, type MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { createStore } from 'zustand/vanilla';
import { createMachinesDomain, type MachinesDomain } from '@/sync/store/domains/machines';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { StorageState } from '@/sync/store/types';
import { createDeferred } from '@/dev/testkit';
import { encodeBase64 } from '@/encryption/base64';
import { createFakeCryptoWorker } from '@/sync/encryption/nativeCryptoWorker/fakeCryptoWorker';
import { resolveCanonicalMachineId } from '@happier-dev/protocol/machines/identity/canonicalMachineId';
import { hasCurrentMachineContent, readMachineInventoryRowReadiness, readObservedMachineDaemonStateVersion } from '@/sync/domains/machines/resolveServerScopedMachines';

function createMachineStore() {
    type State = MachinesDomain & Pick<StorageState, 'sessions' | 'sessionListRowsByServerId'
        | 'ordinarySessionListMembershipByServerId' | 'sessionListIndexByServerId' | 'settings'>
        & { profile: { id: string } };
    return createStore<State>()((set, get) => ({
        sessions: {}, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {},
        sessionListIndexByServerId: {}, settings: settingsDefaults, profile: { id: 'account-1' },
        ...createMachinesDomain<State>({ set, get }),
    }));
}

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
    const decryptDaemonState = vi.fn(async (_version: number, value: string | null): Promise<unknown> => {
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
    it('settles a validated census without replaying rows over live Machine activity', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const validator = 'W/"machine-census-v1-' + 'a'.repeat(64) + '"';
        const applyMachines = vi.fn();
        const onListComplete = vi.fn();
        const options = {
            credentials: legacyCredentials, encryption: null, machineDataKeys: new Map(),
            censusValidator: validator, applyMachines, onListComplete, throwOnError: true,
            request: async (_path: string, init: RequestInit) => {
                if (new Headers(init.headers).get('If-None-Match') === validator) return new Response(null, { status: 304 });
                return jsonResponse([]);
            },
        };
        await fetchAndApplyMachines(options);
        expect(applyMachines).not.toHaveBeenCalled();
        expect(onListComplete).toHaveBeenCalledOnce();
    });

    it('reads only changed Machines and preserves census recovery for withdrawn access', async () => {
        const { createCapturedServerReadTransport } = await import('@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport');
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const store = createMachineStore();
        const fleet = Array.from({ length: 137 }, (_, index) => createPlainMachineRowFixture({ id: `machine-${index}`, accountId: 'account-1' }));
        const requests: string[] = [];
        const selections: string[][] = [];
        let available = fleet;
        let sparse = false;
        const request = async (path: string, init?: RequestInit) => {
            requests.push(new URL(path, 'https://home.test').pathname);
            if (path === '/v1/machines/read-batch') {
                const { machineIds } = JSON.parse(String(init?.body)) as { machineIds: string[] };
                selections.push(machineIds);
                return createMachineReadBatchResponseFixture({ machineIds }, id => {
                    const row = available.find(row => row.id === id) ?? null;
                    return sparse && row ? { ...row, seq: undefined } : row;
                });
            }
            return jsonResponse(available);
        };
        function requestWithResponse(path: string, init?: RequestInit, options?: ServerFetchOptions): Promise<Response>;
        function requestWithResponse<T>(path: string, init: RequestInit | undefined, options: ServerFetchOptions | undefined,
            consume: (response: Response) => Promise<T>): Promise<T>;
        async function requestWithResponse<T>(path: string, init?: RequestInit, _options?: ServerFetchOptions,
            consume?: (response: Response) => Promise<T>): Promise<Response | T> {
            const response = await request(path, init);
            return consume ? await consume(response) : response;
        }
        const readTransport = createCapturedServerReadTransport({ serverId: 'machine-selection.test', credentials: legacyCredentials,
            prepared: { endpointUrl: 'https://home.test', generation: 1,
                request: requestWithResponse } });
        const refresh = (machineIds?: readonly string[]) => fetchAndApplyMachines({
            credentials: legacyCredentials, expectedAccountMode: 'plain',
            encryption: null, machineDataKeys: new Map(), request, readTransport, machineIds, replace: true, throwOnError: true,
            getMachineSnapshot: () => store.getState().machines,
            getExistingMachine: id => store.getState().machines[id],
            applyMachines: (rows, replace) => store.getState().applyMachines(rows, replace),
        });
        await refresh();
        const untouched = store.getState().machines['machine-136'];
        requests.length = 0;
        await refresh([]);
        expect(requests).toEqual([]);
        // The server always publishes its revision in `keyBasis`; a locked row opens nothing, so it is read there.
        available = fleet.map(row => row.id === 'machine-0' ? { ...row, daemonStateVersion: (row.daemonStateVersion ?? 0) + 1,
            keyBasis: { dataEncryptionKey: row.dataEncryptionKey ?? null, metadataVersion: row.metadataVersion,
                daemonStateVersion: (row.daemonStateVersion ?? 0) + 1 } } : row);
        const { applyPlannedChangeActions } = await import('@/sync/runtime/orchestration/changesApplier');
        const { planSyncActionsFromChanges } = await import('@/sync/runtime/orchestration/changesPlanner');
        const result = await applyPlannedChangeActions({
            credentials: legacyCredentials,
            planned: planSyncActionsFromChanges([
                { cursor: 1, kind: 'machine', entityId: 'machine-0', changedAt: 1, hint: null },
                { cursor: 2, kind: 'machineRecipientAccess', entityId: 'machine-0', changedAt: 2, hint: null },
            ]),
            isSessionMessagesLoaded: () => false,
            invalidate: { machines: async machineIds => { await refresh(machineIds); } },
            invalidateMessagesForSession: async () => {}, invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {}, kvBulkGet: async () => ({ values: [] }),
        });
        expect(result.status).toBe('complete');
        expect(requests).toEqual(['/v1/machines/read-batch']);
        expect(selections).toEqual([['machine-0']]);
        expect(readObservedMachineDaemonStateVersion(store.getState().machines['machine-0']!)).toBe(available[0]!.daemonStateVersion);
        expect(store.getState().machines['machine-136']).toBe(untouched);
        expect(Object.keys(store.getState().machines)).toHaveLength(137);
        requests.length = 0;
        sparse = true;
        await refresh(['machine-0']);
        expect(requests).toEqual(['/v1/machines/read-batch', '/v1/machines']);
        expect(store.getState().machines['machine-136']).toBe(untouched);
        sparse = false;
        requests.length = 0;
        await refresh(['not-in-discovery']);
        expect(requests).toEqual(['/v1/machines']);
        expect(Object.keys(store.getState().machines)).toHaveLength(137);
        requests.length = 0;
        available = available.filter(row => row.id !== 'machine-0');
        await refresh(['machine-0']);
        expect(requests).toEqual(['/v1/machines/read-batch', '/v1/machines']);
        expect(store.getState().machines['machine-0']).toBeUndefined();
        expect(store.getState().machines['machine-136']).toBe(untouched);
    });
    it('retains revoked predecessor identity for Session replacement resolution', async () => {
        const { fetchMachineRows } = await import('./syncMachines');
        const old = { ...createPlainMachineRowFixture({ id: 'old', accountId: 'account-1' }), active: false, revokedAt: 1, replacedByMachineId: 'current' };
        const current = createPlainMachineRowFixture({ id: 'current', accountId: 'account-1' });
        const rows = await fetchMachineRows({ credentials: legacyCredentials, request: async path =>
            jsonResponse(new URL(path, 'https://home.test').searchParams.get('includeRevoked') === 'true' ? [old, current] : [current]) });
        expect(resolveCanonicalMachineId('old', rows)?.machineId).toBe('current');
    });
    it('publishes Machine display shells before a background key open settles', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const encryption = await Encryption.create(new Uint8Array(32).fill(17));
        const dataKey = new Uint8Array(32).fill(23);
        const envelope = encodeBase64(await encryption.encryptEncryptionKey(dataKey));
        const secondEnvelope = encodeBase64(await encryption.encryptEncryptionKey(dataKey));
        const content = await encryption.openEncryption(dataKey);
        const metadata = encodeBase64((await content.encrypt([createMachineFixture().metadata!]))[0]!);
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const worker = createFakeCryptoWorker();
        const batchSizes: number[] = [];
        encryption.configureNativeCryptoWorker({ worker: { ...worker,
            decryptDataKeyEnvelopeV1: async request => {
                batchSizes.push(request.items.length);
                entered.resolve();
                await release.promise;
                return worker.decryptDataKeyEnvelopeV1(request);
            },
        }, routing: { mode: 'auto', minPayloadBytes: 0 } });
        const store = createMachineStore();
        let listSettled = false;
        const loading = fetchAndApplyMachines({
            credentials: legacyCredentials, sourceServerId: 'home-1', encryption,
            expectedAccountMode: 'e2ee', machineDataKeys: new Map(),
            request: async () => jsonResponse([{ ...createMachineFixture({ id: 'background' }),
                metadata, dataEncryptionKey: envelope, storageMode: 'e2ee' },
                { ...createMachineFixture({ id: 'peer' }), metadata, dataEncryptionKey: secondEnvelope, storageMode: 'e2ee' }]),
            getMachineSnapshot: () => store.getState().machines,
            getExistingMachine: id => store.getState().machines[id],
            displayFirst: true,
            applyMachines: (rows, replace, _publishedRows, warmDisplays) => store.getState().applyMachines(rows, replace, { warmDisplays }),
        }).then(() => { listSettled = true; });
        try {
            await entered.promise;
            await Promise.resolve();
            expect(store.getState().machineDisplayById.background).toBeDefined();
            expect(store.getState().machines.background?.availability?.kind).not.toBe('available');
            expect(listSettled).toBe(false);
        } finally {
            release.resolve();
            await loading;
        }
        await vi.waitFor(() => expect(store.getState().machines.background).toMatchObject({
            metadata: createMachineFixture().metadata, availability: { kind: 'available' },
        }));
        await vi.waitFor(() => expect(store.getState().machines.peer?.availability?.kind).toBe('available'));
        expect(listSettled).toBe(true);
        expect(batchSizes).toEqual([2]);
    });
    it('shows loading rather than a previous missing-key lock after current key material is ready', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const encryption = await Encryption.create(new Uint8Array(32).fill(17));
        await encryption.initializeMachines(new Map([['m_recovered', null]]));
        const cipher = encryption.getMachineEncryption('m_recovered')!;
        const metadata = await cipher.encryptRaw({ ...createMachineFixture().metadata!, host: 'Recovered devbox' });
        const existing = createMachineFixture({ id: 'm_recovered', metadata: null,
            storageMode: 'e2ee', availability: { kind: 'locked', reason: 'encryption_material_unavailable' },
        });
        const applied: Machine[][] = [];
        await fetchAndApplyMachines({
            credentials: legacyCredentials, sourceServerId: 'home-1', encryption,
            machineDataKeys: new Map(), getExistingMachine: () => existing,
            request: async () => jsonResponse([{ ...existing, metadata, dataEncryptionKey: null }]),
            displayFirst: true,
            applyMachines: machines => { applied.push(machines); },
        });
        expect(applied[0]?.[0]?.metadata).toBeNull();
        expect(applied[0]?.[0]?.availability).toBeUndefined();
        await vi.waitFor(() => expect(applied.at(-1)?.[0]).toMatchObject({
            metadata: { host: 'Recovered devbox' }, availability: { kind: 'available' },
        }));
    });
    it('retains the readable warm state and skips hydration for unchanged encrypted versions', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const existing = createMachineFixture({
            id: 'm_unchanged',
            kind: 'persistent',
            operationProtocolCapabilitiesRevision: null,
            daemonState: { status: 'running' },
            daemonStateVersion: 7,
            storageMode: 'e2ee',
            availability: { kind: 'available' },
        });
        // Crypto and HTTP are external boundaries; fetch/hydration logic remains real.
        const encryption = await createEncryptionHarness();
        const applied: Machine[][] = [];
        const published: (readonly FetchedMachineRow[])[] = [];
        const displayed: (readonly MachineDisplayRenderable[])[] = [];
        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys: new Map(),
            request: async () => jsonResponse([{
                ...existing, metadata: 'unchanged-metadata', daemonState: 'unchanged-daemon', dataEncryptionKey: null,
            }]),
            getExistingMachine: () => existing,
            displayFirst: true,
            applyMachines: (machines, _replace, rows, warmDisplays) => {
                if (warmDisplays) displayed.push(warmDisplays);
                applied.push(machines);
                published.push(rows);
            },
        });
        expect(applied[0]?.[0]).toMatchObject({
            storageMode: 'e2ee', availability: { kind: 'available' },
            metadata: existing.metadata, daemonState: existing.daemonState, daemonStateVersion: 7,
        });
        expect(published.flat()).toEqual([expect.objectContaining({
            id: existing.id, metadata: 'unchanged-metadata', daemonState: 'unchanged-daemon',
        })]);
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
            displayFirst: true,
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
        const entered = createDeferred<void>();
        const pendingMetadata = createDeferred<typeof nextMetadata>();
        const encryption = await createEncryptionHarness();
        encryption.decryptMetadata.mockImplementation(async () => { entered.resolve(); return pendingMetadata.promise; });
        let current: Machine = existing;

        const loading = fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys: new Map(),
            request: async () => jsonResponse([{ ...existing, metadata: 'next-ciphertext', metadataVersion: 2, dataEncryptionKey: null }]),
            getExistingMachine: () => current,
            displayFirst: true,
            applyMachines: (machines) => { current = machines[0]!; },
        });

        try {
            await entered.promise;
            expect(current.metadata?.daemonTerminalSessionAttachSupported).toBe(true);
            expect(current.metadataVersion).toBe(1);
        } finally {
            pendingMetadata.resolve(nextMetadata);
            await loading;
        }
        expect(current.metadataVersion).toBe(2);
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

        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: requestSpy,
            applyMachines,
            ...( {
                getCachedMachineDisplayEntry: (machineId: string) => machineId === 'm_cached' ? {
                    machineId: 'm_cached',
                    metadataVersion: 5,
                    updatedAt: 10,
                    active: true,
                    activeAt: 10,
                    revokedAt: null,
                    displayName: 'Cached machine',
                    host: 'mbp',
                    homeDir: '/home/u',
                } : undefined,
                displayFirst: true,
            } as any),
        } as any);

        await vi.waitFor(() => expect(applyMachines).toHaveBeenLastCalledWith([
            expect.objectContaining({ id: 'm_cached', metadata: { decrypted: 'encrypted-meta' } }),
        ], false, expect.any(Array)));
        expect(applyMachines).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'm_cached',
                metadataVersion: 5,
                metadata: null,
            }),
        ], false, expect.any(Array), expect.any(Array));
        expect(applyMachines).toHaveBeenCalledWith(expect.any(Array), false, expect.any(Array), [
            expect.objectContaining({
                id: 'm_cached',
                metadataVersion: 5,
                metadata: expect.objectContaining({
                    displayName: 'Cached machine',
                    host: 'mbp',
                    homeDir: '/home/u',
                }),
            }),
        ]);
    });

    it('hydrates every machine beyond the previous background row cutoff without publishing each row separately', async () => {
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
        const store = createMachineStore();
        let notifications = 0;
        const unsubscribe = store.subscribe(() => { notifications++; });
        const applyMachines = vi.fn((machines: Machine[], replace: boolean) => {
            store.getState().applyMachines(machines, replace);
        });
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
            getCachedMachineDisplayEntry: (machineId: string) => cachedMachineDisplayEntries[machineId],
            displayFirst: true,
        } as any);
        await Promise.resolve();
        await Promise.resolve();

        await vi.waitFor(() => {
            const hydrated = applyMachines.mock.calls.slice(1).flatMap(([machines]) => machines as Machine[]);
            expect(hydrated.map((machine) => machine.id).sort()).toEqual(rows.map((row) => row.id).sort());
            expect(hydrated.every((machine) => machine.metadata !== null)).toBe(true);
        });
        unsubscribe();
        expect(Object.values(store.getState().machines).every(machine => machine.metadata !== null)).toBe(true);
        // Four concurrent crypto operations finish together. Their canonical
        // store publication must fan out once per cohort, not once per row.
        expect(notifications).toBeLessThanOrEqual(1 + Math.ceil(rows.length / 4));
    });

    it.each([true, false])('publishes all cold names, including offline Machines, before held daemon state (display-first=%s)', async displayFirst => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const encryption = await createEncryptionHarness();
        const store = createMachineStore();
        const daemonRelease = createDeferred<void>();
        const rows = Array.from({ length: 137 }, (_, index) => ({
            ...createMachineFixture({ id: 'cold-' + index, metadataVersion: 2, active: index < 68, activeAt: Date.now() }),
            metadata: 'cold-' + index, daemonState: 'cold-' + index, daemonStateVersion: 2, dataEncryptionKey: 'cold-envelope',
            keyBasis: { dataEncryptionKey: 'cold-envelope', metadataVersion: 2, daemonStateVersion: 2 },
        }));
        const names: string[] = [];
        let notifications = 0;
        const unsubscribe = store.subscribe(state => {
            notifications++;
            for (const row of rows) {
                if (state.machineDisplayById[row.id]?.metadata?.displayName === row.id && !names.includes(row.id)) names.push(row.id);
            }
        });
        encryption.decryptMetadata.mockImplementation(async (_version, id) => ({ ...createMachineFixture().metadata!, displayName: id }));
        encryption.decryptDaemonState.mockImplementation(async (_version, id) => {
            await daemonRelease.promise;
            return { status: 'running', pid: Number(id?.split('-')[1]) + 1 };
        });
        const request = vi.fn(async () => jsonResponse(rows));
        const started = performance.now();
        const loading = fetchAndApplyMachines({
            credentials: legacyCredentials, sourceServerId: 'home-1', encryption, machineDataKeys: new Map(), request,
            getExistingMachine: id => store.getState().machines[id], getMachineSnapshot: () => store.getState().machines,
            displayFirst,
            applyMachines: (machines, replace, _publishedRows, warmDisplays) => store.getState().applyMachines(machines, replace, { warmDisplays }),
        });
        try {
            await vi.waitFor(() => expect(names).toHaveLength(rows.length));
            console.info('[MACHNAME] metadata ready', { displayFirst, names: names.length, elapsedMs: performance.now() - started, daemonResolved: 0 });
            expect(request).toHaveBeenCalledTimes(1);
            expect(encryption.decryptMetadata).toHaveBeenCalledTimes(rows.length);
            for (const row of rows) {
                expect(store.getState().machineDisplayById[row.id]?.metadata?.displayName).toBe(row.id);
                // Machines reads inventory facts; Projects can use the display projection.
                expect(store.getState().machines[row.id]?.metadata?.displayName).toBe(row.id);
                expect(store.getState().machines[row.id]?.daemonState).toBeNull();
                expect(store.getState().machines[row.id]?.daemonStateVersion).toBe(0);
                expect(readMachineInventoryRowReadiness(store.getState().machines[row.id]!)).toBe('pending');
                expect(hasCurrentMachineContent(store.getState().machines[row.id]!)).toBe(false);
            }
        } finally {
            console.info('[MACHNAME] before daemon release', { displayFirst, names: names.length,
                offlineMetadataOpens: encryption.decryptMetadata.mock.calls.filter(([, id]) => rows.some(row => row.id === id && !row.active)).length });
            daemonRelease.resolve();
            await loading;
            unsubscribe();
        }
        expect(encryption.decryptDaemonState).toHaveBeenCalledTimes(rows.length);
        expect(Object.values(store.getState().machines).every(machine => machine.daemonStateVersion === 2 && machine.availability?.kind === 'available')).toBe(true);
        expect(store.getState().machines['cold-136']?.daemonState).toMatchObject({ pid: 137 });
        // Warm shells, then metadata and daemon completions share cohort publications.
        expect(notifications).toBeLessThanOrEqual(2 + 2 * Math.ceil(rows.length / 4));
    });

    it.each((['metadata', 'daemon'] as const).flatMap(phase => (['withdraw', 'supersede', 'retire'] as const).map(action => ({ phase, action }))))(
        'does not republish a $action Machine after held $phase decryption', async ({ phase, action }) => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const encryption = await createEncryptionHarness();
        const store = createMachineStore();
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const fixture = createMachineFixture({ id: 'guarded', metadataVersion: 2, daemonStateVersion: 2 });
        const row = { ...fixture, metadata: 'guarded', daemonState: 'guarded', dataEncryptionKey: null,
            keyBasis: { dataEncryptionKey: null, metadataVersion: 2, daemonStateVersion: 2 } };
        let current = true;
        encryption.decryptMetadata.mockImplementation(async () => {
            if (phase === 'metadata') { entered.resolve(); await release.promise; }
            return { ...fixture.metadata!, displayName: 'guarded' };
        });
        encryption.decryptDaemonState.mockImplementation(async () => {
            if (phase === 'daemon') { entered.resolve(); await release.promise; }
            return { status: 'running', pid: 1 };
        });
        const loading = fetchAndApplyMachines({
            credentials: legacyCredentials, sourceServerId: 'home-1', encryption, machineDataKeys: new Map(),
            request: async () => jsonResponse([row]), shouldContinue: () => current,
            getExistingMachine: id => store.getState().machines[id], getMachineSnapshot: () => store.getState().machines,
            displayFirst: true,
            applyMachines: (machines, replace, _publishedRows, warmDisplays) => store.getState().applyMachines(machines, replace, { warmDisplays }),
        });
        try {
            await entered.promise;
            if (phase === 'daemon') expect(store.getState().machineDisplayById.guarded?.metadata?.displayName).toBe('guarded');
            if (action === 'withdraw') store.getState().applyMachines([], true);
            if (action === 'supersede') store.getState().applyMachines([createMachineFixture({ id: row.id,
                metadataVersion: 3, daemonStateVersion: 3, metadata: { ...fixture.metadata!, displayName: 'Current' } })]);
            if (action === 'retire') current = false;
            const expected = store.getState().machines[row.id];
            const expectedDisplay = store.getState().machineDisplayById[row.id];
            release.resolve();
            await loading;
            expect(store.getState().machines[row.id]).toBe(expected);
            expect(store.getState().machineDisplayById[row.id]).toBe(expectedDisplay);
        } finally { release.resolve(); await loading; }
    });

    it('publishes completed peers before a slow decrypt and preserves a newer row when that decrypt finishes', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const encryption = await createEncryptionHarness();
        const slow = createDeferred<void>();
        const store = createMachineStore();
        encryption.decryptMetadata.mockImplementation(async (_version, value) => {
            if (value === 'slow') await slow.promise;
            return createMachineFixture({ id: value }).metadata;
        });
        const rows = ['fast-a', 'fast-b', 'fast-c', 'slow'].map((id, index) => ({
            ...createMachineFixture({ id, metadataVersion: 2, activeAt: index + 1 }),
            metadata: id, daemonState: 'daemon', daemonStateVersion: 1, dataEncryptionKey: null,
        }));
        const loading = fetchAndApplyMachines({
            credentials: legacyCredentials, sourceServerId: 'home-1', encryption, machineDataKeys: new Map(),
            request: async () => jsonResponse(rows),
            getExistingMachine: id => store.getState().machines[id],
            getMachineSnapshot: () => store.getState().machines,
            displayFirst: true,
            applyMachines: (machines, replace, _publishedRows, warmDisplays) => store.getState().applyMachines(machines, replace, { warmDisplays }),
        });
        try {
            await vi.waitFor(() => expect(['fast-a', 'fast-b', 'fast-c'].every(id => Boolean(store.getState().machines[id]?.metadata))).toBe(true));
            expect(store.getState().machines.slow?.metadata).toBeNull();
            const replacement = createMachineFixture({ id: 'slow', metadataVersion: 3, daemonStateVersion: 2 });
            store.getState().applyMachines([replacement]);
            slow.resolve();
            await loading;
            expect(store.getState().machines.slow?.metadataVersion).toBe(3);
            expect(store.getState().machines.slow?.metadata).toEqual(replacement.metadata);
        } finally {
            slow.resolve();
            await loading;
        }
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

        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: requestSpy,
            applyMachines,
            ...( {
                displayFirst: true,
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
        ], false, expect.any(Array), expect.any(Array));
        expect(applyMachines).toHaveBeenCalledWith(expect.any(Array), false, expect.any(Array), [
            expect.objectContaining({
                id: 'm_replaced',
                replacedByMachineId: 'm_current',
                replacedAt: 11,
                replacementReason: 'reauth',
                replacementSource: 'automatic',
                replacementActorUserId: 'user-1',
            }),
        ]);
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

        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: requestSpy,
            applyMachines,
            ...( {
                getCachedMachineDisplayEntry: (machineId: string) => machineId === 'm_cached' ? {
                    machineId: 'm_cached',
                    metadataVersion: 5,
                    updatedAt: 10,
                    active: true,
                    activeAt: 10,
                    revokedAt: null,
                    displayName: 'Cached machine',
                    host: 'mbp',
                    homeDir: '/home/u',
                } : undefined,
                displayFirst: true,
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
        ], false, expect.any(Array));
    });

    it('preserves existing daemonState while cache-hit machine hydration is still pending', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        // Match the store's stable row identity so the real read-currentness guard stays active.
        const existing = createMachineFixture({ id: 'm_cached', metadataVersion: 5,
            daemonState: { status: 'running' }, daemonStateVersion: 7,
            dataEncryptionKey: 'key-1', storageMode: 'e2ee', availability: { kind: 'available' } });
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
        const release = createDeferred<void>();
        encryption.decryptMetadata.mockImplementation(async () => { await release.promise; return existing.metadata; });
        encryption.decryptDaemonState.mockImplementation(async () => { await release.promise; return existing.daemonState; });
        const applyMachines = vi.fn();

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
                getCachedMachineDisplayEntry: (machineId: string) => machineId === 'm_cached' ? {
                    machineId: 'm_cached',
                    metadataVersion: 5,
                    updatedAt: 10,
                    active: true,
                    activeAt: 10,
                    revokedAt: null,
                    displayName: 'Cached machine',
                    host: 'mbp',
                    homeDir: '/home/u',
                } : undefined,
                displayFirst: true,
            } as any),
        } as any);

        try {
            await vi.waitFor(() => expect(applyMachines).toHaveBeenCalledWith([
                expect.objectContaining({
                    id: 'm_cached',
                    metadataVersion: 5,
                    daemonStateVersion: 7,
                    daemonState: { status: 'running' },
                }),
            ], false, expect.any(Array), expect.any(Array)));
        } finally {
            release.resolve();
            await fetchPromise;
        }
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
                getCachedMachineDisplayEntry: (machineId: string) => machineId === 'm_cached' ? {
                    machineId: 'm_cached',
                    metadataVersion: 5,
                    updatedAt: 10,
                    active: true,
                    activeAt: 10,
                    revokedAt: null,
                    displayName: 'Cached machine',
                    host: 'mbp',
                    homeDir: '/home/u',
                } : undefined,
                displayFirst: true,
            } as any),
        } as any);

        expect(applyMachines).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'm_cached',
                daemonState: null,
                daemonStateVersion: 8,
            }),
        ], false, expect.any(Array), expect.any(Array));
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
        const release = createDeferred<void>();
        encryption.decryptMetadata.mockImplementation(async () => { await release.promise; return createMachineFixture().metadata; });
        const applyMachines = vi.fn();

        const fetchPromise = fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: requestSpy,
            applyMachines,
            displayFirst: true,
        });

        try {
            await vi.waitFor(() => expect(applyMachines).toHaveBeenCalledWith(expect.any(Array), false, expect.any(Array), [
                expect.objectContaining({
                    id: 'm_cold',
                    metadataVersion: 5,
                    metadata: null,
                }),
            ]));
            expect(applyMachines).toHaveBeenCalledWith([
                expect.objectContaining({
                    id: 'm_cold',
                    metadataVersion: 5,
                    metadata: null,
                }),
            ], false, expect.any(Array), expect.any(Array));
        } finally {
            release.resolve();
            await fetchPromise;
        }
    });

    it('never publishes a lower daemon-state version while a cold row opens its metadata before its daemon state', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const encryption = await createEncryptionHarness();
        const daemonOpen = createDeferred<void>();
        encryption.decryptDaemonState.mockImplementation(async (_version: number, value: string | null) => {
            await daemonOpen.promise;
            return value ? { decrypted: value } : null;
        });
        const published: Array<Readonly<{ daemonStateVersion: number; metadata: boolean; daemonState: boolean }>> = [];
        const store = createMachineStore();
        const loading = fetchAndApplyMachines({
            credentials: legacyCredentials, sourceServerId: 'home-1', encryption,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: async () => jsonResponse([{ id: 'm_cold', metadata: 'encrypted-meta', metadataVersion: 5,
                daemonState: 'encrypted-daemon', daemonStateVersion: 84, dataEncryptionKey: 'key-1', seq: 1, active: true,
                activeAt: 10, revokedAt: null, createdAt: 1, updatedAt: 10 } satisfies RawMachine]),
            getMachineSnapshot: () => store.getState().machines,
            getExistingMachine: id => store.getState().machines[id],
            displayFirst: true,
            applyMachines: (rows, replace, _publishedRows, warmDisplays) => {
                for (const row of rows) published.push({ daemonStateVersion: row.daemonStateVersion,
                    metadata: row.metadata !== null, daemonState: row.daemonState != null });
                store.getState().applyMachines(rows, replace, { warmDisplays });
            },
        });
        try {
            // The metadata-opened row is published while its daemon state is still opening.
            await vi.waitFor(() => expect(published.some(row => row.metadata && !row.daemonState)).toBe(true));
        } finally {
            daemonOpen.resolve();
            await loading;
        }
        await vi.waitFor(() => expect(published.at(-1)).toEqual({ daemonStateVersion: 84, metadata: true, daemonState: true }));
        const versions = published.map(row => row.daemonStateVersion);
        expect(versions).toEqual([...versions].sort((left, right) => left - right));
    });

    it('never publishes a lower daemon-state version while a locked row opens', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const encryption = await createEncryptionHarness();
        const row = { id: 'm_locked', metadata: 'encrypted-meta', metadataVersion: 5,
            daemonState: 'encrypted-daemon', daemonStateVersion: 84, dataEncryptionKey: 'key-1', seq: 1, active: true,
            activeAt: 10, revokedAt: null, createdAt: 1, updatedAt: 10 } satisfies RawMachine;
        const store = createMachineStore();
        const versions: number[] = [];
        const read = (withEncryption: boolean) => fetchAndApplyMachines({
            credentials: legacyCredentials, sourceServerId: 'home-1', encryption: withEncryption ? encryption : null,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: async () => jsonResponse([row]),
            getMachineSnapshot: () => store.getState().machines,
            getExistingMachine: id => store.getState().machines[id],
            displayFirst: true,
            applyMachines: (rows, replace, _publishedRows, warmDisplays) => {
                for (const machine of rows) versions.push(machine.daemonStateVersion);
                store.getState().applyMachines(rows, replace, { warmDisplays });
            },
        });
        await read(false);
        expect(store.getState().machines.m_locked?.availability?.kind).toBe('locked');
        await read(true);
        expect(store.getState().machines.m_locked).toMatchObject({ daemonStateVersion: 84, availability: { kind: 'available' } });
        expect(versions).toEqual([...versions].sort((left, right) => left - right));
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

        await fetchAndApplyMachines({
            credentials: legacyCredentials,
            sourceServerId: 'home-1',
            encryption,
            machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
            request: requestSpy,
            applyMachines,
            displayFirst: true,
            shouldContinue: () => false,
        } as any);

        expect(applyMachines).not.toHaveBeenCalled();
    });
});
