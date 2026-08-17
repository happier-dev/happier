import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';

import type { ArtifactDataKeyCache } from './syncArtifacts';

const fetchArtifactsMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/artifacts/apiArtifacts', () => ({
    createArtifact: vi.fn(),
    fetchArtifact: vi.fn(),
    fetchArtifacts: (...args: unknown[]) => fetchArtifactsMock(...args),
    updateArtifact: vi.fn(),
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * Boundary-only encryption double: the artifact body/header crypto below it is the
 * real `ArtifactEncryption`. Only the account-level envelope open — the curve25519
 * work this lane is counting — is stood in for, so the counts are the contract.
 */
function createEncryptionHarness(dataKeyByEnvelope: ReadonlyMap<string, Uint8Array>) {
    const decryptEncryptionKeys = vi.fn(async (values: readonly string[]) =>
        values.map((value) => dataKeyByEnvelope.get(value) ?? null));
    return {
        encryption: { decryptEncryptionKeys } as never,
        decryptEncryptionKeys,
    };
}

async function buildArtifact(id: string, envelope: string, dataKey: Uint8Array) {
    const artifactEncryption = new ArtifactEncryption(dataKey);
    return {
        id,
        header: await artifactEncryption.encryptHeader({ v: 1, kind: 'artifact.legacy', title: `title-${id}` } as never),
        headerVersion: 1,
        body: undefined,
        bodyVersion: undefined,
        dataEncryptionKey: envelope,
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
    };
}

describe('fetchAndApplyArtifactsList artifact data-key unwrapping', () => {
    afterEach(() => {
        fetchArtifactsMock.mockReset();
        vi.resetModules();
    });

    it('opens every artifact envelope in one batch instead of one call per artifact', async () => {
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const keyA = new Uint8Array(32).fill(1);
        const keyB = new Uint8Array(32).fill(2);
        const keyC = new Uint8Array(32).fill(3);
        fetchArtifactsMock.mockResolvedValue([
            await buildArtifact('a', 'env-a', keyA),
            await buildArtifact('b', 'env-b', keyB),
            await buildArtifact('c', 'env-c', keyC),
        ]);
        const { encryption, decryptEncryptionKeys } = createEncryptionHarness(new Map([
            ['env-a', keyA],
            ['env-b', keyB],
            ['env-c', keyC],
        ]));
        const artifactDataKeys: ArtifactDataKeyCache = new Map();
        const applyArtifacts = vi.fn();

        await fetchAndApplyArtifactsList({ credentials: { token: 't', secret: 's' } as never, encryption, artifactDataKeys, applyArtifacts });

        expect(decryptEncryptionKeys).toHaveBeenCalledTimes(1);
        expect(decryptEncryptionKeys.mock.calls[0]![0]).toEqual(['env-a', 'env-b', 'env-c']);
        expect(applyArtifacts.mock.calls[0]![0].map((artifact: { title: string }) => artifact.title))
            .toEqual(['title-a', 'title-b', 'title-c']);
    });

    it('does not re-open an envelope whose unwrapped key is already cached', async () => {
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const keyA = new Uint8Array(32).fill(1);
        const keyB = new Uint8Array(32).fill(2);
        fetchArtifactsMock.mockResolvedValue([
            await buildArtifact('a', 'env-a', keyA),
            await buildArtifact('b', 'env-b', keyB),
        ]);
        const { encryption, decryptEncryptionKeys } = createEncryptionHarness(new Map([
            ['env-a', keyA],
            ['env-b', keyB],
        ]));
        const artifactDataKeys: ArtifactDataKeyCache = new Map();
        const applyArtifacts = vi.fn();
        const params = { credentials: { token: 't', secret: 's' } as never, encryption, artifactDataKeys, applyArtifacts };

        await fetchAndApplyArtifactsList(params);
        await fetchAndApplyArtifactsList(params);

        expect(decryptEncryptionKeys).toHaveBeenCalledTimes(1);
        expect(applyArtifacts).toHaveBeenCalledTimes(2);
        expect(applyArtifacts.mock.calls[1]![0].map((artifact: { title: string }) => artifact.title))
            .toEqual(['title-a', 'title-b']);
    });

    it('re-opens only the artifact whose envelope rotated', async () => {
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const keyA = new Uint8Array(32).fill(1);
        const keyB = new Uint8Array(32).fill(2);
        const rotatedKeyB = new Uint8Array(32).fill(7);
        const { encryption, decryptEncryptionKeys } = createEncryptionHarness(new Map([
            ['env-a', keyA],
            ['env-b', keyB],
            ['env-b-rotated', rotatedKeyB],
        ]));
        const artifactDataKeys: ArtifactDataKeyCache = new Map();
        const applyArtifacts = vi.fn();
        const params = { credentials: { token: 't', secret: 's' } as never, encryption, artifactDataKeys, applyArtifacts };

        fetchArtifactsMock.mockResolvedValue([
            await buildArtifact('a', 'env-a', keyA),
            await buildArtifact('b', 'env-b', keyB),
        ]);
        await fetchAndApplyArtifactsList(params);

        fetchArtifactsMock.mockResolvedValue([
            await buildArtifact('a', 'env-a', keyA),
            await buildArtifact('b', 'env-b-rotated', rotatedKeyB),
        ]);
        await fetchAndApplyArtifactsList(params);

        expect(decryptEncryptionKeys).toHaveBeenCalledTimes(2);
        expect(decryptEncryptionKeys.mock.calls[1]![0]).toEqual(['env-b-rotated']);
        expect(applyArtifacts.mock.calls[1]![0].map((artifact: { title: string }) => artifact.title))
            .toEqual(['title-a', 'title-b']);
    });

    it('drops the cached key when a rotated envelope fails to open', async () => {
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const keyA = new Uint8Array(32).fill(1);
        const { encryption, decryptEncryptionKeys } = createEncryptionHarness(new Map([['env-a', keyA]]));
        const artifactDataKeys: ArtifactDataKeyCache = new Map();
        const applyArtifacts = vi.fn();
        const params = { credentials: { token: 't', secret: 's' } as never, encryption, artifactDataKeys, applyArtifacts };

        fetchArtifactsMock.mockResolvedValue([await buildArtifact('a', 'env-a', keyA)]);
        await fetchAndApplyArtifactsList(params);
        expect(artifactDataKeys.get('a')).toMatchObject({ envelope: 'env-a' });

        fetchArtifactsMock.mockResolvedValue([await buildArtifact('a', 'env-a-rotated', keyA)]);
        await fetchAndApplyArtifactsList(params);

        expect(decryptEncryptionKeys).toHaveBeenCalledTimes(2);
        expect(artifactDataKeys.has('a')).toBe(false);
        // ../dev keeps the row and surfaces it as locked rather than dropping it.
        expect(applyArtifacts.mock.calls[1]![0]).toMatchObject([
            { id: 'a', isDecrypted: false },
        ]);
        consoleError.mockRestore();
    });
});
