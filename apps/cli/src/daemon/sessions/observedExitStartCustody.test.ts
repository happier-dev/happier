import { readFile, rename } from 'node:fs/promises';

import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { SessionTurnMutationReceiptV1Schema, SessionTurnMutationV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';

import { configuration } from '@/configuration';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { createDaemonSessionClientDurableMutationOutbox, createRuntimeSessionClientDurableMutationOutbox } from '@/api/session/client/transport/mutations/createSessionClientDurableMutationOutbox';
import { resolveSessionClientDurableMutationJournalPaths } from '@/api/session/client/transport/mutations/sessionClientDurableMutationPersistence';
import { writeSessionMarker, readSessionMarkerForPid, removeSessionMarker } from '../sessionRegistry';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import type { TrackedSession } from '../types';
import { applyTrackedSessionTurnLifecycle } from './applyTrackedSessionTurnLifecycle';
import { stageObservedExit } from './stageObservedExit';

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return { ...actual, rename: vi.fn(actual.rename) };
});

describe('observed exit across local admission and Home turn start', () => {
    it.each([
        { nativeStarted: false, markerFailure: 'none' },
        { nativeStarted: true, markerFailure: 'none' },
        { nativeStarted: true, markerFailure: 'transient' },
        { nativeStarted: true, markerFailure: 'persistent' },
    ] as const)('settles once with the same host identity ($nativeStarted; marker failure=$markerFailure)', async ({ nativeStarted, markerFailure }) => {
        await withConfiguredDaemonTestHome({ prefix: 'observed-exit-start-' }, async () => {
            const sessionId = 'observed-exit-session';
            const turnId = 'native-turn-incarnation-1';
            const tracked: TrackedSession = { pid: process.pid, startedBy: 'daemon', happySessionId: sessionId };
            const homeTurns = new Set<string>();
            const requests: Array<{ action: string; turnId?: string }> = [];
            // HTTP is the system boundary. Both custody owners, marker writes,
            // lifecycle production and exact receipt admission remain real.
            const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
                const mutation = SessionTurnMutationV1Schema.parse(body);
                const id = 'turnId' in mutation ? mutation.turnId : undefined;
                requests.push({ action: mutation.action, ...(id ? { turnId: id } : {}) });
                if (mutation.action === 'begin') homeTurns.add(mutation.turnId);
                const decision = id && homeTurns.has(id) ? 'applied' : 'missing-turn';
                return { status: 200, data: { success: true, applied: decision === 'applied',
                    receipt: SessionTurnMutationReceiptV1Schema.parse({
                        v: 1, sessionId, mutationId: mutation.mutationId, action: mutation.action,
                        ...(id ? { turnId: id } : {}), observedAt: mutation.observedAt,
                        decision, appliedAt: 300,
                    }),
                } };
            });
            const runtime = createRuntimeSessionClientDurableMutationOutbox({
                token: 'token', sessionId, initiallyActive: false,
                getSocket: () => null, requestReconnect: () => undefined,
            });
            const createDaemon = () => createDaemonSessionClientDurableMutationOutbox({
                token: 'token', sessionId, getSocket: () => null, requestReconnect: () => undefined,
            });
            const daemon = createDaemon();
            try {
                await writeSessionMarker({ pid: tracked.pid, happySessionId: sessionId, startedBy: 'daemon' });
                await Promise.all([runtime.awaitReady(), daemon.awaitReady()]);
                // Input admission owns an exact local identity before the native
                // Agent starts. That authority is deliberately not a Home begin.
                if (markerFailure === 'none') {
                    expect(await applyTrackedSessionTurnLifecycle({
                        trackedSessions: [tracked], sessionId, event: 'prompt_or_steer', turnId,
                    })).toEqual({ status: 'recorded', activeTurnId: turnId });
                }
                if (nativeStarted) {
                    let markerCalls = 0;
                    let markerRenameFailed = false;
                    let restorePlatform: (() => void) | undefined;
                    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
                    vi.mocked(rename).mockImplementation(async (from, to) => {
                        if (markerFailure !== 'none' && (!markerRenameFailed || markerFailure === 'persistent') && String(to).endsWith(`pid-${tracked.pid}.json`)) {
                            markerRenameFailed = true;
                            if (markerFailure === 'transient') {
                                const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
                                restorePlatform = () => platform.mockRestore();
                            }
                            throw Object.assign(new Error('Marker publication unavailable'), { code: markerFailure === 'transient' ? 'EBUSY' : 'EIO' });
                        }
                        try { await actualFs.rename(from, to); }
                        finally { restorePlatform?.(); restorePlatform = undefined; }
                    });
                    let markerAttempted!: () => void;
                    const markerAttempt = new Promise<void>(resolve => { markerAttempted = resolve; });
                    const lifecycle = createSessionTurnLifecycle({ session: { sessionId,
                        enqueueSessionTurnMutation: mutation => runtime.enqueueSessionTurnMutation(mutation),
                    }, onAcceptedTurnLifecycle: async input => {
                        markerCalls++;
                        try {
                            expect(await applyTrackedSessionTurnLifecycle({ trackedSessions: [tracked], sessionId, ...input }))
                                .toEqual({ status: 'recorded', activeTurnId: turnId });
                        } finally { markerAttempted(); }
                    } });
                    lifecycle.observeRuntimeEvent({ kind: 'turn-start', sequence: 1,
                        sessionId, emittedAtMs: 100, turnId, startedBy: 'host', agentTurnId: 'provider-turn-other' });
                    try {
                        await markerAttempt;
                        expect(tracked.activeTurnId).toBe(turnId);
                        await lifecycle.drainAcceptedLifecycle();
                        expect(markerCalls).toBe(1);
                        expect(markerRenameFailed).toBe(markerFailure !== 'none');
                    } finally {
                        lifecycle.retireAcceptedLifecyclePublication();
                        lifecycle.dispose();
                        restorePlatform?.();
                        vi.mocked(rename).mockImplementation(actualFs.rename);
                        await lifecycle.drainAcceptedLifecycle();
                    }
                    await runtime.activateDelivery();
                } else {
                    const paths = resolveSessionClientDurableMutationJournalPaths({
                        activeServerDir: configuration.activeServerDir, custody: 'runtime', sessionId,
                    });
                    await expect(readFile(paths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
                }
                expect((await readSessionMarkerForPid(tracked.pid))?.activeTurnId).toBe(markerFailure === 'persistent' ? undefined : turnId);
                await stageObservedExit({ trackedSession: tracked, observedAt: 200,
                    enqueueExactTurnEnd: mutation => daemon.enqueueExactTurnEnd(mutation),
                    releaseMarkerEvidence: async ({ markerPid }) => { await removeSessionMarker(markerPid); },
                });
                await daemon.flush('flush');
                expect(requests).toEqual([
                    ...(nativeStarted ? [{ action: 'begin', turnId }] : []),
                    { action: 'end_session', turnId },
                ]);
                const paths = resolveSessionClientDurableMutationJournalPaths({
                    activeServerDir: configuration.activeServerDir, custody: 'daemon', sessionId,
                });
                await expect(readFile(paths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
                if (!nativeStarted) {
                    expect(JSON.parse(await readFile(paths.deadLetterPath, 'utf8'))).toMatchObject({ entries: [{
                        reason: 'session_turn_mutation_rejected', diagnostic: { decision: 'missing-turn' },
                    }] });
                }
                vi.useFakeTimers();
                try {
                    await vi.advanceTimersByTimeAsync(60_000);
                    await daemon.flush('connect');
                } finally { vi.useRealTimers(); }
                await daemon.close();
                const restarted = createDaemon();
                try { await restarted.awaitReady(); await restarted.flush('startup'); }
                finally { await restarted.close(); }
                expect(requests).toHaveLength(nativeStarted ? 2 : 1);
            } finally {
                vi.useRealTimers();
                await Promise.all([runtime.close(), daemon.close()]);
                post.mockRestore();
                vi.mocked(rename).mockReset().mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename);
            }
        });
    });
});
