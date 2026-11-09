import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Leaf testkit imports keep this route suite independent of unrelated in-flight fixtures.
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
// Authentication is an external credential boundary; legacy redirects must not require it.
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: false, refreshFromActiveServer: async () => {} }),
}));

// Transform the real route graph during collection, outside the per-interaction test budget.
const Screen = (await import('@/app/(app)/setup/wizard')).default;

describe('legacy setup destinations', () => {
    beforeEach(() => route.resetParams());
    afterEach(standardCleanup);

    it.each([
        [{ scope: 'machine', action: 'local' }, '/settings/machines/add?path=thisComputer'],
        [{ scope: 'machine', action: 'remote' }, '/settings/machines/add?path=ssh'],
        [{ scope: 'machine' }, '/settings/machines/add'],
        [{}, '/'],
        [{ scope: 'all', step: 'remote_ssh_setup' }, '/'],
        [{ scope: ['machine', 'relay'], action: 'local' }, '/'],
    ])('redirects %j to %s', async (params, destination) => {
        route.module.router.setParams(params);
        const screen = await renderScreen(<Screen />);
        expect(screen.findByType('Redirect').props.href).toEqual(destination);
    });

    it('opens the welcome Home step for a signed-out legacy Home setup entry', async () => {
        route.module.router.setParams({ scope: 'relay' });
        const screen = await renderScreen(<Screen />);
        expect(route.spies.replace).toHaveBeenLastCalledWith('/?step=home');
        expect(screen.findAllByType('Redirect')).toHaveLength(0);
    });

    it('preserves an issued account-service callback while removing the legacy mode', async () => {
        route.module.router.setParams({
            mode: 'account-entry', accountServiceReturn: '1', accountServiceIdentity: 'service-1',
        });
        const screen = await renderScreen(<Screen />);
        expect(screen.findByType('Redirect').props.href).toEqual({
            pathname: '/homes/sign-in',
            params: { accountServiceReturn: '1', accountServiceIdentity: 'service-1' },
        });
    });
});
