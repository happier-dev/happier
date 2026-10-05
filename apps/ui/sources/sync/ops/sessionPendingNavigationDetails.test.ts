import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials, HomeCredentialMutationEvent } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { encodeBase64 } from '@/encryption/base64';
import {
    createAccountScopedCryptoMaterialSnapshotV1,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    createPlainSessionOwnerMetadataEnvelopeV1,
    projectSessionAccessCapabilitiesV1,
    projectSessionSharedMetadataV1,
    sealSessionOwnerMetadataEnvelopeV1,
    SessionOwnerMetadataV1Schema,
} from '@happier-dev/protocol';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import { readPendingNavigationDetails } from './sessionPendingNavigationDetails';

const boundary = vi.hoisted(() => ({
    fetch: vi.fn(),
    credentials: vi.fn(),
    credentialObservers: new Set<(event: HomeCredentialMutationEvent) => void>(),
}));
// Credentials and HTTP are genuine device/network boundaries. Hydration, decryption,
// normalization, the reducer and request reconciliation remain real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return {
        ...actual,
        TokenStorage: { ...actual.TokenStorage, getCredentialsForServerUrl: (...args: unknown[]) => boundary.credentials(...args) },
        subscribeHomeCredentialMutations: (observer: (event: HomeCredentialMutationEvent) => void) => {
            boundary.credentialObservers.add(observer);
            return () => boundary.credentialObservers.delete(observer);
        },
    };
});
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => boundary.fetch(...args) }));
vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const { createPartialServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return createPartialServerProfilesModuleMock(importOriginal, { profiles: [
        { id: 'home-a', serverUrl: 'https://home-a.example.test' },
        { id: 'home-b', serverUrl: 'https://home-b.example.test' },
    ], overrides: { getActiveServerSnapshot: () => ({ serverId: 'home-a', serverUrl: 'https://home-a.example.test', generation: 1 }) } });
});
const address = { serverId: 'home-b', sessionId: 'never-opened' };
function credentials(account = 'account-b'): AuthCredentials {
    return { token: `e30.${btoa(JSON.stringify({ sub: account }))}.signature` };
}
function sessionBody(active = true, agentState: unknown = null) {
    return { session: { id: address.sessionId, createdAt: 1, updatedAt: 10, seq: 5,
        active, activeAt: 10, encryptionMode: 'plain', dataEncryptionKey: null,
        metadataLayoutVersion: 0, metadataVersion: 1, metadata: JSON.stringify({ name: 'Unopened' }),
        agentStateVersion: 1, agentState: agentState === null ? null : JSON.stringify(agentState), share: null,
    } };
}
function toolRow(id: string, seq: number, tool = 'AskUserQuestion') {
    return { id: `row-${id}`, seq, localId: null, createdAt: seq * 100, updatedAt: seq * 100,
        content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: {
            type: 'tool-call', callId: id, name: tool, input: { permissionId: id, status: 'pending', questions: [{ question: id }] },
        } } } },
    };
}
function installNetwork(options: { active?: boolean; agentState?: unknown; retireDuringPage?: boolean } = {}) {
    boundary.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
        expect(url.startsWith('https://home-b.example.test/')).toBe(true);
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${credentials().token}`);
        if (url.endsWith('/v1/auth/ping')) return Response.json({ ok: true });
        if (url.includes('/v1/account/encryption/currentness')) return Response.json({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
        if (url.includes('/v2/sessions/')) return Response.json(sessionBody(options.active, options.agentState));
        if (url.includes('/messages')) {
            if (options.retireDuringPage) for (const observer of boundary.credentialObservers) observer({ serverId: 'home-b', serverUrl: 'https://home-b.example.test', kind: 'credentials_removed' });
            const older = new URL(url).searchParams.has('beforeSeq');
            return Response.json({ messages: older ? [toolRow('old-question', 1)] : [toolRow('new-question', 5)],
                hasMore: !older, nextBeforeSeq: older ? null : 5 });
        }
        throw new Error(`Unexpected HTTP path ${new URL(url).pathname}`);
    });
}

function pendingSource(
    ids: readonly string[] = [address.sessionId, 'newer-session'],
    overrides: Parameters<typeof createSessionFixture>[0] = {},
): ActivityAttentionSource {
    const summaries = ids.map(id => createSessionFixture({
        id, serverId: address.serverId, active: true, pendingUserActionRequestCount: 1,
        agentState: { requests: { 'summary-request': { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 1 } } },
        ...overrides,
    }));
    return { isDataReady: true, activeServerId: 'home-a', sessionsById: {},
        audienceScopes: new Map([['home-b', { serverId: 'home-b', accountId: 'account-b' }]]),
        sessionListRowsByServerId: { 'home-b': Object.fromEntries(summaries.map(session => [session.id, buildSessionListRenderableFromSession(session)])) },
        ordinarySessionListMembershipByServerId: { 'home-b': summaries.map(session => session.id) },
        sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {},
    };
}
function installSecondSession() {
    const firstSessionNetwork = boundary.fetch.getMockImplementation()!;
    boundary.fetch.mockImplementation(async (url: string, ...args: unknown[]) => {
        if (url.includes('/v2/sessions/newer-session')) return Response.json({ session: { ...sessionBody().session, id: 'newer-session' } });
        if (url.includes('/sessions/newer-session/messages')) return Response.json({ messages: [toolRow('second-question', 3)], hasMore: false, nextBeforeSeq: null });
        return firstSessionNetwork(url, ...args);
    });
}

describe('exact-Home pending navigation details', () => {
    const initialState = storage.getState();
    let credentialObserverCount = 0;
    beforeEach(() => {
        credentialObserverCount = boundary.credentialObservers.size;
        boundary.credentials.mockResolvedValue(credentials());
        installNetwork();
    });
    afterEach(() => {
        storage.setState(initialState, true);
        boundary.fetch.mockReset();
        boundary.credentials.mockReset();
        expect(boundary.credentialObservers.size).toBe(credentialObserverCount);
    });
    it('selects state-owned requests in a long session without fetching transcript pages', async () => {
        installNetwork({ agentState: { requests: {
            oldest: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 1 },
            newest: { tool: 'Bash', kind: 'permission', arguments: {}, createdAt: 20_000 },
        } } });
        const network = boundary.fetch.getMockImplementation()!;
        boundary.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.includes('/v2/sessions/')) {
                const response = await network(url, init);
                const body = await response.json();
                return Response.json({ session: { ...body.session, seq: 20_000 } });
            }
            if (url.includes('/messages')) {
                return Response.json({ messages: Array.from({ length: 20_000 }, (_, index) => ({
                    id: `text-${index}`, seq: index + 1, localId: null, createdAt: index + 1, updatedAt: index + 1,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'history' } } },
                })), hasMore: false, nextBeforeSeq: null });
            }
            return network(url, init);
        });
        const started = performance.now();
        const result = await readPendingNavigationDetails(address);
        expect(boundary.fetch.mock.calls.some(([url]) => String(url).includes('/messages'))).toBe(false);
        expect(result).toMatchObject({ kind: 'available', requests: [
            expect.objectContaining({ id: 'oldest' }), expect.objectContaining({ id: 'newest' }),
        ] });
        console.info(`Next state hydration (20,000-message session fixture): ${(performance.now() - started).toFixed(2)}ms; transcript pages=0`);
    });
    it('passes invocation cancellation to the in-flight exact-Home snapshot request', async () => {
        const controller = new AbortController();
        const network = boundary.fetch.getMockImplementation()!;
        boundary.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
            if (!url.includes('/v2/sessions/')) return network(url, init);
            expect(init?.signal).toBeDefined();
            controller.abort();
            expect(init?.signal?.aborted).toBe(true);
            throw new DOMException('Cancelled', 'AbortError');
        });
        expect(await readPendingNavigationDetails(address, undefined, { signal: controller.signal }))
            .toEqual({ kind: 'unavailable', reason: 'cancelled' });
    });
    it('hydrates transcript location only for the selected native request, stopping at its matching page', async () => {
        const { nextPendingRequest } = await import('@/activity/source/nextPendingRequest');
        const { navigateToPendingRequest } = await import('@/activity/source/navigateToPendingRequest');
        installNetwork({ agentState: { requests: {
            'new-question': { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 500 },
        } } });
        const source = pendingSource([address.sessionId]);
        const selected = await nextPendingRequest({ source, nowMs: 1_000 });
        expect(selected.kind).toBe('target');
        if (selected.kind !== 'target') return;
        expect(boundary.fetch.mock.calls.filter(([url]) => String(url).includes('/messages'))).toHaveLength(0);
        const routes: string[] = [];
        expect(await navigateToPendingRequest({ target: selected, details: selected.details, source, nowMs: 1_000,
            openRoute: route => routes.push(route) })).toEqual({ status: 'opened' });
        expect(routes).toEqual(['/session/never-opened?jumpSeq=5&serverId=home-b']);
        expect(boundary.fetch.mock.calls.filter(([url]) => String(url).includes('/messages'))).toHaveLength(1);
    });
    it('hydrates a never-opened session and finds the oldest transcript-only request beyond the first page', async () => {
        expect(storage.getState().sessions[address.sessionId]).toBeUndefined();
        const result = await readPendingNavigationDetails(address);
        expect(result).toMatchObject({ kind: 'available' });
        if (result.kind !== 'available') return;
        expect(result.session.serverId).toBe('home-b');
        expect(result.requests.map(request => request.id).sort()).toEqual(['new-question', 'old-question']);
        expect(result.requests.find(request => request.id === 'old-question')?.createdAt).toBe(100);
        expect(storage.getState().sessions[address.sessionId]).toBeUndefined();
    });
    it('excludes completed echoes using fresh session state and never borrows a same-ID active Home transcript', async () => {
        storage.getState().applySessions([createSessionFixture({ id: address.sessionId, serverId: 'home-a', active: true,
            agentState: { requests: { 'wrong-home': { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 1 } } } })]);
        installNetwork({ agentState: { requests: {}, completedRequests: {
            'old-question': { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 100, completedAt: 200, status: 'approved' },
        } } });
        const result = await readPendingNavigationDetails(address);
        expect(result.kind).toBe('available');
        if (result.kind !== 'available') return;
        expect(result.requests.map(request => request.id)).toEqual(['new-question']);
        expect(storage.getState().sessions[address.sessionId]?.serverId).toBe('home-a');
    });
    it('fails closed if target Home credentials change while a page is in flight', async () => {
        installNetwork({ retireDuringPage: true });
        expect(await readPendingNavigationDetails(address)).toEqual({ kind: 'unavailable', reason: 'scope_changed' });
    });
    it('rejects a stale candidate Account before reading a session from replacement credentials', async () => {
        boundary.credentials.mockResolvedValue(credentials('replacement-account'));
        const result = await readPendingNavigationDetails(address, { serverId: 'home-b', accountId: 'account-b' });
        expect(result.kind).toBe('unavailable');
        expect(boundary.fetch).not.toHaveBeenCalled();
    });
    it('excludes ordinary permissions from an inactive session', async () => {
        installNetwork({ active: false, agentState: { requests: {
            'inactive-permission': { tool: 'Bash', kind: 'permission', arguments: { command: 'pwd' }, createdAt: 1 },
        } } });
        const result = await readPendingNavigationDetails(address);
        expect(result.kind).toBe('available');
        if (result.kind !== 'available') return;
        expect(result.requests).toEqual([]);
    });
    it('decrypts never-opened E2EE request identities through the real scoped encryption owner', async () => {
        const { Encryption } = await import('@/sync/encryption/encryption');
        const secret = new Uint8Array(32).fill(7);
        const encryption = await Encryption.create(secret);
        await encryption.initializeSessions(new Map([[address.sessionId, null]]));
        const sessionEncryption = encryption.getSessionEncryption(address.sessionId)!;
        const plainRow = toolRow('encrypted-question', 1);
        const encryptedRow = { ...plainRow, content: { t: 'encrypted', c: await sessionEncryption.encryptRaw(plainRow.content.v) } };
        const body = sessionBody();
        const encryptedBody = { session: { ...body.session, encryptionMode: 'e2ee',
            metadata: await sessionEncryption.encryptRaw({ name: 'Unopened encrypted session' }),
        } };
        boundary.credentials.mockResolvedValue({ token: credentials().token, secret: encodeBase64(secret, 'base64url') });
        boundary.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
            expect(url.startsWith('https://home-b.example.test/')).toBe(true);
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${credentials().token}`);
            if (url.endsWith('/v1/auth/ping')) return Response.json({ ok: true });
            if (url.includes('/v2/sessions/')) return Response.json(encryptedBody);
            if (url.includes('/messages')) return Response.json({ messages: [encryptedRow], hasMore: false, nextBeforeSeq: null });
            throw new Error(`Unexpected HTTP path ${new URL(url).pathname}`);
        });
        const result = await readPendingNavigationDetails(address);
        expect(result.kind).toBe('available');
        if (result.kind !== 'available') return;
        expect(result.requests).toEqual([expect.objectContaining({ id: 'encrypted-question', createdAt: 100 })]);
        expect(storage.getState().sessions[address.sessionId]).toBeUndefined();
    });
    it.each(['plain', 'e2ee'] as const)('selects a cold layout-1 %s request as soon as the missing identity is recovered before transcript exhaustion', async (mode) => {
        const { nextPendingRequest } = await import('@/activity/source/nextPendingRequest');
        const sharedMetadata = projectSessionSharedMetadataV1({ metadata: {
            summary: { text: 'Cold layout-1 session', updatedAt: 10 },
        } });
        const ownerMetadata = SessionOwnerMetadataV1Schema.parse({ v: 1,
            workspace: { path: '/private/layout1-worktree', host: 'owner-host' },
        });
        const agentState = { requests: {
            'new-question': { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 500 },
        } };
        const secret = new Uint8Array(32).fill(17);
        const material = { type: 'legacy' as const, secret };
        const cryptoSnapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material });
        const { Encryption } = await import('@/sync/encryption/encryption');
        const encryption = mode === 'e2ee' ? await Encryption.create(secret) : null;
        const dataKey = new Uint8Array(32).fill(23);
        if (encryption) await encryption.initializeSessions(new Map([[address.sessionId, dataKey]]));
        const sessionEncryption = encryption?.getSessionEncryption(address.sessionId);
        const rows = await Promise.all([toolRow('new-question', 5), toolRow('old-question', 3),
            ...[2, 1].map(seq => ({ ...toolRow(`history-${seq}`, seq),
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Older history' } } },
            }))].map(async row => ({
            ...row,
            content: sessionEncryption ? { t: 'encrypted', c: await sessionEncryption.encryptRaw(row.content.v) } : row.content,
        })));
        const snapshot = { session: { ...sessionBody().session,
            encryptionMode: mode,
            metadataLayoutVersion: 1,
            metadata: sessionEncryption ? await sessionEncryption.encryptRaw(sharedMetadata) : JSON.stringify(sharedMetadata),
            ownerMetadata: mode === 'plain' ? createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata)
                : sealSessionOwnerMetadataEnvelopeV1({ material, ownerMetadata, randomBytes: length => new Uint8Array(length).fill(31) }),
            dataEncryptionKey: encryption ? encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64') : null,
            agentState: sessionEncryption ? await sessionEncryption.encryptRaw(agentState) : JSON.stringify(agentState),
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
                capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
            viewer: {
                readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: 1 },
                relevance: { relevant: true, reasons: ['owned_by_me'] },
                follow: { follows: false, notificationLevel: null },
                notification: { level: 'important', source: 'owner' },
                attention: { needsAttention: true, reasons: ['user_action_required'], primary: 'user_action_required', presentation: 'full' },
            } as const,
            responsibleAccountId: null, responsibleAccount: null,
            // Current Server output: counts and newest observation only, never request identity.
            pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 2, pendingRequestObservedAt: 500,
        } };
        boundary.credentials.mockResolvedValue(mode === 'plain' ? credentials()
            : { token: credentials().token, secret: encodeBase64(secret, 'base64url') });
        const transcriptPages = [
            { messages: [rows[0]], hasMore: true, nextBeforeSeq: 5 },
            { messages: [rows[1]], hasMore: true, nextBeforeSeq: 3 },
            { messages: [rows[2]], hasMore: true, nextBeforeSeq: 2 },
            { messages: [rows[3]], hasMore: false, nextBeforeSeq: null },
        ];
        const pages: string[] = [];
        boundary.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
            expect(url.startsWith('https://home-b.example.test/')).toBe(true);
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${credentials().token}`);
            if (url.endsWith('/v1/auth/ping')) return Response.json({ ok: true });
            if (url.includes('/v1/account/encryption/currentness')) return Response.json({ mode, version: 1,
                signingKeyFingerprint: null,
                contentKeyFingerprint: mode === 'plain' ? null
                    : convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(cryptoSnapshot.contentPublicKeyFingerprint),
                updatedAt: 1 });
            if (url.includes('/v2/sessions/')) return Response.json(snapshot);
            if (url.includes('/messages')) {
                pages.push(new URL(url).pathname + new URL(url).search);
                const beforeSeq = new URL(url).searchParams.get('beforeSeq');
                const pageIndex = beforeSeq === null ? 0
                    : transcriptPages.findIndex(page => String(page.nextBeforeSeq) === beforeSeq) + 1;
                if (pageIndex > 1) throw new Error('Transcript read after all missing pending identities were recovered');
                return Response.json(transcriptPages[pageIndex]);
            }
            throw new Error(`Unexpected HTTP path ${new URL(url).pathname}`);
        });
        const source = pendingSource([address.sessionId], {
            metadataLayoutVersion: 1, encryptionMode: mode,
            metadata: { path: '', host: '', summary: { text: 'Cold layout-1 session', updatedAt: 10 } },
            ownerMetadataView: { path: '/private/layout1-worktree', host: 'owner-host' },
            agentState: null,
            viewer: snapshot.session.viewer,
            pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 2, pendingRequestObservedAt: 500,
        });
        expect(storage.getState().sessions[address.sessionId]).toBeUndefined();
        const { buildPendingNavigationFromSource } = await import('@/activity/source/buildPendingNavigationFromSource');
        expect(buildPendingNavigationFromSource({ source, nowMs: 1_000 }).map(candidate => candidate.address)).toEqual([address]);
        expect(await nextPendingRequest({ source, nowMs: 1_000 })).toMatchObject({ kind: 'target',
            address, requestId: 'old-question', requestKind: 'user_action', createdAt: 300, unavailableCount: 0 });
        expect(pages).toHaveLength(2);
        expect(pages[1]).toContain('beforeSeq=5');
        expect(storage.getState().sessions[address.sessionId]).toBeUndefined();
    });
    it('selects a never-opened oldest request across candidate sessions through actual hydration', async () => {
        const { nextPendingRequest } = await import('@/activity/source/nextPendingRequest');
        installSecondSession();
        const result = await nextPendingRequest({ source: pendingSource(), nowMs: 1_000 });
        expect(result).toMatchObject({ kind: 'target', unavailableCount: 0,
            address, requestId: 'old-question', requestKind: 'user_action', createdAt: 100,
        });
        expect(storage.getState().sessions[address.sessionId]).toBeUndefined();
    });
    it('revalidates a completed request on its original Home and opens the settled session', async () => {
        const { nextPendingRequest } = await import('@/activity/source/nextPendingRequest');
        const { navigateToPendingRequest } = await import('@/activity/source/navigateToPendingRequest');
        installSecondSession();
        const source = pendingSource();
        const result = await nextPendingRequest({ source, nowMs: 1_000 });
        expect(result.kind).toBe('target');
        if (result.kind !== 'target') return;
        const pagesBeforeLanding = boundary.fetch.mock.calls.filter(([url]) => String(url).includes('/messages')).length;
        installNetwork({ agentState: { requests: {}, completedRequests: {
            'old-question': { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 100, completedAt: 200, status: 'approved' },
        } } });
        const routes: string[] = [];
        expect(await navigateToPendingRequest({ target: result, source, nowMs: 1_000,
            details: result.details, openRoute: route => routes.push(route) })).toEqual({ status: 'opened' });
        expect(routes).toEqual(['/session/never-opened?serverId=home-b']);
        expect(boundary.fetch.mock.calls.filter(([url]) => String(url).includes('/messages'))).toHaveLength(pagesBeforeLanding);
        expect(result.address).toEqual(address);
        const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
        const { usePendingNavigationLanding, clearPendingNavigationState } = await import('@/activity/source/pendingNavigationRuntime');
        const landing = await renderHook(() => usePendingNavigationLanding(address));
        try {
            expect(landing.getCurrent()).toMatchObject({ address, requestId: 'old-question', state: 'settled' });
        } finally {
            await landing.unmount();
            clearPendingNavigationState();
        }
    });
    it('does not hydrate candidate details when the captured Home has no Account binding', async () => {
        const { nextPendingRequest } = await import('@/activity/source/nextPendingRequest');
        const source = { ...pendingSource(), audienceScopes: new Map() };
        expect(await nextPendingRequest({ source, nowMs: 1_000 })).toMatchObject({ kind: 'unavailable' });
        expect(boundary.credentials).not.toHaveBeenCalled();
        expect(boundary.fetch).not.toHaveBeenCalled();
    });
    it('selects the real oldest request while reporting an unavailable candidate', async () => {
        const { nextPendingRequest } = await import('@/activity/source/nextPendingRequest');
        installSecondSession();
        const availableNetwork = boundary.fetch.getMockImplementation()!;
        boundary.fetch.mockImplementation(async (url: string, ...args: unknown[]) => {
            if (url.includes('/v2/sessions/unavailable-session')) return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
            return availableNetwork(url, ...args);
        });
        expect(await nextPendingRequest({ source: pendingSource([address.sessionId, 'newer-session', 'unavailable-session']), nowMs: 1_000 }))
            .toMatchObject({ kind: 'target', unavailableCount: 1, address,
                requestId: 'old-question', requestKind: 'user_action', createdAt: 100 });
    });
    it('reports unavailable rather than none when every candidate detail is unavailable', async () => {
        const { nextPendingRequest } = await import('@/activity/source/nextPendingRequest');
        const readyNetwork = boundary.fetch.getMockImplementation()!;
        boundary.fetch.mockImplementation(async (url: string, ...args: unknown[]) => {
            if (url.includes('/v2/sessions/')) return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
            return readyNetwork(url, ...args);
        });
        expect(await nextPendingRequest({ source: pendingSource(), nowMs: 1_000 })).toMatchObject({ kind: 'unavailable' });
    });
});
