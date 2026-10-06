import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, createLaunchProfilePublisherV1,
    createActionExecutor, ArtifactActionOutputSchemasV1, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent, withArtifactExcerptV1,
    isApprovalRequiredByActionsSettings, normalizeActionsSettingsV1, type ActionExecutorContext } from '@happier-dev/protocol';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import * as credentialStorage from '@/auth/storage/tokenStorage';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import type { Artifact, ArtifactCreateRequest, ArtifactUpdateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { openArtifactPrivateRevisionMetadata } from '@/sync/domains/artifacts/accountArtifactEnvelope';
import { ARTIFACT_UPLOAD_PATH_V1, decodeArtifactUploadMetadataV1 } from '@happier-dev/transfers';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { createUiArtifactAction } from './artifactActionDeps';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';
import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';

// HTTP, device credential storage and the native theme runtime are substituted boundaries.
const runtimeFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetch(...args) }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { runtimeFetch.mockReset(); vi.restoreAllMocks(); });

describe('scoped Account workflow Artifact operations', () => {
    it.each([
        ['create', 'credential'], ['update', 'credential'], ['create', 'caller'], ['update', 'caller'],
    ] as const)('keeps the %s acknowledgement after %s retirement without publishing stale content', async (operation, retirement) => {
        const previousState = storage.getState();
        const home = await upsertAndActivateServer({ serverUrl: `https://artifact-retired-${operation}.test`, scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        let retire: Parameters<typeof credentialStorage.subscribeHomeCredentialMutations>[0] | undefined;
        // Device credential subscription is the retirement boundary; codecs and Account fencing remain real.
        vi.spyOn(credentialStorage, 'subscribeHomeCredentialMutations').mockImplementation(listener => { retire = listener; return () => {}; });
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const caller = new AbortController();
        const header = { title: 'Acknowledged', kind: 'home-hub-layout.v1', v: 1 };
        const body = 'acknowledged body';
        const before: Artifact = { id: artifactId, ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent({ title: 'Before' }),
            body: encodePlainArtifactStoredContent({ body: 'before' }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        storage.setState({ settingsScope: { serverId: home.id, accountId: 'artifact-account' }, artifacts: {} });
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === `/v1/artifacts/${artifactId}` && init?.method !== 'POST') return json(before);
            if (init?.method === 'POST' && (path === '/v1/artifacts' || path === `/v1/artifacts/${artifactId}`)) {
                if (retirement === 'credential') retire?.({ kind: 'credentials_removed', serverId: home.id, serverUrl: home.serverUrl });
                else caller.abort();
                if (operation === 'create') return json({ ...before, header: encodePlainArtifactStoredContent(header),
                    body: encodePlainArtifactStoredContent({ body }), headerVersion: 2, bodyVersion: 2 });
                return json({ success: true, headerVersion: 2, bodyVersion: 2 });
            }
            throw new Error(`Unexpected route ${path}`);
        });
        const account = await captureLazyActionAccountContext(home.id, caller.signal);
        try {
            if (operation === 'create') await expect(account.createArtifactDocument({ artifactId, header, body }))
                .resolves.toMatchObject({ artifactId, revision: { headerVersion: 2, bodyVersion: 2 }, artifact: { rawHeader: header, body } });
            else await expect(account.updateArtifactDocument({ artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, header, body }))
                .resolves.toMatchObject({ ok: true, revision: { headerVersion: 2, bodyVersion: 2 } });
            expect(account.accountLifetime.isCurrent()).toBe(false);
            expect(storage.getState().artifacts[artifactId]).toBeUndefined();
            await expect(account.fetchArtifact(artifactId)).rejects.toMatchObject(retirement === 'credential'
                ? { code: 'action_account_scope_changed' } : { name: 'AbortError' });
        } finally { account.dispose(); storage.setState(previousState); }
    });

    it('admits a typed binary body through the captured public-link keyholding resource', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://artifact-binary-resource.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const body = { blobId: '11111111-1111-4111-8111-111111111111', mime: 'image/png', sizeBytes: 4, sha256: 'a'.repeat(64) };
        runtimeFetch.mockImplementation(async (url: unknown) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (target.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v1/artifacts/binary-artifact') return json({ id: 'binary-artifact',
                ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent({ title: 'Image', kind: 'published.v1' }), body: encodePlainArtifactStoredContent({ body }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            return json({ error: 'unexpected_route' }, 404);
        });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            expect(await account.readArtifactPublicLinkResource('binary-artifact')).toMatchObject({ body, encryptionMode: 'plain', dataKey: null, access: 'owner' });
        } finally { account.dispose(); }
    });
    it('returns the committed Artifact create acknowledgement without depending on a subsequent read', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://artifact-create-acknowledgement.test', scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: 'https://artifact-create-other-home.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const reads: string[] = [];
        let committed: Artifact | undefined;
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v1/artifacts' && init?.method === 'POST') {
                const write = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                // Exact-id create may acknowledge an incumbent row after a same-id race.
                committed = { ...write, ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
                    header: encodePlainArtifactStoredContent({ title: 'Incumbent' }), body: encodePlainArtifactStoredContent({ body: 'incumbent body' }),
                    provenance: null, provenanceDataEncryptionKey: null,
                    headerVersion: 3, bodyVersion: 4, seq: 4, createdAt: 1, updatedAt: 2 };
                return json(committed);
            }
            reads.push(target.pathname);
            return json({ error: 'read_transport_unavailable' }, 403);
        });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({ artifactAction: createUiArtifactAction(account) })));
            const caller = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
            expect(await execute('artifact.create', { artifactId, header: { title: 'Attempted' }, body: 'attempted body' }, caller))
                .toEqual({ ok: true, result: { artifactId, revision: { headerVersion: 3, bodyVersion: 4 } } });
            expect(committed?.id).toBe(artifactId);
            expect(reads).toEqual([]);
            expect(await account.workflowArtifacts.create({ artifactId, header: {}, body: 'workflow body' })).toBe(artifactId);
            expect(reads).toEqual([]);
        } finally { account.dispose(); }
    });
    it('selects ordinary Artifact lists across structural pages without leaking filters or truncating omitted limits', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://ordinary-artifact-selection.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const row = (id: string, title: string, kind: string, updatedAt: number, createdAt = updatedAt): Artifact => ({
            id, ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
            header: encodePlainArtifactStoredContent({ title, kind }), body: encodePlainArtifactStoredContent({ body: 'retained body' }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt, updatedAt,
        });
        const rows = [...Array.from({ length: 500 }, (_, index) => row(`other-${index}`, 'Other', 'other.v1', 1000 - index)),
            row('zebra', 'Private zebra', 'published.v1', 2, 6000), row('alpha', 'Private alpha', 'published.v1', 1, 5000)];
        const urls: URL[] = [];
        runtimeFetch.mockImplementation(async (url: unknown) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname !== '/v1/artifacts') return json({ error: 'unexpected_route' }, 404);
            urls.push(target);
            const cursor = target.searchParams.get('cursor');
            const after = cursor ? JSON.parse(new TextDecoder().decode(decodeBase64(cursor, 'base64url'))) as { id: string } : null;
            const start = after ? rows.findIndex(item => item.id === after.id) + 1 : 0;
            const limit = Number(target.searchParams.get('limit') ?? 100);
            if (limit > 500) return json({ error: 'invalid_limit' }, 400);
            return json(rows.slice(start, start + limit));
        });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({ artifactAction: createUiArtifactAction(account) })));
            const caller = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
            const selected = await execute('artifact.list', { search: 'PRIVATE', kind: 'published.v1', sort: 'title_asc', limit: 1 }, caller);
            expect(selected).toMatchObject({ ok: true, result: { items: [{ artifactId: 'alpha' }], nextCursor: expect.any(String) } });
            if (!selected.ok) throw new Error(selected.error);
            const first = ArtifactActionOutputSchemasV1['artifact.list'].parse(selected.result);
            expect(first.items.map(item => item.artifactId)).toEqual(['alpha']);
            const next = await execute('artifact.list', { search: 'PRIVATE', kind: 'published.v1', sort: 'title_asc', limit: 1, cursor: first.nextCursor }, caller);
            expect(next).toMatchObject({ ok: true, result: { items: [{ artifactId: 'zebra' }] } });
            if (!next.ok) throw new Error(next.error);
            expect(ArtifactActionOutputSchemasV1['artifact.list'].parse(next.result).nextCursor).toBeUndefined();
            const created = await execute('artifact.list', { search: 'PRIVATE', kind: 'published.v1', sort: 'created_desc' }, caller);
            if (!created.ok) throw new Error(created.error);
            expect(ArtifactActionOutputSchemasV1['artifact.list'].parse(created.result).items.map(item => item.artifactId)).toEqual(['zebra', 'alpha']);
            const complete = await execute('artifact.list', {}, caller);
            if (!complete.ok) throw new Error(complete.error);
            expect(ArtifactActionOutputSchemasV1['artifact.list'].parse(complete.result).items).toHaveLength(rows.length);
            const structural = await account.workflowArtifacts.list({ limit: 500, includeBody: true });
            expect(structural.items).toHaveLength(500);
            expect(structural.items[0]).toMatchObject({ body: 'retained body' });
            expect(structural.nextCursor).toBeDefined();
            for (const url of urls) {
                expect(url.searchParams.has('search') || url.searchParams.has('kind') || url.searchParams.has('sort')).toBe(false);
            }
        } finally { account.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('runs ordinary %s Artifact CRUD through the front door on the captured Home', async mode => {
        const home = await upsertAndActivateServer({ serverUrl: `https://ordinary-artifacts-${mode}.test`, scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: `https://ordinary-focused-${mode}.test`, scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(mode === 'plain' ? { token }
            : { token, secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') });
        const artifactId = '11111111-1111-4111-8111-111111111111';
        let stored: Artifact | undefined;
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/account/encryption') return json({ mode, updatedAt: 0 });
            if (target.pathname === ARTIFACT_UPLOAD_PATH_V1 && init?.method === 'POST') {
                if (!(init.body instanceof ArrayBuffer)) throw new Error('Expected canonical binary upload');
                const frame = new Uint8Array(init.body);
                const metadata = decodeArtifactUploadMetadataV1(frame.subarray(0, frame.indexOf(10)));
                if (metadata.kind !== 'create') throw new Error('Expected publication create');
                stored = { id: metadata.artifactId, header: metadata.header, body: metadata.body, dataEncryptionKey: metadata.dataEncryptionKey,
                    provenance: metadata.provenance, provenanceDataEncryptionKey: metadata.provenanceDataEncryptionKey,
                    ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: mode,
                    seq: 1, headerVersion: 1, bodyVersion: 1, createdAt: 1, updatedAt: 1 };
                return json(stored);
            }
            if (target.pathname === '/v1/artifacts' && init?.method === 'POST') {
                const write = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                stored = { ...write, ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: mode,
                    seq: 1, headerVersion: 1, bodyVersion: 1, createdAt: 1, updatedAt: 1 };
                return json(stored);
            }
            if (target.pathname === '/v1/artifacts') return json(stored ? [stored] : []);
            if (stored && target.pathname.endsWith('/recipients')) return json({ artifactId: stored.id,
                ownerAccountId: stored.ownerAccountId, access: stored.access, encryptionMode: mode, dataEncryptionKey: stored.dataEncryptionKey,
                callerDataEncryptionKey: stored.dataEncryptionKey, provenanceDataEncryptionKey: stored.provenanceDataEncryptionKey,
                callerProvenanceDataEncryptionKey: stored.provenanceDataEncryptionKey, recipients: [] });
            if (stored && target.pathname === `/v1/artifacts/${stored.id}/html-preview`) return json({ url: `https://artifact-isolated.test/a/${stored.id}` });
            if (stored && init?.method === 'DELETE' && target.pathname === `/v1/artifacts/${stored.id}/revision/2/2`) {
                stored = undefined; return new Response(null, { status: 204 });
            }
            if (!stored || (target.pathname !== `/v1/artifacts/${stored.id}` && target.pathname !== `/v1/artifacts/${stored.id}/content/binary`)) return json({ error: 'not_found' }, 404);
            if (init?.method === 'DELETE') { stored = undefined; return new Response(null, { status: 204 }); }
            if (init?.method !== 'POST') return json(stored);
            const write = JSON.parse(String(init.body)) as ArtifactUpdateRequest;
            if (write.expectedHeaderVersion !== stored.headerVersion || write.expectedBodyVersion !== stored.bodyVersion) return json({ success: false, error: 'version-mismatch' });
            stored = { ...stored, ...write, header: write.header!, body: write.body!, headerVersion: 2, bodyVersion: 2 };
            return json({ success: true, headerVersion: 2, bodyVersion: 2 });
        });
        const context = await captureLazyActionAccountContext(home.id);
        try {
            const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({ artifactAction: createUiArtifactAction(context) })));
            const caller = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
            expect(await execute('artifact.create', { artifactId, header: { title: 'First' }, body: 'initial' }, caller))
                .toEqual({ ok: true, result: { artifactId, revision: { headerVersion: 1, bodyVersion: 1 } } });
            const openedEnvelope = async () => {
                const row = stored!;
                if (mode === 'plain') return decodePlainArtifactStoredContent(row.body!);
                const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
                const encryption = await createEncryptionFromAuthCredentials((await TokenStorage.getCredentialsForServerUrl(home.serverUrl))!);
                const key = await encryption!.decryptEncryptionKey(row.dataEncryptionKey);
                return new ArtifactEncryption(key!).decryptBody(row.body!);
            };
            const openedProvenance = async () => {
                const row = stored!;
                const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
                const encryption = mode === 'e2ee' ? await createEncryptionFromAuthCredentials((await TokenStorage.getCredentialsForServerUrl(home.serverUrl))!) : null;
                const dataKey = row.provenanceDataEncryptionKey ? await encryption!.decryptEncryptionKey(row.provenanceDataEncryptionKey) : null;
                return openArtifactPrivateRevisionMetadata({ mode, artifactId: row.id, bodyVersion: row.bodyVersion!, provenance: row.provenance, dataKey });
            };
            const openedPublicHeader = async () => {
                const row = stored!;
                if (mode === 'plain') return decodePlainArtifactStoredContent(row.header);
                const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
                const encryption = await createEncryptionFromAuthCredentials((await TokenStorage.getCredentialsForServerUrl(home.serverUrl))!);
                const key = await encryption!.decryptEncryptionKey(row.dataEncryptionKey);
                return new ArtifactEncryption(key!).decryptHeaderRaw(row.header);
            };
            expect(await openedEnvelope()).toEqual({ body: 'initial' });
            expect(await openedProvenance()).toEqual({ savedBy: { kind: 'person', accountId: 'artifact-account' } });
            expect(stored?.dataEncryptionKey === ARTIFACT_PLAIN_DATA_KEY_MARKER).toBe(mode === 'plain');
            expect(await execute('artifact.get', { artifactId }, caller)).toMatchObject({ ok: true, result: { artifact: { artifactId, body: 'initial', header: { title: 'First' } } } });
            expect(await execute('artifact.list', {}, caller)).toMatchObject({ ok: true, result: { items: [{ artifactId, header: { title: 'First' } }] } });
            expect(await execute('artifact.update', { artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, header: { title: 'Second' }, body: 'changed' }, caller))
                .toEqual({ ok: true, result: { artifactId, revision: { headerVersion: 2, bodyVersion: 2 } } });
            expect(await openedEnvelope()).toEqual({ body: 'changed' });
            expect(await openedProvenance()).toEqual({ savedBy: { kind: 'person', accountId: 'artifact-account' } });
            expect(await execute('artifact.update', { artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, header: {}, body: 'stale' }, caller))
                .toMatchObject({ ok: false, errorCode: 'version_mismatch' });
            expect(await execute('artifact.delete', { artifactId, expectedRevision: { headerVersion: 2, bodyVersion: 2 } }, caller))
                .toEqual({ ok: true, result: { artifactId, deleted: true } });
            expect(await execute('artifact.get', { artifactId }, caller)).toEqual({ ok: true, result: { artifact: null } });
            expect(await execute('artifact.publish_from_file', { path: 'result.txt' }, caller))
                .toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
            expect(await execute('artifact.publish_from_file', { path: 'result.txt' }, { ...caller, defaultSessionId: 'publication-session' }))
                .toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
            storage.setState({ sessions: { 'publication-session': createSessionFixture({ id: 'publication-session', serverId: home.id,
                metadata: { ...createSessionFixture().metadata!, path: '/workspace', machineId: 'publication-machine' } }) },
                machineListByServerId: { [home.id]: [createMachineFixture({ id: 'publication-machine' })] } });
            const download = vi.fn(async (request: { signal?: AbortSignal | null; destination: { writeBytes: (bytes: Uint8Array) => Promise<void>; close: () => Promise<void> } }) => {
                await request.destination.writeBytes(new TextEncoder().encode('<h1>Published</h1>'));
                await request.destination.close();
                return { ok: true as const, name: 'result.html', sizeBytes: 18 };
            });
            // This port is the remote workspace byte-transport boundary; Session lookup and publication remain real.
            // Session provenance retains the Agent approval floor. Use the real persisted waiver policy for this admitted source test.
            const publicationSettings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'artifact.publish_from_file': ['agent'] } });
            const publication = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({ artifactAction: createUiArtifactAction(context, {
                workspaceDownload: download,
            }), isActionApprovalRequired: (actionId, actionContext, input) => isApprovalRequiredByActionsSettings(
                actionId, publicationSettings, actionContext, undefined, undefined, input,
            ) })));
            const publicationCaller = { kind: 'session', sessionId: 'publication-session', starterDepth: 0, turnDepth: 0 } satisfies NonNullable<ActionExecutorContext['actionCaller']>;
            const sessionCaller = { ...caller, serverId: home.id, runtimeAccountId: 'artifact-account',
                defaultSessionId: 'publication-session', actionCaller: publicationCaller };
            expect(await execute('artifact.publish_from_file', { path: 'result.html' }, sessionCaller))
                .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
            expect(stored).toBeUndefined();
            expect(download).not.toHaveBeenCalled();
            expect(await publication('artifact.publish_from_file', { path: 'result.html' }, { ...sessionCaller, runtimeAccountId: 'other-account' }))
                .toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
            expect(await publication('artifact.publish_from_file', { path: 'result.html' }, { ...sessionCaller, serverId: 'other-home' }))
                .toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
            expect(download).not.toHaveBeenCalled();
            expect(await publication('artifact.publish_from_file', { path: 'result.html' }, sessionCaller))
                .toMatchObject({ ok: true, result: { revision: { headerVersion: 1, bodyVersion: 1 }, previewUrl: expect.stringContaining('#d=') } });
            expect(await openedProvenance()).toEqual({ savedBy: { kind: 'agent', accountId: 'artifact-account', sessionId: 'publication-session' }, source: {
                sessionId: 'publication-session', machineId: 'publication-machine', path: 'result.html', sha: expect.any(String),
            } });
            expect(await openedPublicHeader()).not.toHaveProperty('source');
            expect(await openedEnvelope()).toEqual({ body: '<h1>Published</h1>' });
            expect(download).toHaveBeenCalledWith(expect.objectContaining({ serverId: home.id, machineId: 'publication-machine', rootPath: '/workspace', confinedToWorkingDirectory: true }));
            const published = stored;
            const publishedRead = await publication('artifact.get', { artifactId: published!.id }, caller);
            expect(publishedRead).toMatchObject({ ok: true, result: { artifact: { body: '<h1>Published</h1>', header: { kind: 'html' }, provenance: {
                source: { sessionId: 'publication-session', machineId: 'publication-machine', path: 'result.html', sha: expect.any(String) } } }, previewUrl: expect.stringContaining('#d=') } });
            const calls = download.mock.calls.length;
            expect(await publication('artifact.publish_from_file', { path: '../private.txt' }, sessionCaller))
                .toMatchObject({ ok: false, errorCode: 'artifact_source_forbidden' });
            expect(download).toHaveBeenCalledTimes(calls);
            const cancellation = new AbortController();
            download.mockImplementationOnce(async (request) => {
                await request.destination.writeBytes(new TextEncoder().encode('<h1>Cancelled</h1>'));
                cancellation.abort();
                expect(request.signal?.aborted).toBe(true);
                return { ok: true, name: 'result.html', sizeBytes: 18 };
            });
            expect(await publication('artifact.publish_from_file', { path: 'result.html' }, { ...sessionCaller, signal: cancellation.signal }))
                .toMatchObject({ ok: false });
            expect(stored).toBe(published);
            download.mockImplementationOnce(async () => {
                const session = storage.getState().sessions['publication-session'];
                storage.setState({ sessions: { 'publication-session': { ...session, metadata: { ...session.metadata!, path: '/different-workspace' } } } });
                return { ok: true, name: 'result.html', sizeBytes: 18 };
            });
            expect(await publication('artifact.publish_from_file', { path: 'result.html' }, sessionCaller))
                .toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
            expect(stored).toBe(published);
            download.mockImplementationOnce(async request => {
                await request.destination.writeBytes(new Uint8Array([0, 255, 128, 42]));
                await request.destination.close();
                return { ok: true, name: 'result.bin', sizeBytes: 4 };
            });
            expect(await publication('artifact.publish_from_file', { path: 'result.bin', mime: 'application/octet-stream' }, sessionCaller))
                .toMatchObject({ ok: true });
            expect(await openedPublicHeader()).not.toHaveProperty('source');
            expect(await openedEnvelope()).toMatchObject({ body: { mime: 'application/octet-stream', sizeBytes: 4 } });
            expect(await openedEnvelope()).not.toHaveProperty('provenance');
            const binarySource = (await openedProvenance())!.source;
            expect(binarySource).toMatchObject({ sessionId: 'publication-session', machineId: 'publication-machine', path: 'result.bin', sha: expect.any(String) });
            expect(await publication('artifact.update', { artifactId: stored!.id, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
                header: { title: 'Rewritten', source: { sessionId: 'forged' } }, body: 'replacement' }, caller)).toMatchObject({ ok: true });
            expect(await openedPublicHeader()).not.toHaveProperty('source');
            expect(await openedEnvelope()).toEqual({ body: 'replacement' });
            expect(await openedProvenance()).toEqual({ savedBy: { kind: 'person', accountId: 'artifact-account' }, source: binarySource });
        } finally { context.dispose(); }
    });
    it('publishes from raw exact-Home Settings through the existing Settings CAS and Artifact stores', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://profile-publisher.test', scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: 'https://profile-publisher-focused.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'profile-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        let raw: Record<string, unknown> = { profiles: [{ v: 2, id: 'deploy', name: 'Deploy', createdAt: 1, updatedAt: 1 }],
            secretBindingsByProfileId: { deploy: { TOKEN: 'happier:shared-secret:v1:deploy' } }, futureSibling: { retained: true } };
        let version = 4;
        let stored: Artifact | undefined;
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (target.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v2/account/settings') {
                if (init?.method === 'POST') {
                    const write = JSON.parse(String(init.body)) as { expectedVersion: number; content: { t: string; v: Record<string, unknown> } };
                    expect(write.expectedVersion).toBe(version);
                    expect(write.content.t).toBe('plain');
                    raw = write.content.v;
                    return json({ success: true, version: ++version });
                }
                return json({ content: { t: 'plain', v: raw }, version });
            }
            if (target.pathname === '/v1/artifacts' && init?.method === 'POST') {
                const write = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                stored = { ...write, ownerAccountId: 'profile-account', access: 'owner', encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
                return json(stored);
            }
            if (target.pathname === '/v1/artifacts') return json(stored ? [stored] : []);
            if (stored && target.pathname === `/v1/artifacts/${stored.id}`) return json(stored);
            return json({ error: 'unexpected' }, 404);
        });
        const context = await captureLazyActionAccountContext(home.id);
        try {
            const result = await createLaunchProfilePublisherV1({ readSettings: context.readRawSettings,
                mutateSettings: context.mutateRawSettings, artifactStore: { read: (artifactId, signal) => context.workflowArtifacts.read(artifactId, { signal }),
                    create: async ({ header, body }) => ({ artifactId: await context.createArtifact({ ...header, title: 'Deploy' }, body) }) },
            }).publish({ profileId: 'deploy' });
            expect(raw.profiles).toEqual([result]);
            expect(raw.secretBindingsByProfileId).toEqual({});
            expect(raw.futureSibling).toEqual({ retained: true });
            expect(stored?.dataEncryptionKey).toBe(ARTIFACT_PLAIN_DATA_KEY_MARKER);
            expect(await context.readLaunchProfiles(raw.profiles)).toMatchObject([{ id: 'deploy', artifactId: result.artifactId,
                secretBindings: { TOKEN: 'happier:shared-secret:v1:deploy' } }]);
        } finally { context.dispose(); }
    });

    it('rejects captured-scope retirement before dispatch and after an asynchronous read', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://artifact-retirement.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        let releaseRead: (() => void) | undefined;
        let readStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => { readStarted = resolve; });
        runtimeFetch.mockImplementation(async (url: unknown) => {
            const target = new URL(String(url));
            if (target.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v1/artifacts/held') {
                readStarted!();
                await new Promise<void>((resolve) => { releaseRead = resolve; });
                return json({ error: 'missing' }, 404);
            }
            return json({});
        });
        const context = await captureLazyActionAccountContext(home.id);
        try {
            const pending = context.workflowArtifacts.read('held');
            const rejected = expect(pending).rejects.toMatchObject({ code: 'action_account_scope_changed' });
            await started;
            expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: 'replacement-account' })).toBe(true);
            releaseRead!();
            await rejected;
            const dispatched = runtimeFetch.mock.calls.length;
            await expect(context.workflowArtifacts.delete('held')).rejects.toMatchObject({ code: 'action_account_scope_changed' });
            expect(runtimeFetch.mock.calls).toHaveLength(dispatched);
        } finally { context.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('reads, pages, creates, CAS-updates and deletes %s content on the captured Home', async (mode) => {
        const home = await upsertAndActivateServer({ serverUrl: `https://workflow-artifacts-${mode}.test`, scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: `https://focused-artifacts-${mode}.test`, scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(mode === 'plain'
            ? { token } : { token, secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') });
        let stored: Artifact | undefined;
        const requests: URL[] = [];
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            requests.push(target);
            expect(target.origin).toBe(home.serverUrl);
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            if (target.pathname === '/v1/account/encryption') return json({ mode, updatedAt: 0 });
            if (target.pathname === '/v1/artifacts' && init?.method === 'POST') {
                const body = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                stored = { ...body, ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: mode, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 9 };
                return json(stored);
            }
            if (target.pathname === '/v1/artifacts') return json(stored ? [stored] : []);
            if (target.pathname.endsWith('/transport-error')) return json({ error: 'denied' }, 403);
            if (target.pathname.endsWith('/locked')) return json({ ...stored, id: 'locked', encryptionMode: 'e2ee', header: 'broken', dataEncryptionKey: 'unopenable' });
            if (stored && target.pathname.endsWith('/recipients')) return json({ artifactId: stored.id,
                ownerAccountId: stored.ownerAccountId, access: stored.access, encryptionMode: stored.encryptionMode,
                dataEncryptionKey: stored.dataEncryptionKey, callerDataEncryptionKey: stored.dataEncryptionKey,
                provenanceDataEncryptionKey: stored.provenanceDataEncryptionKey,
                callerProvenanceDataEncryptionKey: stored.provenanceDataEncryptionKey, recipients: [] });
            if (!stored || target.pathname !== `/v1/artifacts/${stored.id}`) return json({ error: 'missing' }, 404);
            if (init?.method === 'DELETE') { stored = undefined; return new Response(null, { status: 204 }); }
            if (init?.method !== 'POST') return json(stored);
            const update = JSON.parse(String(init.body)) as ArtifactUpdateRequest;
            if (update.expectedHeaderVersion !== stored.headerVersion || update.expectedBodyVersion !== stored.bodyVersion) return json({ success: false, error: 'version-mismatch' });
            stored = { ...stored, header: update.header!, body: update.body!, provenance: update.provenance,
                ...(update.provenanceDataEncryptionKey === undefined ? {} : { provenanceDataEncryptionKey: update.provenanceDataEncryptionKey }),
                headerVersion: 2, bodyVersion: 2 };
            return json({ success: true, headerVersion: 2, bodyVersion: 2 });
        });
        const context = await captureLazyActionAccountContext(home.id);
        try {
            const workflowBody = (text: string) => JSON.stringify({ kind: 'workflow-definition.v1', definition: { version: 1,
                defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
                blocks: [{ kind: 'step', id: 'review', document: { text, references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
            } });
            const body = workflowBody('Review');
            const artifactId = '11111111-1111-4111-8111-111111111111';
            const header = { kind: 'workflow-definition.v1', definitionId: artifactId, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Workflow' } };
            const port = context.workflowArtifacts;
            expect(await port.read(artifactId)).toBeNull();
            await port.create({ artifactId, header, body });
            expect(stored?.id).toBe(artifactId);
            expect(stored?.dataEncryptionKey === ARTIFACT_PLAIN_DATA_KEY_MARKER).toBe(mode === 'plain');
            const encryption = (await context.resolveAccountEncryption()).encryption;
            const key = encryption ? await encryption.decryptEncryptionKey(stored!.dataEncryptionKey) : null;
            const storedHeader = mode === 'plain' ? decodePlainArtifactStoredContent(stored!.header)
                : await new ArtifactEncryption(key!).decryptHeaderRaw(stored!.header);
            const expectedHeader = withArtifactExcerptV1({ ...header, previewSteps: ['Review'] }, body);
            expect(storedHeader).toEqual(expectedHeader);
            expect(await port.read(artifactId)).toEqual({ artifactId, ownerAccountId: 'artifact-account', access: 'owner', header: expectedHeader, body,
                provenance: { savedBy: { kind: 'person', accountId: 'artifact-account' } }, revision: { headerVersion: 1, bodyVersion: 1 } });
            const page = await port.list({ limit: 1, cursor: 'incoming-cursor' });
            expect(page.items[0]).toMatchObject({ artifactId, ownerAccountId: 'artifact-account', access: 'owner', header: expectedHeader, headerVersion: 1, updatedAt: 9 });
            expect(page.nextCursor).toBe(context.encodeArtifactListCursor(page.items[0]!));
            expect(requests.find((url) => url.searchParams.has('cursor'))?.searchParams.get('cursor')).toBe('incoming-cursor');
            expect(requests.find((url) => url.searchParams.has('limit'))?.searchParams.get('limit')).toBe('1');
            const nextHeader = { ...header, revision: { headerVersion: 2, bodyVersion: 2 } };
            expect(await port.update({ artifactId, expectedRevision: header.revision, header: nextHeader, body })).toEqual({ ok: true, revision: nextHeader.revision });
            expect(await port.update({ artifactId, expectedRevision: header.revision, header: nextHeader, body: workflowBody('Overwrite') })).toMatchObject({ ok: false, errorCode: 'version_mismatch' });
            await expect(port.read('transport-error')).rejects.toMatchObject({ status: 403 });
            await expect(port.read('locked')).rejects.toMatchObject({ code: 'content_unavailable' });
            expect(await port.delete(artifactId)).toEqual({ ok: true });
            expect(await port.read(artifactId)).toBeNull();
        } finally { context.dispose(); }
    });
});
