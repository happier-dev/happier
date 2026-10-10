import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import type { Artifact, ArtifactCreateRequest, ArtifactUpdateRequest, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { Encryption } from '@/sync/encryption/encryption';
import { createArtifactViaApi, createArtifactWithHeaderViaApi, fetchArtifactWithBodyFromApi, updateArtifactWithHeaderViaApi, type ArtifactDataKeyCache } from './syncArtifacts';

// HTTP is the only substituted boundary; API, mode, compatibility, and crypto stay real.
const runtimeFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetch(...args) }));

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => { runtimeFetch.mockReset(); });

describe('artifact captured Home transport', () => {
    it('uses the caller artifact id and exact revision even when recovering an uncached key', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(23));
        const artifactDataKeys: ArtifactDataKeyCache = new Map();
        let stored: Artifact | undefined;
        let projected: DecryptedArtifact | undefined;
        const updates: ArtifactUpdateRequest[] = [];
        const request = vi.fn(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') return json({ mode: 'e2ee', updatedAt: 0 });
            if (path === '/v1/artifacts') {
                const payload = JSON.parse(String(init?.body)) as ArtifactCreateRequest;
                stored ??= { ...payload, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
                return json(stored);
            }
            if (stored && path.endsWith('/recipients')) return json({ artifactId: stored.id,
                ownerAccountId: stored.ownerAccountId, access: stored.access, encryptionMode: stored.encryptionMode,
                dataEncryptionKey: stored.dataEncryptionKey, callerDataEncryptionKey: stored.dataEncryptionKey, recipients: [] });
            if (init?.method === 'POST') {
                const payload = JSON.parse(String(init.body)) as ArtifactUpdateRequest;
                updates.push(payload);
                if (payload.expectedHeaderVersion !== stored!.headerVersion || payload.expectedBodyVersion !== stored!.bodyVersion) {
                    return json({ success: false, error: 'version-mismatch' });
                }
                stored = { ...stored!, header: payload.header!, body: payload.body!, headerVersion: 2, bodyVersion: 2 };
                return json({ success: true, headerVersion: 2, bodyVersion: 2 });
            }
            return json(stored);
        });
        const common = { credentials: { token: 'captured-account-token' }, encryption, artifactDataKeys, request };
        expect(await createArtifactWithHeaderViaApi({ ...common, artifactId: 'caller-id', header: { title: 'Original' }, body: 'same body',
            addArtifact: (artifact) => { projected = artifact; } })).toBe('caller-id');
        expect(stored?.id).toBe('caller-id');
        await createArtifactWithHeaderViaApi({ ...common, artifactId: 'caller-id', header: { title: 'Competing create' }, body: 'different body',
            addArtifact: (artifact) => { projected = artifact; } });
        expect(projected).toMatchObject({ title: 'Original', body: 'same body' });
        artifactDataKeys.clear();
        await updateArtifactWithHeaderViaApi({ ...common, artifactId: 'caller-id', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
            header: { title: 'Changed' }, body: 'same body', getArtifact: () => projected,
            updateArtifact: (artifact) => { projected = artifact; } });
        expect(updates[0]).toMatchObject({ expectedHeaderVersion: 1, expectedBodyVersion: 1 });
        expect(typeof updates[0]?.body).toBe('string');
        expect(projected).toMatchObject({ headerVersion: 2, bodyVersion: 2, title: 'Changed', body: 'same body' });
        artifactDataKeys.clear();
        await expect(updateArtifactWithHeaderViaApi({ ...common, artifactId: 'caller-id', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
            header: { title: 'Stale overwrite' }, body: 'stale body', getArtifact: () => projected,
            updateArtifact: (artifact) => { projected = artifact; } })).rejects.toMatchObject({ code: 'version_mismatch' });
        expect(updates[1]).toMatchObject({ expectedHeaderVersion: 1, expectedBodyVersion: 1 });
        expect(projected?.title).toBe('Changed');
    });
    it.each(['plain', 'e2ee'] as const)('creates, fetches and updates %s artifacts on B while A is focused', async (mode) => {
        const homeB = await upsertAndActivateServer({ serverUrl: `https://artifact-b-${mode}.test`, scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: `https://artifact-a-${mode}.test`, scope: 'tab' });
        let stored: Artifact | undefined;
        const requests: string[] = [];
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            requests.push(target.href);
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: {} });
            if (target.origin !== homeB.serverUrl) return json({ error: 'wrong-home' }, 403);
            expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token-b');
            if (target.pathname === '/v1/account/encryption') return json({ mode, updatedAt: 0 });
            if (target.pathname === '/v1/artifacts' && init?.method === 'POST') {
                const body = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                stored = { ...body, ownerAccountId: 'owner', access: 'owner', encryptionMode: mode, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
                return json(stored);
            }
            if (stored && target.pathname.endsWith('/recipients')) return json({ artifactId: stored.id,
                ownerAccountId: stored.ownerAccountId, access: stored.access, encryptionMode: stored.encryptionMode,
                dataEncryptionKey: stored.dataEncryptionKey, callerDataEncryptionKey: stored.dataEncryptionKey, recipients: [] });
            if (stored && target.pathname === `/v1/artifacts/${stored.id}`) {
                if (init?.method !== 'POST') return json(stored);
                const update = JSON.parse(String(init.body)) as ArtifactUpdateRequest;
                expect(update.expectedHeaderVersion).toBe(1);
                expect(update.expectedBodyVersion).toBe(1);
                stored = { ...stored, header: update.header!, body: update.body!, headerVersion: 2, bodyVersion: 2 };
                return json({ success: true, headerVersion: 2, bodyVersion: 2 });
            }
            return json({ error: 'missing' }, 404);
        });
        const request = (path: string, init?: RequestInit) => runtimeFetch(`${homeB.serverUrl}${path}`, init) as Promise<Response>;
        const encryption = mode === 'plain' ? null : await Encryption.create(new Uint8Array(32).fill(22));
        const artifactDataKeys: ArtifactDataKeyCache = new Map();
        const context = { credentials: { token: 'token-b' }, encryption, artifactDataKeys, request, serverId: homeB.id };
        let projected: DecryptedArtifact | undefined;
        // Optional header fields are deliberately omitted, as with an ordinary new artifact.
        const id = await createArtifactViaApi({ ...context, title: 'B title', body: 'B body', addArtifact: (value) => { projected = value; } });
        expect(projected).toMatchObject({ id, title: 'B title', body: 'B body', storageMode: mode });
        expect(stored?.dataEncryptionKey === ARTIFACT_PLAIN_DATA_KEY_MARKER).toBe(mode === 'plain');
        context.artifactDataKeys.clear();
        const fetched = await fetchArtifactWithBodyFromApi({ ...context, artifactId: id });
        expect(fetched).toMatchObject({ title: 'B title', body: 'B body', storageMode: mode });
        // Missing versions force the update's recovery read through the same captured transport.
        // `headerVersion` is required on the projection type, so the version-less cache entry a
        // released writer can leave behind is constructed deliberately here.
        projected = { ...fetched!, headerVersion: undefined, bodyVersion: undefined } as unknown as DecryptedArtifact;
        context.artifactDataKeys.clear();
        await updateArtifactWithHeaderViaApi({ ...context, artifactId: id, header: { ...fetched!.rawHeader, title: 'B updated' },
            body: 'B updated body', getArtifact: () => projected, updateArtifact: (value) => { projected = value; } });
        expect(projected).toMatchObject({ title: 'B updated', body: 'B updated body', headerVersion: 2, bodyVersion: 2 });
        expect(await fetchArtifactWithBodyFromApi({ ...context, artifactId: id })).toMatchObject({ title: 'B updated', body: 'B updated body' });
        expect(requests.filter((url) => !url.endsWith('/health') && !url.includes('/v1/auth/ping')).every((url) => url.startsWith(homeB.serverUrl))).toBe(true);
        if (mode === 'plain') expect(context.artifactDataKeys.size).toBe(0);
    });
});
