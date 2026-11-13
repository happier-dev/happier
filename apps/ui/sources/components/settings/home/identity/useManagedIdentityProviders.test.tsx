import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { useManagedIdentityProviders } = await import('./useManagedIdentityProviders');
// Finish the real executor graph at collection, before render waits own an Action.
await import('@/sync/ops/actions/defaultActionExecutor');
const LIST_PATH = '/v1/identity/providers/list';

async function home() {
    const serverId = await harness.addHome({ name: 'Identity Home', serverUrl: 'https://identity-wakes.example', accountId: 'account-a', teamsEnabled: true });
    harness.answer(serverId, LIST_PATH, { body: { items: [], unreadableCount: 0 } });
    return { serverId, accountId: 'account-a' };
}

describe('useManagedIdentityProviders AccountChange freshness through the real reader', () => {
    beforeEach(() => installHomeGovernanceBoundaries(harness));
    afterEach(async () => { standardCleanup(); await harness.reset(); });

    it('refreshes a Home-owned query for exact Home governance, Team-consumer and content-free wakes', async () => {
        const scope = await home();
        const rendered = await renderHook(() => useManagedIdentityProviders(scope));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().state).toMatchObject({ kind: 'ready', unreadableCount: 0 }));
        harness.answer(scope.serverId, LIST_PATH, { body: { items: [], unreadableCount: 1 } });
        await act(async () => { publishHomeAccountChange('other-home', ['home-governance']); });
        expect(harness.requestsFor(LIST_PATH)).toHaveLength(1);
        expect(rendered.getCurrent().state).toMatchObject({ kind: 'ready', unreadableCount: 0 });
        for (const [index, entityIds] of [['teams'], ['home-governance'], undefined].entries()) {
            harness.answer(scope.serverId, LIST_PATH, { body: { items: [], unreadableCount: index + 1 } });
            await act(async () => { publishHomeAccountChange(scope.serverId, entityIds); });
            await waitForHomeGovernance(() => expect(rendered.getCurrent().state).toMatchObject({ kind: 'ready', unreadableCount: index + 1, refreshing: false }));
        }
        await rendered.unmount();
    });

    it('refreshes a Team-owned query for Team and content-free wakes while excluding Home governance', async () => {
        const scope = await home();
        const rendered = await renderHook(() => useManagedIdentityProviders(scope, { kind: 'team', teamId: 'team-a' }));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().state).toMatchObject({ kind: 'ready', unreadableCount: 0 }));
        expect(harness.requestsFor(LIST_PATH)[0]?.input).toEqual({ owner: { kind: 'team', teamId: 'team-a' } });
        harness.answer(scope.serverId, LIST_PATH, { body: { items: [], unreadableCount: 1 } });
        await act(async () => { publishHomeAccountChange(scope.serverId, ['home-governance']); });
        expect(harness.requestsFor(LIST_PATH)).toHaveLength(1);
        expect(rendered.getCurrent().state).toMatchObject({ kind: 'ready', unreadableCount: 0 });
        await act(async () => { publishHomeAccountChange(scope.serverId, ['teams']); });
        await waitForHomeGovernance(() => expect(rendered.getCurrent().state).toMatchObject({ kind: 'ready', unreadableCount: 1 }));
        harness.answer(scope.serverId, LIST_PATH, { body: { items: [], unreadableCount: 2 } });
        await act(async () => { publishHomeAccountChange(scope.serverId); });
        await waitForHomeGovernance(() => expect(rendered.getCurrent().state).toMatchObject({ kind: 'ready', unreadableCount: 2 }));
        await rendered.unmount();
    });

    it('releases its subscription on unmount and reads current Home state on remount', async () => {
        const scope = await home();
        const first = await renderHook(() => useManagedIdentityProviders(scope));
        await waitForHomeGovernance(() => expect(first.getCurrent().state).toMatchObject({ kind: 'ready', unreadableCount: 0 }));
        await first.unmount();
        const requestsBeforeWake = harness.requestsFor(LIST_PATH).length;
        harness.answer(scope.serverId, LIST_PATH, { body: { items: [], unreadableCount: 1 } });
        await act(async () => { publishHomeAccountChange(scope.serverId, ['home-governance']); });
        expect(harness.requestsFor(LIST_PATH)).toHaveLength(requestsBeforeWake);
        const second = await renderHook(() => useManagedIdentityProviders(scope));
        await waitForHomeGovernance(() => expect(second.getCurrent().state).toMatchObject({ kind: 'ready', unreadableCount: 1 }));
        await second.unmount();
    });
});
