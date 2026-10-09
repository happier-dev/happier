import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { useManagedMachineAccountSettings } = await import('./useManagedMachineAccountSettings');
beforeEach(async () => { await harness.reset(); });
afterEach(() => standardCleanup());

describe('managed creation preferences on the addressed Account', () => {
    it('reads the saved Home rather than the focused Home and withdraws its preferences when custody retires', async () => {
        const target = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'owner' });
        await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' });
        const settings = { managedMachineCreationEnabled: false, machineRetentionDefaultsV1: { v: 1, local: {
            retention: { kind: 'unused', afterMs: 17_500, effect: 'stop' }, wakeOnAcceptedMessage: true,
        } } };
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        const hook = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(target);
            return { binding: binding?.scope, preferences: useManagedMachineAccountSettings(binding) };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().binding).toMatchObject({ accountId: 'owner' }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.loading).toBe(false));
        expect(hook.getCurrent().preferences).toMatchObject({ settings, loading: false, error: null });
        expect(harness.requestsFor('/v2/account/settings').every(request => request.serverId === target)).toBe(true);
        harness.answer(target, '/v2/account/settings', { status: 403, body: { error: 'permission_denied' } });
        await act(async () => { await harness.switchAccount(target, 'replacement'); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.settings).toBeNull());
        await hook.unmount();
    });
});
