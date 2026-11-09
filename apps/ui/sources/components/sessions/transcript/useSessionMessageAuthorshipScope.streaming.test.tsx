import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';

import { useSessionMessageAuthorshipScope } from './useSessionMessageAuthorshipScope';

afterEach(() => {
    standardCleanup();
});

const SERVER_ID = 'home-authorship';

/**
 * Live: the transcript root reads authorship through this hook, and every Session record or list row
 * write during a turn (activity stamps, seq, metadata version, read cursor) re-rendered the root to
 * re-derive one boolean.
 */
describe('useSessionMessageAuthorshipScope', () => {
    it('stays quiet through Session record and list row writes and follows the collaborator fact', async () => {
        const previous = storage.getState();
        const sessionId = 'authorship-quiet';
        const session = createSessionFixture({ id: sessionId, serverId: SERVER_ID, active: true, seq: 1, hasOtherNamedCollaborator: false });
        storage.getState().applySessions([session]);
        storage.getState().applyServerScopedSessionListRowPatches(SERVER_ID, [{ sessionId, patch: { lastViewedSessionSeq: 0 } }]);
        const counts = createRenderCommitCounter();
        const hook = await renderHook(() => {
            useRenderCommitCounter(counts);
            return useSessionMessageAuthorshipScope(sessionId, SERVER_ID);
        });
        try {
            counts.reset();
            for (let write = 2; write <= 6; write++) {
                await act(async () => {
                    const current = storage.getState().sessions[sessionId]!;
                    storage.getState().applySessions([{ ...current, seq: write, updatedAt: 1000 + write,
                        meaningfulActivityAt: 1000 + write, metadataVersion: write }], 'projection');
                    storage.getState().applyServerScopedSessionListRowPatches(SERVER_ID, [{ sessionId,
                        patch: { seq: write, lastViewedSessionSeq: write, updatedAt: 1000 + write } }]);
                });
            }
            expect(counts.read()).toEqual({ renders: 0, commits: 0 });
            expect(hook.getCurrent().hasOtherNamedCollaborator).toBe(false);

            await act(async () => {
                storage.getState().applyServerScopedSessionListRowPatches(SERVER_ID, [{ sessionId,
                    patch: { hasOtherNamedCollaborator: true } }]);
            });
            expect(hook.getCurrent().hasOtherNamedCollaborator).toBe(true);
        } finally {
            await hook.unmount();
            storage.setState(previous, true);
        }
    });
});
