import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, standardCleanup } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { storage } from '@/sync/domains/state/storage';
import { setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import {
    isSessionArchivePending,
    stopSessionAndMaybeArchive,
    type StopSessionAndMaybeArchiveParams,
} from './sessionStopArchiveFlow';

vi.mock('@/text', () => createTextModuleMock({ translate: (key: string) => key }));

const sessionId = 'session_flow';
const serverId = 'server_flow';
const isPending = () => isSessionArchivePending(sessionId, serverId);

function params(overrides: Partial<StopSessionAndMaybeArchiveParams> = {}) {
    return {
        sessionId, serverId, hideInactiveSessions: true, isPinned: false,
        archiveAfterStop: 'always' as const,
        stopSession: async () => ({ success: true }),
        archiveSession: async () => ({ success: true }),
        stopErrorMessage: 'stop failed', archiveErrorMessage: 'archive failed',
        ...overrides,
    };
}

describe('stopSessionAndMaybeArchive', () => {
    beforeEach(() => {
        storage.setState({ sessionArchiveOperations: {} });
    });
    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
        delete process.env.EXPO_PUBLIC_HAPPIER_SESSION_ARCHIVE_AFTER_STOP_RETRY_MS;
        delete process.env.EXPO_PUBLIC_HAPPIER_SESSION_ARCHIVE_AFTER_STOP_TIMEOUT_MS;
    });

    it.each([
        { success: true },
        { success: false, code: 'session_stop_requested', recovery: 'wait_for_inactive' as const },
    ])('stops without entering the archive lifecycle for stop-only requests: %j', async (stopResult) => {
        const archiveSession = vi.fn(async () => ({ success: true }));
        await stopSessionAndMaybeArchive(params({
            archiveAfterStop: 'never', archiveSession,
            stopSession: async () => { expect(isPending()).toBe(false); return stopResult; },
        }));
        expect(archiveSession).not.toHaveBeenCalled();
        expect(isPending()).toBe(false);
    });

    it('surfaces truthful recovery when session control is unavailable', async () => {
        await expect(stopSessionAndMaybeArchive(params({
            stopSession: async () => ({ success: false, recovery: 'retry_when_runtime_available' }),
        }))).rejects.toMatchObject({ message: 'sessionInfo.stopSessionControlUnavailable' });
        expect(isPending()).toBe(false);
    });

    it('shows the session as archiving from stop until archive settles', async () => {
        const archived = createDeferred<{ success: boolean }>();
        const archiveSession = vi.fn(() => { expect(isPending()).toBe(true); return archived.promise; });
        const result = stopSessionAndMaybeArchive(params({
            stopSession: async () => { expect(isPending()).toBe(true); return { success: true }; },
            archiveSession,
        }));
        await vi.waitFor(() => expect(archiveSession).toHaveBeenCalledTimes(1));
        expect(isPending()).toBe(true);
        archived.resolve({ success: true });
        await result;
        expect(isPending()).toBe(false);
    });

    it('retains admission when a feature response promotes the pending server identity', async () => {
        const profile = upsertServerProfile({ serverUrl: 'https://archive-promotion.example' });
        const canonicalId = 'srv_archive_promoted';
        const stopped = createDeferred<{ success: boolean }>();
        const stopSession = vi.fn(() => stopped.promise);
        const first = stopSessionAndMaybeArchive(params({ serverId: profile.id, stopSession }));
        expect(isSessionArchivePending(sessionId, profile.id)).toBe(true);
        try {
            setServerProfileIdentityForUrl(profile.serverUrl, canonicalId);
            const pendingAfterPromotion = isSessionArchivePending(sessionId, canonicalId);
            const duplicate = await stopSessionAndMaybeArchive(params({
                serverId: canonicalId,
                stopSession: async () => {
                    stopSession();
                    return { success: true };
                },
            }));
            expect({ pendingAfterPromotion, duplicateSkipped: duplicate === false, stopRequests: stopSession.mock.calls.length })
                .toEqual({ pendingAfterPromotion: true, duplicateSkipped: true, stopRequests: 1 });
        } finally {
            stopped.resolve({ success: true });
            await first;
        }
        expect(isSessionArchivePending(sessionId, profile.id)).toBe(false);
        expect(isSessionArchivePending(sessionId, canonicalId)).toBe(false);
    });

    it('clears pending and does not archive after stop fails', async () => {
        const archiveSession = vi.fn(async () => ({ success: true }));
        await expect(stopSessionAndMaybeArchive(params({
            stopSession: async () => ({ success: false, message: 'stop boom' }), archiveSession,
        }))).rejects.toMatchObject({ message: 'stop boom' });
        expect(archiveSession).not.toHaveBeenCalled();
        expect(isPending()).toBe(false);
    });

    it('waits for authoritative inactivity after an accepted stop, without requesting stop again', async () => {
        vi.useFakeTimers();
        const stopSession = vi.fn(async () => ({
            success: false, code: 'session_stop_requested', recovery: 'wait_for_inactive' as const,
        }));
        const archiveSession = vi.fn()
            .mockResolvedValueOnce({ success: false, code: 'session_active' })
            .mockResolvedValueOnce({ success: false, code: 'session_active' })
            .mockResolvedValueOnce({ success: true });
        const result = stopSessionAndMaybeArchive(params({ stopSession, archiveSession }));
        await vi.advanceTimersByTimeAsync(200);
        expect(isPending()).toBe(true);
        await vi.advanceTimersByTimeAsync(200);
        await result;
        expect(stopSession).toHaveBeenCalledTimes(1);
        expect(archiveSession).toHaveBeenCalledTimes(3);
        expect(isPending()).toBe(false);
    });

    it('allows a missing runner to try the authoritative archive boundary once', async () => {
        const archiveSession = vi.fn(async () => ({ success: true }));
        await stopSessionAndMaybeArchive(params({
            stopSession: async () => ({ success: false, code: 'session_stop_not_found' }), archiveSession,
        }));
        expect(archiveSession).toHaveBeenCalledTimes(1);
        expect(isPending()).toBe(false);
    });

    it('keeps a first archive attempt but disables inactivity polling when the configured timeout is zero', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SESSION_ARCHIVE_AFTER_STOP_TIMEOUT_MS = '0';
        const archiveSession = vi.fn(async () => ({ success: false, code: 'session_active' }));
        await expect(stopSessionAndMaybeArchive(params({ archiveSession })))
            .rejects.toMatchObject({ message: 'archive failed' });
        expect(archiveSession).toHaveBeenCalledTimes(1);
        expect(isPending()).toBe(false);
    });

    it('recovers archive admission when the first request never settles', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SESSION_ARCHIVE_AFTER_STOP_TIMEOUT_MS = '1000';
        vi.useFakeTimers();
        const cleanup = createDeferred<{ success: boolean }>();
        const network: { signal?: AbortSignal } = {};
        let settled = false;
        // The supplied archive effect is the network boundary; its promise settles only on abort.
        const archiveSession: StopSessionAndMaybeArchiveParams['archiveSession'] = (options) => {
            network.signal = options?.signal;
            return new Promise((resolve, reject) => {
                options?.signal?.addEventListener('abort', () => {
                    const error = new Error('Aborted');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });
                void cleanup.promise.then(resolve);
            });
        };
        const result = stopSessionAndMaybeArchive(params({ archiveSession }))
            .catch((error: unknown) => error).finally(() => { settled = true; });
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(isPending()).toBe(true);
            await vi.advanceTimersByTimeAsync(1000);
            expect({ settled, aborted: network.signal?.aborted, pending: isPending() })
                .toEqual({ settled: true, aborted: true, pending: false });
            expect(await result).toBeInstanceOf(Error);
            await expect(stopSessionAndMaybeArchive(params())).resolves.toBeUndefined();
            expect(isPending()).toBe(false);
        } finally {
            cleanup.resolve({ success: true });
            await result;
        }
    });

    it('fails immediately when a missing runner cannot satisfy the authoritative archive guard', async () => {
        vi.useFakeTimers();
        const stopSession = vi.fn(async () => ({ success: false, code: 'session_stop_not_found' }));
        const archiveSession = vi.fn(async () => ({ success: false, code: 'session_active' }));
        let settled = false;
        const result = stopSessionAndMaybeArchive(params({ stopSession, archiveSession }))
            .then(() => { settled = true; }, (error: unknown) => {
                settled = true;
                expect(error).toMatchObject({ message: 'archive failed' });
            });
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(settled).toBe(true);
            expect(archiveSession).toHaveBeenCalledTimes(1);
            expect(stopSession).toHaveBeenCalledTimes(1);
        } finally {
            await vi.advanceTimersByTimeAsync(75_001);
            await result;
        }
        expect(isPending()).toBe(false);
    });

    it('keeps the default inactivity wait long enough for delayed exit observation and fails at its deadline', async () => {
        vi.useFakeTimers();
        const archiveSession = vi.fn(async () => ({ success: false, code: 'session_active' }));
        let settled = false;
        const result = stopSessionAndMaybeArchive(params({ archiveSession }))
            .catch((error: unknown) => {
                settled = true;
                expect(error).toMatchObject({ message: 'archive failed' });
            });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(settled).toBe(false);
        expect(isPending()).toBe(true);
        await vi.advanceTimersByTimeAsync(15_001);
        await result;
        expect(settled).toBe(true);
        expect(isPending()).toBe(false);
    });

    it.each(['result', 'exception'] as const)('clears pending when archive fails through %s', async (failure) => {
        await expect(stopSessionAndMaybeArchive(params({ archiveSession: async () => {
            if (failure === 'exception') throw new Error('archive boom');
            return { success: false, message: 'archive boom' };
        } }))).rejects.toMatchObject({ message: 'archive boom' });
        expect(isPending()).toBe(false);
    });

    it('does not let an older completion clear a new archive after account reset', async () => {
        const firstGate = createDeferred<{ success: boolean }>();
        const secondGate = createDeferred<{ success: boolean }>();
        const first = stopSessionAndMaybeArchive(params({ stopSession: () => firstGate.promise }));
        expect(isPending()).toBe(true);
        storage.setState({ sessionArchiveOperations: {} });
        const second = stopSessionAndMaybeArchive(params({ stopSession: () => secondGate.promise }));
        try {
            firstGate.resolve({ success: true });
            await first;
            expect(isPending()).toBe(true);
            await expect(stopSessionAndMaybeArchive(params())).resolves.toBe(false);
        } finally {
            secondGate.resolve({ success: true });
            await Promise.all([first, second]);
        }
        expect(isPending()).toBe(false);
    });
});
