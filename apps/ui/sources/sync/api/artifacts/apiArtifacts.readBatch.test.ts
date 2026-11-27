import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import type { ServerFetch } from '@/sync/http/client';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createArtifact, fetchArtifactReadBatch, prepareArtifactReadBatch } from './apiArtifacts';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createCapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { ArtifactReadBatchInputV1Schema, ArtifactReadBatchHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';

const runtimeFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/system/runtimeFetch')>();
    return { ...actual,
        runtimeFetch: (...args: unknown[]) => runtimeFetch(...args),
        runtimeFetchManualResponse: (...args: unknown[]) => runtimeFetch(...args),
    };
});
afterEach(() => runtimeFetch.mockReset());

// The shared setup resets this real owner; load its cold graph outside the hook budget.
await vi.importActual('@/sync/domains/machines/reachability/machineReachability');

function capturedRead(request: ServerFetch, credentials: AuthCredentials = { token: 'same-authority' }) {
    runtimeFetch.mockImplementation(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({});
        if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: { accountStoredContentCompatibility: {
            v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
        } } });
        return request(url.pathname + url.search, init);
    });
    return createCapturedServerReadTransport({ serverId: 'artifact-read-test',
        profile: { serverUrl: 'https://artifact-read.test' }, credentials });
}

const ids = ['11111111-1111-4111-8111-000000000001', '11111111-1111-4111-8111-000000000002',
    '11111111-1111-4111-8111-000000000003'];

function missing(artifactIds: readonly string[]): Response {
    return Response.json({ items: artifactIds.map(artifactId => ({ artifactId, ok: false,
        error: 'artifact_not_found', status: 404, retryable: false })) });
}

