import { createHash, randomUUID } from 'node:crypto';
import * as privacyKit from 'privacy-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, ApprovalRequestV1Schema, buildApprovalRequestArtifactHeaderV1,
    encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { serveSessionActionHome } from '../../../../ui/sources/dev/testkit/harness/sessionActionHome';
import { installDisconnectedServerSocketBoundary } from '../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness';
import { waitForHomeGovernance } from '../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '../../../../ui/sources/dev/testkit';

vi.mock('socket.io-client', async original =>
    (await import('../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
// Load the real UI graph before timed fixture setup; no domain or projection is mocked.
await import('../../../../ui/sources/sync/syncEngine');

describe('Artifact inventory publications through SQLite, HTTP and UI Sync', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-artifact-publications-', initEncrypt: true });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(() => standardCleanup());

    it('keeps unchanged cold-list and exact-body observations quiet while publishing real exposure, revision and revocation changes', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const approval = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'session' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'List sessions' });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id, kind: 'other',
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval))),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(approval) })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1 } });
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: viewer.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        // The app boot prepares device persistence before restoring Sync. This
        // composed transport fixture starts below that boot entry point.
        const { prepareWarmCacheStorage } = await import('../../../../ui/sources/sync/domains/state/warmCachePersistence');
        await prepareWarmCacheStorage();
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            let cursor = 0;
            let cold = false;
            let exactAudience: 'unknown' | 'omitted' | null = null;
            let listReads = 0;
            let bodyReads = 0;
            let headerSetReads = 0;
            const home = await serveSessionActionHome({ homes: [{ key: 'artifact', serverUrl: 'https://artifact-publications.test',
                accountId: viewer.id, currentAccount: true }], route: async request => {
                // Expired device cursors exercise the actual cold-list fallback, not a cache bypass.
                if (request.path === '/v2/cursor') return Response.json({ cursor, changesFloor: 0 });
                if (request.path === '/v2/changes' && cold) return Response.json({ currentCursor: cursor }, { status: 410 });
                if (request.path === '/v2/changes') return Response.json({ changes: [
                    { kind: 'artifact', entityId: artifact.id, cursor, changedAt: 1 },
                ], nextCursor: cursor });
                if (!request.path.startsWith('/v1/artifacts')) return undefined;
                if (request.method !== 'GET' && request.method !== 'POST') throw new Error('Unexpected Artifact request method');
                if (request.path === '/v1/artifacts') listReads++;
                if (request.path === '/v1/artifacts/read') {
                    if (request.body && typeof request.body === 'object' && Reflect.get(request.body, 'projection') === 'headers') headerSetReads++;
                    else bodyReads++;
                }
                // Only HTTP and credential verification are substituted. Fastify serialization,
                // admission, the real database, UI codecs, Sync and the store all remain real.
                const response = await app.inject({ method: request.method, url: request.url.pathname + request.url.search,
                    headers: { ...Object.fromEntries(request.headers), 'x-test-user-id': request.accountId ?? '' },
                    ...(request.body === undefined ? {} : { payload: request.body }) });
                if (exactAudience !== null && response.statusCode === 200
                    && (request.path === '/v1/artifacts/read' || request.path === `/v1/artifacts/${artifact.id}`)) {
                    const wire: unknown = response.json();
                    if (!wire || typeof wire !== 'object') throw new Error('Invalid test HTTP response');
                    const items: unknown = Reflect.get(wire, 'items');
                    if (request.path === '/v1/artifacts/read' && !Array.isArray(items)) throw new Error('Invalid batch HTTP response');
                    const rows: unknown[] = Array.isArray(items) ? items.map(item => item?.artifact) : [wire];
                    for (const row of rows) {
                        if (!row || typeof row !== 'object') continue;
                        if (exactAudience === 'omitted') Reflect.deleteProperty(row, 'publicAudience');
                        else Reflect.set(row, 'publicAudience', exactAudience);
                    }
                    return Response.json(wire);
                }
                return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
            } });
            const disconnect = await home.restoreActiveConnection();
            let off: (() => void) | undefined;
            try {
                const { sync } = await import('../../../../ui/sources/sync/sync');
                const { storage } = await import('../../../../ui/sources/sync/domains/state/storage');
                const { TokenStorage } = await import('../../../../ui/sources/auth/storage/tokenStorage');
                const { fetchArtifactReadBatch } = await import('../../../../ui/sources/sync/api/artifacts/apiArtifacts');
                const credentials = await TokenStorage.getCredentialsForServerUrl('https://artifact-publications.test');
                if (!credentials) throw new Error('Expected the composed Home credential');
                await waitForHomeGovernance(() => {
                    expect(storage.getState().artifactsLoaded).toBe(true);
                    expect(storage.getState().artifacts[artifact.id]?.body).toBe(JSON.stringify(approval));
                });
                let publications = 0;
                const changedFields: string[][] = [];
                off = storage.subscribe((next, before) => {
                    if (next.artifacts === before.artifacts) return;
                    publications++;
                    const left = before.artifacts[artifact.id];
                    const right = next.artifacts[artifact.id];
                    changedFields.push([...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])]
                        .filter(key => Object.hasOwn(left ?? {}, key) !== Object.hasOwn(right ?? {}, key)
                            || Reflect.get(left ?? {}, key) !== Reflect.get(right ?? {}, key)).sort());
                });
                const refresh = async () => { cold = true; cursor++; await sync.fetchArtifactsList(); };
                const firstLists = listReads;
                const firstBodies = bodyReads;
                for (let index = 0; index < 3; index++) await refresh();
                expect(listReads - firstLists).toBe(3);
                expect(bodyReads - firstBodies).toBe(0);
                expect({ publications, changedFields }).toEqual({ publications: 0, changedFields: [] });
                expect(Object.hasOwn(storage.getState().artifacts[artifact.id], 'provenance')).toBe(true);

                const beforeWarm = { listReads, bodyReads, headerSetReads, publications };
                cold = false;
                cursor++;
                await sync.fetchArtifactsList();
                expect({ listReads, bodyReads, headerSetReads, publications }).toEqual({ ...beforeWarm,
                    headerSetReads: beforeWarm.headerSetReads + 1 });
                expect(storage.getState().artifacts[artifact.id]?.body).toBe(JSON.stringify(approval));

                const publication = await db.publicSessionShare.create({ data: { artifactId: artifact.id,
                    createdByUserId: owner.id, keyDerivation: 'fragment_v1', tokenHash: createHash('sha256').update(randomUUID()).digest() } });
                await refresh();
                expect(storage.getState().artifacts[artifact.id]).toMatchObject({ publicAudience: 'retained', headerVersion: 1, bodyVersion: 1 });
                expect(publications).toBe(1);
                await db.publicSessionShare.delete({ where: { id: publication.id } });
                await refresh();
                expect(storage.getState().artifacts[artifact.id]).toMatchObject({ publicAudience: 'none', headerVersion: 1, bodyVersion: 1 });
                expect(publications).toBe(2);

                for (const audience of ['unknown', 'omitted'] as const) {
                    exactAudience = audience;
                    const beforeUnknown = publications;
                    // Header refresh does not demand retained bodies. A real full
                    // batch demand still rejects a malformed exposure witness.
                    await refresh();
                    await expect(fetchArtifactReadBatch(credentials, [artifact.id], { fresh: true }))
                        .rejects.toMatchObject({ name: 'HappyError', canTryAgain: false });
                    expect(publications).toBe(beforeUnknown);
                    // The predecessor-capable opaque exact reader retains readable content,
                    // but missing/unfamiliar exposure never becomes an authoritative `none`.
                    const opened = await sync.fetchArtifactWithBody(artifact.id, { fresh: true });
                    expect(opened).toMatchObject({ publicAudience: 'unknown',
                        isDecrypted: true, body: JSON.stringify(approval) });
                }
                exactAudience = null;
                await refresh();
                expect(storage.getState().artifacts[artifact.id]?.publicAudience).toBe('none');

                const revised = { ...approval, summary: 'Updated request' };
                await db.artifact.update({ where: { id: artifact.id }, data: { bodyVersion: 2,
                    body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(revised) })) } });
                const beforeRevision = publications;
                await refresh();
                expect(storage.getState().artifacts[artifact.id]).toMatchObject({ bodyVersion: 2, body: JSON.stringify(revised) });
                // A changed head withdraws the previous body before the independent exact read completes.
                expect(publications - beforeRevision).toBe(2);
                await db.artifactAccountGrant.deleteMany({ where: { artifactId: artifact.id, accountId: viewer.id } });
                const beforeRevocation = publications;
                await refresh();
                expect(storage.getState().artifacts[artifact.id]).toBeUndefined();
                expect(publications - beforeRevocation).toBe(1);
            } finally { off?.(); await disconnect(); await home.dispose(); }
        });
    });
});
