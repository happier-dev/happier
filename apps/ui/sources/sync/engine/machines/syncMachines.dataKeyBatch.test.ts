import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAndApplyMachines, type MachineDataKeyCacheEntry } from './syncMachines';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { createMachineFixture } from '@/dev/testkit';

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
    createdAt: number;
    updatedAt: number;
};

function machineRow(id: string, dataEncryptionKey: string | null): RawMachine {
    return {
        id,
        metadata: `meta-${id}`,
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        dataEncryptionKey,
        seq: 1,
        active: true,
        activeAt: 10,
        revokedAt: null,
        createdAt: 1,
        updatedAt: 10,
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function createEncryptionHarness(
    decrypt: (envelopes: readonly string[]) => Array<Uint8Array | null>,
) {
    const decryptEncryptionKeys = vi.fn(async (values: readonly string[]) => decrypt(values));
    const initialized = new Set<string>();
    const initializeMachines = vi.fn(async (machineKeys: Map<string, Uint8Array | null>) => {
        for (const machineId of machineKeys.keys()) initialized.add(machineId);
    });
    return {
        decryptEncryptionKeys,
        initializeMachines,
        getMachineEncryption: (machineId: string) => {
            if (!initialized.has(machineId)) return null;
            return {
                decryptMetadata: async (_version: number, value: string) => ({ decrypted: value }),
                decryptDaemonState: async (_version: number, value: string | null) =>
                    value ? { decrypted: value } : null,
            };
        },
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

async function loadFetchAndApplyMachines() {
    return fetchAndApplyMachines;
}

describe('fetchAndApplyMachines machine data-key unwrapping', () => {
    it('hydrates explicitly plain rows and evicts their prior encrypted key without opening the marker', async () => {
        const encryption = Encryption.createWithoutKeyMaterial();
        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>([
            ['plain', { envelope: 'old-envelope', dataKey: new Uint8Array(32).fill(2) }],
        ]);
        const plainMetadata = { ...createMachineFixture().metadata, host: 'plain-host', displayName: 'Développement 🦋' };
        const plainState = { status: 'running' };
        const typedContent = (value: unknown) => encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: value })), 'base64');
        const machines: Machine[] = [];
        await fetchAndApplyMachines({ credentials: { token: 't', secret: 's' }, encryption, machineDataKeys,
            request: async (path) => path === '/v1/account/encryption' ? jsonResponse({ mode: 'plain', updatedAt: 1 }) : jsonResponse([machineRow('legacy', null), machineRow('unreadable', 'invalid-envelope'), {
                ...machineRow('plain', typedContent(null)), metadata: typedContent(plainMetadata),
                daemonState: typedContent(plainState), daemonStateVersion: 1,
            }]), applyMachines: (rows) => machines.push(...rows),
        });
        expect(machines.find((machine) => machine.id === 'plain')).toMatchObject({ metadata: plainMetadata, daemonState: plainState });
        expect(machineDataKeys.has('plain')).toBe(false);
    });

    it('rejects a plain marker when the account mode is E2EE', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(1));
        const typedContent = (value: unknown) => encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: value })), 'base64');
        const machines: Machine[] = [];
        await fetchAndApplyMachines({ credentials: { token: 't', secret: 's' }, encryption, machineDataKeys: new Map(),
            request: async (path) => path === '/v1/account/encryption' ? jsonResponse({ mode: 'e2ee', updatedAt: 1 }) : jsonResponse([{
                ...machineRow('plain', typedContent(null)), metadata: typedContent({ ...createMachineFixture().metadata, host: 'unexpected-plain' }),
            }]), applyMachines: (rows) => machines.push(...rows),
        });
        expect(machines.find((machine) => machine.id === 'plain')?.metadata).toBeNull();
        expect(encryption.getMachineEncryption('plain')).toBeNull();
    });

    it('rejects a present empty machine key rather than retaining a legacy cipher', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const encryption = await Encryption.create(new Uint8Array(32).fill(1));
        await encryption.initializeMachines(new Map([['m1', null]]));
        await fetchAndApplyMachines({ credentials: { token: 't', secret: 's' }, encryption,
            machineDataKeys: new Map(), request: async () => jsonResponse([machineRow('m1', '')]), applyMachines: () => {},
        });
        expect(encryption.getMachineEncryption('m1')).toBeNull();
    });

    it('opens every machine envelope in one batch instead of one call per machine', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const request = vi.fn(async () => jsonResponse([
            machineRow('m1', 'env-1'),
            machineRow('m2', 'env-2'),
            machineRow('m3', null),
            machineRow('m4', 'env-4'),
        ]));
        const encryption = createEncryptionHarness((values) => values.map((_, index) => new Uint8Array([index + 1])));
        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();

        await fetchAndApplyMachines({
            credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
            encryption,
            machineDataKeys,
            request,
            applyMachines: () => {},
        });

        // One batched open for all envelope-bearing machines. Per-machine calls put a
        // single 505-byte payload under the worker routing threshold on every machine,
        // forcing curve25519 onto the JS thread N times.
        expect(encryption.decryptEncryptionKeys).toHaveBeenCalledTimes(1);
        expect(encryption.decryptEncryptionKeys.mock.calls[0]![0]).toEqual(['env-1', 'env-2', 'env-4']);
        expect([...machineDataKeys.keys()].sort()).toEqual(['m1', 'm2', 'm4']);
        expect(machineDataKeys.get('m2')).toEqual({ envelope: 'env-2', dataKey: new Uint8Array([2]) });
    });

    it('maps a per-item decrypt failure to the machine that owns that envelope', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const request = vi.fn(async () => jsonResponse([
            machineRow('m1', 'env-1'),
            machineRow('m2', 'env-2'),
        ]));
        const encryption = createEncryptionHarness((values) =>
            values.map((value) => (value === 'env-1' ? null : new Uint8Array([9]))));
        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();
        const initializedKeys: Array<Map<string, Uint8Array | null>> = [];
        encryption.initializeMachines.mockImplementation(async (machineKeys) => {
            initializedKeys.push(new Map(machineKeys));
        });

        await fetchAndApplyMachines({
            credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
            encryption,
            machineDataKeys,
            request,
            applyMachines: () => {},
        });

        expect(machineDataKeys.has('m1')).toBe(false);
        expect(machineDataKeys.get('m2')?.dataKey).toEqual(new Uint8Array([9]));
        expect(initializedKeys[0]?.has('m1')).toBe(false);
        expect(initializedKeys[0]?.get('m2')).toEqual(new Uint8Array([9]));
    });

    it('does not re-open an envelope whose unwrapped key is already cached', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const request = vi.fn(async () => jsonResponse([
            machineRow('m1', 'env-1'),
            machineRow('m2', 'env-2'),
        ]));
        const encryption = createEncryptionHarness((values) =>
            values.map((value) => new Uint8Array([value === 'env-1' ? 1 : 2])));
        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();
        const initializedKeys: Array<Map<string, Uint8Array | null>> = [];
        encryption.initializeMachines.mockImplementation(async (machineKeys) => {
            initializedKeys.push(new Map(machineKeys));
        });

        const call = async () => fetchAndApplyMachines({
            credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
            encryption,
            machineDataKeys,
            request,
            applyMachines: () => {},
        });

        await call();
        await call();

        // The second refresh sees the same wrapped envelopes it already unwrapped, so it
        // must not run a single asymmetric open — machine refreshes fire on every screen
        // focus and every foreground.
        expect(encryption.decryptEncryptionKeys).toHaveBeenCalledTimes(1);
        // Machine encryption is still initialized with the same plaintext keys.
        expect(initializedKeys[1]?.get('m1')).toEqual(new Uint8Array([1]));
        expect(initializedKeys[1]?.get('m2')).toEqual(new Uint8Array([2]));
    });

    it('re-opens only the machine whose envelope rotated', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        let rotated = false;
        const request = vi.fn(async () => jsonResponse([
            machineRow('m1', 'env-1'),
            machineRow('m2', rotated ? 'env-2-rotated' : 'env-2'),
        ]));
        const keyByEnvelope: Record<string, Uint8Array> = {
            'env-1': new Uint8Array([1]),
            'env-2': new Uint8Array([2]),
            'env-2-rotated': new Uint8Array([22]),
        };
        const encryption = createEncryptionHarness((values) => values.map((value) => keyByEnvelope[value] ?? null));
        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();
        const initializedKeys: Array<Map<string, Uint8Array | null>> = [];
        encryption.initializeMachines.mockImplementation(async (machineKeys) => {
            initializedKeys.push(new Map(machineKeys));
        });

        const call = async () => fetchAndApplyMachines({
            credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
            encryption,
            machineDataKeys,
            request,
            applyMachines: () => {},
        });

        await call();
        rotated = true;
        await call();

        expect(encryption.decryptEncryptionKeys).toHaveBeenCalledTimes(2);
        expect(encryption.decryptEncryptionKeys.mock.calls[1]![0]).toEqual(['env-2-rotated']);
        expect(initializedKeys[1]?.get('m1')).toEqual(new Uint8Array([1]));
        expect(initializedKeys[1]?.get('m2')).toEqual(new Uint8Array([22]));
        expect(machineDataKeys.get('m2')).toEqual({ envelope: 'env-2-rotated', dataKey: new Uint8Array([22]) });
    });

    it('drops the cached key when a rotated envelope fails to open', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        let rotated = false;
        const request = vi.fn(async () => jsonResponse([
            machineRow('m1', rotated ? 'env-1-rotated' : 'env-1'),
        ]));
        const encryption = createEncryptionHarness((values) =>
            values.map((value) => (value === 'env-1' ? new Uint8Array([1]) : null)));
        const machineDataKeys = new Map<string, MachineDataKeyCacheEntry>();
        const initializedKeys: Array<Map<string, Uint8Array | null>> = [];
        encryption.initializeMachines.mockImplementation(async (machineKeys) => {
            initializedKeys.push(new Map(machineKeys));
        });

        const call = async () => fetchAndApplyMachines({
            credentials: { token: 't', secret: 's' } satisfies AuthCredentials,
            encryption,
            machineDataKeys,
            request,
            applyMachines: () => {},
        });

        await call();
        rotated = true;
        await call();

        // Failed encrypted key opens never authorize the historical no-envelope legacy path.
        expect(machineDataKeys.has('m1')).toBe(false);
        expect(initializedKeys[1]?.has('m1')).toBe(false);
    });
});