describe('Artifact read acquisition', () => {
    it('separates concurrent header and full demands while sharing each exact header set', async () => {
        const issued: unknown[] = [];
        const release = createDeferred<void>();
        const artifact = { id: ids[0]!, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
            publicAudience: 'none', header: encodePlainArtifactStoredContent({ title: 'Header' }),
            headerVersion: 1, bodyVersion: 1, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            seq: 1, createdAt: 1, updatedAt: 1 };
        const readTransport = capturedRead(async (_path, init) => {
            const input = JSON.parse(String(init?.body));
            issued.push(input);
            await release.promise;
            return input.projection === 'headers'
                ? Response.json({ projection: 'headers', items: [{ artifactId: artifact.id, ok: true, artifact }] })
                : Response.json({ items: [{ artifactId: artifact.id, ok: true,
                    artifact: { ...artifact, body: encodePlainArtifactStoredContent({ body: 'Full' }) }, recipientCensus: null }] });
        });
        let admittedItems = 0;
        const observeInput = (value: unknown) => {
            const values: unknown = value && typeof value === 'object' ? Reflect.get(value, 'artifactIds') : undefined;
            if (Array.isArray(values)) admittedItems += values.length;
        };
        // Count schema visits while keeping every invoked Zod parser real.
        const parseEntry = ArtifactReadBatchInputV1Schema.parse;
        const parsePartition = ArtifactReadBatchHttpInputV1Schema.parse;
        const entry = vi.spyOn(ArtifactReadBatchInputV1Schema, 'parse').mockImplementation((value, options) => {
            observeInput(value);
            return parseEntry(value, options);
        });
        const partition = vi.spyOn(ArtifactReadBatchHttpInputV1Schema, 'parse').mockImplementation((value, options) => {
            observeInput(value);
            return parsePartition(value, options);
        });
        try {
            const headers = fetchArtifactReadBatch({ token: 'same-authority' }, [artifact.id], { readTransport, projection: 'headers' });
            const duplicate = fetchArtifactReadBatch({ token: 'same-authority' }, [artifact.id], { readTransport, projection: 'headers' });
            const full = fetchArtifactReadBatch({ token: 'same-authority' }, [artifact.id], { readTransport });
            release.resolve();
            const [headerItems, duplicateItems, fullItems] = await Promise.all([headers, duplicate, full]);
            expect(issued).toHaveLength(2);
            expect(issued).toEqual(expect.arrayContaining([{ artifactIds: [artifact.id], projection: 'headers' }, { artifactIds: [artifact.id] }]));
            expect(headerItems).toEqual(duplicateItems);
            expect(headerItems[0]).not.toHaveProperty('recipientCensus');
            expect(headerItems[0]).not.toHaveProperty('artifact.body');
            expect(fullItems[0]).toHaveProperty('artifact.body');
            // Each public caller is admitted; owned partitions do not re-admit IDs.
            expect(admittedItems).toBe(3);
        } finally { entry.mockRestore(); partition.mockRestore(); }
    });

    it.each([200, 409, 400])('does not lend pre-write or in-write observations after mutation settlement (%s)', async status => {
        const oldStarted = createDeferred<void>();
        const writeStarted = createDeferred<void>();
        const allowCommit = createDeferred<void>();
        const releaseReads = createDeferred<void>();
        const artifactId = ids[0]!;
        const input = { id: artifactId, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ title: 'Committed' }), body: encodePlainArtifactStoredContent({ body: 'Current' }) };
        const stored = { ...input, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        let committed = false;
        let reads = 0;
        const request: ServerFetch = async path => {
            if (path === '/v1/artifacts') {
                writeStarted.resolve();
                await allowCommit.promise;
                committed = true;
                return Response.json(status === 200 ? stored : { error: status === 409 ? 'conflict' : 'ack_unavailable' }, { status });
            }
            if (path !== '/v1/artifacts/read') throw new Error(`Unexpected Artifact route: ${path}`);
            const observed = committed;
            reads++;
            if (!observed) { oldStarted.resolve(); await releaseReads.promise; }
            return observed ? Response.json({ items: [{ artifactId, ok: true, artifact: stored, recipientCensus: null }] }) : missing([artifactId]);
        };
        const credentials = { token: 'same-authority' };
        // A distinct captured authority on the same Home has its own pending
        // partition. Mutation invalidation must not depend on descriptor identity.
        const readCredentials = { ...credentials, secret: 'other-captured-material' };
        const readTransport = capturedRead(request, readCredentials);
        const writeTransport = createCapturedServerReadTransport({ serverId: 'artifact-read-test',
            profile: { serverUrl: 'https://artifact-read.test' }, credentials });
        const old = fetchArtifactReadBatch(readCredentials, [artifactId], { readTransport });
        let during: ReturnType<typeof fetchArtifactReadBatch> | undefined;
        let write: Promise<unknown> | undefined;
        try {
            await oldStarted.promise;
            write = createArtifact(credentials, input, { request, readTransport: writeTransport, serverId: 'artifact-read-test' }).catch(error => error);
            await writeStarted.promise;
            during = fetchArtifactReadBatch(readCredentials, [artifactId], { readTransport });
            await vi.waitFor(() => expect(reads).toBe(2));
            allowCommit.resolve();
            await write;
            await expect(fetchArtifactReadBatch(readCredentials, [artifactId], { readTransport })).resolves.toMatchObject([{ ok: true, artifact: stored }]);
            expect(reads).toBe(3);
        } finally {
            allowCommit.resolve(); releaseReads.resolve();
            await Promise.allSettled([old, during, write]);
        }
    });

    it('does not infer neutral transport authority from an opaque request callback identity', async () => {
        const release = createDeferred<void>();
        let attempts = 0;
        const request: ServerFetch = async () => {
            attempts++;
            await release.promise;
            return missing([ids[0]!]);
        };
        const first = fetchArtifactReadBatch({ token: 'opaque-authority' }, [ids[0]!], { request });
        const sibling = fetchArtifactReadBatch({ token: 'opaque-authority' }, [ids[0]!], { request });
        release.resolve();
        await Promise.all([first, sibling]);
        expect(attempts).toBe(2);
    });

    it('runs on native signals without AbortSignal.throwIfAborted', async () => {
        const original = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'throwIfAborted')!;
        Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', { ...original, value: undefined });
        try {
            await expect(fetchArtifactReadBatch({ token: 'native-authority' }, [ids[0]!], {
                signal: new AbortController().signal, readTransport: capturedRead(async () => missing([ids[0]!]), { token: 'native-authority' }),
            })).resolves.toMatchObject([{ artifactId: ids[0], ok: false }]);
        } finally { Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', original); }
    });

    it('gathers overlapping demanded ids once and preserves each caller order without retaining settled results', async () => {
        const issued: string[][] = [];
        const release = createDeferred<void>();
        const request: ServerFetch = async (_path, init) => {
            const input = JSON.parse(String(init?.body)) as { artifactIds: string[] };
            issued.push(input.artifactIds);
            await release.promise;
            return missing(input.artifactIds);
        };
        const readTransport = capturedRead(request);
        const preparing = prepareArtifactReadBatch({ token: 'same-authority' }, { readTransport });
        const first = fetchArtifactReadBatch({ token: 'same-authority' }, ids.slice(0, 2), { readTransport });
        const second = (async () => {
            try {
                for (let depth = 0; depth < 64; depth += 1) await Promise.resolve();
                return await preparing.read(ids.slice(1));
            } finally { preparing.release(); }
        })();
        release.resolve();
        const results = await Promise.all([first, second]);
        expect(results.map(items => items.map(item => item.artifactId))).toEqual([ids.slice(0, 2), ids.slice(1)]);
        expect(issued.flat().filter(id => id === ids[1])).toHaveLength(1);
        expect(issued).toEqual([ids]);
        await fetchArtifactReadBatch({ token: 'same-authority' }, [ids[1]!], { readTransport });
        expect(issued).toEqual([ids, [ids[1]!]]);
    });

    it('keeps a surviving borrower when the first borrower cancels', async () => {
        const started = createDeferred<AbortSignal>();
        const release = createDeferred<void>();
        let attempts = 0;
        const request: ServerFetch = async (_path, init) => {
            attempts++;
            started.resolve(init?.signal as AbortSignal);
            await release.promise;
            init?.signal?.throwIfAborted();
            return missing([ids[0]!]);
        };
        const readTransport = capturedRead(request);
        const firstController = new AbortController();
        const first = fetchArtifactReadBatch({ token: 'same-authority' }, [ids[0]!], { readTransport, signal: firstController.signal });
        const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
        const second = fetchArtifactReadBatch({ token: 'same-authority' }, [ids[0]!], { readTransport });
        const sharedSignal = await started.promise;
        firstController.abort();
        const survivingReadWasAborted = sharedSignal.aborted;
        release.resolve();
        await firstRejected;
        await expect(second).resolves.toMatchObject([{ artifactId: ids[0], ok: false }]);
        expect(survivingReadWasAborted).toBe(false);
        expect(attempts).toBe(1);
    });

    it('joins ids already issued while sending only the newly demanded remainder', async () => {
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        const issued: string[][] = [];
        const request: ServerFetch = async (_path, init) => {
            const input = JSON.parse(String(init?.body)) as { artifactIds: string[] };
            issued.push(input.artifactIds);
            started.resolve();
            await release.promise;
            return missing(input.artifactIds);
        };
        const readTransport = capturedRead(request);
        const first = fetchArtifactReadBatch({ token: 'same-authority' }, ids.slice(0, 2), { readTransport });
        await started.promise;
        const second = fetchArtifactReadBatch({ token: 'same-authority' }, ids.slice(1), { readTransport });
        release.resolve();
        await Promise.all([first, second]);
        expect(issued).toEqual([ids.slice(0, 2), [ids[2]!]]);
    });

    it('does not merge different credential authorities and releases shared failures for recovery', async () => {
        const release = createDeferred<void>();
        const tokens: unknown[] = [];
        let fail = true;
        const request: ServerFetch = async (_path, init) => {
            tokens.push(new Headers(init?.headers).get('Authorization'));
            await release.promise;
            return fail ? Response.json({ error: 'unavailable' }, { status: 503 }) : missing([ids[0]!]);
        };
        const one = capturedRead(request, { token: 'one' });
        const two = capturedRead(request, { token: 'two' });
        const first = fetchArtifactReadBatch({ token: 'one' }, [ids[0]!], { readTransport: one });
        const sibling = fetchArtifactReadBatch({ token: 'one' }, [ids[0]!], { readTransport: one });
        const otherAuthority = fetchArtifactReadBatch({ token: 'two' }, [ids[0]!], { readTransport: two });
        release.resolve();
        const results = await Promise.allSettled([first, sibling, otherAuthority]);
        expect(results.every(result => result.status === 'rejected')).toBe(true);
        expect(tokens.sort()).toEqual(['Bearer one', 'Bearer two']);
        fail = false;
        await expect(fetchArtifactReadBatch({ token: 'one' }, [ids[0]!], { readTransport: one }))
            .resolves.toMatchObject([{ artifactId: ids[0], ok: false }]);
        expect(tokens).toHaveLength(3);
    });

    it('isolates exact fresh witnesses and different credential key material', async () => {
        const release = createDeferred<void>();
        let attempts = 0;
        const request: ServerFetch = async () => {
            attempts++;
            await release.promise;
            return missing([ids[0]!]);
        };
        const one = capturedRead(request, { token: 'same-token', secret: 'one' });
        const two = capturedRead(request, { token: 'same-token', secret: 'two' });
        const ordinary = fetchArtifactReadBatch({ token: 'same-token', secret: 'one' }, [ids[0]!], { readTransport: one });
        const otherKeys = fetchArtifactReadBatch({ token: 'same-token', secret: 'two' }, [ids[0]!], { readTransport: two });
        const fresh = fetchArtifactReadBatch({ token: 'same-token', secret: 'one' }, [ids[0]!], { readTransport: one, fresh: true });
        release.resolve();
        await Promise.all([ordinary, otherKeys, fresh]);
        expect(attempts).toBe(3);
    });

    it('aborts a physical read after its final borrower leaves and permits a new demand', async () => {
        const started = createDeferred<AbortSignal>();
        const release = createDeferred<void>();
        let attempts = 0;
        const request: ServerFetch = async (_path, init) => {
            attempts++;
            if (attempts === 1) {
                started.resolve(init?.signal as AbortSignal);
                await release.promise;
            }
            init?.signal?.throwIfAborted();
            return missing([ids[0]!]);
        };
        const readTransport = capturedRead(request);
        const controller = new AbortController();
        const pending = fetchArtifactReadBatch({ token: 'same-authority' }, [ids[0]!], { readTransport, signal: controller.signal });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        const sharedSignal = await started.promise;
        try {
            controller.abort();
            await rejected;
            expect(sharedSignal.aborted).toBe(true);
            await expect(fetchArtifactReadBatch({ token: 'same-authority' }, [ids[0]!], { readTransport }))
                .resolves.toMatchObject([{ artifactId: ids[0], ok: false }]);
            expect(attempts).toBe(2);
        } finally { release.resolve(); }
    });
});


