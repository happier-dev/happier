import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

// Locale is an environment boundary; these contracts exercise routes/commands, not translation loading.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const route = createExpoRouterMock();
vi.mock('expo-router', () => route.module);

beforeEach(() => {
    route.resetParams();
    route.spies.replace.mockClear();
});
afterEach(standardCleanup);

// Transform the real route graph during collection, outside the per-interaction test budget.
const Screen = (await import('@/app/(app)/server')).default;

async function renderServerRoute() {
    return renderScreen(<Screen />);
}

describe('/server legacy entry', () => {
    it('opens the Homes collection', async () => {
        await renderServerRoute();
        expect(route.spies.replace).toHaveBeenCalledWith({ pathname: '/settings/server' });
    });

    it('forwards a signed-out Home address into the welcome connection step', async () => {
        route.module.router.setParams({ url: 'https://company.example.test', auto: '1', source: 'notification' });
        await renderServerRoute();
        expect(route.spies.replace).toHaveBeenCalledWith('/?step=home&server=https%3A%2F%2Fcompany.example.test');
    });

    it('preserves an explicitly empty group seed in the new-group draft', async () => {
        route.module.router.setParams({ groupEditor: '1', groupServerIds: '[]' });
        await renderServerRoute();
        expect(route.spies.replace).toHaveBeenCalledWith({
            pathname: '/settings/server/groups/new',
            params: { groupServerIds: '[]' },
        });
    });

    it('keeps exact Home recovery outside Settings and returns to its caller even for a missing target', async () => {
        route.module.router.setParams({ recoveryProfile: 'missing-home', recoveryReturnTo: '/session/s1' });
        const screen = await renderServerRoute();
        expect(route.spies.replace).not.toHaveBeenCalled();
        expect(screen.findByTestId('home-recovery-authentication-target-unavailable')).not.toBeNull();
        await screen.pressByTestIdAsync('home-recovery-authentication-target-unavailable-action');
        expect(route.spies.replace).toHaveBeenCalledWith('/session/s1');
    });
});
