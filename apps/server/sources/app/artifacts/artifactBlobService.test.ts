import * as privacyKit from 'privacy-kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encryptBytes, initEncrypt } from '@/modules/encrypt';
import * as privateFiles from '@/storage/blob/files';
import { openArtifactBlobBytes, type ArtifactBlobRow } from './artifactBlobService';

// Private file IO is the system boundary; envelope parsing and encryption stay real.
const readPrivateFile = vi.spyOn(privateFiles, 'readPrivateFile');
const row: ArtifactBlobRow = { id: 'blob-1', artifactId: 'artifact-1', storageKey: 'artifacts/artifact-1/blob-1/file',
    encryptionMode: 'plain', storedSizeBytes: 0n };
const accountId = 'account-1';
const payload = new Uint8Array([0, 1, 255, 42]);
const stored = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

beforeAll(async () => {
    vi.stubEnv('HANDY_MASTER_SECRET', 'artifact-blob-reader-test');
    await initEncrypt();
});
afterAll(() => vi.unstubAllEnvs());

describe('openArtifactBlobBytes', () => {
    it('opens additive plain and sealed file envelopes with real ciphertext identity checks', async () => {
        readPrivateFile.mockResolvedValue(stored({ t: 'plain', v: privacyKit.encodeBase64(payload), future: true }));
        expect(await openArtifactBlobBytes(accountId, row)).toEqual(payload);
        const c = privacyKit.encodeBase64(encryptBytes(['storage', 'artifact', accountId, row.artifactId, 'blob', row.id, 'v1'], payload));
        readPrivateFile.mockResolvedValue(stored({ t: 'sealed_v1', c, future: { version: 2 } }));
        expect(await openArtifactBlobBytes(accountId, row)).toEqual(payload);
        await expect(openArtifactBlobBytes(accountId, { ...row, id: 'other' })).rejects.toThrow();
    });

    it('refuses malformed required fields, unknown envelope tags and unavailable modes', async () => {
        for (const envelope of [{ t: 'plain', v: 42, future: true }, { t: 'sealed_v1', c: 42 }, { t: 'encrypted', c: 'YWJj' }]) {
            readPrivateFile.mockResolvedValue(stored(envelope));
            await expect(openArtifactBlobBytes(accountId, row)).rejects.toThrow();
        }
        await expect(openArtifactBlobBytes(accountId, { ...row, encryptionMode: 'unknown' })).rejects.toThrow();
        readPrivateFile.mockResolvedValue(payload);
        expect(await openArtifactBlobBytes(accountId, { ...row, encryptionMode: 'e2ee' })).toEqual(payload);
    });
});
