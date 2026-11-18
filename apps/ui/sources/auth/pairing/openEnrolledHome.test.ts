import { beforeEach, describe, expect, it, vi } from 'vitest';

import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { homeProfileForTests } from '@/auth/storage/tokenStorage.testHelpers';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';

const HOME = homeProfileForTests('profile-a', 'https://home-a.test');
const alertCalls: Array<{ title: string; body: string }> = [];

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alertAsync: async (title, body = '', buttons) => {
                alertCalls.push({ title, body });
                buttons?.find((button) => button.style === 'cancel')?.onPress?.();
            },
        },
    }).module;
});

describe('openEnrolledHomeOrReturnToShell', () => {
    beforeEach(async () => {
        alertCalls.length = 0;
        await seedPersistedHomeProfilesForTests({ profiles: [HOME], activeServerId: HOME.id });
    });
    it('reports failed Home selection and returns to the shell', async () => {

        const { openEnrolledHomeOrReturnToShell } = await import('./openEnrolledHome');
        const result = await openEnrolledHomeOrReturnToShell({
            profileId: 'unsaved-profile',
            targetLabel: 'Home A',
            isCurrent: () => true,
            refreshAuth: vi.fn(async () => {}),
        });

        expect(result).toBe('returned_to_shell');
        expect(alertCalls).toHaveLength(1);
        expect(alertCalls[0].title).toBe('Home A');
    });

    it('refreshes an already-focused saved Home without any notice', async () => {

        const { openEnrolledHomeOrReturnToShell } = await import('./openEnrolledHome');
        const result = await openEnrolledHomeOrReturnToShell({
            profileId: HOME.id,
            targetLabel: 'Home A',
            isCurrent: () => true,
            refreshAuth: vi.fn(async () => {}),
        });

        expect(result).toBe('opened');
        expect(getActiveServerSnapshot().serverId).toBe(HOME.id);
        expect(alertCalls).toHaveLength(0);
    });

    it('offers the open retry when the already-focused Home cannot refresh its credential', async () => {

        const { openEnrolledHomeOrReturnToShell } = await import('./openEnrolledHome');
        const result = await openEnrolledHomeOrReturnToShell({
            profileId: HOME.id,
            targetLabel: 'Home A',
            isCurrent: () => true,
            refreshAuth: vi.fn(async () => {
                throw new Error('refresh failed');
            }),
        });

        expect(result).toBe('returned_to_shell');
        expect(alertCalls).toHaveLength(1);
        expect(alertCalls[0].title).toBe('Home A');
    });
});
