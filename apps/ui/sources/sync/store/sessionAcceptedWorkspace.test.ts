import { act } from 'react';
import { expect, it, onTestFinished } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';

it('pushes the Session accepted checkout without republishing unrelated Session or Project edits', async () => {
    const { useSessionAcceptedWorkspaceRef } = await import('./hooks');
    const previous = storage.getState();
    onTestFinished(() => storage.setState(previous, true));
    const scope = { serverId: 'home', accountId: 'account' };
    const checkout = { id: 'checkout', projectKey: 'project', serverId: scope.serverId, machineId: 'machine', rootPath: '/repo', createdAtMs: 0 };
    storage.setState({ profileScope: scope });
    storage.getState().activateProjectAccountRowsScope(scope);
    const rows = { scope, status: 'ready' as const, coverage: 'complete' as const, workspaceRefs: [checkout], relationships: [], organizations: [], revisionsByPhysicalKey: {} };
    storage.getState().applyProjectAccountRowsForScope(scope, rows);
    storage.getState().applySessions([createSessionFixture({ id: 'session', serverId: scope.serverId, ownerAccountId: scope.accountId,
        access: createSessionAccessFixture('owner'), metadata: { path: '/repo', host: 'tester.local', machineId: 'machine', workspaceId: checkout.id } })]);
    let renders = 0;
    const mounted = await renderHook(() => { renders++; return useSessionAcceptedWorkspaceRef('session', scope); });
    onTestFinished(() => mounted.unmount());
    expect(mounted.getCurrent()).toEqual(checkout);
    const first = mounted.getCurrent();
    const firstRenders = renders;
    await act(async () => {
        storage.getState().applySessions([createSessionFixture({ id: 'other-session', serverId: scope.serverId })]);
        storage.getState().applyProjectAccountRowsForScope(scope, { ...rows, organizations: [{
            key: { kind: 'project-organization', serverId: scope.serverId, projectKey: 'other-project' }, revision: 1, value: { pinned: true },
        }] });
    });
    expect(mounted.getCurrent()).toBe(first);
    expect(renders).toBe(firstRenders);
    await act(async () => { storage.getState().setProjectAccountRowsStatusForScope(scope, 'locked'); });
    expect(mounted.getCurrent()).toBeNull();
});
