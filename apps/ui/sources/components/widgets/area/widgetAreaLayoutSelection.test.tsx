import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
installDisconnectedServerSocketBoundary();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
// The answering app publishes Sync before loading its UI Action consumers.
await loadSyncSingletonForTests();
const { useCorePageWidgetAreaBinding } = await import('./useCorePageWidgetAreaBinding');
const { useWidgetAreaLayout } = await import('./useWidgetAreaLayout');
const { createUiClientActionReverseHandler } = await import('@/sync/ops/actions/clientActionReverseDispatch');
const { API_TOKEN_FULL_GRANT_V1 } = await import('@happier-dev/protocol/auth/apiTokenGrant');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId: string;
beforeEach(async () => {
    await homes.reset();
    serverId = await homes.addHome({ name: 'Home', serverUrl: 'https://area-selection.test', accountId: 'account-a' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://area-selection.test', accountId: 'account-a', request: homes.request });
    installHomeGovernanceBoundaries(homes);
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
});

it('select through the answering client changes the mounted document and refuses after unmount', async () => {
    const routeChanges: string[] = [];
    const input = { serverId, pageId: 'automation', area: 'main', context: {}, onSelectLayout: (id: string) => routeChanges.push(id), presets: [
        { id: 'overview', name: 'Overview', items: [{ kind: 'widget' as const,
            instance: { v: 1 as const, id: 'child', definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: {} } }] },
        { id: 'empty', name: 'Empty', items: [] },
    ] };
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        return { binding, layout: useWidgetAreaLayout(binding.port!, input.context) };
    });
    await vi.waitFor(() => expect(hook.getCurrent().layout.state).toMatchObject({ status: 'ready', placements: [{ instance: { id: 'child' } }] }));
    const surface = hook.getCurrent().binding.surface!;
    const receive = createUiClientActionReverseHandler({ serverId: surface.serverId, accountId: surface.accountId, isCurrent: () => true });
    const execute = async (selectedSurface: typeof surface) => (await receive({ v: 1, actionId: 'widgets.area.layout.select', input: { surface: selectedSurface },
        context: { surface: 'mcp', authority: 'account_automation', externalActionCredential: {
            accountId: surface.accountId, principalId: 'select-only', credentialId: 'select-only',
            grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['widgets.area.layout.select'] } },
        } } }, { signal: new AbortController().signal })).execution;
    await act(async () => {
        const result = await execute({ ...surface, owner: { ...surface.owner, layoutId: 'empty' } });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    });
    await vi.waitFor(() => expect(hook.getCurrent().layout.state).toMatchObject({ status: 'ready', surface: { owner: { layoutId: 'empty' } }, placements: [] }));
    expect(routeChanges).toEqual(['empty']);
    expect(homes.artifacts(serverId).list()).toEqual([]);
    await hook.unmount();
    expect(await execute(surface)).toMatchObject({ ok: false, errorCode: 'widget_area_layout_owner_unavailable' });
});

it('refuses an ambiguous mounted area without changing either owner', async () => {
    const input = { serverId, pageId: 'twice', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [] }, { id: 'empty', name: 'Empty', items: [] },
    ] };
    const hook = await renderHook(() => ({ first: useCorePageWidgetAreaBinding(input), second: useCorePageWidgetAreaBinding(input) }));
    const surface = hook.getCurrent().first.surface!;
    expect(await createDefaultActionExecutor().execute('widgets.area.layout.select', {
        surface: { ...surface, owner: { ...surface.owner, layoutId: 'empty' } },
    }, { surface: 'ui', serverId: surface.serverId, expectedAccountId: surface.accountId })).toMatchObject({
        ok: false, errorCode: 'widget_area_layout_owner_ambiguous',
    });
    expect(hook.getCurrent().first.surface).toEqual(surface);
    expect(hook.getCurrent().second.surface).toEqual(surface);
    await hook.unmount();
});