describe('requester Artifact HTTP refusal causes', () => {
    it('preserves the stale Source setup refusal without retrying the read', async () => {
        const { fetchArtifact } = await import('./apiArtifacts');
        const response = vi.fn(async () => Response.json({ error: 'project_setup_review_unavailable' }, { status: 409 }));
        await expect(fetchArtifact({ token: 'same-authority' }, 'published-document', {
            projectSourceId: 'source', readTransport: capturedRead(response),
        })).rejects.toMatchObject({ code: 'project_setup_review_unavailable', status: 409, canTryAgain: false });
        expect(response).toHaveBeenCalledTimes(1);
    });

    it.each(['artifact_access_forbidden', 'artifact_data_key_changed'])(
        'keeps the closed 403 code %s for the requester presenter', async code => {
            const { fetchArtifact } = await import('./apiArtifacts');
            const readTransport = capturedRead(async () => Response.json({ error: code }, { status: 403 }));
            await expect(fetchArtifact({ token: 'same-authority' }, 'refused-document', { readTransport, retry: 'none' }))
                .rejects.toMatchObject({ code, status: 403 });
        });

    it('does not turn foreign HTTP prose into a requester cause', async () => {
        const { fetchArtifact } = await import('./apiArtifacts');
        const readTransport = capturedRead(async () => Response.json({ error: 'private upstream diagnostic' }, { status: 403 }));
        await expect(fetchArtifact({ token: 'same-authority' }, 'refused-document', { readTransport, retry: 'none' }))
            .rejects.toMatchObject({ code: 'content_unavailable', message: 'Failed to fetch artifact' });
    });
});
