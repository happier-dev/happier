import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createSessionDraftPrivatePayloadV2,
    SessionDraftMutateResponseV2Schema,
} from '@happier-dev/protocol/drafts/sessionDraftsV2';
import {
    SessionDraftMutateResponseV1Schema,
    SessionDraftReadResponseV1Schema,
} from '@happier-dev/protocol/drafts/sessionDrafts';

const request = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
const address = { kind: 'session', sessionId: 'session-a' } as const;

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('apiSessionDrafts', () => {
    beforeEach(() => request.mockReset());

    it('projects stored plaintext draft content without relaxing the HTTP record envelope', async () => {
        const { createApiSessionDraftsTransport } = await import('./apiSessionDrafts');
        const field = <T>(value: T) => ({ mutationId: '20000000-0000-4000-8000-000000000001', value });
        const payload = createSessionDraftPrivatePayloadV2(address, { v: 1,
            composer: { text: field('Keep me'), mentions: field([]), attachments: field([]) },
            target: { kind: 'session', routing: { recipient: field(null), agentContinuation: field(null), executionRunDelivery: field(null) } },
            extensions: {},
        });
        const record = { address, revision: 1, createdAt: 1, updatedAt: 1,
            content: { t: 'plain', v: { ...payload, retired: true, document: { ...payload.document, retired: true } } } };
        request.mockResolvedValueOnce(jsonResponse({ status: 'present', record }))
            .mockResolvedValueOnce(jsonResponse({ items: [record] }))
            .mockResolvedValueOnce(jsonResponse({ status: 'present', record: { ...record, retired: true } }));
        const transport = createApiSessionDraftsTransport({ request });
        await expect(transport.read(address)).resolves.toEqual({ status: 'present', record: { ...record,
            content: { t: 'plain', v: payload } } });
        await expect(transport.list({})).resolves.toEqual({ items: [{ ...record, content: { t: 'plain', v: payload } }] });
        await expect(transport.read(address)).rejects.toThrow('Invalid session draft response');
    });

    it('posts typed read and mutate requests and validates responses', async () => {
        const { createApiSessionDraftsTransport } = await import('./apiSessionDrafts');
        const readResponse = SessionDraftReadResponseV1Schema.parse({ status: 'absent' });
        const mutateResponse = SessionDraftMutateResponseV1Schema.parse({
            status: 'conflict',
            current: { status: 'absent' },
        });
        request.mockResolvedValueOnce(jsonResponse(readResponse)).mockResolvedValueOnce(jsonResponse(mutateResponse));
        const transport = createApiSessionDraftsTransport({ request });

        await expect(transport.read(address)).resolves.toEqual(readResponse);
        await expect(transport.mutate({ address, expectedRevision: 'absent', content: null })).resolves.toEqual(mutateResponse);

        expect(request).toHaveBeenNthCalledWith(1, '/v2/account/session-drafts/read', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ address }),
            headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }), { recoveryRead: 'unbounded' });
    });

    it('rejects malformed successful responses instead of materializing unvalidated bytes', async () => {
        const { createApiSessionDraftsTransport } = await import('./apiSessionDrafts');
        request.mockResolvedValueOnce(jsonResponse({ status: 'present', record: { revision: 'wrong' } }));

        await expect(createApiSessionDraftsTransport({ request }).read(address)).rejects.toThrow('Invalid session draft response');
    });

    it.each([{ status: 400, retryable: false }, { status: 500, retryable: true }])('preserves HTTP retry eligibility for a $status draft rejection', async ({ status, retryable }) => {
        const { createApiSessionDraftsTransport } = await import('./apiSessionDrafts');
        const { shouldRetryError } = await import('@/sync/runtime/connectivity/transientConnectivityErrors');
        request.mockResolvedValueOnce(jsonResponse({}, status));
        const error = await createApiSessionDraftsTransport({ request }).mutate({ address, expectedRevision: 'absent', content: null }).catch(error => error);
        expect(error).toBeInstanceOf(Error);
        expect(shouldRetryError(error)).toBe(retryable);
    });

    it.each([
        { kind: 'session', sessionId: 'missing-session' },
        { kind: 'run', sessionId: 'missing-session', runId: 'run-a' },
    ] as const)('preserves the typed missing-Session refusal for a $kind draft clear', async (missingAddress) => {
        const { createApiSessionDraftsTransport } = await import('./apiSessionDrafts');
        request.mockResolvedValueOnce(jsonResponse({ error: 'session_unavailable' }, 404));

        await expect(createApiSessionDraftsTransport({ request }).mutate({
            address: missingAddress, expectedRevision: 0, content: null,
        })).rejects.toMatchObject({ name: 'HappyError', code: 'session_unavailable', status: 404, canTryAgain: false });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('gives a failed fetch a typed network outcome without disguising programming errors or cancellation', async () => {
        const { createApiSessionDraftsTransport } = await import('./apiSessionDrafts');
        const transport = createApiSessionDraftsTransport({ request });
        request.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await expect(transport.mutate({ address, expectedRevision: 0, content: null }))
            .rejects.toMatchObject({ name: 'HappyError', code: 'network_error', kind: 'network', canTryAgain: true });

        const programmingError = new TypeError('Cannot read properties of undefined');
        const cancellation = new DOMException('Cancelled', 'AbortError');
        request.mockRejectedValueOnce(programmingError).mockRejectedValueOnce(cancellation);
        await expect(transport.read(address)).rejects.toBe(programmingError);
        await expect(transport.read(address)).rejects.toBe(cancellation);
    });

    it('retains the local PR form when the real draft-delete transport refuses a missing Session', async () => {
        const { createApiSessionDraftsTransport } = await import('./apiSessionDrafts');
        const { createSessionDraftRepository, readSessionScmDraftFromDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { createSessionDraftCipher } = await import('@/sync/encryption/sessionDraftEncryption');
        const values = new Map<string, string>();
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const cipher = createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null,
            getSessionContext: () => ({ mode: 'plain' }), randomBytes: size => new Uint8Array(size) });
        const repository = createSessionDraftRepository({
            storage: { getString: key => values.get(key), getAllKeys: () => [...values.keys()], set: (key, value) => { values.set(key, value); },
                delete: key => { values.delete(key); } },
            scope, syncEnabled: false, cipher,
        });
        repository.writeExistingSessionDraft({ scope, sessionId: address.sessionId,
            patch: { scmPullRequestV1: { title: 'Keep my title', body: 'Keep my description', base: 'main', draft: true } } });
        request.mockResolvedValueOnce(jsonResponse({ error: 'session_unavailable' }, 404));

        await expect(repository.deleteSessionDraftWithScopedRuntime({ scope, address,
            runtime: { transport: createApiSessionDraftsTransport({ request }), cipher },
            isCurrent: () => true,
        })).rejects.toMatchObject({ code: 'session_unavailable' });
        const retained = repository.getSessionDraftSnapshot(scope, address);
        expect(retained?.status).toBe('offline');
        expect(readSessionScmDraftFromDraft(retained?.document).pullRequest)
            .toMatchObject({ title: 'Keep my title', body: 'Keep my description' });
    });
});



