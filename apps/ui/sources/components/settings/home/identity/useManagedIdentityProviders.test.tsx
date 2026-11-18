import { act } from 'react-test-renderer';
import { useLayoutEffect } from 'react';
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
        let allowResponse!: () => void;
        const respondAfter = new Promise<void>(resolve => { allowResponse = resolve; });
        harness.answer(scope.serverId, LIST_PATH, { body: { items: [], unreadableCount: 1 }, respondAfter });
        const frames: Array<ReturnType<typeof useManagedIdentityProviders>['state']> = [];
        const second = await renderHook(() => {
            const result = useManagedIdentityProviders(scope);
            useLayoutEffect(() => { frames.push(result.state); });
            return result;
        });
        expect(frames[0]).toMatchObject({ kind: 'ready', unreadableCount: 0, refreshing: true });
        expect(second.getCurrent().state).toMatchObject({ kind: 'ready', unreadableCount: 0, refreshing: true });
        await act(async () => allowResponse());
        await waitForHomeGovernance(() => expect(second.getCurrent().state).toMatchObject({ kind: 'ready', unreadableCount: 1 }));
        await second.unmount();
    });

    it('withdraws the retained provider observation after the Home refuses access', async () => {
        const scope = await home();
        const first = await renderHook(() => useManagedIdentityProviders(scope));
        await waitForHomeGovernance(() => expect(first.getCurrent().state.kind).toBe('ready'));
        await first.unmount();

        harness.answer(scope.serverId, LIST_PATH, { status: 403 });
        const declined = await renderHook(() => useManagedIdentityProviders(scope));
        await waitForHomeGovernance(() => expect(declined.getCurrent().state.kind).toBe('unavailable'));
        await declined.unmount();

        harness.answer(scope.serverId, LIST_PATH, {
            body: { items: [], unreadableCount: 1 }, respondAfter: new Promise<void>(() => {}),
        });
        const again = await renderHook(() => useManagedIdentityProviders(scope));
        expect(again.getCurrent().state.kind).toBe('loading');
        await again.unmount();
    });

    it('waits for a current answer before reporting a missing provider on a detail route', async () => {
        const scope = await home();
        const list = await renderHook(() => useManagedIdentityProviders(scope));
        await waitForHomeGovernance(() => expect(list.getCurrent().state.kind).toBe('ready'));
        await list.unmount();

        let releaseResponse!: () => void;
        const respondAfter = new Promise<void>(resolve => { releaseResponse = resolve; });
        harness.answer(scope.serverId, LIST_PATH, { body: { items: [], unreadableCount: 0 }, respondAfter });
        const detail = await renderHook(() => useManagedIdentityProviders(
            scope, { kind: 'home' }, undefined, 'new-provider',
        ));
        expect(detail.getCurrent().state.kind).toBe('loading');
        await act(async () => { releaseResponse(); });
        await waitForHomeGovernance(() => expect(detail.getCurrent().state).toMatchObject({
            kind: 'ready', items: [], refreshing: false,
        }));
        await detail.unmount();
    });
});
