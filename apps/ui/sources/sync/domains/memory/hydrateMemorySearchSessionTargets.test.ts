import { describe, expect, it, vi } from 'vitest';
import type { ServerAccountRequestAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';

const fetchSessionById = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({
        getSyncTuning: () => ({ sessionListHydrationConcurrencyLimit: 2 }),
    }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope', () => ({
    fetchSessionByIdWithServerScope: (...args: unknown[]) => fetchSessionById(...args),
}));

const {
    authorizeMemorySessionRange,
    authorizeMemorySearchResult,
    hydrateMemorySearchSessionTargets,
    readMemorySearchSessionForServerScope,
} = await import('./hydrateMemorySearchSessionTargets');

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

describe('hydrateMemorySearchSessionTargets', () => {
    it('keeps daemon-authorized document hits outside Session visibility hydration', async () => {
        const document = {
            type: 'artifact' as const, ref: { kind: 'doc' as const, serverId: 'server-a', artifactId: 'doc-1' },
            revision: { headerVersion: 1, bodyVersion: 1 }, location: 'document' as const,
            summary: 'Current instruction', score: 0.8,
        };
        const read = vi.fn(async () => ({ ok: false }));
        const result = await authorizeMemorySearchResult({
            result: { v: 1, ok: true, hits: [document] }, serverId: 'server-a', accountId: 'account-a',
            authority: { scope: { serverId: 'server-a', accountId: 'account-a' } },
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            readSessionForServerScope: read, concurrencyLimit: 2,
        });
        expect(result).toEqual({ v: 1, ok: true, hits: [document] });
        expect(read).not.toHaveBeenCalled();
    });
    it('rejects a memory window for a revoked Session before daemon access', async () => {
        await expect(authorizeMemorySessionRange({
            target: TARGETS[0],
            seqFrom: 1,
            seqTo: 2,
            authority: { scope: { serverId: 'server-a', accountId: 'account-a' } },
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            readSessionForServerScope: async () => ({ ok: false, errorCode: 'session_not_found' }),
        })).resolves.toBe(false);
    });

    it('rejects a memory window whose range crosses the projected transcript ceiling', async () => {
        await expect(authorizeMemorySessionRange({
            target: TARGETS[0],
            seqFrom: 4,
            seqTo: 6,
            authority: { scope: { serverId: 'server-a', accountId: 'account-a' } },
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            readSessionForServerScope: async () => ({ ok: true, visibleThroughSeq: 5 }),
        })).resolves.toBe(false);
    });

    it('filters every retained summary for a revoked Session from a public Action result', async () => {
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
            authority: { scope: { serverId: 'server-a', accountId: 'account-a' } },
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            readSessionForServerScope: async ({ target }) => target.sessionId === 'readable'
                ? { ok: true, visibleThroughSeq: 2 }
                : { ok: false },
            concurrencyLimit: 2,
        });

        expect(result).toEqual({ v: 1, ok: true, hits: [hit('readable')] });
    });

    it('suppresses only retained hit ranges above the currently projected transcript ceiling', async () => {
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
            authority: { scope: { serverId: 'server-a', accountId: 'account-a' } },
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            readSessionForServerScope: async () => ({ ok: true, visibleThroughSeq: 4 }),
            concurrencyLimit: 2,
        });

        expect(result).toEqual({ v: 1, ok: true, hits: [visible] });
    });

    it('hydrates hits outside the local projection through the explicit-server reader', async () => {
        const authority = { scope: { serverId: 'server-a', accountId: 'account-a' } };
        const readSessionForServerScope = vi.fn(async () => ({ ok: true }));

        const authorized = await hydrateMemorySearchSessionTargets({
            targets: TARGETS,
            authority,
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            concurrencyLimit: 2,
            readSessionForServerScope,
        });

        expect(readSessionForServerScope).toHaveBeenCalledTimes(2);
        expect(readSessionForServerScope).toHaveBeenCalledWith(
            expect.objectContaining({
                target: expect.objectContaining({ serverId: 'server-a', sessionId: 'outside-1' }),
                authority,
                signal: expect.any(AbortSignal),
            }),
        );
        expect(authorized.map((target) => target.sessionId)).toEqual(['local-1', 'outside-1']);
    });

    it('suppresses a stale row when the explicit-server read finds no authorization or existence', async () => {
        const authorized = await hydrateMemorySearchSessionTargets({
            targets: TARGETS,
            authority: { scope: { serverId: 'server-a', accountId: 'account-a' } },
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            concurrencyLimit: 2,
            readSessionForServerScope: async () => ({ ok: false, errorCode: 'session_not_found' }),
        });

        expect(authorized).toEqual([]);
    });

    it('suppresses a stale row when the explicit-server read fails', async () => {
        const authorized = await hydrateMemorySearchSessionTargets({
            targets: TARGETS,
            authority: { scope: { serverId: 'server-a', accountId: 'account-a' } },
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            concurrencyLimit: 2,
            readSessionForServerScope: async () => {
                throw new Error('offline');
            },
        });

        expect(authorized).toEqual([]);
    });

    it('still authorizes a locally projected target through the exact Account authority', async () => {
        const readSessionForServerScope = vi.fn(async () => ({ ok: true }));

        await hydrateMemorySearchSessionTargets({
            targets: TARGETS,
            authority: { scope: { serverId: 'server-a', accountId: 'account-a' } },
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            concurrencyLimit: 2,
            readSessionForServerScope,
        });

        expect(readSessionForServerScope).toHaveBeenCalledTimes(2);
    });

    it('stops hydrating once the caller cancels', async () => {
        const controller = new AbortController();
        const readSessionForServerScope = vi.fn(async () => {
            controller.abort();
            return { ok: true };
        });

        const authorized = await hydrateMemorySearchSessionTargets({
            targets: [
                { sessionKey: 'account-a:server-a:a', serverId: 'server-a', accountId: 'account-a', sessionId: 'a' },
                { sessionKey: 'account-a:server-a:b', serverId: 'server-a', accountId: 'account-a', sessionId: 'b' },
            ],
            authority: { scope: { serverId: 'server-a', accountId: 'account-a' } },
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            concurrencyLimit: 2,
            readSessionForServerScope,
            signal: controller.signal,
        });

        expect(readSessionForServerScope).toHaveBeenCalledTimes(1);
        expect(authorized).toEqual([]);
    });

    it('aborts reads and suppresses publication when the exact Account lifetime retires', async () => {
        const retirement: { current: (() => void) | null } = { current: null };
        let current = true;
        const observedSignal: { current: AbortSignal | null } = { current: null };
        let finishRead!: () => void;
        const readFinished = new Promise<void>((resolve) => { finishRead = resolve; });
        const pending = hydrateMemorySearchSessionTargets({
            targets: [TARGETS[0]],
            authority: { scope: { serverId: 'server-a', accountId: 'account-a' } },
            accountLifetime: {
                isCurrent: () => current,
                onRetire: (callback) => {
                    retirement.current = callback;
                    return { dispose: () => undefined };
                },
            },
            concurrencyLimit: 2,
            readSessionForServerScope: async ({ signal }) => {
                observedSignal.current = signal;
                await readFinished;
                return { ok: true };
            },
        });
        await vi.waitFor(() => expect(observedSignal.current).not.toBeNull());

        current = false;
        retirement.current?.();
        expect(observedSignal.current?.aborted).toBe(true);
        finishRead();

        await expect(pending).resolves.toEqual([]);
    });

    it('passes the exact Account authority and AbortSignal through the canonical Session reader', async () => {
        const request = vi.fn(async () => new Response('{}'));
        const authority = createRequestAuthority(request);
        const controller = new AbortController();
        fetchSessionById.mockImplementationOnce(async (params) => {
            params.applySessions([{
                id: 'local-1', serverId: 'server-a', seq: 1, createdAt: 1, updatedAt: 1,
                active: true, activeAt: 1, archivedAt: null, encryptionMode: 'plain',
                metadata: { name: 'Scoped title', path: '/work/scoped' }, metadataVersion: 1,
                agentState: {}, agentStateVersion: 1, thinking: false, thinkingAt: 0,
            }]);
            return { ok: true };
        });

        await expect(readMemorySearchSessionForServerScope({
            target: TARGETS[0],
            authority,
            signal: controller.signal,
        })).resolves.toEqual({ ok: true, visibleThroughSeq: 1 });

        expect(fetchSessionById).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'local-1',
            serverId: 'server-a',
            includeTurnsProjection: false,
            authority: expect.objectContaining({ scope: authority.scope }),
        }));
        const passedAuthority = fetchSessionById.mock.calls.at(-1)?.[0]?.authority;
        await passedAuthority.request('/v2/sessions/local-1', { method: 'GET' });
        expect(request).toHaveBeenCalledWith('/v2/sessions/local-1', expect.objectContaining({
            signal: controller.signal,
        }));
    });

    it('fails closed before reading when the target Account differs from captured authority', async () => {
        fetchSessionById.mockClear();
        const controller = new AbortController();
        const authority = createRequestAuthority(vi.fn());

        await expect(readMemorySearchSessionForServerScope({
            target: { ...TARGETS[0], accountId: 'account-b' },
            authority,
            signal: controller.signal,
        })).resolves.toEqual({ ok: false, errorCode: 'account_scope_mismatch' });
        expect(fetchSessionById).not.toHaveBeenCalled();
    });

    it('uses bounded concurrency while preserving provider target order', async () => {
        let active = 0;
        let maximumActive = 0;
        const releases: Array<() => void> = [];
        const pending = hydrateMemorySearchSessionTargets({
            targets: TARGETS,
            authority: { scope: { serverId: 'server-a', accountId: 'account-a' } },
            accountLifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
            concurrencyLimit: 2,
            readSessionForServerScope: async () => {
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                await new Promise<void>((resolve) => releases.push(resolve));
                active -= 1;
                return { ok: true };
            },
        });
        await vi.waitFor(() => expect(maximumActive).toBe(2));
        releases.reverse().forEach((release) => release());

        await expect(pending).resolves.toEqual(TARGETS);
    });
});