describe('successor newSession content epoch', () => {
    beforeEach(() => request.mockReset());
    const newAddress = { kind: 'newSession', draftId: '10000000-0000-4000-8000-000000000001' } as const;

    it('keeps non-representable encrypted newSession content on V2 and retains intent when unavailable', async () => {
        const { createApiSessionDraftsTransport } = await import('./apiSessionDrafts');
        request.mockResolvedValueOnce(jsonResponse({}, 404));
        await expect(createApiSessionDraftsTransport({ request }).mutate({
            address: newAddress, expectedRevision: 'absent', content: { t: 'encrypted', c: 'cipher', v: 2 },
        })).rejects.toMatchObject({ code: 'session_draft_epoch_unavailable' });
        expect(request.mock.calls.map(([path]) => path)).toEqual(['/v2/account/session-drafts/mutate']);
    });

    it('never writes a newSession draft to the predecessor V1 route, and still reads one that was created there', async () => {
        const { createApiSessionDraftsTransport } = await import('./apiSessionDrafts');
        const canonicalContent = {
            t: 'plain' as const,
            v: {
                v: 2 as const,
                address: newAddress,
                document: {
                    v: 2 as const,
                    composer: {
                        text: { mutationId: '20000000-0000-4000-8000-000000000001', value: 'keep me' },
                        mentions: { mutationId: '20000000-0000-4000-8000-000000000002', value: [] },
                        attachments: { mutationId: '20000000-0000-4000-8000-000000000003', value: [] },
                    },
                    target: {
                        kind: 'newSession' as const,
                        authoring: {
                            executionTarget: {
                                mutationId: '20000000-0000-4000-8000-000000000004',
                                value: {
                                    kind: 'machine',
                                    target: { serverId: 'home-a', machineId: 'machine-a' },
                                    selectionOrigin: { kind: 'machine_pool', poolId: '11111111-1111-4111-8111-111111111111' },
                                },
                            },
                            organizationPlacement: {
                                mutationId: '20000000-0000-4000-8000-000000000005',
                                value: { folderId: null, tagIds: ['tag-a'] },
                            },
                            runtimeDescriptorV1: {
                                mutationId: '20000000-0000-4000-8000-000000000006',
                                value: null,
                            },
                        },
                    },
                    extensions: {
                        happier: {
                            retained: { mutationId: '20000000-0000-4000-8000-000000000007', value: { future: true } },
                        },
                    },
                },
            },
        };
        // A 0.2-written row, produced by the released projection rather than
        // hand-written: a losslessly V1-representable document is stored in the
        // exact V1 payload shape a 0.2 client wrote.
        const predecessorPayload = createSessionDraftPrivatePayloadV2(newAddress, {
            v: 1,
            composer: canonicalContent.v.document.composer,
            target: {
                kind: 'newSession',
                authoring: {
                    serverId: { mutationId: '20000000-0000-4000-8000-000000000009', value: 'predecessor-home' },
                    machineId: { mutationId: '20000000-0000-4000-8000-000000000010', value: 'predecessor-machine' },
                },
            },
            extensions: {},
        });
        expect(predecessorPayload.v).toBe(1);
        const predecessorRecord = {
            address: newAddress,
            revision: 4,
            content: { t: 'plain' as const, v: predecessorPayload },
            createdAt: 10,
            updatedAt: 20,
        };

        // 0.3 is a one-way upgrade, so a Home without the V2 draft epoch is not a
        // supported peer: the write settles the local draft as unsupported and
        // never re-posts successor authoring a released V1 reader would reject.
        request.mockResolvedValueOnce(jsonResponse({}, 404));
        const transport = createApiSessionDraftsTransport({ request });
        await expect(transport.mutate({
            address: newAddress,
            expectedRevision: 3,
            content: canonicalContent,
        })).rejects.toMatchObject({ code: 'session_draft_epoch_unavailable' });
        expect(request.mock.calls.map(([path]) => path)).toEqual(['/v2/account/session-drafts/mutate']);

        // The obligation that survives R-COMPAT: a draft a 0.2 client created is
        // still readable. Its closed V1 payload is admitted by the V2 payload
        // union itself, so it needs no bridge and arrives byte-faithful.
        request.mockReset();
        request.mockResolvedValueOnce(jsonResponse({ status: 'present', record: predecessorRecord }))
            .mockResolvedValueOnce(jsonResponse({ items: [predecessorRecord] }));
        await expect(transport.read(newAddress)).resolves.toEqual({ status: 'present', record: predecessorRecord });
        await expect(transport.list({})).resolves.toEqual({ items: [predecessorRecord] });
        // V2 reads admit the closed V1 payload, while avoiding a repeated V1
        // probe when a 0.3-only row occupies the same newSession address.
        expect(request.mock.calls.map(([path]) => path)).toEqual([
            '/v2/account/session-drafts/read',
            '/v2/account/session-drafts/list',
        ]);
    });

    it('uses V2 for reads and retains V1 writes for representable legacy content', async () => {
        const { createApiSessionDraftsTransport } = await import('./apiSessionDrafts');
        request.mockResolvedValueOnce(jsonResponse({ items: [] }))
            .mockResolvedValueOnce(jsonResponse({ status: 'absent' }))
            .mockResolvedValueOnce(jsonResponse({ error: 'session_draft_epoch_unavailable' }, 409))
            .mockResolvedValueOnce(jsonResponse({ status: 'conflict', current: { status: 'absent' } }));
        const transport = createApiSessionDraftsTransport({ request });
        await transport.list({});
        await expect(transport.read({ kind: 'session', sessionId: 'legacy-session' })).resolves.toEqual({ status: 'absent' });
        await transport.mutate({ address: newAddress, expectedRevision: 3, content: { t: 'encrypted', c: 'compatible' } });
        expect(request.mock.calls.map(([path]) => path)).toEqual([
            '/v2/account/session-drafts/list', '/v2/account/session-drafts/read',
            '/v1/account/session-drafts/mutate', '/v2/account/session-drafts/mutate',
        ]);
        expect(request.mock.calls[2]?.[1]?.body).toEqual(request.mock.calls[3]?.[1]?.body);
    });

    it('falls back to V1 reads only when the V2 endpoint is unavailable', async () => {
        const { createApiSessionDraftsTransport } = await import('./apiSessionDrafts');
        request.mockResolvedValueOnce(jsonResponse({}, 404)).mockResolvedValueOnce(jsonResponse({ status: 'absent' }));

        await expect(createApiSessionDraftsTransport({ request }).read(address)).resolves.toEqual({ status: 'absent' });
        expect(request.mock.calls.map(([path]) => path)).toEqual([
            '/v2/account/session-drafts/read',
            '/v1/account/session-drafts/read',
        ]);
    });

    it('reads newSession drafts through V2 so a V2-only row does not repeatedly probe V1', async () => {
        const { createApiSessionDraftsTransport } = await import('./apiSessionDrafts');
        const response = { status: 'absent' as const };
        request.mockResolvedValueOnce(jsonResponse(response)).mockResolvedValueOnce(jsonResponse(response));
        const transport = createApiSessionDraftsTransport({ request });

        await expect(transport.read(newAddress)).resolves.toEqual(response);
        await expect(transport.read(newAddress)).resolves.toEqual(response);
        expect(request.mock.calls.map(([path]) => path)).toEqual([
            '/v2/account/session-drafts/read',
            '/v2/account/session-drafts/read',
        ]);
    });

    it('reports an unavailable V2 list without requesting the predecessor list', async () => {
        const { createApiSessionDraftsTransport } = await import('./apiSessionDrafts');
        request.mockResolvedValueOnce(jsonResponse({}, 404)).mockResolvedValueOnce(jsonResponse({ items: [] }));
        await expect(createApiSessionDraftsTransport({ request }).list({}))
            .rejects.toMatchObject({ code: 'session_draft_epoch_unavailable' });
        expect(request.mock.calls.map(([path]) => path)).toEqual(['/v2/account/session-drafts/list']);
    });
});
