import { afterEach, expect, it } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { useSessionStatus } from '@/utils/sessions/sessionUtils';
import { useSessionRuntimeStatusSource } from './useSessionRuntimeStatusSource';

afterEach(() => standardCleanup());

it('updates the retained composer status after archive and unarchive settle', async () => {
    const previous = storage.getState();
    const session = createSessionFixture({ id: 'archive-status', serverId: 'home',
        active: false, presence: 'online', archivedAt: null, activeAt: Date.now() });
    storage.getState().applySessions([session]);
    const hook = await renderHook(() => useSessionStatus(useSessionRuntimeStatusSource(session), {
        subscribeToSession: false, subscribeToTranscript: false,
    }));
    try {
        expect(hook.getCurrent()?.state).not.toBe('archived');
        await act(async () => {
            storage.getState().applySessions([{ ...session, archivedAt: 42, updatedAt: 42 }], 'projection');
        });
        expect(storage.getState().sessions[session.id]?.archivedAt).toBe(42);
        expect(hook.getCurrent()?.state).toBe('archived');
        await act(async () => {
            storage.getState().applySessions([{ ...session, archivedAt: null, updatedAt: 43 }], 'projection');
        });
        expect(hook.getCurrent()?.state).not.toBe('archived');
    } finally {
        await hook.unmount();
        storage.setState(previous, true);
    }
});
