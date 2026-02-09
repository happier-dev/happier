import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAndApplyMachines } from './syncMachines';

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
    const decryptEncryptionKey = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const initializeMachines = vi.fn(async () => {});
    const decryptMetadata = vi.fn(async (_version: number, value: string) => ({ decrypted: value }));
    const decryptDaemonState = vi.fn(async (_version: number, value: string | null) => {
        if (!value) return null;
        return { decrypted: value };
    });
    return {
        decryptEncryptionKey,
        initializeMachines,
        getMachineEncryption: () => ({ decryptMetadata, decryptDaemonState }),
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

        const requestSpy = vi.fn(async () =>
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
            request: (path, init) => requestSpy(path, init),
            applyMachines: (machines) => {
                applied.push(machines);
            },
        });

        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(applied).toHaveLength(1);
        expect((applied[0] as any[])[0]?.id).toBe('m1');
    });
});
