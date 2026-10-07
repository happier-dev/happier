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
        runtimeFetch.mockImplementation(async (url: unknown) => {
            const target = new URL(String(url));
            if (target.pathname === '/v1/artifacts') return json([head, plainHead(1)]);
            if (target.pathname === `/v1/artifacts/${head.id}`) return detail.promise;
            return json({ ok: true });
        });
        const applied: DecryptedArtifact[][] = [];
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const sync = fetchAndApplyArtifactsList({ credentials: { token: 'token' }, encryption: null, artifactDataKeys: new Map(),
            applyArtifacts: rows => applied.push(rows) });
        try {
            await vi.waitFor(() => expect(applied.flat().some(row => row.id === plainHead(1).id)).toBe(true));
            console.info('B08 list publications while detail is pending:', applied.length);
            expect(applied).toHaveLength(1);
            expect(applied.flat().find(row => row.id === head.id)?.body).toBeUndefined();
        } finally {
            detail.resolve(json({ ...head, body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }) }));
            await sync;
        }
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
            return json(target.pathname === '/v1/artifacts' ? [head]
                : { ...head, body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }) });
        });
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const bound = { credentials: { token: 'token' }, encryption: null, artifactDataKeys: new Map(),
            request: createServerFetchAtEndpoint({ endpointUrl: 'https://captured-artifact-home.test',
                serverId: 'captured-home', credentials: { token: 'token' } }),
            signal: new AbortController().signal, applyArtifacts: vi.fn() };
        await fetchAndApplyArtifactsList(bound);
        expect(origins).toEqual(['https://captured-artifact-home.test', 'https://captured-artifact-home.test']);
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
