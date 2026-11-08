import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerAccountRequestAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { createSessionFixture, createDeferred } from '@/dev/testkit';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { MemorySearchResultV1Schema } from '@happier-dev/protocol/memory/memorySearch';
import { findSessionListLookupSession } from '@/sync/domains/session/listing/sessionListLookupState';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { sealEncryptedDataKeyEnvelopeV1} from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import {
    sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { encodeBase64 } from '@/encryption/base64';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readComposerSessionSuggestionDisplay } from '@/sync/domains/input/suggestionSession';
import { buildSessionFromListRenderable } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

const {
    authorizeMemorySessionRange,
    authorizeMemorySearchResult,
    hydrateMemorySearchSessionTargets,
    readMemorySearchSessionForServerScope,
} = await import('./hydrateMemorySearchSessionTargets');
const { storage } = await import('@/sync/domains/state/storage');
const initialState = storage.getState();
afterEach(() => storage.setState(initialState, true));

const TARGETS = [
    { sessionKey: 'account-a:server-a:local-1', serverId: 'server-a', accountId: 'account-a', sessionId: 'local-1' },
    { sessionKey: 'account-a:server-a:outside-1', serverId: 'server-a', accountId: 'account-a', sessionId: 'outside-1' },
] as const;

function createRequestAuthority(
    request: ServerAccountRequestAuthority['request'],
): ServerAccountRequestAuthority {
    return {
        scope: { serverId: 'server-a', accountId: 'account-a' },
        context: {
            scope: 'scoped',
            timeoutMs: 5_000,
            targetServerId: 'server-a',
            targetServerUrl: 'https://server-a.example.test',
            targetAccountId: 'account-a',
            token: 'token-a',
            credentials: { token: 'token-a' },
            encryption: null,
        },
        request,
        release: async () => undefined,
    };
}

/** Reuse the canonical HTTP fixture; Session decoding, authorization and publication stay real. */
function sessionReads(options: Readonly<{
    absent?: readonly string[];
    ceiling?: number;
    beforeRead?: (sessionId: string, signal: AbortSignal | null | undefined) => Promise<void> | void;
}> = {}) {
    const sessions = Object.fromEntries(['local-1', 'outside-1', 'readable', 'revoked', 'shared-session', 'a', 'b']
        .filter(id => !options.absent?.includes(id))
        .map(id => [id, createSessionFixture({ id, serverId: 'server-a', seq: options.ceiling ?? 2 })]));
    const http = createSessionMetadataHttpBoundary(() => sessions);
    const requests: Array<{ path: string; signal: AbortSignal | null | undefined }> = [];
    const authority = createRequestAuthority(async (path, init) => {
        requests.push({ path, signal: init?.signal });
        if (path === '/v1/account/encryption/currentness') {
            return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        }
        const sessionId = /^\/v2\/sessions\/([^/?]+)/.exec(path)?.[1];
        if (sessionId) await options.beforeRead?.(sessionId, init?.signal);
        const response = http.handle(`https://server-a.example.test${path}`, init);
        if (!response) throw new Error(`Unexpected Session HTTP request: ${path}`);
        return response;
    });
    return { authority, requests, readSessionForServerScope: readMemorySearchSessionForServerScope };
}

