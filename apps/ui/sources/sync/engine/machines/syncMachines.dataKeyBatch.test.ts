import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

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

beforeEach(() => {
    vi.resetModules();
});

async function loadFetchAndApplyMachines() {
    const mod = await import('./syncMachines');
    return mod.fetchAndApplyMachines;
}

describe('fetchAndApplyMachines machine data-key unwrapping', () => {
    it('opens every machine envelope in one batch instead of one call per machine', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const request = vi.fn(async () => jsonResponse([
            machineRow('m1', 'env-1'),
            machineRow('m2', 'env-2'),
            machineRow('m3', null),
            machineRow('m4', 'env-4'),
        ]));
        const encryption = createEncryptionHarness((values) => values.map((_, index) => new Uint8Array([index + 1])));
        const machineDataKeys = new Map<string, Uint8Array>();

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
        expect(machineDataKeys.get('m2')).toEqual(new Uint8Array([2]));
    });

    it('maps a per-item decrypt failure to the machine that owns that envelope', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const request = vi.fn(async () => jsonResponse([
            machineRow('m1', 'env-1'),
            machineRow('m2', 'env-2'),
        ]));
        const encryption = createEncryptionHarness((values) =>
            values.map((value) => (value === 'env-1' ? null : new Uint8Array([9]))));
        const machineDataKeys = new Map<string, Uint8Array>();
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
        expect(machineDataKeys.get('m2')).toEqual(new Uint8Array([9]));
        expect(initializedKeys[0]?.get('m1')).toBe(null);
        expect(initializedKeys[0]?.get('m2')).toEqual(new Uint8Array([9]));
    });
});
