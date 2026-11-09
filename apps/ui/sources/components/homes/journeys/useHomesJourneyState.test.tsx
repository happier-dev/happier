import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { resetPersistentUiStateForTest } from '@/dev/testkit/cleanup/persistentUiState';
import { adoptPersonalHomeProfileAndComplete, getServerProfileById, resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { storage } from '@/sync/domains/state/storageStore';
import { useHomesReconcileState } from './useHomesJourneyState';
import { useServerAuthStatusByServerId } from '@/components/settings/server/hooks/useServerAuthStatusByServerId';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);

describe('Homes journey acknowledgement history', () => {
    beforeEach(async () => { await homes.reset(); await resetPersistentUiStateForTest(); });
    afterEach(async () => { standardCleanup(); await homes.reset(); vi.restoreAllMocks(); });

    it('settles the real signed-in Homes offer across visits without preference writes', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        const personalId = await homes.addHome({ name: 'Personal', serverUrl: 'https://personal-journey.test',
            serverIdentityId: 'srv_personal-journey', accountId: 'person' });
        await adoptPersonalHomeProfileAndComplete({ source: 'desktop-personal-home', descriptor: {
            serverUrl: 'https://personal-journey.test', homeServerIdentityId: 'srv_personal-journey', displayName: 'Personal',
        } });
        now.mockReturnValue(5_000);
        const workId = await homes.addHome({ name: 'Work', serverUrl: 'https://work-journey.test',
            serverIdentityId: 'srv_work-journey', accountId: 'person' });
        const personal = getServerProfileById(personalId);
        const work = getServerProfileById(workId);
        if (!personal || !work) throw new Error('Expected the saved Home profiles');
        const personalScopeId = resolveServerProfileScopeId(personal);
        const workScopeId = resolveServerProfileScopeId(work);
        const hook = await renderHook(useHomesReconcileState);
        await vi.waitFor(() => expect(hook.getCurrent().offer)
            .toEqual({ personalHomeId: personalScopeId, foundHomeIds: [workScopeId] }));
        const device = getPersistenceStorage();
        const preferences = storage.getState().localSettings;
        const writes = vi.spyOn(device, 'set');
        await act(async () => { hook.getCurrent().settle(); });
        expect(hook.getCurrent().offer).toBeNull();
        expect(JSON.parse(device.getString('ui-state:homes-journey-v1:acknowledged')!)).toEqual([workScopeId]);
        expect(writes.mock.calls.filter(([key]) => key === 'local-settings')).toHaveLength(0);
        expect(storage.getState().localSettings).toBe(preferences);
        await hook.unmount();
        const again = await renderHook(() => {
            const journey = useHomesReconcileState();
            return { journey, auth: useServerAuthStatusByServerId(journey.profiles) };
        });
        await vi.waitFor(() => expect(again.getCurrent().auth[workScopeId]).toBe('signedIn'));
        expect(again.getCurrent().journey.offer).toBeNull();
    });
});
