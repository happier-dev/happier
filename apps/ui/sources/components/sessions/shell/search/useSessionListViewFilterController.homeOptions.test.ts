import { afterEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';

afterEach(standardCleanup);

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

// Prepare the real filter-controller graph outside the behavioral budget.
const { buildSessionListFilterHomeOptions } = await import('./useSessionListViewFilterController');
const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { t } = await import('@/text');

describe('buildSessionListFilterHomeOptions', () => {
    it('names each Home by the canonical Home label, never by its raw address', async () => {
        // A Home saved under its address only, as a dev Home is, and a Home this device named.
        const current = await upsertServerProfile({ serverUrl: 'http://127.0.0.1:3013', name: '127.0.0.1:3013' });
        const studio = await upsertServerProfile({ serverUrl: 'https://studio.example.test', name: 'Studio' });
        await setActiveServerId(current.id, { scope: 'device' });

        const options = buildSessionListFilterHomeOptions([current.id, studio.id]);

        expect(options).toEqual([
            { serverId: current.id, label: t('settingsAccount.thisHomeTitle') },
            { serverId: studio.id, label: 'Studio' },
        ]);
    });
});
