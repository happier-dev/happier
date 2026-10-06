import { afterEach, describe, expect, it, vi } from 'vitest';
import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { sealArtifactPrivateRevisionMetadata } from '@/sync/domains/artifacts/accountArtifactEnvelope';
import { encodeBase64 } from '@/encryption/base64';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { readArtifactProvenance } from '@/components/artifacts/artifactBrowserModel';

const runtimeFetch = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetch(...args) }));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function json(value: unknown): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('fetchAndApplyArtifactsList', () => {
    afterEach(() => {
        runtimeFetch.mockReset();
        vi.resetModules();
    });

    it('drops fetched artifacts when the captured sync scope is stale before apply', async () => {
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');

        const applyArtifacts = vi.fn();
        await fetchAndApplyArtifactsList({
            credentials: { token: 'token-a', secret: 'secret-a' },
            encryption: {} as any,
            artifactDataKeys: new Map(),
            applyArtifacts,
            shouldContinue: () => false,
        } as Parameters<typeof fetchAndApplyArtifactsList>[0] & { shouldContinue: () => boolean });

        expect(applyArtifacts).not.toHaveBeenCalled();
    });

    it.each(['plain', 'e2ee'] as const)('retains opened %s private source on cold header-only Browser refresh without loading document bodies', async mode => {
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const home = await upsertAndActivateServer({ serverUrl: `https://artifact-cold-${mode}.test`, scope: 'device' });
        expect(getActiveServerSnapshot().serverUrl).toBe(home.serverUrl);
        const encryption = mode === 'plain' ? null : await Encryption.create(new Uint8Array(32).fill(9));
        const contentKey = new Uint8Array(32).fill(10);
        const privateKey = new Uint8Array(32).fill(11);
        const id = '11111111-1111-4111-8111-111111111111';
        const source = { sessionId: 'session', machineId: 'machine', path: 'private/output.ts', sha: 'a'.repeat(64) };
        const provenance = { savedBy: { kind: 'agent' as const, accountId: 'owner', sessionId: source.sessionId }, source };
        const row = { id, ownerAccountId: 'owner', access: 'owner' as const, encryptionMode: mode,
            header: mode === 'plain' ? encodePlainArtifactStoredContent({ title: 'Published output' }) : await new ArtifactEncryption(contentKey).encryptHeader({ title: 'Published output' }),
            headerVersion: 1, bodyVersion: 2, seq: 2, createdAt: 1, updatedAt: 2,
            dataEncryptionKey: encryption ? encodeBase64(await encryption.encryptEncryptionKey(contentKey)) : ARTIFACT_PLAIN_DATA_KEY_MARKER,
            provenance: await sealArtifactPrivateRevisionMetadata({ mode, artifactId: id, bodyVersion: 2, provenance, dataKey: privateKey }),
            provenanceDataEncryptionKey: encryption ? encodeBase64(await encryption.encryptEncryptionKey(privateKey)) : null,
        };
        runtimeFetch.mockImplementation(async (url: unknown) => {
            const target = new URL(String(url));
            if (target.pathname !== '/v1/artifacts') return json({ ok: true });
            expect(target.origin).toBe(home.serverUrl);
            expect(target.searchParams.has('includeBody')).toBe(false);
            return json([row]);
        });
        const applied: DecryptedArtifact[][] = [];
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        await fetchAndApplyArtifactsList({ credentials: { token: 'token' }, encryption, artifactDataKeys: new Map(),
            applyArtifacts: rows => applied.push(rows) });
        expect(applied[0]?.[0]).toMatchObject({ id, bodyVersion: 2, provenance });
        expect(applied[0]?.[0]?.body).toBeUndefined();
        expect(readArtifactProvenance(applied[0]![0]!)).toEqual(source);
        expect(applied[0]?.[0]?.rawHeader).not.toHaveProperty('source');
        if (mode === 'e2ee') {
            const viewerEncryption = await Encryption.create(new Uint8Array(32).fill(12));
            const viewerContentWrap = encodeBase64(await viewerEncryption.encryptEncryptionKey(contentKey));
            const viewerPrivateWrap = encodeBase64(await viewerEncryption.encryptEncryptionKey(privateKey));
            expect(viewerPrivateWrap).not.toBe(row.provenanceDataEncryptionKey);
            // The HTTP boundary projects content-only custody without private metadata.
            const viewerRow = { ...row, access: 'view' as const, dataEncryptionKey: viewerContentWrap,
                provenance: null, provenanceDataEncryptionKey: null };
            runtimeFetch.mockImplementation(async (url: unknown) => json(new URL(String(url)).pathname === '/v1/artifacts' ? [viewerRow] : { ok: true }));
            await fetchAndApplyArtifactsList({ credentials: { token: 'viewer' }, encryption: viewerEncryption,
                artifactDataKeys: new Map(), applyArtifacts: rows => applied.push(rows) });
            expect(applied[1]?.[0]).toMatchObject({ id, isDecrypted: true, title: 'Published output' });
            expect(readArtifactProvenance(applied[1]![0]!)).toBeNull();
            runtimeFetch.mockImplementation(async (url: unknown) => json(new URL(String(url)).pathname === '/v1/artifacts' ? [{ ...viewerRow,
                provenance: row.provenance, provenanceDataEncryptionKey: viewerPrivateWrap }] : { ok: true }));
            await fetchAndApplyArtifactsList({ credentials: { token: 'viewer' }, encryption: viewerEncryption,
                artifactDataKeys: new Map(), applyArtifacts: rows => applied.push(rows) });
            expect(applied[2]?.[0]).toMatchObject({ id, bodyVersion: 2, provenance });
            expect(readArtifactProvenance(applied[2]![0]!)).toEqual(source);
            expect(await new ArtifactEncryption(contentKey).decryptHeaderRaw(row.provenance)).toBeNull();
        }
        expect(runtimeFetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).not.toContain(`/v1/artifacts/${id}`);
    });
});
