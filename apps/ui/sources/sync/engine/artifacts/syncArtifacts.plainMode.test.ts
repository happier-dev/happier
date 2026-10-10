import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Artifact, ArtifactCreateRequest, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { ArtifactDataKeyCache } from './syncArtifacts';
import type { ServerFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    decodePlainArtifactStoredContent,
    encodePlainArtifactStoredContent,
} from '@happier-dev/protocol';

const mocks = vi.hoisted(() => ({
    createArtifact: vi.fn(),
    fetchArtifact: vi.fn(),
    fetchArtifacts: vi.fn(),
    fetchAccountEncryptionMode: vi.fn(),
    randomUUID: vi.fn(() => 'artifact-plain-1'),
    updateArtifact: vi.fn(),
}));

// Substitute HTTP responses only; mode admission, list selection and content codecs stay real.
const httpRequest: ServerFetch = async (path, init) => {
    const target = new URL(path, 'https://artifact-mode.test');
    const credentials = { token: new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '') ?? '' };
    try {
        let value: unknown;
        if (target.pathname === '/v1/account/encryption') value = await mocks.fetchAccountEncryptionMode();
        else if (target.pathname === '/v1/artifacts/read') {
            const input = JSON.parse(String(init?.body)) as { artifactIds: string[] };
            value = { items: await Promise.all(input.artifactIds.map(async artifactId => ({ artifactId, ok: true,
                artifact: { ...await mocks.fetchArtifact(credentials, artifactId), publicAudience: 'none' }, recipientCensus: null }))) };
        } else if (target.pathname === '/v1/artifacts') value = init?.method === 'POST'
            ? await mocks.createArtifact(credentials, JSON.parse(String(init.body))) : await mocks.fetchArtifacts(credentials);
        else {
            const artifactId = decodeURIComponent(target.pathname.slice('/v1/artifacts/'.length));
            value = init?.method === 'POST' ? await mocks.updateArtifact(credentials, artifactId, JSON.parse(String(init.body)))
                : await mocks.fetchArtifact(credentials, artifactId);
        }
        return Response.json(value);
    } catch (error) {
        if (error instanceof HappyError && error.status) return Response.json({ error: error.message }, { status: error.status });
        throw error;
    }
};

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: mocks.randomUUID,
}));

import {
    applySocketArtifactUpdate,
    createArtifactWithHeaderViaApi,
    decryptArtifactListItem,
    decryptArtifactWithBody,
    decryptSocketNewArtifactUpdate,
    fetchAndApplyArtifactsList,
    fetchArtifactWithBodyFromApi,
    updateArtifactWithHeaderViaApi,
} from './syncArtifacts';

function buildPlainArtifact(): Artifact {
    return {
        ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        id: 'artifact-plain-1',
        header: encodePlainArtifactStoredContent({
            v: 1,
            kind: 'approval_request.v1',
            title: 'Approve export',
        }),
        headerVersion: 1,
        body: encodePlainArtifactStoredContent({ body: '{"v":1}' }),
        bodyVersion: 1,
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        seq: 1,
        createdAt: 10,
        updatedAt: 20,
    };
}

