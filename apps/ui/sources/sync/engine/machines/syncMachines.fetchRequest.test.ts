import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAndApplyMachines } from './syncMachines';

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

describe('fetchAndApplyMachines request override', () => {
    it('uses injected request transport when provided', async () => {
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
    });

    it('does not drop machines when dataEncryptionKey cannot be decrypted (fallback to legacy machine encryption)', async () => {
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
});
