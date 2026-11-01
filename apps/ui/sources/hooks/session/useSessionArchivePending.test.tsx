import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { setActiveServerId, setServerProfileIdentityForUrl, upsertServerProfile, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { useSessionArchivePending } from './useSessionArchivePending';

describe('useSessionArchivePending', () => {
    let firstServer: ServerProfile;
    let secondServer: ServerProfile;
    beforeEach(() => {
        storage.setState({ sessionArchiveOperations: {} });
        firstServer = upsertServerProfile({ serverUrl: 'https://pending-a.example' });
        secondServer = upsertServerProfile({ serverUrl: 'https://pending-b.example' });
        setActiveServerId(firstServer.id);
    });
    afterEach(standardCleanup);

    it('follows active-server fallback across identity promotion while explicit scopes remain isolated', async () => {
        const operation = storage.getState().beginSessionArchive('same-id', firstServer.id);
        if (!operation) throw new Error('Expected archive admission');
        const fallback = await renderHook(() => useSessionArchivePending('same-id'));
        const scoped = await renderHook(() => useSessionArchivePending('same-id', firstServer.id));
        expect(fallback.getCurrent()).toBe(true);
        expect(scoped.getCurrent()).toBe(true);
        await act(async () => { setServerProfileIdentityForUrl(firstServer.serverUrl, 'srv_pending_promoted'); });
        expect(fallback.getCurrent()).toBe(true);
        expect(scoped.getCurrent()).toBe(true);
        await act(async () => { setActiveServerId(secondServer.id); });
        expect(fallback.getCurrent()).toBe(false);
        expect(scoped.getCurrent()).toBe(true);
        await act(async () => { storage.getState().finishSessionArchive(operation); });
        expect(scoped.getCurrent()).toBe(false);
    });

    it('does not rerender a session for another session archive', async () => {
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useSessionArchivePending('selected', firstServer.id);
        });
        const before = renders;
        await act(async () => { storage.getState().beginSessionArchive('unrelated', firstServer.id); });
        expect(hook.getCurrent()).toBe(false);
        expect(renders).toBe(before);
    });
});