describe('syncArtifacts plaintext account storage', () => {
    beforeEach(() => {
        mocks.createArtifact.mockReset();
        mocks.fetchArtifact.mockReset();
        mocks.fetchArtifacts.mockReset();
        mocks.fetchAccountEncryptionMode.mockReset();
        mocks.randomUUID.mockClear();
        mocks.updateArtifact.mockReset();
        mocks.fetchAccountEncryptionMode.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    });

    it('creates an artifact without account encryption material using canonical plain envelopes', async () => {
        mocks.createArtifact.mockImplementation(async (_credentials, request: ArtifactCreateRequest) => ({
            ...buildPlainArtifact(),
            ...request,
        }));
        const added: DecryptedArtifact[] = [];

        const id = await createArtifactWithHeaderViaApi({
            request: httpRequest,
            credentials: { token: 'token-only' },
            header: {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve export',
            },
            body: '{"v":1}',
            encryption: null,
            artifactDataKeys: new Map(),
            addArtifact: (artifact) => added.push(artifact),
        });

        expect(id).toBe('artifact-plain-1');
        expect(mocks.randomUUID).toHaveBeenCalledTimes(1);
        const request = mocks.createArtifact.mock.calls[0]?.[1] as ArtifactCreateRequest;
        expect(request.dataEncryptionKey).toBe(ARTIFACT_PLAIN_DATA_KEY_MARKER);
        expect(request.header).not.toContain('Approve export');
        expect(request.body).not.toContain('{"v":1}');
        expect(added[0]).toMatchObject({
            id,
            title: 'Approve export',
            body: '{"v":1}',
            storageMode: 'plain',
            isDecrypted: true,
        });
    });


    it('reads plain list and full artifacts without account encryption material', async () => {
        const artifact = buildPlainArtifact();
        const artifactDataKeys: ArtifactDataKeyCache = new Map();

        const list = await decryptArtifactListItem({
            artifact,
            encryption: null,
            artifactDataKeys,
        });
        const full = await decryptArtifactWithBody({
            artifact,
            encryption: null,
            artifactDataKeys,
        });

        expect(list).toMatchObject({
            title: 'Approve export',
            storageMode: 'plain',
            isDecrypted: true,
        });
        expect(full).toMatchObject({
            title: 'Approve export',
            body: '{"v":1}',
            storageMode: 'plain',
            isDecrypted: true,
        });
        expect(artifactDataKeys.size).toBe(0);
    });

    it('hydrates actionable plain approval bodies after publishing headers', async () => {
        const request = {
            v: 1,
            status: 'open',
            createdAtMs: 1,
            updatedAtMs: 1,
            createdBy: { surface: 'system', sessionId: 'session-1' },
            actionId: 'session.list',
            actionArgs: {},
            summary: 'List sessions',
        };
        const full = {
            ...buildPlainArtifact(),
            header: encodePlainArtifactStoredContent({
                v: 1,
                kind: 'approval_request.v1',
                title: request.summary,
                approvalStatus: request.status,
                actionId: request.actionId,
                sessionId: 'session-1',
                sessions: ['session-1'],
            }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }),
        };
        const { body: _body, ...listRow } = full;
        mocks.fetchArtifacts.mockResolvedValueOnce([listRow]);
        mocks.fetchArtifact.mockResolvedValueOnce(full);
        const applyArtifacts = vi.fn();

        await fetchAndApplyArtifactsList({
            request: httpRequest,
            credentials: { token: 'token-only' },
            encryption: null,
            artifactDataKeys: new Map(),
            applyArtifacts,
        });

        expect(applyArtifacts).toHaveBeenCalledWith([
            expect.objectContaining({ id: full.id, body: JSON.stringify(request) }),
        ]);
    });

    it('hydrates Launch Profile document bodies through the existing mode-aware Artifact sync owner', async () => {
        const full = { ...buildPlainArtifact(),
            header: encodePlainArtifactStoredContent({ kind: 'launch-profile.v1', title: 'Shared', name: 'Shared', profileId: 'shared' }),
            body: encodePlainArtifactStoredContent({ body: '{"kind":"launch-profile.v1"}' }),
        };
        const { body: _body, ...listRow } = full;
        mocks.fetchArtifacts.mockResolvedValueOnce([listRow]);
        mocks.fetchArtifact.mockResolvedValueOnce(full);
        const applied: DecryptedArtifact[][] = [];
        await fetchAndApplyArtifactsList({ credentials: { token: 'token-only' }, request: httpRequest, encryption: null,
            artifactDataKeys: new Map(), applyArtifacts: (rows) => applied.push(rows) });
        expect(applied.at(-1)?.[0]).toMatchObject({ id: full.id, isDecrypted: true, body: '{"kind":"launch-profile.v1"}' });
    });

    it('enriches open usage notice headers with exact-read privacy and body before Inbox admission', async () => {
        const notice = createUsageNoticeArtifactFixture({ ownerAccountId: 'owner' });
        const full: Artifact = { ...buildPlainArtifact(), id: notice.id,
            header: encodePlainArtifactStoredContent(notice.header),
            body: encodePlainArtifactStoredContent({ body: notice.body }),
        };
        const { body: _body, ...listRow } = full;
        mocks.fetchArtifacts.mockResolvedValueOnce([listRow]);
        mocks.fetchArtifact.mockResolvedValueOnce(full);
        const applied: DecryptedArtifact[][] = [];

        await fetchAndApplyArtifactsList({ credentials: { token: 'token-only' }, request: httpRequest,
            encryption: null, artifactDataKeys: new Map(), applyArtifacts: rows => applied.push(rows) });

        expect(applied[0]?.[0]).toMatchObject({ id: notice.id, publicAudience: 'unknown' });
        expect(applied.at(-1)?.[0]).toMatchObject({ id: notice.id, publicAudience: 'none', body: notice.body });
    });

    it('surfaces retained malformed plain Artifact reads and socket updates as locked instead of throwing', async () => {
        const artifact = {
            ...buildPlainArtifact(),
            header: Buffer.from(JSON.stringify({ t: 'plain' }), 'utf8').toString('base64'),
        };

        const expectedLockedState = {
            id: artifact.id,
            isDecrypted: false,
            storageMode: 'plain',
            availability: {
                kind: 'locked',
                reason: 'invalid_stored_content',
            },
        };

        await expect(decryptArtifactListItem({
            artifact,
            encryption: null,
            artifactDataKeys: new Map(),
        })).resolves.toMatchObject(expectedLockedState);
        await expect(decryptArtifactWithBody({
            artifact,
            encryption: null,
            artifactDataKeys: new Map(),
        })).resolves.toMatchObject(expectedLockedState);
        await expect(decryptSocketNewArtifactUpdate({
            artifactId: artifact.id,
            dataEncryptionKey: artifact.dataEncryptionKey,
            header: artifact.header,
            headerVersion: artifact.headerVersion,
            body: artifact.body,
            bodyVersion: artifact.bodyVersion,
            seq: artifact.seq,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
            encryption: null,
            artifactDataKeys: new Map(),
        })).resolves.toMatchObject(expectedLockedState);

        const existingArtifact = (await decryptArtifactWithBody({
            artifact: buildPlainArtifact(),
            encryption: null,
            artifactDataKeys: new Map(),
        }))!;
        await expect(applySocketArtifactUpdate({
            existingArtifact,
            createdAt: 30,
            dataEncryptionKey: null,
            header: { version: 2, value: artifact.header },
        })).resolves.toMatchObject({
            ...expectedLockedState,
            headerVersion: 2,
        });
    });

    it('applies plain socket updates without an artifact data key', async () => {
        const existingArtifact: DecryptedArtifact = {
            id: 'artifact-plain-1',
            header: { v: 1, kind: 'approval_request.v1', title: 'Old' },
            title: 'Old',
            body: 'old',
            headerVersion: 1,
            bodyVersion: 1,
            seq: 1,
            createdAt: 10,
            updatedAt: 20,
            isDecrypted: true,
            storageMode: 'plain',
        };

        const updated = await applySocketArtifactUpdate({
            existingArtifact,
            createdAt: 30,
            dataEncryptionKey: null,
            header: {
                version: 2,
                value: encodePlainArtifactStoredContent({
                    v: 1,
                    kind: 'approval_request.v1',
                    title: 'New',
                }),
            },
            body: {
                version: 2,
                value: encodePlainArtifactStoredContent({ body: 'new' }),
            },
        });

        expect(updated).toMatchObject({
            title: 'New',
            body: 'new',
            headerVersion: 2,
            bodyVersion: 2,
            updatedAt: 30,
            storageMode: 'plain',
        });
    });

    it('updates a plain artifact without resolving an account or artifact key', async () => {
        const current = (await decryptArtifactWithBody({
            artifact: buildPlainArtifact(),
            encryption: null,
            artifactDataKeys: new Map(),
        }))!;
        mocks.updateArtifact.mockResolvedValue({
            success: true,
            headerVersion: 2,
            bodyVersion: 2,
        });
        const updated: DecryptedArtifact[] = [];

        await updateArtifactWithHeaderViaApi({
            request: httpRequest,
            credentials: { token: 'token-only' },
            artifactId: current.id,
            header: {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approved',
            },
            body: '{"v":2}',
            encryption: null,
            artifactDataKeys: new Map(),
            getArtifact: () => current,
            updateArtifact: (artifact) => updated.push(artifact),
        });

        expect(mocks.fetchArtifact).not.toHaveBeenCalled();
        const request = mocks.updateArtifact.mock.calls[0]?.[2];
        expect(request).toMatchObject({
            expectedHeaderVersion: 1,
            expectedBodyVersion: 1,
        });
        expect(decodePlainArtifactStoredContent(request.header)).toMatchObject({ title: 'Approved' });
        expect(decodePlainArtifactStoredContent(request.body)).toEqual({ body: '{"v":2}' });
        expect(updated[0]).toMatchObject({
            title: 'Approved',
            body: '{"v":2}',
            storageMode: 'plain',
        });
    });

});

