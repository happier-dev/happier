import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExternalSessionFollowLeaseManager } from './createExternalSessionFollowLeaseManager';

type FollowStatusWriteInput = Parameters<
    NonNullable<
        NonNullable<Parameters<typeof createExternalSessionFollowLeaseManager>[0]>['writeFollowStatus']
    >
>[0];

function readPublishedFollowStatus(call: readonly unknown[]): Readonly<{
    status: string;
    reason: string;
}> {
    const input = call[0] as Readonly<{
        followStatusV1: Readonly<{ status: string; reason: string }>;
    }>;
    return {
        status: input.followStatusV1.status,
        reason: input.followStatusV1.reason,
    };
}

describe('createExternalSessionFollowLeaseManager', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renews an existing viewer lease id for the same session and detaches it cleanly', async () => {
        // Viewer-lease identity, expiry, capacity and demand are one concept with one
        // owner: these contracts are asserted through the manager that owns them, not
        // against a second registry kept in hand-written lockstep with it.
        let nowMs = 1_000;
        const manager = createExternalSessionFollowLeaseManager({
            now: () => nowMs,
            randomId: () => 'lease-generated',
        });

        await expect(manager.attach({
            sessionId: 'session-1',
            ttlMs: 30_000,
        })).resolves.toEqual({
            leaseId: 'lease-generated',
            expiresAtMs: 31_000,
            renewed: false,
        });

        nowMs = 5_000;
        await expect(manager.attach({
            sessionId: 'session-1',
            leaseId: 'lease-generated',
            ttlMs: 30_000,
        })).resolves.toEqual({
            leaseId: 'lease-generated',
            expiresAtMs: 35_000,
            renewed: true,
        });
        expect(manager.countActiveLeases('session-1')).toBe(1);
        await expect(manager.detach({
            sessionId: 'session-1',
            leaseId: 'lease-generated',
        })).resolves.toEqual({ detached: true });
        expect(manager.countActiveLeases('session-1')).toBe(0);
    });

    it('bounds distinct active viewer leases per session while allowing renewal at capacity', async () => {
        const manager = createExternalSessionFollowLeaseManager({
            now: () => 1_000,
        });

        for (let index = 0; index < 64; index += 1) {
            await expect(manager.attach({
                sessionId: 'session-bounded',
                leaseId: `lease-${index}`,
                ttlMs: 30_000,
            })).resolves.toEqual({
                leaseId: `lease-${index}`,
                expiresAtMs: 31_000,
                renewed: false,
            });
        }

        expect(manager.countActiveLeases('session-bounded')).toBe(64);
        await expect(manager.attach({
            sessionId: 'session-bounded',
            leaseId: 'lease-over-capacity',
            ttlMs: 30_000,
        })).rejects.toThrowError(expect.objectContaining({
            name: 'ExternalSessionViewerLeaseCapacityExceededError',
        }));
        await expect(manager.attach({
            sessionId: 'session-bounded',
            leaseId: 'lease-0',
            ttlMs: 60_000,
        })).resolves.toEqual({
            leaseId: 'lease-0',
            expiresAtMs: 61_000,
            renewed: true,
        });
        expect(manager.countActiveLeases('session-bounded')).toBe(64);
    });

    it('releases viewer-lease capacity and cursor custody when a lease is detached or expires', async () => {
        let nowMs = 1_000;
        const requestTranscriptRefresh = vi.fn(async (): Promise<void> => undefined);
        const manager = createExternalSessionFollowLeaseManager({
            now: () => nowMs,
        });

        for (let index = 0; index < 64; index += 1) {
            await manager.attach({
                sessionId: 'session-releases-capacity',
                leaseId: `lease-${index}`,
                ttlMs: index === 0 ? 1_000 : 30_000,
                acceptedTailCursor: 'cursor-0',
                requestTranscriptRefresh,
            });
        }

        await expect(manager.detach({
            sessionId: 'session-releases-capacity',
            leaseId: 'lease-1',
        })).resolves.toEqual({ detached: true });
        await expect(manager.attach({
            sessionId: 'session-releases-capacity',
            leaseId: 'lease-after-detach',
            ttlMs: 30_000,
        })).resolves.toMatchObject({ renewed: false });
        expect(manager.countActiveLeases('session-releases-capacity')).toBe(64);

        // The expired lease releases capacity from the same record that carries its
        // cursor custody, without waiting for its expiry timer to fire.
        nowMs = 2_000;
        await expect(manager.attach({
            sessionId: 'session-releases-capacity',
            leaseId: 'lease-after-expiry',
            ttlMs: 30_000,
        })).resolves.toMatchObject({ renewed: false });
        expect(manager.countActiveLeases('session-releases-capacity')).toBe(64);
        expect(requestTranscriptRefresh).not.toHaveBeenCalled();
    });

    it('shares one generation-qualified follower across multiple viewers and background policy', async () => {
        const release = vi.fn(async () => {});
        const acquireFollowLease = vi.fn(async () => ({ release }));
        const retirement = new AbortController();
        const manager = createExternalSessionFollowLeaseManager();
        const resource = {
            linkGeneration: 'link-1',
            pluginGeneration: 'plugin-1',
            retirementSignal: retirement.signal,
        };

        await manager.attach({
            sessionId: 'session-shared',
            leaseId: 'viewer-1',
            ttlMs: 30_000,
            resource,
            acquireFollowLease,
        });
        await manager.attach({
            sessionId: 'session-shared',
            leaseId: 'viewer-2',
            ttlMs: 30_000,
            resource,
            acquireFollowLease,
        });
        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-shared',
            enabled: true,
            resource,
            acquireFollowLease,
        });

        expect(acquireFollowLease).toHaveBeenCalledTimes(1);

        await manager.detach({ sessionId: 'session-shared', leaseId: 'viewer-1' });
        await manager.detach({ sessionId: 'session-shared', leaseId: 'viewer-2' });
        expect(release).not.toHaveBeenCalled();

        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-shared',
            enabled: false,
        });
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('does not let a stalled session block another session while preserving same-session order and disposal', async () => {
        let resolveFirstAcquisition:
            | ((lease: Readonly<{ release: () => Promise<void> }>) => void)
            | undefined;
        const firstAcquisition = new Promise<Readonly<{
            release: () => Promise<void>;
        }>>((resolve) => {
            resolveFirstAcquisition = resolve;
        });
        const firstRelease = vi.fn(async () => {});
        const secondRelease = vi.fn(async () => {});
        const acquireFirst = vi.fn(async () => await firstAcquisition);
        const acquireSecond = vi.fn(async () => ({ release: secondRelease }));
        const manager = createExternalSessionFollowLeaseManager();

        const firstAttach = manager.attach({
            sessionId: 'session-stalled',
            leaseId: 'viewer-first',
            ttlMs: 30_000,
            acquireFollowLease: acquireFirst,
        });
        await vi.waitFor(() => expect(acquireFirst).toHaveBeenCalledOnce());

        let sameSessionAttachSettled = false;
        const sameSessionAttach = manager.attach({
            sessionId: 'session-stalled',
            leaseId: 'viewer-same-session',
            ttlMs: 30_000,
            acquireFollowLease: acquireFirst,
        }).then((result) => {
            sameSessionAttachSettled = true;
            return result;
        });
        let independentAttachSettled = false;
        const independentAttach = manager.attach({
            sessionId: 'session-independent',
            leaseId: 'viewer-independent',
            ttlMs: 30_000,
            acquireFollowLease: acquireSecond,
        }).then((result) => {
            independentAttachSettled = true;
            return result;
        });
        let disposeSettled = false;
        const dispose = manager.dispose().then(() => {
            disposeSettled = true;
        });
        let operationSettlements: PromiseSettledResult<unknown>[] = [];

        try {
            await vi.waitFor(() => expect(acquireSecond).toHaveBeenCalledOnce());
            await independentAttach;

            expect(independentAttachSettled).toBe(true);
            expect(sameSessionAttachSettled).toBe(false);
            expect(manager.countActiveLeases('session-stalled')).toBe(1);
            expect(disposeSettled).toBe(false);
        } finally {
            resolveFirstAcquisition?.({ release: firstRelease });
            operationSettlements = await Promise.allSettled([
                firstAttach,
                sameSessionAttach,
                independentAttach,
                dispose,
            ]);
        }

        expect(operationSettlements.every(({ status }) => status === 'fulfilled')).toBe(true);
        expect(sameSessionAttachSettled).toBe(true);
        expect(acquireFirst).toHaveBeenCalledOnce();
        expect(firstRelease).toHaveBeenCalledOnce();
        expect(secondRelease).toHaveBeenCalledOnce();
        expect(disposeSettled).toBe(true);
    });

    it('converges relink and generation retirement by replacing and releasing each follower once', async () => {
        const firstRelease = vi.fn(async () => {});
        const secondRelease = vi.fn(async () => {});
        const firstRetirement = new AbortController();
        const secondRetirement = new AbortController();
        const manager = createExternalSessionFollowLeaseManager();

        await manager.attach({
            sessionId: 'session-relinked',
            leaseId: 'viewer',
            ttlMs: 30_000,
            resource: {
                linkGeneration: 'link-1',
                pluginGeneration: 'plugin-1',
                retirementSignal: firstRetirement.signal,
            },
            acquireFollowLease: async () => ({ release: firstRelease }),
        });
        await manager.attach({
            sessionId: 'session-relinked',
            leaseId: 'viewer',
            ttlMs: 30_000,
            resource: {
                linkGeneration: 'link-2',
                pluginGeneration: 'plugin-2',
                retirementSignal: secondRetirement.signal,
            },
            acquireFollowLease: async () => ({ release: secondRelease }),
        });

        expect(firstRelease).toHaveBeenCalledTimes(1);
        expect(secondRelease).not.toHaveBeenCalled();

        firstRetirement.abort();
        await Promise.resolve();
        expect(firstRelease).toHaveBeenCalledTimes(1);
        expect(secondRelease).not.toHaveBeenCalled();

        secondRetirement.abort();
        await vi.waitFor(() => expect(secondRelease).toHaveBeenCalledTimes(1));

        await manager.dispose();
        expect(firstRelease).toHaveBeenCalledTimes(1);
        expect(secondRelease).toHaveBeenCalledTimes(1);
    });

    it('suspends before an authority transition and resumes the retained desired follower on rollback', async () => {
        const firstRelease = vi.fn(async () => {});
        const secondRelease = vi.fn(async () => {});
        const acquireFollowLease = vi.fn()
            .mockResolvedValueOnce({ release: firstRelease })
            .mockResolvedValueOnce({ release: secondRelease });
        const manager = createExternalSessionFollowLeaseManager();

        await manager.attach({
            sessionId: 'session-takeover',
            leaseId: 'viewer',
            ttlMs: 30_000,
            acquireFollowLease,
        });
        await manager.suspendSession({
            sessionId: 'session-takeover',
            reason: 'takeover',
        });

        expect(firstRelease).toHaveBeenCalledTimes(1);
        expect(acquireFollowLease).toHaveBeenCalledTimes(1);

        await manager.resumeSession({
            sessionId: 'session-takeover',
            reason: 'takeover',
        });
        expect(acquireFollowLease).toHaveBeenCalledTimes(2);
        expect(secondRelease).not.toHaveBeenCalled();
    });

    it('does not let connectivity restoration clear an active takeover suspension', async () => {
        const firstRelease = vi.fn(async () => {});
        const secondRelease = vi.fn(async () => {});
        const acquireFollowLease = vi.fn()
            .mockResolvedValueOnce({ release: firstRelease })
            .mockResolvedValueOnce({ release: secondRelease });
        const manager = createExternalSessionFollowLeaseManager();

        await manager.attach({
            sessionId: 'session-nested-suspension',
            leaseId: 'viewer',
            ttlMs: 30_000,
            acquireFollowLease,
        });
        await manager.suspendSession({
            sessionId: 'session-nested-suspension',
            reason: 'takeover',
        });
        await manager.suspendSession({
            sessionId: 'session-nested-suspension',
            reason: 'daemon_disconnected',
        });

        await expect(manager.resumeSession({
            sessionId: 'session-nested-suspension',
            reason: 'daemon_disconnected',
        })).resolves.toEqual({
            resumed: true,
            leaseAcquired: false,
        });
        expect(manager.isSessionSuspended({
            sessionId: 'session-nested-suspension',
            reason: 'takeover',
        })).toBe(true);
        expect(acquireFollowLease).toHaveBeenCalledTimes(1);

        await expect(manager.resumeSession({
            sessionId: 'session-nested-suspension',
            reason: 'takeover',
        })).resolves.toEqual({
            resumed: true,
            leaseAcquired: true,
        });
        expect(acquireFollowLease).toHaveBeenCalledTimes(2);
        expect(secondRelease).not.toHaveBeenCalled();
    });

    it('catches up once from the accepted cursor after suspended observation continuity is restored', async () => {
        const release = vi.fn(async () => {});
        const acquireFollowLease = vi.fn(async () => ({
            release,
            readAcceptedCursor: () => 'stale-physical-lease-cursor',
        }));
        const requestTranscriptRefresh = vi.fn(async () => ({
            outcome: 'already_current' as const,
        }));
        const manager = createExternalSessionFollowLeaseManager();
        const resource = {
            linkGeneration: 'link-generation',
            pluginGeneration: 'plugin-generation',
        };

        await manager.attach({
            sessionId: 'session-continuity-gap',
            leaseId: 'viewer',
            ttlMs: 30_000,
            acceptedTailCursor: 'accepted-cursor',
            resource,
            acquireFollowLease,
            requestTranscriptRefresh,
        });
        expect(requestTranscriptRefresh).not.toHaveBeenCalled();

        await manager.suspendSession({
            sessionId: 'session-continuity-gap',
            reason: 'takeover',
        });
        await expect(manager.resumeSession({
            sessionId: 'session-continuity-gap',
            reason: 'takeover',
        })).resolves.toEqual({
            resumed: true,
            leaseAcquired: true,
        });

        expect(requestTranscriptRefresh).toHaveBeenCalledTimes(1);
        expect(requestTranscriptRefresh).toHaveBeenCalledWith(
            'accepted-cursor',
            expect.any(Function),
        );
        expect(acquireFollowLease.mock.calls[1]).toEqual([]);

        await expect(manager.resumeSession({
            sessionId: 'session-continuity-gap',
            reason: 'takeover',
        })).resolves.toEqual({
            resumed: false,
            leaseAcquired: false,
        });
        expect(requestTranscriptRefresh).toHaveBeenCalledTimes(1);
    });

    it('shares one reacquisition invalidation across ordinary viewers at the same accepted cursor', async () => {
        const firstRefresh = vi.fn(async () => ({
            outcome: 'already_current' as const,
        }));
        const secondRefresh = vi.fn(async () => ({
            outcome: 'already_current' as const,
        }));
        const manager = createExternalSessionFollowLeaseManager();
        const resource = {
            linkGeneration: 'link-shared-cursor',
            pluginGeneration: 'plugin-shared-cursor',
        };
        const acquireFollowLease = vi.fn(async () => ({
            release: vi.fn(async () => {}),
        }));

        await manager.attach({
            sessionId: 'session-shared-cursor',
            leaseId: 'viewer-one',
            ttlMs: 30_000,
            acceptedTailCursor: 'accepted-shared',
            resource,
            acquireFollowLease,
            requestTranscriptRefresh: firstRefresh,
        });
        await manager.attach({
            sessionId: 'session-shared-cursor',
            leaseId: 'viewer-two',
            ttlMs: 30_000,
            acceptedTailCursor: 'accepted-shared',
            resource,
            acquireFollowLease,
            requestTranscriptRefresh: secondRefresh,
        });

        await manager.suspendSession({
            sessionId: 'session-shared-cursor',
            reason: 'daemon_disconnected',
        });
        await manager.resumeSession({
            sessionId: 'session-shared-cursor',
            reason: 'daemon_disconnected',
        });

        expect(firstRefresh).toHaveBeenCalledOnce();
        expect(firstRefresh).toHaveBeenCalledWith(
            'accepted-shared',
            expect.any(Function),
        );
        expect(secondRefresh).not.toHaveBeenCalled();
    });

    it('requests one reacquisition invalidation for each distinct ordinary-viewer cursor', async () => {
        const firstRefresh = vi.fn(async () => ({
            outcome: 'already_current' as const,
        }));
        const secondRefresh = vi.fn(async () => ({
            outcome: 'already_current' as const,
        }));
        const manager = createExternalSessionFollowLeaseManager();
        const resource = {
            linkGeneration: 'link-distinct-cursors',
            pluginGeneration: 'plugin-distinct-cursors',
        };
        const acquireFollowLease = vi.fn(async () => ({
            release: vi.fn(async () => {}),
        }));

        await manager.attach({
            sessionId: 'session-distinct-cursors',
            leaseId: 'viewer-one',
            ttlMs: 30_000,
            acceptedTailCursor: 'accepted-one',
            resource,
            acquireFollowLease,
            requestTranscriptRefresh: firstRefresh,
        });
        await manager.attach({
            sessionId: 'session-distinct-cursors',
            leaseId: 'viewer-two',
            ttlMs: 30_000,
            acceptedTailCursor: 'accepted-two',
            resource,
            acquireFollowLease,
            requestTranscriptRefresh: secondRefresh,
        });

        await manager.suspendSession({
            sessionId: 'session-distinct-cursors',
            reason: 'daemon_disconnected',
        });
        await manager.resumeSession({
            sessionId: 'session-distinct-cursors',
            reason: 'daemon_disconnected',
        });

        expect(firstRefresh).toHaveBeenCalledOnce();
        expect(firstRefresh).toHaveBeenCalledWith(
            'accepted-one',
            expect.any(Function),
        );
        expect(secondRefresh).toHaveBeenCalledOnce();
        expect(secondRefresh).toHaveBeenCalledWith(
            'accepted-two',
            expect.any(Function),
        );
    });

    it('keeps a shared ordinary-viewer cursor current when its selected viewer leaves in flight', async () => {
        let finishRefresh: (() => void) | undefined;
        let readCurrent: (() => boolean) | undefined;
        const refreshInFlight = new Promise<void>((resolve) => {
            finishRefresh = resolve;
        });
        const firstRefresh = vi.fn(async (
            _cursor: string,
            isCurrent: () => boolean,
        ) => {
            readCurrent = isCurrent;
            await refreshInFlight;
            return { outcome: 'already_current' as const };
        });
        const secondRefresh = vi.fn(async () => ({
            outcome: 'already_current' as const,
        }));
        const manager = createExternalSessionFollowLeaseManager();
        const resource = {
            linkGeneration: 'link-viewer-removal',
            pluginGeneration: 'plugin-viewer-removal',
        };

        await manager.attach({
            sessionId: 'session-viewer-removal',
            leaseId: 'viewer-one',
            ttlMs: 30_000,
            acceptedTailCursor: 'accepted-shared',
            resource,
            requestTranscriptRefresh: firstRefresh,
        });
        await manager.attach({
            sessionId: 'session-viewer-removal',
            leaseId: 'viewer-two',
            ttlMs: 30_000,
            acceptedTailCursor: 'accepted-shared',
            resource,
            requestTranscriptRefresh: secondRefresh,
        });

        const refresh = manager.requestTranscriptRefresh({
            sessionId: 'session-viewer-removal',
            resource,
        });
        await vi.waitFor(() => expect(firstRefresh).toHaveBeenCalledOnce());
        await manager.detach({
            sessionId: 'session-viewer-removal',
            leaseId: 'viewer-one',
        });

        expect(readCurrent?.()).toBe(true);
        finishRefresh?.();
        await refresh;
        expect(secondRefresh).not.toHaveBeenCalled();
    });

    it('moves a pending ordinary-viewer refresh to its changed accepted cursor', async () => {
        let finishRefresh: (() => void) | undefined;
        let readCurrent: (() => boolean) | undefined;
        const refreshInFlight = new Promise<void>((resolve) => {
            finishRefresh = resolve;
        });
        const firstRefresh = vi.fn(async (
            _cursor: string,
            isCurrent: () => boolean,
        ) => {
            readCurrent = isCurrent;
            await refreshInFlight;
            return { outcome: 'already_current' as const };
        });
        const secondRefresh = vi.fn(async () => ({
            outcome: 'already_current' as const,
        }));
        const manager = createExternalSessionFollowLeaseManager();
        const resource = {
            linkGeneration: 'link-cursor-change',
            pluginGeneration: 'plugin-cursor-change',
        };

        await manager.attach({
            sessionId: 'session-cursor-change',
            leaseId: 'viewer',
            ttlMs: 30_000,
            acceptedTailCursor: 'accepted-before',
            resource,
            requestTranscriptRefresh: firstRefresh,
        });
        const firstRequest = manager.requestTranscriptRefresh({
            sessionId: 'session-cursor-change',
            resource,
        });
        await vi.waitFor(() => expect(firstRefresh).toHaveBeenCalledOnce());

        await manager.attach({
            sessionId: 'session-cursor-change',
            leaseId: 'viewer',
            ttlMs: 30_000,
            acceptedTailCursor: 'accepted-after',
            resource,
            requestTranscriptRefresh: secondRefresh,
        });
        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-cursor-change',
            resource,
        })).resolves.toEqual({ requested: true, coalesced: true });
        expect(readCurrent?.()).toBe(false);

        finishRefresh?.();
        await firstRequest;
        await vi.waitFor(() => expect(secondRefresh).toHaveBeenCalledOnce());
        expect(secondRefresh).toHaveBeenCalledWith(
            'accepted-after',
            expect.any(Function),
        );
    });

    it('retries one shared ordinary-viewer cursor after a coalesced in-flight failure', async () => {
        let rejectRefresh: ((error: Error) => void) | undefined;
        const firstAttempt = new Promise<void>((_resolve, reject) => {
            rejectRefresh = reject;
        });
        let attempts = 0;
        const requestTranscriptRefresh = vi.fn(async () => {
            attempts += 1;
            if (attempts === 1) await firstAttempt;
            return { outcome: 'already_current' as const };
        });
        const manager = createExternalSessionFollowLeaseManager();
        const resource = {
            linkGeneration: 'link-shared-retry',
            pluginGeneration: 'plugin-shared-retry',
        };

        for (const leaseId of ['viewer-one', 'viewer-two']) {
            await manager.attach({
                sessionId: 'session-shared-retry',
                leaseId,
                ttlMs: 30_000,
                acceptedTailCursor: 'accepted-shared',
                resource,
                requestTranscriptRefresh,
            });
        }

        const firstRequest = manager.requestTranscriptRefresh({
            sessionId: 'session-shared-retry',
            resource,
        });
        await vi.waitFor(() =>
            expect(requestTranscriptRefresh).toHaveBeenCalledTimes(1),
        );
        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-shared-retry',
            resource,
        })).resolves.toEqual({ requested: true, coalesced: true });

        rejectRefresh?.(new Error('refresh failed'));
        await firstRequest;
        await vi.waitFor(() =>
            expect(requestTranscriptRefresh).toHaveBeenCalledTimes(2),
        );
    });

    it('keeps same-cursor scoped listeners independent because each owns delivery and acknowledgement', async () => {
        const firstRefresh = vi.fn(async () => ({
            outcome: 'already_current' as const,
        }));
        const secondRefresh = vi.fn(async () => ({
            outcome: 'already_current' as const,
        }));
        const manager = createExternalSessionFollowLeaseManager();
        const resource = {
            linkGeneration: 'link-scoped-listeners',
            pluginGeneration: 'plugin-scoped-listeners',
        };
        const acquireFollowLease = vi.fn(async () => ({
            release: vi.fn(async () => {}),
        }));

        await manager.attachScoped({
            sessionId: 'session-scoped-listeners',
            acceptedTailCursor: 'accepted-shared',
            resource,
            acquireFollowLease,
            requestTranscriptRefresh: firstRefresh,
        });
        await manager.attachScoped({
            sessionId: 'session-scoped-listeners',
            acceptedTailCursor: 'accepted-shared',
            resource,
            acquireFollowLease,
            requestTranscriptRefresh: secondRefresh,
        });

        await manager.suspendSession({
            sessionId: 'session-scoped-listeners',
            reason: 'daemon_disconnected',
        });
        await manager.resumeSession({
            sessionId: 'session-scoped-listeners',
            reason: 'daemon_disconnected',
        });

        expect(firstRefresh).toHaveBeenCalledOnce();
        expect(secondRefresh).toHaveBeenCalledOnce();
    });

    it('captures the canonical lease cursor when scoped live demand precedes replay', async () => {
        const release = vi.fn(async () => undefined);
        const manager = createExternalSessionFollowLeaseManager();
        const attached = await manager.attachScoped({
            sessionId: 'session-scoped-baseline',
            acceptedTailCursor: null,
            resource: {
                linkGeneration: 'link-scoped-baseline',
                pluginGeneration: 'plugin-scoped-baseline',
            },
            acquireFollowLease: async () => ({
                release,
                readAcceptedCursor: () => 'captured-tail',
            }),
            requestTranscriptRefresh: async () => ({ outcome: 'already_current' }),
        });

        expect(attached.acceptedTailCursor).toBe('captured-tail');
        await attached.release();
        expect(release).toHaveBeenCalledOnce();
    });

    it('reacquires background-only follow from its last accepted cursor without rebasing past suspended changes', async () => {
        let providerTailCursor = 'cursor-before-suspension';
        const baselineTail = vi.fn(async () => providerTailCursor);
        const readAfterTranscript = vi.fn(async (cursor: string) => {
            expect(cursor).toBe('cursor-before-suspension');
            return providerTailCursor;
        });
        const releases: Array<ReturnType<typeof vi.fn>> = [];
        const acquireFollowLease = vi.fn(async (initialCursor?: string | null) => {
            let acceptedCursor = initialCursor ?? await baselineTail();
            const release = vi.fn(async () => {});
            releases.push(release);
            return {
                release,
                readAcceptedCursor: () => acceptedCursor,
                requestTranscriptRefresh: async () => {
                    acceptedCursor = await readAfterTranscript(acceptedCursor);
                    return { outcome: 'advanced' as const };
                },
            };
        });
        const manager = createExternalSessionFollowLeaseManager();
        const resource = {
            linkGeneration: 'link-generation',
            pluginGeneration: 'plugin-generation',
        };

        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-background-continuity-gap',
            enabled: true,
            resource,
            acquireFollowLease,
        });
        expect(baselineTail).toHaveBeenCalledTimes(1);
        expect(readAfterTranscript).not.toHaveBeenCalled();

        await manager.suspendSession({
            sessionId: 'session-background-continuity-gap',
            reason: 'daemon_disconnected',
        });
        providerTailCursor = 'cursor-after-suspension';
        await manager.resumeSession({
            sessionId: 'session-background-continuity-gap',
            reason: 'daemon_disconnected',
        });

        expect(acquireFollowLease).toHaveBeenCalledTimes(2);
        expect(acquireFollowLease.mock.calls[1]).toEqual(['cursor-before-suspension']);
        expect(baselineTail).toHaveBeenCalledTimes(1);
        expect(readAfterTranscript).toHaveBeenCalledTimes(1);
        expect(readAfterTranscript).toHaveBeenCalledWith('cursor-before-suspension');

        await manager.resumeSession({
            sessionId: 'session-background-continuity-gap',
            reason: 'daemon_disconnected',
        });
        expect(readAfterTranscript).toHaveBeenCalledTimes(1);
        expect(releases[0]).toHaveBeenCalledTimes(1);
        expect(releases[1]).not.toHaveBeenCalled();
    });

    it('does not carry a suspended background cursor into a replacement generation', async () => {
        const firstRetirement = new AbortController();
        const secondRetirement = new AbortController();
        const firstAcquire = vi.fn(async () => ({
            release: vi.fn(async () => {}),
            readAcceptedCursor: () => 'cursor-from-retired-generation',
            requestTranscriptRefresh: vi.fn(async () => ({
                outcome: 'already_current' as const,
            })),
        }));
        const secondAcquire = vi.fn(async (_initialCursor?: string | null) => ({
            release: vi.fn(async () => {}),
            readAcceptedCursor: () => 'cursor-from-current-generation',
            requestTranscriptRefresh: vi.fn(async () => ({
                outcome: 'already_current' as const,
            })),
        }));
        const manager = createExternalSessionFollowLeaseManager();

        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-generation-fence',
            enabled: true,
            resource: {
                linkGeneration: 'link-1',
                pluginGeneration: 'plugin-1',
                retirementSignal: firstRetirement.signal,
            },
            acquireFollowLease: firstAcquire,
        });
        await manager.suspendSession({
            sessionId: 'session-generation-fence',
            reason: 'daemon_disconnected',
        });
        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-generation-fence',
            enabled: true,
            resource: {
                linkGeneration: 'link-2',
                pluginGeneration: 'plugin-2',
                retirementSignal: secondRetirement.signal,
            },
            acquireFollowLease: secondAcquire,
        });
        await manager.resumeSession({
            sessionId: 'session-generation-fence',
            reason: 'daemon_disconnected',
        });

        expect(firstAcquire).toHaveBeenCalledTimes(1);
        expect(secondAcquire).toHaveBeenCalledTimes(1);
        expect(secondAcquire.mock.calls[0]).toEqual([]);
    });

    it('drops suspended catch-up when the final transcript demand is removed', async () => {
        const acquireFollowLease = vi.fn(async () => ({
            release: vi.fn(async () => {}),
        }));
        const requestTranscriptRefresh = vi.fn(async () => ({
            outcome: 'already_current' as const,
        }));
        const manager = createExternalSessionFollowLeaseManager();
        const resource = {
            linkGeneration: 'link-generation',
            pluginGeneration: 'plugin-generation',
        };

        await manager.attach({
            sessionId: 'session-demand-removed',
            leaseId: 'first-viewer',
            ttlMs: 30_000,
            acceptedTailCursor: 'first-cursor',
            resource,
            acquireFollowLease,
            requestTranscriptRefresh,
        });
        await manager.suspendSession({
            sessionId: 'session-demand-removed',
            reason: 'takeover',
        });
        await manager.detach({
            sessionId: 'session-demand-removed',
            leaseId: 'first-viewer',
        });
        await manager.resumeSession({
            sessionId: 'session-demand-removed',
            reason: 'takeover',
        });

        await manager.attach({
            sessionId: 'session-demand-removed',
            leaseId: 'second-viewer',
            ttlMs: 30_000,
            acceptedTailCursor: 'second-cursor',
            resource,
            acquireFollowLease,
            requestTranscriptRefresh,
        });

        expect(requestTranscriptRefresh).not.toHaveBeenCalled();
    });

    it('acquires one follow lease for a viewer lease, renews its expiry, and releases it on detach', async () => {
        let nowMs = 1_000;
        const release = vi.fn(async () => {});
        const acquireFollowLease = vi.fn(async () => ({ release }));

        const manager = createExternalSessionFollowLeaseManager({
            now: () => nowMs,
            randomId: () => 'lease-1',
        });

        const attached = await manager.attach({
            sessionId: 'session-1',
            ttlMs: 30_000,
            acquireFollowLease,
        });

        expect(attached).toEqual({
            leaseId: 'lease-1',
            expiresAtMs: 31_000,
            renewed: false,
        });
        expect(acquireFollowLease).toHaveBeenCalledTimes(1);

        nowMs = 10_000;
        const renewed = await manager.attach({
            sessionId: 'session-1',
            leaseId: 'lease-1',
            ttlMs: 30_000,
            acquireFollowLease,
        });

        expect(renewed).toEqual({
            leaseId: 'lease-1',
            expiresAtMs: 40_000,
            renewed: true,
        });
        expect(acquireFollowLease).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(29_999);
        expect(release).not.toHaveBeenCalled();

        const detached = await manager.detach({
            sessionId: 'session-1',
            leaseId: 'lease-1',
        });

        expect(detached).toEqual({ detached: true });
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('releases follow leases automatically when the viewer lease expires', async () => {
        let nowMs = 5_000;
        const release = vi.fn(async () => {});
        const manager = createExternalSessionFollowLeaseManager({
            now: () => nowMs,
            randomId: () => 'lease-expiring',
        });

        await manager.attach({
            sessionId: 'session-expiring',
            ttlMs: 2_000,
            acquireFollowLease: async () => ({ release }),
        });

        await vi.advanceTimersByTimeAsync(1_999);
        expect(release).not.toHaveBeenCalled();

        nowMs = 7_100;
        await vi.advanceTimersByTimeAsync(1);

        expect(release).toHaveBeenCalledTimes(1);
        expect(manager.countActiveLeases('session-expiring')).toBe(0);
    });

    it('keeps equal caller lease ids isolated by session through expiry cleanup', async () => {
        let nowMs = 1_000;
        const firstRelease = vi.fn(async () => {});
        const secondRelease = vi.fn(async () => {});
        const manager = createExternalSessionFollowLeaseManager({
            now: () => nowMs,
        });

        await manager.attach({
            sessionId: 'session-first',
            leaseId: 'shared-caller-lease-id',
            ttlMs: 2_000,
            acquireFollowLease: async () => ({ release: firstRelease }),
        });
        await manager.attach({
            sessionId: 'session-second',
            leaseId: 'shared-caller-lease-id',
            ttlMs: 4_000,
            acquireFollowLease: async () => ({ release: secondRelease }),
        });

        nowMs = 3_100;
        await vi.advanceTimersByTimeAsync(2_000);

        expect(firstRelease).toHaveBeenCalledTimes(1);
        expect(secondRelease).not.toHaveBeenCalled();
        expect(manager.countActiveLeases('session-first')).toBe(0);
        expect(manager.countActiveLeases('session-second')).toBe(1);

        nowMs = 5_100;
        await vi.advanceTimersByTimeAsync(2_000);

        expect(firstRelease).toHaveBeenCalledTimes(1);
        expect(secondRelease).toHaveBeenCalledTimes(1);
        expect(manager.countActiveLeases('session-second')).toBe(0);
    });

    it('keeps the shared follower across attached-to-background demand transitions until disabled', async () => {
        let nowMs = 1_000;
        const attachedRelease = vi.fn(async () => {});
        const backgroundRelease = vi.fn(async () => {});
        const acquireAttachedFollowLease = vi.fn(async () => ({ release: attachedRelease }));
        const acquireBackgroundFollowLease = vi.fn(async () => ({ release: backgroundRelease }));
        const manager = createExternalSessionFollowLeaseManager({
            now: () => nowMs,
            randomId: () => 'lease-background',
        });

        await manager.attach({
            sessionId: 'session-background',
            ttlMs: 30_000,
            acquireFollowLease: acquireAttachedFollowLease,
        });
        expect(acquireAttachedFollowLease).toHaveBeenCalledTimes(1);

        const backgroundFollow = await manager.setBackgroundFollowEnabled({
            sessionId: 'session-background',
            enabled: true,
            acquireFollowLease: acquireBackgroundFollowLease,
        });

        expect(backgroundFollow).toEqual(expect.objectContaining({ enabled: true, leaseAcquired: false }));
        expect(acquireBackgroundFollowLease).toHaveBeenCalledTimes(0);

        await manager.detach({
            sessionId: 'session-background',
            leaseId: 'lease-background',
        });
        expect(attachedRelease).not.toHaveBeenCalled();
        expect(acquireBackgroundFollowLease).not.toHaveBeenCalled();
        expect(backgroundRelease).toHaveBeenCalledTimes(0);
        expect(manager.countActiveLeases('session-background')).toBe(0);
        expect(manager.hasBackgroundFollowLease('session-background')).toBe(true);

        const disabled = await manager.setBackgroundFollowEnabled({
            sessionId: 'session-background',
            enabled: false,
        });

        expect(disabled).toEqual({ enabled: false, leaseAcquired: false });
        expect(attachedRelease).toHaveBeenCalledTimes(1);
        expect(backgroundRelease).not.toHaveBeenCalled();
    });

    it('keeps the shared follower when attached demand expires but background demand remains', async () => {
        let nowMs = 1_000;
        const attachedRelease = vi.fn(async () => {});
        const backgroundRelease = vi.fn(async () => {});
        const acquireAttachedFollowLease = vi.fn(async () => ({ release: attachedRelease }));
        const acquireBackgroundFollowLease = vi.fn(async () => ({ release: backgroundRelease }));
        const manager = createExternalSessionFollowLeaseManager({
            now: () => nowMs,
            randomId: () => 'lease-expiry-background',
        });

        await manager.attach({
            sessionId: 'session-expiry-background',
            ttlMs: 2_000,
            acquireFollowLease: acquireAttachedFollowLease,
        });
        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-expiry-background',
            enabled: true,
            acquireFollowLease: acquireBackgroundFollowLease,
        });

        await vi.advanceTimersByTimeAsync(1_999);
        expect(attachedRelease).not.toHaveBeenCalled();
        expect(acquireBackgroundFollowLease).toHaveBeenCalledTimes(0);

        nowMs = 3_100;
        await vi.advanceTimersByTimeAsync(1);

        expect(attachedRelease).not.toHaveBeenCalled();
        expect(acquireBackgroundFollowLease).not.toHaveBeenCalled();
        expect(manager.countActiveLeases('session-expiry-background')).toBe(0);
        expect(manager.hasBackgroundFollowLease('session-expiry-background')).toBe(true);

        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-expiry-background',
            enabled: false,
        });
        expect(attachedRelease).toHaveBeenCalledTimes(1);
        expect(backgroundRelease).not.toHaveBeenCalled();
    });

    it('keeps a shared background follow lease alive until the last attached viewer detaches', async () => {
        const viewerRelease = vi.fn(async () => {});
        const backgroundRelease = vi.fn(async () => {});
        const acquireViewerFollowLease = vi.fn(async () => ({ release: viewerRelease }));
        const acquireBackgroundFollowLease = vi.fn(async () => ({ release: backgroundRelease }));
        const manager = createExternalSessionFollowLeaseManager({
            randomId: () => 'lease-shared-background',
        });

        const enabled = await manager.setBackgroundFollowEnabled({
            sessionId: 'session-shared-background',
            enabled: true,
            acquireFollowLease: acquireBackgroundFollowLease,
        });
        expect(enabled).toEqual(expect.objectContaining({ enabled: true, leaseAcquired: true }));
        expect(manager.hasBackgroundFollowLease('session-shared-background')).toBe(true);

        await manager.attach({
            sessionId: 'session-shared-background',
            ttlMs: 30_000,
            acquireFollowLease: acquireViewerFollowLease,
        });

        expect(acquireViewerFollowLease).not.toHaveBeenCalled();
        expect(manager.countActiveLeases('session-shared-background')).toBe(1);

        const disabled = await manager.setBackgroundFollowEnabled({
            sessionId: 'session-shared-background',
            enabled: false,
        });
        expect(disabled).toEqual({ enabled: false, leaseAcquired: false });
        expect(backgroundRelease).not.toHaveBeenCalled();

        await manager.detach({
            sessionId: 'session-shared-background',
            leaseId: 'lease-shared-background',
        });

        expect(backgroundRelease).toHaveBeenCalledTimes(1);
        expect(viewerRelease).not.toHaveBeenCalled();
    });

    it('releases all follow leases for a session idempotently during archive teardown', async () => {
        const viewerRelease = vi.fn(async () => {});
        const backgroundRelease = vi.fn(async () => {});
        const writeFollowStatus = vi.fn(async () => {});
        const manager = createExternalSessionFollowLeaseManager({
            now: () => 42_000,
            randomId: () => 'lease-archive',
            writeFollowStatus,
        });
        const resource = {
            linkGeneration: 'link-archive',
            pluginGeneration: 'plugin-archive',
        };

        await manager.attach({
            sessionId: 'session-archive',
            ttlMs: 30_000,
            resource,
            acquireFollowLease: async () => ({ release: viewerRelease }),
        });
        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-archive',
            enabled: true,
            resource,
            acquireFollowLease: async () => ({ release: backgroundRelease }),
        });

        const managerWithRelease = manager as typeof manager & Readonly<{
            releaseSession?: (input: Readonly<{ sessionId: string }>) => Promise<unknown>;
        }>;
        expect(managerWithRelease.releaseSession).toBeTypeOf('function');

        await expect(managerWithRelease.releaseSession?.({ sessionId: 'session-archive' })).resolves.toEqual({
            releasedAttachedLeases: 1,
            releasedBackgroundLease: false,
        });
        await expect(managerWithRelease.releaseSession?.({ sessionId: 'session-archive' })).resolves.toEqual({
            releasedAttachedLeases: 0,
            releasedBackgroundLease: false,
        });

        expect(viewerRelease).toHaveBeenCalledTimes(1);
        expect(backgroundRelease).not.toHaveBeenCalled();
        expect(manager.countActiveLeases('session-archive')).toBe(0);
        expect(manager.isBackgroundFollowEnabled('session-archive')).toBe(false);
        expect(manager.hasBackgroundFollowLease('session-archive')).toBe(false);
        expect(writeFollowStatus).toHaveBeenCalledTimes(2);
        expect(writeFollowStatus).toHaveBeenNthCalledWith(1, {
            sessionId: 'session-archive',
            expectedLinkGeneration: 'link-archive',
            followStatusV1: {
                v: 1,
                status: 'active',
                reason: 'viewer_attached',
                updatedAtMs: 42_000,
            },
        });
        expect(writeFollowStatus).toHaveBeenNthCalledWith(2, {
            sessionId: 'session-archive',
            expectedLinkGeneration: 'link-archive',
            followStatusV1: {
                v: 1,
                status: 'paused',
                reason: 'archived',
                updatedAtMs: 42_000,
            },
        });
    });

    it('archives atomically by discarding viewer leases while preserving background intent and source', async () => {
        const release = vi.fn(async () => {});
        const acquireBackgroundFollowLease = vi.fn(async () => ({ release }));
        const manager = createExternalSessionFollowLeaseManager({
            randomId: () => 'viewer-archive',
        });

        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-archive-preserve-background',
            enabled: true,
            acquireFollowLease: acquireBackgroundFollowLease,
        });
        await manager.attach({
            sessionId: 'session-archive-preserve-background',
            ttlMs: 30_000,
        });

        const archived = await manager.archiveSession({
            sessionId: 'session-archive-preserve-background',
        });

        expect(archived).toEqual({
            releasedAttachedLeases: 1,
            releaseSettled: true,
        });
        expect(manager.countActiveLeases(
            'session-archive-preserve-background',
        )).toBe(0);
        expect(manager.isBackgroundFollowEnabled(
            'session-archive-preserve-background',
        )).toBe(true);
        expect(manager.isSessionSuspended({
            sessionId: 'session-archive-preserve-background',
            reason: 'session_archived',
        })).toBe(true);
        expect(release).toHaveBeenCalledOnce();

        await manager.resumeSession({
            sessionId: 'session-archive-preserve-background',
            reason: 'session_archived',
        });
        expect(acquireBackgroundFollowLease).toHaveBeenCalledTimes(2);
        expect(manager.hasBackgroundFollowLease(
            'session-archive-preserve-background',
        )).toBe(true);
    });

    it('retains failed archive-release custody and retries it before unarchive can resume', async () => {
        const release = vi.fn()
            .mockRejectedValueOnce(new Error('release failed'))
            .mockResolvedValueOnce(undefined);
        const acquireFollowLease = vi.fn(async () => ({ release }));
        const manager = createExternalSessionFollowLeaseManager();

        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-archive-release-retry-owner',
            enabled: true,
            acquireFollowLease,
        });

        await expect(manager.archiveSession({
            sessionId: 'session-archive-release-retry-owner',
        })).resolves.toEqual({
            releasedAttachedLeases: 0,
            releaseSettled: false,
        });
        expect(manager.hasBackgroundFollowLease(
            'session-archive-release-retry-owner',
        )).toBe(true);
        expect(manager.isBackgroundFollowEnabled(
            'session-archive-release-retry-owner',
        )).toBe(true);

        await expect(manager.archiveSession({
            sessionId: 'session-archive-release-retry-owner',
        })).resolves.toEqual({
            releasedAttachedLeases: 0,
            releaseSettled: true,
        });
        await manager.resumeSession({
            sessionId: 'session-archive-release-retry-owner',
            reason: 'session_archived',
        });

        expect(release).toHaveBeenCalledTimes(2);
        expect(acquireFollowLease).toHaveBeenCalledTimes(2);
        expect(manager.hasBackgroundFollowLease(
            'session-archive-release-retry-owner',
        )).toBe(true);
    });

    it('does not resurrect viewer-only demand after archive and unarchive', async () => {
        const release = vi.fn(async () => {});
        const acquireFollowLease = vi.fn(async () => ({ release }));
        const manager = createExternalSessionFollowLeaseManager({
            randomId: () => 'viewer-only-archive',
        });

        await manager.attach({
            sessionId: 'session-viewer-only-archive',
            ttlMs: 30_000,
            acquireFollowLease,
        });
        await manager.archiveSession({
            sessionId: 'session-viewer-only-archive',
        });
        await manager.resumeSession({
            sessionId: 'session-viewer-only-archive',
            reason: 'session_archived',
        });

        expect(manager.countActiveLeases('session-viewer-only-archive')).toBe(0);
        expect(manager.isBackgroundFollowEnabled(
            'session-viewer-only-archive',
        )).toBe(false);
        expect(acquireFollowLease).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
        expect(manager.hasBackgroundFollowLease(
            'session-viewer-only-archive',
        )).toBe(false);
    });

    it('publishes active and disabled through one follow-status writer on acquire and release', async () => {
        let nowMs = 10_000;
        const release = vi.fn(async () => {});
        const writeFollowStatus = vi.fn(async () => {});
        const manager = createExternalSessionFollowLeaseManager({
            now: () => nowMs,
            randomId: () => 'lease-status',
            writeFollowStatus,
        });
        const resource = {
            linkGeneration: 'link-status',
            pluginGeneration: 'plugin-status',
        };

        await manager.attach({
            sessionId: 'session-status',
            ttlMs: 30_000,
            resource,
            acquireFollowLease: async () => ({ release }),
        });

        nowMs = 11_000;
        await manager.detach({
            sessionId: 'session-status',
            leaseId: 'lease-status',
        });
        await manager.detach({
            sessionId: 'session-status',
            leaseId: 'lease-status',
        });

        expect(writeFollowStatus.mock.calls).toEqual([
            [{
                sessionId: 'session-status',
                expectedLinkGeneration: 'link-status',
                followStatusV1: {
                    v: 1,
                    status: 'active',
                    reason: 'viewer_attached',
                    updatedAtMs: 10_000,
                },
            }],
            [{
                sessionId: 'session-status',
                expectedLinkGeneration: 'link-status',
                followStatusV1: {
                    v: 1,
                    status: 'disabled',
                    reason: 'follow_demand_released',
                    updatedAtMs: 11_000,
                },
            }],
        ]);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('retains a rejected terminal follow status for the existing final-release retry', async () => {
        const release = vi.fn(async () => {});
        const writeFollowStatus = vi.fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('transient metadata failure'))
            .mockResolvedValueOnce(undefined);
        const manager = createExternalSessionFollowLeaseManager({
            randomId: () => 'lease-terminal-status-retry',
            writeFollowStatus,
        });
        const resource = {
            linkGeneration: 'link-terminal-status-retry',
            pluginGeneration: 'plugin-terminal-status-retry',
        };

        await manager.attach({
            sessionId: 'session-terminal-status-retry',
            ttlMs: 30_000,
            resource,
            acquireFollowLease: async () => ({ release }),
        });
        await manager.detach({
            sessionId: 'session-terminal-status-retry',
            leaseId: 'lease-terminal-status-retry',
        });

        expect(writeFollowStatus.mock.calls.map(readPublishedFollowStatus)).toEqual([
            { status: 'active', reason: 'viewer_attached' },
            { status: 'disabled', reason: 'follow_demand_released' },
        ]);

        await manager.releaseSession({
            sessionId: 'session-terminal-status-retry',
        });

        expect(writeFollowStatus.mock.calls.map(readPublishedFollowStatus)).toEqual([
            { status: 'active', reason: 'viewer_attached' },
            { status: 'disabled', reason: 'follow_demand_released' },
            { status: 'disabled', reason: 'follow_demand_released' },
        ]);
        await manager.dispose();
    });

    it('fences every lifecycle publication to the exact actual or desired link generation', async () => {
        const firstRetirement = new AbortController();
        const secondRetirement = new AbortController();
        const writeFollowStatus = vi.fn(async () => {});
        const manager = createExternalSessionFollowLeaseManager({
            now: () => 12_000,
            randomId: () => 'lease-generation-status',
            writeFollowStatus,
        });
        const firstResource = {
            linkGeneration: 'link-1',
            pluginGeneration: 'plugin-1',
            retirementSignal: firstRetirement.signal,
        };
        const secondResource = {
            linkGeneration: 'link-2',
            pluginGeneration: 'plugin-2',
            retirementSignal: secondRetirement.signal,
        };

        await manager.attach({
            sessionId: 'session-generation-status',
            ttlMs: 30_000,
            resource: firstResource,
            acquireFollowLease: async () => ({ release: async () => {} }),
        });
        await expect(manager.setBackgroundFollowEnabled({
            sessionId: 'session-generation-status',
            enabled: true,
            resource: secondResource,
            acquireFollowLease: async () => {
                throw new Error('acquire failed');
            },
        })).rejects.toThrow('acquire failed');
        await manager.attach({
            sessionId: 'session-generation-status',
            ttlMs: 30_000,
            resource: secondResource,
            acquireFollowLease: async () => ({ release: async () => {} }),
        });
        secondRetirement.abort();
        await vi.waitFor(() => expect(writeFollowStatus).toHaveBeenCalledTimes(6));

        const publications = writeFollowStatus.mock.calls as unknown as Array<[
            Readonly<{
                followStatusV1: Readonly<{ status: string; reason: string }>;
                expectedLinkGeneration?: string;
            }>,
        ]>;
        expect(publications.map(([publication]) => ({
            status: publication.followStatusV1.status,
            reason: publication.followStatusV1.reason,
            expectedLinkGeneration: Reflect.get(publication, 'expectedLinkGeneration'),
        }))).toEqual([
            {
                status: 'active',
                reason: 'viewer_attached',
                expectedLinkGeneration: 'link-1',
            },
            {
                status: 'paused',
                reason: 'follow_source_generation_changed',
                expectedLinkGeneration: 'link-1',
            },
            {
                status: 'reacquiring',
                reason: 'follow_source_generation_changed',
                expectedLinkGeneration: 'link-2',
            },
            {
                status: 'error',
                reason: 'lease_acquire_failed',
                expectedLinkGeneration: 'link-2',
            },
            {
                status: 'active',
                reason: 'viewer_attached',
                expectedLinkGeneration: 'link-2',
            },
            {
                status: 'paused',
                reason: 'plugin_generation_retired',
                expectedLinkGeneration: 'link-2',
            },
        ]);
    });

    it('does not publish a false pause or reacquire when only the demand kind changes', async () => {
        let nowMs = 20_000;
        const attachedRelease = vi.fn(async () => {});
        const backgroundRelease = vi.fn(async () => {});
        const acquireBackgroundFollowLease = vi.fn(async () => ({ release: backgroundRelease }));
        const writeFollowStatus = vi.fn(async () => {});
        const manager = createExternalSessionFollowLeaseManager({
            now: () => nowMs,
            randomId: () => 'lease-reacquire',
            writeFollowStatus,
        });

        await manager.attach({
            sessionId: 'session-reacquire',
            ttlMs: 30_000,
            acquireFollowLease: async () => ({ release: attachedRelease }),
        });
        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-reacquire',
            enabled: true,
            acquireFollowLease: acquireBackgroundFollowLease,
        });

        nowMs = 21_000;
        await manager.detach({
            sessionId: 'session-reacquire',
            leaseId: 'lease-reacquire',
        });

        expect(writeFollowStatus.mock.calls.slice(1)).toEqual([]);
        expect(attachedRelease).not.toHaveBeenCalled();
        expect(acquireBackgroundFollowLease).not.toHaveBeenCalled();
        expect(backgroundRelease).not.toHaveBeenCalled();
    });

    it('publishes a bounded issue when replacing the source generation fails to acquire', async () => {
        let nowMs = 30_000;
        const writeFollowStatus = vi.fn(async () => {});
        const manager = createExternalSessionFollowLeaseManager({
            now: () => nowMs,
            randomId: () => 'lease-reacquire-error',
            writeFollowStatus,
        });

        await manager.attach({
            sessionId: 'session-reacquire-error',
            ttlMs: 30_000,
            resource: {
                linkGeneration: 'link-1',
                pluginGeneration: 'plugin-1',
            },
            acquireFollowLease: async () => ({ release: async () => {} }),
        });

        nowMs = 31_000;
        await expect(manager.setBackgroundFollowEnabled({
            sessionId: 'session-reacquire-error',
            enabled: true,
            resource: {
                linkGeneration: 'link-2',
                pluginGeneration: 'plugin-2',
            },
            acquireFollowLease: async () => {
                throw new Error('secret Agent failure');
            },
        })).rejects.toThrow('secret Agent failure');

        expect(writeFollowStatus).toHaveBeenLastCalledWith({
            sessionId: 'session-reacquire-error',
            expectedLinkGeneration: 'link-2',
            followStatusV1: {
                v: 1,
                status: 'error',
                reason: 'lease_acquire_failed',
                updatedAtMs: 31_000,
            },
            lastFollowIssueV1: {
                v: 1,
                code: 'follow_lease_acquire_failed',
                retryable: true,
                observedAtMs: 31_000,
            },
        });
        expect(JSON.stringify(writeFollowStatus.mock.calls)).not.toContain('secret Agent failure');
    });

    it('retains retry custody and publishes an error when Agent follow release fails', async () => {
        const release = vi.fn(async () => {});
        release.mockRejectedValueOnce(new Error('secret release failure'));
        const writeFollowStatus = vi.fn(async () => {});
        const manager = createExternalSessionFollowLeaseManager({
            now: () => 40_000,
            randomId: () => 'lease-release-error',
            writeFollowStatus,
        });
        const resource = {
            linkGeneration: 'link-release-error',
            pluginGeneration: 'plugin-release-error',
        };

        await manager.attach({
            sessionId: 'session-release-error',
            ttlMs: 30_000,
            resource,
            acquireFollowLease: async () => ({
                release,
            }),
        });
        await manager.detach({
            sessionId: 'session-release-error',
            leaseId: 'lease-release-error',
        });

        expect(writeFollowStatus).toHaveBeenLastCalledWith({
            sessionId: 'session-release-error',
            expectedLinkGeneration: 'link-release-error',
            followStatusV1: {
                v: 1,
                status: 'error',
                reason: 'lease_release_failed',
                updatedAtMs: 40_000,
            },
            lastFollowIssueV1: {
                v: 1,
                code: 'follow_lease_release_failed',
                retryable: true,
                observedAtMs: 40_000,
            },
        });
        expect(JSON.stringify(writeFollowStatus.mock.calls)).not.toContain('secret release failure');

        writeFollowStatus.mockClear();
        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-release-error',
            enabled: false,
        });

        expect(release).toHaveBeenCalledTimes(2);
        expect(writeFollowStatus).toHaveBeenLastCalledWith({
            sessionId: 'session-release-error',
            expectedLinkGeneration: 'link-release-error',
            followStatusV1: {
                v: 1,
                status: 'disabled',
                reason: 'follow_demand_released',
                updatedAtMs: 40_000,
            },
        });
    });

    it('does not acquire a replacement generation until the prior release succeeds', async () => {
        const firstRelease = vi.fn(async () => {});
        firstRelease.mockRejectedValueOnce(new Error('first release failed'));
        const replacementRelease = vi.fn(async () => {});
        const replacementAcquire = vi.fn(async () => ({
            release: replacementRelease,
        }));
        const manager = createExternalSessionFollowLeaseManager();

        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-release-before-replace',
            enabled: true,
            resource: {
                linkGeneration: 'link-first',
                pluginGeneration: 'plugin-first',
            },
            acquireFollowLease: async () => ({
                release: firstRelease,
            }),
        });

        await expect(manager.setBackgroundFollowEnabled({
            sessionId: 'session-release-before-replace',
            enabled: true,
            resource: {
                linkGeneration: 'link-second',
                pluginGeneration: 'plugin-second',
            },
            acquireFollowLease: replacementAcquire,
        })).resolves.toMatchObject({
            enabled: true,
            leaseAcquired: false,
        });
        expect(firstRelease).toHaveBeenCalledTimes(1);
        expect(replacementAcquire).not.toHaveBeenCalled();
        expect(manager.hasBackgroundFollowLease('session-release-before-replace')).toBe(true);

        await expect(manager.setBackgroundFollowEnabled({
            sessionId: 'session-release-before-replace',
            enabled: true,
            resource: {
                linkGeneration: 'link-second',
                pluginGeneration: 'plugin-second',
            },
            acquireFollowLease: replacementAcquire,
        })).resolves.toMatchObject({
            enabled: true,
            leaseAcquired: true,
        });
        expect(firstRelease).toHaveBeenCalledTimes(2);
        expect(replacementAcquire).toHaveBeenCalledTimes(1);
        expect(replacementRelease).not.toHaveBeenCalled();
    });

    it('lets exact source retirement fence a rejected release before replacement', async () => {
        const retirement = new AbortController();
        const retiredRelease = vi.fn(async () => {
            throw new Error('retired release failed');
        });
        const replacementAcquire = vi.fn(async () => ({
            release: async () => {},
        }));
        const manager = createExternalSessionFollowLeaseManager();

        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-retired-release',
            enabled: true,
            resource: {
                linkGeneration: 'link-retired',
                pluginGeneration: 'plugin-retired',
                retirementSignal: retirement.signal,
            },
            acquireFollowLease: async () => ({
                release: retiredRelease,
            }),
        });

        retirement.abort();
        await vi.waitFor(() => expect(retiredRelease).toHaveBeenCalledTimes(1));

        await expect(manager.setBackgroundFollowEnabled({
            sessionId: 'session-retired-release',
            enabled: true,
            resource: {
                linkGeneration: 'link-current',
                pluginGeneration: 'plugin-current',
            },
            acquireFollowLease: replacementAcquire,
        })).resolves.toMatchObject({
            enabled: true,
            leaseAcquired: true,
        });
        expect(retiredRelease).toHaveBeenCalledTimes(1);
        expect(replacementAcquire).toHaveBeenCalledTimes(1);
    });

    it('retains a late acquired lease until matching source retirement retries its exact release', async () => {
        const retirement = new AbortController();
        let resolveAcquisition:
            | ((lease: Readonly<{ release: () => Promise<void> }>) => void)
            | undefined;
        const acquisition = new Promise<Readonly<{
            release: () => Promise<void>;
        }>>((resolve) => {
            resolveAcquisition = resolve;
        });
        const release = vi.fn()
            .mockRejectedValueOnce(new Error('late release failed'))
            .mockResolvedValueOnce(undefined);
        const acquireFollowLease = vi.fn(async () => await acquisition);
        const manager = createExternalSessionFollowLeaseManager();

        const enabling = manager.setBackgroundFollowEnabled({
            sessionId: 'session-late-acquired-retirement',
            enabled: true,
            resource: {
                linkGeneration: 'link-late-acquired',
                pluginGeneration: 'plugin-late-acquired',
                retirementSignal: retirement.signal,
            },
            acquireFollowLease,
        });
        await vi.waitFor(() => expect(acquireFollowLease).toHaveBeenCalledOnce());

        retirement.abort();
        resolveAcquisition?.({ release });

        await expect(enabling).resolves.toEqual({
            enabled: true,
            leaseAcquired: false,
        });
        await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
        expect(manager.hasBackgroundFollowLease(
            'session-late-acquired-retirement',
        )).toBe(false);
        await manager.dispose();
    });

    it('does not let desired-source retirement fence retained custody from another generation', async () => {
        const desiredRetirement = new AbortController();
        const retainedRelease = vi.fn(async () => {
            throw new Error('retained release failed');
        });
        const retiredDesiredAcquire = vi.fn(async () => ({
            release: async () => {},
        }));
        const nextAcquire = vi.fn(async () => ({
            release: async () => {},
        }));
        const manager = createExternalSessionFollowLeaseManager();

        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-retirement-scope',
            enabled: true,
            resource: {
                linkGeneration: 'link-actual',
                pluginGeneration: 'plugin-actual',
            },
            acquireFollowLease: async () => ({
                release: retainedRelease,
            }),
        });
        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-retirement-scope',
            enabled: true,
            resource: {
                linkGeneration: 'link-retired-desired',
                pluginGeneration: 'plugin-retired-desired',
                retirementSignal: desiredRetirement.signal,
            },
            acquireFollowLease: retiredDesiredAcquire,
        });
        expect(retainedRelease).toHaveBeenCalledTimes(1);
        expect(retiredDesiredAcquire).not.toHaveBeenCalled();

        desiredRetirement.abort();
        await vi.waitFor(() => expect(retainedRelease).toHaveBeenCalledTimes(2));

        await expect(manager.setBackgroundFollowEnabled({
            sessionId: 'session-retirement-scope',
            enabled: true,
            resource: {
                linkGeneration: 'link-next',
                pluginGeneration: 'plugin-next',
            },
            acquireFollowLease: nextAcquire,
        })).resolves.toMatchObject({
            enabled: true,
            leaseAcquired: false,
        });
        expect(retainedRelease).toHaveBeenCalledTimes(3);
        expect(nextAcquire).not.toHaveBeenCalled();
    });

    it('admits refresh only for the current demanded link and plugin generation', async () => {
        const requestTranscriptRefresh = vi.fn(async () => {});
        const retirement = new AbortController();
        const manager = createExternalSessionFollowLeaseManager({
            randomId: () => 'lease-refresh',
        });
        const resource = {
            linkGeneration: 'link-current',
            pluginGeneration: 'plugin-current',
            retirementSignal: retirement.signal,
        };

        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-refresh',
            resource,
        })).resolves.toEqual({ requested: false, reason: 'not-demanded' });

        await manager.attach({
            sessionId: 'session-refresh',
            ttlMs: 30_000,
            resource,
            acquireFollowLease: async () => ({
                release: async () => {},
                requestTranscriptRefresh,
            }),
        });

        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-refresh',
            resource: {
                linkGeneration: 'link-stale',
                pluginGeneration: 'plugin-current',
            },
        })).resolves.toEqual({ requested: false, reason: 'stale-source' });
        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-refresh',
            resource: {
                linkGeneration: 'link-current',
                pluginGeneration: 'plugin-stale',
            },
        })).resolves.toEqual({ requested: false, reason: 'stale-source' });
        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-unknown',
            resource,
        })).resolves.toEqual({ requested: false, reason: 'not-demanded' });
        expect(requestTranscriptRefresh).not.toHaveBeenCalled();

        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-refresh',
            resource,
        })).resolves.toEqual({ requested: true, coalesced: false });
        expect(requestTranscriptRefresh).toHaveBeenCalledTimes(1);

        retirement.abort();
        await vi.waitFor(() => {
            expect(manager.hasTranscriptDemand({
                sessionId: 'session-refresh',
                resource,
            })).toBe(false);
        });
        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-refresh',
            resource,
        })).resolves.toEqual({ requested: false, reason: 'not-demanded' });
        expect(requestTranscriptRefresh).toHaveBeenCalledTimes(1);
    });

    it('uses the current viewer cursor for refresh without acquiring an Agent follow lease', async () => {
        const requestTranscriptRefresh = vi.fn(async (
            _cursor: string,
            isCurrent: () => boolean,
        ) => {
            expect(isCurrent()).toBe(true);
        });
        const manager = createExternalSessionFollowLeaseManager({
            randomId: () => 'viewer-opencode',
        });
        const resource = {
            linkGeneration: 'link-opencode',
            pluginGeneration: 'plugin-opencode',
        };

        await manager.attach({
            sessionId: 'session-opencode',
            ttlMs: 30_000,
            acceptedTailCursor: 'happier_external_cursor_v1:YzA',
            resource,
            requestTranscriptRefresh,
        });

        expect(manager.hasTranscriptDemand({
            sessionId: 'session-opencode',
            resource,
        })).toBe(true);
        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-opencode',
            resource,
        })).resolves.toEqual({ requested: true, coalesced: false });
        expect(requestTranscriptRefresh).toHaveBeenLastCalledWith(
            'happier_external_cursor_v1:YzA',
            expect.any(Function),
        );

        await manager.attach({
            sessionId: 'session-opencode',
            leaseId: 'viewer-opencode',
            ttlMs: 30_000,
            acceptedTailCursor: 'happier_external_cursor_v1:YzE',
            resource,
            requestTranscriptRefresh,
        });
        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-opencode',
            resource,
        })).resolves.toEqual({ requested: true, coalesced: false });
        expect(requestTranscriptRefresh).toHaveBeenLastCalledWith(
            'happier_external_cursor_v1:YzE',
            expect.any(Function),
        );

        await manager.detach({
            sessionId: 'session-opencode',
            leaseId: 'viewer-opencode',
        });
        expect(manager.hasTranscriptDemand({
            sessionId: 'session-opencode',
            resource,
        })).toBe(false);
        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-opencode',
            resource,
        })).resolves.toEqual({ requested: false, reason: 'not-demanded' });
        expect(requestTranscriptRefresh).toHaveBeenCalledTimes(2);
    });

    it('does not admit cursorless viewer demand without an actual follow lease', async () => {
        const requestTranscriptRefresh = vi.fn(async (_cursor: string) => {});
        const manager = createExternalSessionFollowLeaseManager({
            randomId: () => 'viewer-cursorless',
        });
        const resource = {
            linkGeneration: 'link-cursorless',
            pluginGeneration: 'plugin-cursorless',
        };

        await manager.attach({
            sessionId: 'session-cursorless',
            ttlMs: 30_000,
            resource,
            requestTranscriptRefresh,
        });

        expect(manager.hasTranscriptDemand({
            sessionId: 'session-cursorless',
            resource,
        })).toBe(false);
        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-cursorless',
            resource,
        })).resolves.toEqual({ requested: false, reason: 'not-demanded' });
        expect(requestTranscriptRefresh).not.toHaveBeenCalled();
    });

    it('replaces stale generation cursor demand before admitting the new current cursor', async () => {
        const firstRefresh = vi.fn(async (_cursor: string) => {});
        const secondRefresh = vi.fn(async (_cursor: string) => {});
        const manager = createExternalSessionFollowLeaseManager({
            randomId: () => 'viewer-relinked',
        });
        const firstResource = {
            linkGeneration: 'link-first',
            pluginGeneration: 'plugin-first',
        };
        const secondResource = {
            linkGeneration: 'link-second',
            pluginGeneration: 'plugin-second',
        };

        await manager.attach({
            sessionId: 'session-relinked-cursor',
            ttlMs: 30_000,
            acceptedTailCursor: 'happier_external_cursor_v1:Zmlyc3Q',
            resource: firstResource,
            requestTranscriptRefresh: firstRefresh,
        });
        await manager.attach({
            sessionId: 'session-relinked-cursor',
            leaseId: 'viewer-relinked',
            ttlMs: 30_000,
            acceptedTailCursor: 'happier_external_cursor_v1:c2Vjb25k',
            resource: secondResource,
            requestTranscriptRefresh: secondRefresh,
        });

        expect(manager.hasTranscriptDemand({
            sessionId: 'session-relinked-cursor',
            resource: firstResource,
        })).toBe(false);
        expect(manager.hasTranscriptDemand({
            sessionId: 'session-relinked-cursor',
            resource: secondResource,
        })).toBe(true);
        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-relinked-cursor',
            resource: secondResource,
        })).resolves.toEqual({ requested: true, coalesced: false });
        expect(firstRefresh).not.toHaveBeenCalled();
        expect(secondRefresh).toHaveBeenCalledWith(
            'happier_external_cursor_v1:c2Vjb25k',
            expect.any(Function),
        );
    });

    it('coalesces refresh bursts through one in-flight plus one pending current-lease request', async () => {
        let releaseFirstRefresh: (() => void) | undefined;
        const firstRefresh = new Promise<void>((resolve) => {
            releaseFirstRefresh = resolve;
        });
        const requestTranscriptRefresh = vi.fn()
            .mockImplementationOnce(async () => await firstRefresh)
            .mockResolvedValue(undefined);
        const manager = createExternalSessionFollowLeaseManager({
            randomId: () => 'lease-refresh-coalesced',
        });
        const resource = {
            linkGeneration: 'link-current',
            pluginGeneration: 'plugin-current',
        };
        await manager.attach({
            sessionId: 'session-refresh-coalesced',
            ttlMs: 30_000,
            resource,
            acquireFollowLease: async () => ({
                release: async () => {},
                requestTranscriptRefresh,
            }),
        });

        const first = manager.requestTranscriptRefresh({
            sessionId: 'session-refresh-coalesced',
            resource,
        });
        const second = manager.requestTranscriptRefresh({
            sessionId: 'session-refresh-coalesced',
            resource,
        });
        const third = manager.requestTranscriptRefresh({
            sessionId: 'session-refresh-coalesced',
            resource,
        });

        await expect(second).resolves.toEqual({ requested: true, coalesced: true });
        await expect(third).resolves.toEqual({ requested: true, coalesced: true });
        expect(requestTranscriptRefresh).toHaveBeenCalledTimes(1);

        releaseFirstRefresh?.();
        await expect(first).resolves.toEqual({ requested: true, coalesced: false });
        await vi.waitFor(() => expect(requestTranscriptRefresh).toHaveBeenCalledTimes(2));
        await Promise.resolve();
        expect(requestTranscriptRefresh).toHaveBeenCalledTimes(2);
    });

    it('runs one replacement-source refresh after an old-source refresh settles', async () => {
        let releaseFirstRefresh: (() => void) | undefined;
        const firstRefreshResult = new Promise<void>((resolve) => {
            releaseFirstRefresh = resolve;
        });
        const firstRefresh = vi.fn(async (_cursor: string) => await firstRefreshResult);
        const secondRefresh = vi.fn(async (_cursor: string) => {});
        const manager = createExternalSessionFollowLeaseManager({
            randomId: () => 'viewer-refresh-replaced',
        });
        const firstResource = {
            linkGeneration: 'link-first',
            pluginGeneration: 'plugin-first',
        };
        const secondResource = {
            linkGeneration: 'link-second',
            pluginGeneration: 'plugin-second',
        };

        await manager.attach({
            sessionId: 'session-refresh-replaced',
            ttlMs: 30_000,
            acceptedTailCursor: 'happier_external_cursor_v1:b2xk',
            resource: firstResource,
            requestTranscriptRefresh: firstRefresh,
        });
        const firstRequest = manager.requestTranscriptRefresh({
            sessionId: 'session-refresh-replaced',
            resource: firstResource,
        });
        await vi.waitFor(() => expect(firstRefresh).toHaveBeenCalledTimes(1));

        await manager.attach({
            sessionId: 'session-refresh-replaced',
            leaseId: 'viewer-refresh-replaced',
            ttlMs: 30_000,
            acceptedTailCursor: 'happier_external_cursor_v1:bmV3',
            resource: secondResource,
            requestTranscriptRefresh: secondRefresh,
        });
        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-refresh-replaced',
            resource: secondResource,
        })).resolves.toEqual({ requested: true, coalesced: true });
        expect(secondRefresh).not.toHaveBeenCalled();

        releaseFirstRefresh?.();
        await firstRequest;
        await vi.waitFor(() => expect(secondRefresh).toHaveBeenCalledTimes(1));

        expect(firstRefresh).toHaveBeenCalledTimes(1);
        expect(secondRefresh).toHaveBeenCalledWith(
            'happier_external_cursor_v1:bmV3',
            expect.any(Function),
        );
    });

    it.each([
        'source_replaced',
        'resync_required',
    ] as const)(
        'fences %s refreshes by releasing the current lease and requiring a newly resolved source',
        async (outcome) => {
            const release = vi.fn(async () => undefined);
            const staleRefresh = vi.fn(async () => ({ outcome }));
            const replacementRefresh = vi.fn(async () => undefined);
            const manager = createExternalSessionFollowLeaseManager({
                randomId: () => 'terminal-refresh-lease',
            });
            const staleResource = {
                linkGeneration: 'link-before-replacement',
                pluginGeneration: 'plugin-generation',
            };
            const replacementResource = {
                linkGeneration: 'link-after-replacement',
                pluginGeneration: 'plugin-generation',
            };

            await manager.attach({
                sessionId: 'session-terminal-refresh',
                leaseId: 'viewer-terminal-refresh',
                ttlMs: 30_000,
                acceptedTailCursor: 'happier_external_cursor_v1:c3RhbGU',
                resource: staleResource,
                acquireFollowLease: async () => ({ release }),
                requestTranscriptRefresh: staleRefresh,
            });

            await expect(manager.requestTranscriptRefresh({
                sessionId: 'session-terminal-refresh',
                resource: staleResource,
            })).resolves.toEqual({ requested: true, coalesced: false });
            expect(release).toHaveBeenCalledOnce();
            expect(staleRefresh).toHaveBeenCalledWith(
                'happier_external_cursor_v1:c3RhbGU',
                expect.any(Function),
            );
            expect(manager.hasTranscriptDemand({
                sessionId: 'session-terminal-refresh',
                resource: staleResource,
            })).toBe(false);
            await expect(manager.requestTranscriptRefresh({
                sessionId: 'session-terminal-refresh',
                resource: staleResource,
            })).resolves.toEqual({ requested: false, reason: 'not-demanded' });
            expect(staleRefresh).toHaveBeenCalledOnce();
            expect(release).toHaveBeenCalledOnce();

            await manager.attach({
                sessionId: 'session-terminal-refresh',
                leaseId: 'viewer-terminal-refresh',
                ttlMs: 30_000,
                acceptedTailCursor: 'happier_external_cursor_v1:bmV3',
                resource: replacementResource,
                acquireFollowLease: async () => ({ release: async () => undefined }),
                requestTranscriptRefresh: replacementRefresh,
            });
            await expect(manager.requestTranscriptRefresh({
                sessionId: 'session-terminal-refresh',
                resource: replacementResource,
            })).resolves.toEqual({ requested: true, coalesced: false });
            expect(replacementRefresh).toHaveBeenCalledWith(
                'happier_external_cursor_v1:bmV3',
                expect.any(Function),
            );
        },
    );

    it.each([
        'source_replaced',
        'source_unavailable',
        'read_failed',
    ] as const)(
        'publishes a typed background-follow error for %s without silently remaining active',
        async (outcome) => {
            const writeFollowStatus = vi.fn(async () => {});
            const manager = createExternalSessionFollowLeaseManager({
                now: () => 50_000,
                writeFollowStatus,
            });
            const resource = {
                linkGeneration: 'link-background-error',
                pluginGeneration: 'plugin-background-error',
            };

            await manager.setBackgroundFollowEnabled({
                sessionId: 'session-background-error',
                enabled: true,
                resource,
                acquireFollowLease: async () => ({
                    release: async () => {},
                    requestTranscriptRefresh: async () => ({ outcome }),
                }),
            });

            await expect(manager.requestTranscriptRefresh({
                sessionId: 'session-background-error',
                resource,
            })).resolves.toEqual({ requested: true, coalesced: false });

            expect(writeFollowStatus).toHaveBeenLastCalledWith({
                sessionId: 'session-background-error',
                expectedLinkGeneration: 'link-background-error',
                followStatusV1: {
                    v: 1,
                    status: 'error',
                    reason: `follow_refresh_${outcome}`,
                    updatedAtMs: 50_000,
                },
                lastFollowIssueV1: {
                    v: 1,
                    code: `follow_refresh_${outcome}`,
                    retryable: true,
                    observedAtMs: 50_000,
                },
            });
        },
    );

    it('retries a retryable transcript refresh through the existing session pump and stops after success', async () => {
        const refresh = vi.fn()
            .mockResolvedValueOnce({ outcome: 'read_failed' as const })
            .mockResolvedValueOnce({ outcome: 'already_current' as const });
        const manager = createExternalSessionFollowLeaseManager();
        const resource = {
            linkGeneration: 'link-refresh-retry',
            pluginGeneration: 'plugin-refresh-retry',
        };

        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-refresh-retry',
            enabled: true,
            resource,
            acquireFollowLease: async () => ({
                release: async () => {},
                requestTranscriptRefresh: refresh,
            }),
        });

        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-refresh-retry',
            resource,
        })).resolves.toEqual({ requested: true, coalesced: false });
        expect(refresh).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(250);
        expect(refresh).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(refresh).toHaveBeenCalledTimes(2);
        await manager.dispose();
    });

    it('cancels a retryable transcript refresh retry when its demand is released', async () => {
        const refresh = vi.fn(async () => ({ outcome: 'source_unavailable' as const }));
        const manager = createExternalSessionFollowLeaseManager({
            randomId: () => 'refresh-retry-release',
        });
        const resource = {
            linkGeneration: 'link-refresh-retry-release',
            pluginGeneration: 'plugin-refresh-retry-release',
        };

        await manager.attach({
            sessionId: 'session-refresh-retry-release',
            leaseId: 'refresh-retry-release',
            ttlMs: 30_000,
            acceptedTailCursor: 'cursor-refresh-retry-release',
            resource,
            acquireFollowLease: async () => ({ release: async () => {} }),
            requestTranscriptRefresh: refresh,
        });
        await manager.requestTranscriptRefresh({
            sessionId: 'session-refresh-retry-release',
            resource,
        });
        expect(refresh).toHaveBeenCalledTimes(1);

        await manager.detach({
            sessionId: 'session-refresh-retry-release',
            leaseId: 'refresh-retry-release',
        });
        await vi.advanceTimersByTimeAsync(10_000);

        expect(refresh).toHaveBeenCalledTimes(1);
        await manager.dispose();
    });

    it('does not let a delayed retired-plugin refresh status overwrite the current same-link generation', async () => {
        let releaseDelayedStatus: (() => void) | undefined;
        const delayedStatus = new Promise<void>((resolve) => {
            releaseDelayedStatus = resolve;
        });
        let markDelayedStatusStarted: (() => void) | undefined;
        const delayedStatusStarted = new Promise<void>((resolve) => {
            markDelayedStatusStarted = resolve;
        });
        let persistedStatus: Readonly<{ status: string; reason?: string }> | null = null;
        const writeFollowStatus = vi.fn(async (input: Readonly<{
            followStatusV1: Readonly<{ status: string; reason?: string }>;
        }>) => {
            if (input.followStatusV1.reason === 'follow_refresh_read_failed') {
                markDelayedStatusStarted?.();
                await delayedStatus;
            }
            persistedStatus = input.followStatusV1;
        });
        const firstRetirement = new AbortController();
        const manager = createExternalSessionFollowLeaseManager({
            now: () => 55_000,
            writeFollowStatus,
        });
        const firstResource = {
            linkGeneration: 'link-shared',
            pluginGeneration: 'plugin-retired',
            retirementSignal: firstRetirement.signal,
        };
        const replacementResource = {
            linkGeneration: 'link-shared',
            pluginGeneration: 'plugin-current',
        };

        await manager.attach({
            sessionId: 'session-delayed-refresh-status',
            ttlMs: 30_000,
            resource: firstResource,
            acquireFollowLease: async () => ({
                release: async () => {},
                requestTranscriptRefresh: async () => ({ outcome: 'read_failed' }),
            }),
        });
        const refresh = manager.requestTranscriptRefresh({
            sessionId: 'session-delayed-refresh-status',
            resource: firstResource,
        });
        await delayedStatusStarted;

        firstRetirement.abort();
        const replacement = manager.attach({
            sessionId: 'session-delayed-refresh-status',
            ttlMs: 30_000,
            resource: replacementResource,
            acquireFollowLease: async () => ({ release: async () => {} }),
        });
        await vi.advanceTimersByTimeAsync(0);
        releaseDelayedStatus?.();
        await Promise.all([refresh, replacement]);

        expect(persistedStatus).toMatchObject({
            status: 'active',
            reason: 'viewer_attached',
        });
    });

    it('publishes reacquiring then active around one bounded background gap recovery', async () => {
        const writeFollowStatus = vi.fn(async () => {});
        const recover = vi.fn(async () => {});
        const manager = createExternalSessionFollowLeaseManager({
            now: () => 60_000,
            writeFollowStatus,
        });
        const resource = {
            linkGeneration: 'link-background-gap',
            pluginGeneration: 'plugin-background-gap',
        };

        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-background-gap',
            enabled: true,
            resource,
            acquireFollowLease: async () => ({
                release: async () => {},
                requestTranscriptRefresh: async () => ({
                    outcome: 'gap_or_cursor_expired',
                    recover,
                }),
            }),
        });
        writeFollowStatus.mockClear();

        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-background-gap',
            resource,
        })).resolves.toEqual({ requested: true, coalesced: false });

        expect(recover).toHaveBeenCalledOnce();
        expect(writeFollowStatus).toHaveBeenNthCalledWith(1, {
            sessionId: 'session-background-gap',
            expectedLinkGeneration: 'link-background-gap',
            followStatusV1: {
                v: 1,
                status: 'reacquiring',
                reason: 'follow_refresh_gap_or_cursor_expired',
                updatedAtMs: 60_000,
            },
            lastFollowIssueV1: {
                v: 1,
                code: 'follow_refresh_gap_or_cursor_expired',
                retryable: true,
                observedAtMs: 60_000,
            },
        });
        expect(writeFollowStatus).toHaveBeenNthCalledWith(2, {
            sessionId: 'session-background-gap',
            expectedLinkGeneration: 'link-background-gap',
            followStatusV1: {
                v: 1,
                status: 'active',
                reason: 'follow_refresh_resynced',
                updatedAtMs: 60_000,
            },
            lastFollowIssueV1: {
                v: 1,
                code: 'follow_refresh_gap_or_cursor_expired',
                retryable: false,
                observedAtMs: 60_000,
            },
        });
    });

    it('publishes a typed error when a background refresh rejects', async () => {
        const writeFollowStatus = vi.fn(async () => {});
        const manager = createExternalSessionFollowLeaseManager({
            now: () => 70_000,
            writeFollowStatus,
        });
        const resource = {
            linkGeneration: 'link-background-rejection',
            pluginGeneration: 'plugin-background-rejection',
        };

        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-background-rejection',
            enabled: true,
            resource,
            acquireFollowLease: async () => ({
                release: async () => {},
                requestTranscriptRefresh: async () => {
                    throw new Error('secret refresh rejection');
                },
            }),
        });
        writeFollowStatus.mockClear();

        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-background-rejection',
            resource,
        })).resolves.toEqual({ requested: true, coalesced: false });

        expect(writeFollowStatus).toHaveBeenLastCalledWith({
            sessionId: 'session-background-rejection',
            expectedLinkGeneration: 'link-background-rejection',
            followStatusV1: {
                v: 1,
                status: 'error',
                reason: 'follow_refresh_failed',
                updatedAtMs: 70_000,
            },
            lastFollowIssueV1: {
                v: 1,
                code: 'follow_refresh_failed',
                retryable: true,
                observedAtMs: 70_000,
            },
        });
        expect(JSON.stringify(writeFollowStatus.mock.calls))
            .not.toContain('secret refresh rejection');
    });

    it.each([
        'source_replaced',
        'source_unavailable',
        'read_failed',
    ] as const)(
        'publishes a typed scoped-viewer error for %s without silently remaining active',
        async (outcome) => {
            const writeFollowStatus = vi.fn(async () => {});
            const manager = createExternalSessionFollowLeaseManager({
                now: () => 75_000,
                writeFollowStatus,
            });
            const resource = {
                linkGeneration: 'link-viewer-error',
                pluginGeneration: 'plugin-viewer-error',
            };

            await manager.attachScoped({
                sessionId: 'session-viewer-error',
                acceptedTailCursor: 'cursor-accepted',
                resource,
                acquireFollowLease: async () => ({
                    release: async () => {},
                }),
                requestTranscriptRefresh: async () => ({ outcome }),
            });
            writeFollowStatus.mockClear();

            await expect(manager.requestTranscriptRefresh({
                sessionId: 'session-viewer-error',
                resource,
            })).resolves.toEqual({ requested: true, coalesced: false });

            expect(writeFollowStatus).toHaveBeenLastCalledWith({
                sessionId: 'session-viewer-error',
                expectedLinkGeneration: 'link-viewer-error',
                followStatusV1: {
                    v: 1,
                    status: 'error',
                    reason: `follow_refresh_${outcome}`,
                    updatedAtMs: 75_000,
                },
                lastFollowIssueV1: {
                    v: 1,
                    code: `follow_refresh_${outcome}`,
                    retryable: true,
                    observedAtMs: 75_000,
                },
            });
        },
    );

    it('settles a source-replaced scoped binding once after its terminal status while keeping source unavailability retryable', async () => {
        const writeFollowStatus = vi.fn(async (_input: FollowStatusWriteInput) => {});
        const sourceReplacementNotices: Array<
            Readonly<{ status: string; reason: string }>
        > = [];
        const manager = createExternalSessionFollowLeaseManager({
            now: () => 75_500,
            writeFollowStatus,
        });
        const resource = {
            linkGeneration: 'link-scoped-terminal',
            pluginGeneration: 'plugin-scoped-terminal',
        };

        await manager.attachScoped({
            sessionId: 'session-scoped-source-replaced',
            acceptedTailCursor: 'cursor-accepted',
            resource,
            acquireFollowLease: async () => ({
                release: async () => {},
            }),
            requestTranscriptRefresh: async () => ({
                outcome: 'source_replaced' as const,
            }),
            onSourceReplaced: async () => {
                const publication = writeFollowStatus.mock.lastCall?.[0];
                sourceReplacementNotices.push({
                    status: publication?.followStatusV1.status ?? 'missing',
                    reason: publication?.followStatusV1.reason ?? 'missing',
                });
            },
        });
        writeFollowStatus.mockClear();

        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-scoped-source-replaced',
            resource,
        })).resolves.toEqual({ requested: true, coalesced: false });
        expect(sourceReplacementNotices).toEqual([{
            status: 'error',
            reason: 'follow_refresh_source_replaced',
        }]);
        expect(manager.countActiveLeases('session-scoped-source-replaced')).toBe(0);
        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-scoped-source-replaced',
            resource,
        })).resolves.toEqual({ requested: false, reason: 'not-demanded' });
        expect(sourceReplacementNotices).toHaveLength(1);

        const unavailableLease = await manager.attachScoped({
            sessionId: 'session-scoped-source-unavailable',
            acceptedTailCursor: 'cursor-accepted',
            resource,
            acquireFollowLease: async () => ({
                release: async () => {},
            }),
            requestTranscriptRefresh: async () => ({
                outcome: 'source_unavailable' as const,
            }),
            onSourceReplaced: async () => {
                sourceReplacementNotices.push({
                    status: 'unexpected',
                    reason: 'unexpected',
                });
            },
        });

        await expect(manager.requestTranscriptRefresh({
            sessionId: 'session-scoped-source-unavailable',
            resource,
        })).resolves.toEqual({ requested: true, coalesced: false });
        expect(sourceReplacementNotices).toHaveLength(1);
        expect(manager.countActiveLeases('session-scoped-source-unavailable')).toBe(1);
        await unavailableLease.release();
    });

    it('publishes scoped-viewer gap recovery and rejected-refresh outcomes through the same status writer', async () => {
        const writeFollowStatus = vi.fn(async () => {});
        const recover = vi.fn(async () => {});
        const refresh = vi.fn()
            .mockResolvedValueOnce({
                outcome: 'gap_or_cursor_expired',
                recover,
            })
            .mockRejectedValueOnce(new Error('secret scoped refresh rejection'));
        const manager = createExternalSessionFollowLeaseManager({
            now: () => 76_000,
            writeFollowStatus,
        });
        const resource = {
            linkGeneration: 'link-viewer-gap',
            pluginGeneration: 'plugin-viewer-gap',
        };

        await manager.attachScoped({
            sessionId: 'session-viewer-gap',
            acceptedTailCursor: 'cursor-accepted',
            resource,
            acquireFollowLease: async () => ({
                release: async () => {},
            }),
            requestTranscriptRefresh: refresh,
        });
        writeFollowStatus.mockClear();

        await manager.requestTranscriptRefresh({
            sessionId: 'session-viewer-gap',
            resource,
        });
        expect(recover).toHaveBeenCalledOnce();
        expect(writeFollowStatus.mock.calls.map(readPublishedFollowStatus)).toEqual([
            {
                status: 'reacquiring',
                reason: 'follow_refresh_gap_or_cursor_expired',
            },
            {
                status: 'active',
                reason: 'follow_refresh_resynced',
            },
        ]);

        writeFollowStatus.mockClear();
        await manager.requestTranscriptRefresh({
            sessionId: 'session-viewer-gap',
            resource,
        });
        expect(writeFollowStatus).toHaveBeenLastCalledWith({
            sessionId: 'session-viewer-gap',
            expectedLinkGeneration: 'link-viewer-gap',
            followStatusV1: {
                v: 1,
                status: 'error',
                reason: 'follow_refresh_failed',
                updatedAtMs: 76_000,
            },
            lastFollowIssueV1: {
                v: 1,
                code: 'follow_refresh_failed',
                retryable: true,
                observedAtMs: 76_000,
            },
        });
        expect(JSON.stringify(writeFollowStatus.mock.calls))
            .not.toContain('secret scoped refresh rejection');
    });

    it('drops a coalesced pending refresh when the current lease retires in flight', async () => {
        let releaseRefresh: (() => void) | undefined;
        const refresh = new Promise<void>((resolve) => {
            releaseRefresh = resolve;
        });
        const requestTranscriptRefresh = vi.fn(async () => await refresh);
        const retirement = new AbortController();
        const manager = createExternalSessionFollowLeaseManager({
            randomId: () => 'lease-refresh-retired',
        });
        const resource = {
            linkGeneration: 'link-current',
            pluginGeneration: 'plugin-current',
            retirementSignal: retirement.signal,
        };
        await manager.attach({
            sessionId: 'session-refresh-retired',
            ttlMs: 30_000,
            resource,
            acquireFollowLease: async () => ({
                release: async () => {},
                requestTranscriptRefresh,
            }),
        });

        const first = manager.requestTranscriptRefresh({
            sessionId: 'session-refresh-retired',
            resource,
        });
        await manager.requestTranscriptRefresh({
            sessionId: 'session-refresh-retired',
            resource,
        });
        retirement.abort();
        releaseRefresh?.();

        await first;
        await Promise.resolve();
        expect(requestTranscriptRefresh).toHaveBeenCalledTimes(1);
    });
});
