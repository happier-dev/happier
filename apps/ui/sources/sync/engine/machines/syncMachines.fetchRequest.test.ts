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

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function createEncryptionHarness() {
    const decryptEncryptionKey = vi.fn(async (): Promise<Uint8Array | null> => new Uint8Array([1, 2, 3]));
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
        decryptEncryptionKey,
        initializeMachines,
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
        const machineDataKeys = new Map<string, Uint8Array>();
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

    it('does not throw when the request transport fails (e.g. network error)', async () => {
        const fetchAndApplyMachines = await loadFetchAndApplyMachines();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const requestSpy = vi.fn(async () => {
                throw new TypeError('Failed to fetch');
            });

            const encryption = createEncryptionHarness();
            const machineDataKeys = new Map<string, Uint8Array>();
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
        encryption.decryptEncryptionKey.mockResolvedValueOnce(null);

        const machineDataKeys = new Map<string, Uint8Array>();
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

        expect(applied).toHaveLength(1);
        expect((applied[0] as any[])).toHaveLength(1);
        expect((applied[0] as any[])[0]?.id).toBe('m1');
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
        const machineDataKeys = new Map<string, Uint8Array>();

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
});