describe('syncArtifacts retained encrypted content', () => {
    beforeEach(() => {
        mocks.fetchArtifact.mockReset();
        mocks.fetchArtifacts.mockReset();
        mocks.updateArtifact.mockReset();
    });

    function buildRetainedEncryptedArtifact(): Artifact {
        return {
            ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
            id: 'artifact-retained-e2ee-1',
            header: 'retained-encrypted-header',
            headerVersion: 3,
            body: 'retained-encrypted-body',
            bodyVersion: 5,
            dataEncryptionKey: 'retained-encrypted-data-key',
            seq: 8,
            createdAt: 10,
            updatedAt: 20,
        };
    }

    it('keeps a retained E2EE row visible with a typed locked state when account material is unavailable', async () => {
        const artifact = buildRetainedEncryptedArtifact();
        const original = structuredClone(artifact);
        const applied: DecryptedArtifact[][] = [];
        mocks.fetchArtifacts.mockResolvedValueOnce([artifact]);

        await fetchAndApplyArtifactsList({
            request: httpRequest,
            credentials: { token: 'token-only' },
            encryption: null,
            artifactDataKeys: new Map(),
            applyArtifacts: (artifacts) => applied.push(artifacts),
        });

        expect(applied).toEqual([[
            expect.objectContaining({
                id: artifact.id,
                isDecrypted: false,
                storageMode: 'e2ee',
                availability: {
                    kind: 'locked',
                    reason: 'encryption_material_unavailable',
                },
                headerVersion: 3,
                bodyVersion: 5,
            }),
        ]]);
        expect(artifact).toEqual(original);
        expect(mocks.updateArtifact).not.toHaveBeenCalled();
    });

    it('distinguishes a retained locked detail from an artifact that was not found', async () => {
        const artifact = buildRetainedEncryptedArtifact();
        mocks.fetchArtifact.mockResolvedValueOnce(artifact);

        const locked = await fetchArtifactWithBodyFromApi({
            request: httpRequest,
            credentials: { token: 'token-only' },
            artifactId: artifact.id,
            encryption: null,
            artifactDataKeys: new Map(),
        });

        expect(locked).toMatchObject({
            id: artifact.id,
            isDecrypted: false,
            availability: {
                kind: 'locked',
                reason: 'encryption_material_unavailable',
            },
        });

        mocks.fetchArtifact.mockRejectedValueOnce(new HappyError('Artifact not found', false, { status: 404 }));
        await expect(fetchArtifactWithBodyFromApi({
            request: httpRequest,
            credentials: { token: 'token-only' },
            artifactId: 'missing-artifact',
            encryption: null,
            artifactDataKeys: new Map(),
        })).resolves.toBeNull();
    });

    it('keeps a retained E2EE socket row visible when account material is unavailable', async () => {
        const artifact = buildRetainedEncryptedArtifact();

        const locked = await decryptSocketNewArtifactUpdate({
            artifactId: artifact.id,
            dataEncryptionKey: artifact.dataEncryptionKey,
            header: artifact.header,
            headerVersion: artifact.headerVersion,
            body: artifact.body,
            bodyVersion: artifact.bodyVersion,
            seq: artifact.seq,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
            encryption: null,
            artifactDataKeys: new Map(),
        });

        expect(locked).toMatchObject({
            id: artifact.id,
            isDecrypted: false,
            storageMode: 'e2ee',
            availability: {
                kind: 'locked',
                reason: 'encryption_material_unavailable',
            },
        });
    });
});