describe('hydrateMemorySearchSessionTargets', () => {
    it.each([0, 1] as const)('authorizes indexed encrypted message hits through the exact Account reader and real metadata codec (layout %s)', async (layout) => {
        const { Encryption } = await import('@/sync/encryption/encryption');
        const secret = new Uint8Array(32).fill(7);
        const sessionKey = new Uint8Array(32).fill(8);
        const writer = await Encryption.create(secret);
        await writer.initializeSessions(new Map([['local-1', sessionKey]]));
        const seed = createSessionFixture({ id: 'local-1', serverId: 'server-a', seq: 22 });
        const owner = createSessionOwnerMetadataV1({ metadata: seed.metadata });
        if (!owner.ok) throw new Error('Expected canonical fixture owner metadata');
        const dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
            dataKey: sessionKey, recipientPublicKey: writer.contentDataKey,
            randomBytes: length => new Uint8Array(length).fill(3),
        }), 'base64');
        const record = SessionCurrentProjectionRecordV1Schema.parse({
            id: seed.id, seq: seed.seq, createdAt: seed.createdAt, updatedAt: seed.updatedAt,
            active: seed.active, activeAt: seed.activeAt, archivedAt: null,
            encryptionMode: 'e2ee', metadataLayoutVersion: layout,
            metadata: await writer.getSessionEncryption(seed.id)!.encryptRaw(layout === 1
                ? projectSessionSharedMetadataV1({ metadata: seed.metadata }) : seed.metadata),
            ...(layout === 1 ? { ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
                material: { type: 'legacy', secret }, ownerMetadata: owner.ownerMetadata,
                randomBytes: length => new Uint8Array(length).fill(4),
            }) } : {}),
            metadataVersion: seed.metadataVersion, dataEncryptionKey,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: seed.access!.capabilities },
            responsibleAccountId: null, responsibleAccount: null, share: null,
            agentState: null, agentStateVersion: 0, pendingCount: 0, pendingVersion: 0,
        });
        const reader = await Encryption.create(secret);
        const authority: ServerAccountRequestAuthority = {
            ...createRequestAuthority(async path => {
                if (path === '/v1/account/encryption/currentness') return Response.json(AccountEncryptionCurrentnessResponseSchema.parse({
                    mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-current', contentKeyFingerprint: 'content-current',
                    updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' },
                }));
                if (path.startsWith('/v2/sessions/local-1')) return Response.json({ session: record });
                throw new Error(`Unexpected encrypted Session request: ${path}`);
            }),
            context: { scope: 'scoped', timeoutMs: 5_000, targetServerId: 'server-a',
                targetServerUrl: 'https://server-a.example.test', targetAccountId: 'account-a', token: 'token-a',
                credentials: { token: 'token-a', secret: encodeBase64(secret, 'base64') }, encryption: reader },
        };
        const hit = { sessionId: seed.id, seqFrom: 3, seqTo: 22,
            createdAtFromMs: 10, createdAtToMs: 20, summary: 'Amber orchard', score: 0.5 };
        const result = await authorizeMemorySearchResult({
            result: MemorySearchResultV1Schema.parse({ v: 1, ok: true, hits: [hit] }),
            serverId: 'server-a', accountId: 'account-a', authority,
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            readSessionForServerScope: readMemorySearchSessionForServerScope, concurrencyLimit: 2,
        });
        expect(MemorySearchResultV1Schema.parse(result)).toEqual({ v: 1, ok: true, hits: [hit] });
        expect(findSessionListLookupSession(storage.getState(), { serverId: 'server-a', sessionId: seed.id })?.session)
            .toMatchObject({ seq: 22, metadata: seed.metadata, metadataLayoutVersion: layout, encryptedContentAvailability: 'ready' });
    });
    it('keeps daemon-authorized document hits outside Session visibility hydration', async () => {
        const document = {
            type: 'artifact' as const, ref: { kind: 'doc' as const, serverId: 'server-a', artifactId: 'doc-1' },
            revision: { headerVersion: 1, bodyVersion: 1 }, location: 'document' as const,
            summary: 'Current instruction', score: 0.8,
        };
        const reads = sessionReads();
        const result = await authorizeMemorySearchResult({
            result: { v: 1, ok: true, hits: [document] }, serverId: 'server-a', accountId: 'account-a',
            authority: reads.authority,
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            readSessionForServerScope: reads.readSessionForServerScope, concurrencyLimit: 2,
        });
        expect(result).toEqual({ v: 1, ok: true, hits: [document] });
        expect(reads.requests).toEqual([]);
        expect(MemorySearchResultV1Schema.parse(result)).toEqual(result);
    });
    it('rejects a memory window for a revoked Session before daemon access', async () => {
        const reads = sessionReads({ absent: ['local-1'] });
        await expect(authorizeMemorySessionRange({
            target: TARGETS[0],
            seqFrom: 1,
            seqTo: 2,
            authority: reads.authority,
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            readSessionForServerScope: reads.readSessionForServerScope,
        })).resolves.toBe(false);
    });

    it('rejects a memory window whose range crosses the projected transcript ceiling', async () => {
        const reads = sessionReads({ ceiling: 5 });
        await expect(authorizeMemorySessionRange({
            target: TARGETS[0],
            seqFrom: 4,
            seqTo: 6,
            authority: reads.authority,
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            readSessionForServerScope: reads.readSessionForServerScope,
        })).resolves.toBe(false);
    });

    it('filters every retained summary for a revoked Session from a public Action result', async () => {
        const reads = sessionReads({ absent: ['revoked'] });
        const hit = (sessionId: string) => ({
            sessionId,
            seqFrom: 1,
            seqTo: 2,
            createdAtFromMs: 10,
            createdAtToMs: 20,
            summary: `retained ${sessionId}`,
            score: 0.8,
        });
        const result = await authorizeMemorySearchResult({
            result: { v: 1, ok: true, hits: [hit('readable'), hit('revoked')] },
            serverId: 'server-a',
            accountId: 'account-a',
            authority: reads.authority,
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            readSessionForServerScope: reads.readSessionForServerScope,
            concurrencyLimit: 2,
        });

        expect(result).toEqual({ v: 1, ok: true, hits: [hit('readable')] });
        expect(MemorySearchResultV1Schema.parse(result)).toEqual(result);
    });

    it('suppresses only retained hit ranges above the currently projected transcript ceiling', async () => {
        const reads = sessionReads({ ceiling: 4 });
        const hit = (seqFrom: number, seqTo: number) => ({
            sessionId: 'shared-session',
            seqFrom,
            seqTo,
            createdAtFromMs: seqFrom,
            createdAtToMs: seqTo,
            summary: `retained ${seqFrom}-${seqTo}`,
            score: 0.8,
        });
        const visible = hit(1, 4);
        const aboveCeiling = hit(5, 6);
        const result = await authorizeMemorySearchResult({
            result: { v: 1, ok: true, hits: [visible, aboveCeiling] },
            serverId: 'server-a',
            accountId: 'account-a',
            authority: reads.authority,
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            readSessionForServerScope: reads.readSessionForServerScope,
            concurrencyLimit: 2,
        });

        expect(result).toEqual({ v: 1, ok: true, hits: [visible] });
    });

    it('hydrates hits outside the local projection through the explicit-server reader', async () => {
        const reads = sessionReads();

        const authorized = await hydrateMemorySearchSessionTargets({
            targets: TARGETS,
            authority: reads.authority,
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            concurrencyLimit: 2,
            readSessionForServerScope: reads.readSessionForServerScope,
        });

        expect(authorized.map((target) => target.sessionId)).toEqual(['local-1', 'outside-1']);
        expect(findSessionListLookupSession(storage.getState(), { serverId: 'server-a', sessionId: 'outside-1' })).toMatchObject({
            serverId: 'server-a', session: { id: 'outside-1', seq: 2 },
        });
    });

    it('suppresses a stale row when the explicit-server read finds no authorization or existence', async () => {
        const reads = sessionReads({ absent: ['local-1', 'outside-1'] });
        const authorized = await hydrateMemorySearchSessionTargets({
            targets: TARGETS,
            authority: reads.authority,
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            concurrencyLimit: 2,
            readSessionForServerScope: reads.readSessionForServerScope,
        });

        expect(authorized).toEqual([]);
    });

    it('suppresses a stale row when the explicit-server read fails', async () => {
        const reads = sessionReads({ beforeRead: () => { throw new Error('offline'); } });
        const authorized = await hydrateMemorySearchSessionTargets({
            targets: TARGETS,
            authority: reads.authority,
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            concurrencyLimit: 2,
            readSessionForServerScope: reads.readSessionForServerScope,
        });

        expect(authorized).toEqual([]);
    });

    it('stops hydrating once the caller cancels', async () => {
        const controller = new AbortController();
        const reads = sessionReads({ beforeRead: () => { controller.abort(); } });

        const authorized = await hydrateMemorySearchSessionTargets({
            targets: [
                { sessionKey: 'account-a:server-a:a', serverId: 'server-a', accountId: 'account-a', sessionId: 'a' },
                { sessionKey: 'account-a:server-a:b', serverId: 'server-a', accountId: 'account-a', sessionId: 'b' },
            ],
            authority: reads.authority,
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            concurrencyLimit: 1,
            readSessionForServerScope: reads.readSessionForServerScope,
            signal: controller.signal,
        });

        expect(authorized).toEqual([]);
        expect(reads.requests.filter(request => request.path.startsWith('/v2/sessions/')).map(request => request.path))
            .toEqual([expect.stringContaining('/v2/sessions/a')]);
    });

    it('aborts reads and suppresses publication when the exact Account lifetime retires', async () => {
        const retirement: { current: (() => void) | null } = { current: null };
        let current = true;
        const observedSignal: { current: AbortSignal | null } = { current: null };
        const readFinished = createDeferred<void>();
        const reads = sessionReads({ beforeRead: async (_id, signal) => {
            observedSignal.current = signal ?? null;
            await readFinished.promise;
        } });
        const pending = hydrateMemorySearchSessionTargets({
            targets: [TARGETS[0]],
            authority: reads.authority,
            accountLifetime: {
                isCurrent: () => current,
                onRetire: (callback) => {
                    retirement.current = callback;
                    return { dispose: () => undefined };
                },
            },
            concurrencyLimit: 2,
            readSessionForServerScope: reads.readSessionForServerScope,
        });
        await vi.waitFor(() => expect(observedSignal.current).not.toBeNull());

        current = false;
        retirement.current?.();
        expect(observedSignal.current?.aborted).toBe(true);
        readFinished.resolve();

        await expect(pending).resolves.toEqual([]);
    });

    it('decodes the exact Account response and publishes its ceiling through the canonical Session reader', async () => {
        const reads = sessionReads({ ceiling: 1 });
        const controller = new AbortController();

        await expect(readMemorySearchSessionForServerScope({
            target: TARGETS[0],
            authority: reads.authority,
            signal: controller.signal,
        })).resolves.toEqual({ ok: true, visibleThroughSeq: 1 });

        expect(reads.requests).toContainEqual({ path: expect.stringContaining('/v2/sessions/local-1'), signal: controller.signal });
        expect(findSessionListLookupSession(storage.getState(), { serverId: 'server-a', sessionId: 'local-1' })?.session.seq).toBe(1);
    });

    it('keeps a first-prompt Session title while a Memory hit refreshes its metadata', async () => {
        const reads = sessionReads();
        const target = TARGETS[0];
        const title = 'DOCS-JOURNEY3D smoke: review the bakery plan';
        const read = () => readMemorySearchSessionForServerScope({ target, authority: reads.authority, signal: new AbortController().signal });
        expect(await read()).toMatchObject({ ok: true });
        const current = findSessionListLookupSession(storage.getState(), target)!.session;
        const row = buildSessionListRenderableFromSession(buildSessionFromListRenderable(current, { serverId: target.serverId }), current, [{
            kind: 'user-text', id: 'first-prompt', seq: 1, localId: null, createdAt: 1, text: title,
        }]);
        storage.getState().applyServerScopedSessionListRows(target.serverId, [row], { source: 'rowOnly', mode: 'append' });
        expect(readComposerSessionSuggestionDisplay(target)?.title).toBe(title);
        expect(await read()).toMatchObject({ ok: true });
        expect(readComposerSessionSuggestionDisplay(target)?.title).toBe(title);
    });

    it('fails closed before reading when the target Account differs from captured authority', async () => {
        const controller = new AbortController();
        const reads = sessionReads();

        await expect(readMemorySearchSessionForServerScope({
            target: { ...TARGETS[0], accountId: 'account-b' },
            authority: reads.authority,
            signal: controller.signal,
        })).resolves.toEqual({ ok: false, errorCode: 'account_scope_mismatch' });
        expect(reads.requests).toEqual([]);
    });

    it('uses bounded concurrency while preserving provider target order', async () => {
        let active = 0;
        let maximumActive = 0;
        const releases: Array<() => void> = [];
        const reads = sessionReads({ beforeRead: async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await new Promise<void>(resolve => releases.push(resolve));
            active -= 1;
        } });
        const pending = hydrateMemorySearchSessionTargets({
            targets: TARGETS,
            authority: reads.authority,
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            concurrencyLimit: 2,
            readSessionForServerScope: reads.readSessionForServerScope,
        });
        await vi.waitFor(() => expect(maximumActive).toBe(2));
        releases.reverse().forEach((release) => release());

        await expect(pending).resolves.toEqual(TARGETS);
    });
});
