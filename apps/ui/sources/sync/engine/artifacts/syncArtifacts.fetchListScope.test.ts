import { afterEach, describe, expect, it, vi } from 'vitest';
import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent,
    ApprovalRequestV1Schema, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol';
import { createDeferred } from '@/dev/testkit';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { sealArtifactPrivateRevisionMetadata } from '@/sync/domains/artifacts/accountArtifactEnvelope';
import { encodeBase64 } from '@/encryption/base64';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { readArtifactProvenance } from '@/components/artifacts/artifactBrowserModel';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { signAccountContentKeyBindingV1, computeContentPublicKeyFingerprint, openEncryptedDataKeyEnvelopeV1,
    type ArtifactRecipientKeyEnvelopeCommitInputV1 } from '@happier-dev/protocol';
import { decodeBase64 } from '@/encryption/base64';
import { shouldRetryError } from '@/sync/runtime/connectivity/transientConnectivityErrors';

const runtimeFetch = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetch(...args) }));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function json(value: unknown): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function plainHead(index: number): Artifact {
    return { id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
        ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ title: `Document ${index}` }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: index, createdAt: index, updatedAt: index };
}

describe('fetchAndApplyArtifactsList', () => {
    afterEach(() => {
        runtimeFetch.mockReset();
        vi.resetModules();
    });

    it('continues beyond the first transport page without evicting older heads', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://artifact-complete-list.test', scope: 'device' });
        const firstPage = Array.from({ length: 500 }, (_, index) => plainHead(502 - index));
        const secondPage = [plainHead(2), plainHead(1)];
        const last = firstPage.at(-1)!;
        const cursor = encodeBase64(new TextEncoder().encode(JSON.stringify({ updatedAt: last.updatedAt, id: last.id })), 'base64url');
        const cursors: Array<string | null> = [];
        const limits: Array<string | null> = [];
        runtimeFetch.mockImplementation(async (url: unknown) => {
            const target = new URL(String(url));
            if (target.pathname !== '/v1/artifacts') return json({ ok: true });
            const requestedCursor = target.searchParams.get('cursor');
            cursors.push(requestedCursor);
            limits.push(target.searchParams.get('limit'));
            return json(requestedCursor === null ? firstPage : secondPage);
        });
        const rows = new Map<string, DecryptedArtifact>();
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        await fetchAndApplyArtifactsList({ credentials: { token: 'token' }, encryption: null, artifactDataKeys: new Map(),
            applyArtifacts: artifacts => { for (const artifact of artifacts) rows.set(artifact.id, artifact); } });
        expect(cursors).toEqual([null, cursor]);
        expect(limits).toEqual(['500', '500']);
        expect(rows.size).toBe(502);
        expect(rows.get(secondPage[1]!.id)?.title).toBe('Document 1');
    });

    it('publishes usable headers before independent actionable detail hydration completes', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://artifact-staged-list.test', scope: 'device' });
        const approval = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'List sessions' });
        const head: Artifact = { ...plainHead(2), header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)) };
        const detail = createDeferred<Response>();
        const detailReads: string[] = [];
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            if (target.pathname === '/v1/artifacts') return json([head, plainHead(1)]);
            if (target.pathname.startsWith('/v1/artifacts/')) detailReads.push(target.pathname);
            if (target.pathname === '/v1/artifacts/read') {
                expect(JSON.parse(String(init?.body))).toEqual({ artifactIds: [head.id] });
            }
            if (target.pathname === '/v1/artifacts/read' || target.pathname === `/v1/artifacts/${head.id}`) return detail.promise;
            return json({ ok: true });
        });
        const applied: DecryptedArtifact[][] = [];
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const sync = fetchAndApplyArtifactsList({ credentials: { token: 'token' }, encryption: null, artifactDataKeys: new Map(),
            applyArtifacts: rows => applied.push(rows) });
        try {
            await vi.waitFor(() => expect(applied.flat().some(row => row.id === plainHead(1).id)).toBe(true));
            expect(applied).toHaveLength(1);
            expect(applied.flat().find(row => row.id === head.id)?.body).toBeUndefined();
        } finally {
            const artifact = { ...head, publicAudience: 'none', body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }) };
            detail.resolve(json(detailReads.includes('/v1/artifacts/read')
                ? { items: [{ artifactId: head.id, ok: true, artifact, recipientCensus: null }] } : artifact));
            await sync;
        }
        expect(detailReads).toEqual(['/v1/artifacts/read']);
        expect(applied.flat().filter(row => row.id === head.id).at(-1)?.body).toBe(JSON.stringify(approval));
        expect(applied).toHaveLength(2);
    });

    it('keeps header and actionable detail reads on the supplied Account transport', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://different-active-home.test', scope: 'device' });
        const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
        const approval = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'List sessions' });
        const head = { ...plainHead(1), header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)) };
        const origins: string[] = [];
        runtimeFetch.mockImplementation(async (url: unknown) => {
            const target = new URL(String(url));
            if (target.pathname.startsWith('/v1/artifacts')) origins.push(target.origin);
            const artifact = { ...head, publicAudience: 'none', body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }) };
            return json(target.pathname === '/v1/artifacts' ? [head] : target.pathname === '/v1/artifacts/read'
                ? { items: [{ artifactId: head.id, ok: true, recipientCensus: null, artifact }] } : artifact);
        });
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const bound = { credentials: { token: 'token' }, encryption: null, artifactDataKeys: new Map(),
            request: createServerFetchAtEndpoint({ endpointUrl: 'https://captured-artifact-home.test',
                serverId: 'captured-home', credentials: { token: 'token' } }),
            signal: new AbortController().signal, applyArtifacts: vi.fn() };
        await fetchAndApplyArtifactsList(bound);
        expect(origins).toEqual(['https://captured-artifact-home.test', 'https://captured-artifact-home.test']);
    });

    it('batches selected encrypted bodies and rejects a changed caller key before applying details', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(21));
        const key = new Uint8Array(32).fill(22);
        const artifactEncryption = new ArtifactEncryption(key);
        const dataEncryptionKey = encodeBase64(await encryption.encryptEncryptionKey(key));
        const changedDataEncryptionKey = encodeBase64(await encryption.encryptEncryptionKey(new Uint8Array(32).fill(23)));
        const rows: Artifact[] = await Promise.all([1, 2].map(async index => ({ ...plainHead(index),
            encryptionMode: 'e2ee' as const, dataEncryptionKey,
            header: await artifactEncryption.encryptHeader({ title: `Profile ${index}`, kind: 'launch-profile.v1' }),
            body: await artifactEncryption.encryptBody({ body: `Profile body ${index}` }), publicAudience: 'none' as const })));
        const paths: string[] = [];
        let changed = false;
        const signingSecret = new Uint8Array(32).fill(24);
        const signingPublic = ed25519.getPublicKey(signingSecret);
        const recipientSecret = new Uint8Array(32).fill(25);
        const recipientPublic = x25519.getPublicKey(recipientSecret);
        const recipientFingerprint = computeContentPublicKeyFingerprint(recipientPublic);
        const signature = signAccountContentKeyBindingV1({ accountSigningSecretKey: new Uint8Array([...signingSecret, ...signingPublic]),
            contentPublicKey: recipientPublic });
        const prepared: ArtifactRecipientKeyEnvelopeCommitInputV1[] = [];
        const census = (artifact: Artifact) => ({ artifactId: artifact.id, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
            dataEncryptionKey, callerDataEncryptionKey: changed ? changedDataEncryptionKey : dataEncryptionKey,
            recipients: [{ recipientAccountId: 'recipient', contentKey: { status: 'available',
                accountSigningPublicKey: Buffer.from(signingPublic).toString('hex'), contentPublicKey: encodeBase64(recipientPublic),
                contentPublicKeySignature: encodeBase64(signature) }, contentPublicKeyFingerprint: recipientFingerprint,
                encryptedDataKey: null, recipientContentPublicKeyFingerprint: null }] });
        const request = vi.fn(async (path: string, init?: RequestInit) => {
            const target = new URL(path, 'https://captured.test');
            paths.push(target.pathname);
            if (target.pathname === '/v1/artifacts') return json(rows.map(({ body: _body, ...head }) => head));
            if (target.pathname === '/v1/artifacts/read') {
                expect(JSON.parse(String(init?.body))).toEqual({ artifactIds: [...rows].reverse().map(row => row.id) });
                return json({ items: [...rows].reverse().map(artifact => ({ artifactId: artifact.id, ok: true, artifact,
                    recipientCensus: census(artifact) })) });
            }
            if (target.pathname.endsWith('/key-envelopes')) {
                const input = JSON.parse(String(init?.body)) as ArtifactRecipientKeyEnvelopeCommitInputV1;
                expect(input.expectedDataEncryptionKey).toBe(dataEncryptionKey);
                expect(input.recipientKeyEnvelopes.map(item => item.recipientAccountId)).toEqual(['recipient']);
                expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(input.recipientKeyEnvelopes[0]!.encryptedDataKey),
                    recipientSecretKeyOrSeed: recipientSecret })).toEqual(key);
                prepared.push(input);
                return json({ appliedRecipientAccountIds: ['recipient'], skippedRecipientAccountIds: [] });
            }
            const artifact = rows.find(row => target.pathname === `/v1/artifacts/${row.id}`
                || target.pathname === `/v1/artifacts/${row.id}/access/recipients`);
            if (artifact) return json(target.pathname.endsWith('/recipients') ? census(artifact) : artifact);
            return json({ error: 'unexpected request' });
        });
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const applied: DecryptedArtifact[][] = [];
        const params = { credentials: { token: 'token' }, encryption, artifactDataKeys: new Map(), request,
            applyArtifacts: (items: DecryptedArtifact[]) => applied.push(items) };
        await fetchAndApplyArtifactsList(params);
        expect(paths.filter(path => !path.endsWith('/key-envelopes'))).toEqual(['/v1/artifacts', '/v1/artifacts/read']);
        expect(prepared.map(input => input.artifactId).sort()).toEqual(rows.map(row => row.id).sort());
        expect(applied.at(-1)?.map(row => row.body)).toEqual(['Profile body 2', 'Profile body 1']);
        changed = true;
        applied.length = 0;
        prepared.length = 0;
        await expect(fetchAndApplyArtifactsList(params)).rejects.toMatchObject({ code: 'artifact_data_key_changed' });
        expect(prepared).toEqual([]);
        expect(applied).toHaveLength(1);
        expect(applied[0]?.every(row => row.body === undefined)).toBe(true);
    });

    it('drops fetched artifacts when the captured sync scope is stale before apply', async () => {
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');

        const applyArtifacts = vi.fn();
        await fetchAndApplyArtifactsList({
            credentials: { token: 'token-a', secret: 'secret-a' },
            encryption: null,
            artifactDataKeys: new Map(),
            applyArtifacts,
            shouldContinue: () => false,
        });

        expect(applyArtifacts).not.toHaveBeenCalled();
    });

    it('skips disappeared details but rejects refused or incomplete batches after publishing headers', async () => {
        const head = { ...plainHead(1), header: encodePlainArtifactStoredContent({ title: 'Profile', kind: 'launch-profile.v1' }) };
        let batch: unknown = { items: [{ artifactId: head.id, ok: false, error: 'artifact_not_found', status: 404, retryable: false }] };
        const request = async (path: string) => json(path.startsWith('/v1/artifacts?') ? [head] : batch);
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const applied: DecryptedArtifact[][] = [];
        const params = { credentials: { token: 'token' }, encryption: null, artifactDataKeys: new Map(), request,
            applyArtifacts: (rows: DecryptedArtifact[]) => applied.push(rows) };
        await fetchAndApplyArtifactsList(params);
        expect(applied).toHaveLength(1);
        batch = { items: [{ artifactId: head.id, ok: false, error: 'artifact_content_unavailable', status: 409, retryable: false }] };
        applied.length = 0;
        const refusal = await fetchAndApplyArtifactsList(params).catch((error: unknown) => error);
        expect(refusal).toMatchObject({ code: 'artifact_content_unavailable' });
        expect(shouldRetryError(refusal)).toBe(false);
        expect(applied).toHaveLength(1);
        batch = { items: [{ artifactId: head.id, ok: false, error: 'artifact_content_unavailable', status: 500, retryable: true }] };
        const ownerFailure = await fetchAndApplyArtifactsList(params).catch((error: unknown) => error);
        expect(ownerFailure).toMatchObject({ code: 'artifact_content_unavailable', status: 500 });
        expect(shouldRetryError(ownerFailure)).toBe(true);
        // Census refuses with the existing generic access error, not the exact detail's terminal409.
        batch = { items: [{ artifactId: head.id, ok: false, error: 'artifact_content_unavailable', status: 409, retryable: true }] };
        const censusFailure = await fetchAndApplyArtifactsList(params).catch((error: unknown) => error);
        expect(censusFailure).toMatchObject({ code: 'artifact_content_unavailable', status: 409 });
        expect(shouldRetryError(censusFailure)).toBe(true);
        batch = { items: [] };
        applied.length = 0;
        await expect(fetchAndApplyArtifactsList(params)).rejects.toMatchObject({ code: 'artifact_content_unavailable' });
        expect(applied).toHaveLength(1);
    });

    it('keeps a failed batch HTTP read retryable through the existing retry owner', async () => {
        const head = { ...plainHead(1), header: encodePlainArtifactStoredContent({ title: 'Profile', kind: 'launch-profile.v1' }) };
        const request = async (path: string) => path.startsWith('/v1/artifacts?') ? json([head])
            : Response.json({ error: 'artifact_content_unavailable' }, { status: 500 });
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const refusal = await fetchAndApplyArtifactsList({ credentials: { token: 'token' }, encryption: null,
            artifactDataKeys: new Map(), request, applyArtifacts: () => {} }).catch((error: unknown) => error);
        expect(refusal).toMatchObject({ code: 'artifact_content_unavailable', status: 500 });
        expect(shouldRetryError(refusal)).toBe(true);
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
