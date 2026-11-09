// @vitest-environment jsdom
import * as React from 'react';
import { useRouter as useExpoRouter } from 'expo-router';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { normalizePluginUiDestinationBindingV1, type PluginUiLaunchInputV1 } from '@happier-dev/protocol/plugins/ui';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { storage } from '@/sync/domains/state/storageStore';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable,
    publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { resolvePluginPages } from './pluginPages';
import { clearActiveUnsavedChangesGuard, setActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import type { UnsavedChangesDecision } from '@/utils/ui/promptUnsavedChangesAlert';
import { withInternalRouteQueryParams } from '@/utils/path/routeUtils';
import { createPluginPageOpenSurfaceHandler, PluginPageLaunchInputScope, usePluginPageExplicitNavigation, usePluginPageLaunch, usePluginPageLaunchInputStaging } from './pluginPageNavigation';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';

const native = vi.hoisted(() => ({ platform: 'ios', pathname: '/', initialUrl: null as string | null,
    pushes: [] as string[], listeners: new Set<(event: { url: string }) => void>() }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return native.platform; } }, Linking: {
        getInitialURL: async () => native.initialUrl,
        addEventListener: (_event: string, listener: (event: { url: string }) => void) => {
            native.listeners.add(listener);
            return { remove: () => { native.listeners.delete(listener); } };
        },
    } });
});
// Expo is the OS URL/navigation boundary; launch custody and delivery stay real.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => native.pathname,
        router: { push: href => { native.pushes.push(String(href)); } } }).module;
});

const pluginId = 'acme.notes';
const localId = 'notes';
const subPath = 'entries/42';
const route = `/plugins/${pluginId}/${localId}/${subPath}`;
const binding = normalizePluginUiDestinationBindingV1({ pluginId, destinationId: localId,
    rendererId: 'notes-renderer', container: 'appPage', target: { kind: 'app' } });
if (!binding) throw new Error('Expected an admitted app-page binding');
const placement: PluginUiSurfacePlacementProjection = {
    id: `surfacePlacement:${pluginId}:${localId}`, pluginId, occurrenceId: 'notes-occurrence',
    contributionKind: 'surfacePlacement', descriptorId: localId, binding, target: binding.target,
    renderer: { kind: 'reactNative', contributionId: 'notes-renderer' },
    display: { developerFallback: 'Notes' }, headerActions: [],
    availability: { state: 'available', reason: 'available', diagnostics: [] },
    hostOrigin: { serverId: 'server-1', machineId: 'machine-1', phase: 'current', interactionEnabled: true,
        executionOrigin: null },
};
const pages = resolvePluginPages({ target: { kind: 'app' }, placements: [placement] });
let navigationTimingDescriptor: PropertyDescriptor | undefined;
const initialStorage = storage.getState();
const initialAppliedServer = getAppliedActiveServerSnapshot();
const initialRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();

beforeEach(() => {
    native.platform = 'ios';
    native.initialUrl = null;
    native.pathname = route;
    native.listeners.clear();
    native.pushes = [];
    storage.setState({ profileScope: { serverId: 'server-1', accountId: 'ingress-account' } });
    publishAppliedActiveServerSnapshot({ serverId: 'server-1', serverUrl: 'https://ingress.test', generation: 1 });
    expect(captureActiveServerAccountScopeLifetime()?.isCurrent()).toBe(true);
    navigationTimingDescriptor = Object.getOwnPropertyDescriptor(window.performance, 'getEntriesByType');
    window.history.replaceState(null, '', route);
});
afterEach(async () => {
    await standardCleanup();
    clearActiveUnsavedChangesGuard();
    vi.restoreAllMocks();
    if (navigationTimingDescriptor) Object.defineProperty(window.performance, 'getEntriesByType', navigationTimingDescriptor);
    else Reflect.deleteProperty(window.performance, 'getEntriesByType');
    retireActiveServerAccountScopeLifetime();
    storage.setState(initialStorage, true);
    publishAppliedActiveServerSnapshot(initialAppliedServer, initialRuntimeAvailable);
});

it('opens a qualified plugin page through the window effect with its relaunch location and no copied launch input', async () => {
    const opened: string[] = [];
    const staged: unknown[] = [];
    const open = createPluginPageOpenSurfaceHandler({ pages, placements: [placement],
        accountLifetime: captureActiveServerAccountScopeLifetime(),
        navigate: () => { throw new Error('window open must not replace the current route'); },
        stageLaunchInput: value => { staged.push(value); return true; },
        openWindow: async href => { opened.push(href); return { ok: true }; },
    });
    expect(await open({ destination: binding.destination, presentation: 'window', subPath })).toEqual({ ok: true });
    expect(opened).toEqual([route]);
    expect(staged).toEqual([]);
});

async function mountIngress(options: Readonly<{ cold?: boolean; restoreLayout?: boolean; retained?: boolean; initialSubPath?: string }> = {}) {
    let launch: ReturnType<typeof usePluginPageLaunch> = null;
    let hiddenLaunch: ReturnType<typeof usePluginPageLaunch> = null;
    let visible = true;
    let stage: ReturnType<typeof usePluginPageLaunchInputStaging> | null = null;
    let navigate: ReturnType<typeof usePluginPageExplicitNavigation> | null = null;
    let currentSubPath = options.initialSubPath ?? subPath;
    let mirrorRevision = 0;
    let admittedPages = options.cold ? [] : pages;
    function Probe() {
        stage = usePluginPageLaunchInputStaging();
        navigate = usePluginPageExplicitNavigation();
        launch = usePluginPageLaunch({ pluginId, localId, subPath: currentSubPath });
        return null;
    }
    function RestoreLayout() {
        React.useLayoutEffect(() => {
            native.pathname = route;
            window.history.replaceState(null, '', route);
        }, [mirrorRevision]);
        return null;
    }
    function HiddenProbe() {
        hiddenLaunch = usePluginPageLaunch({ pluginId, localId, subPath: currentSubPath });
        return null;
    }
    const destination = { kind: `plugin:${pluginId}:${localId}`, params: { pluginId, localId, subPath } };
    function RetainedProbes() {
        const navigation = useExpoRouter();
        return <>
            <DestinationInstanceHost tabId="hidden" ref={destination} pathname={route} focused={false} visible={false} navigation={navigation}><HiddenProbe /></DestinationInstanceHost>
            <DestinationInstanceHost tabId="selected" ref={destination} pathname={route} focused={visible} visible={visible} navigation={navigation}><Probe /></DestinationInstanceHost>
        </>;
    }
    const render = () => <PluginPageLaunchInputScope target={{ kind: 'app' }} pages={admittedPages} pluginUiProjection={null}>
        {options.restoreLayout ? <RestoreLayout /> : null}
        {options.retained ? <RetainedProbes /> : <Probe />}
    </PluginPageLaunchInputScope>;
    const screen = await renderScreen(render());
    return { read: () => launch, readHidden: () => hiddenLaunch,
        visibility: async (next: boolean) => { visible = next; await screen.update(render()); }, open: () => {
        if (!stage) throw new Error('Missing mounted launch staging');
        return stage({ pageId: `plugin:${pluginId}:${localId}`, subPath, input: undefined });
    }, openAt: (next: string, input: PluginUiLaunchInputV1) => {
        if (!stage) throw new Error('Missing mounted launch staging');
        return createPluginPageOpenSurfaceHandler({ pages, placements: [placement],
            accountLifetime: captureActiveServerAccountScopeLifetime(),
            stageLaunchInput: stage, navigate: href => { native.pushes.push(href); },
        })({ destination: placement.binding.destination, subPath: next, input });
    }, move: async (next: string) => {
        currentSubPath = next;
        native.pathname = `/plugins/${pluginId}/${localId}${next ? `/${next}` : ''}`;
        window.history.replaceState(null, '', native.pathname);
        await screen.update(render());
    },
    navigate: () => {
        if (!navigate) throw new Error('Missing explicit route adapter');
        navigate(route);
    },
    reconcileParentMirror: async () => {
        // Expo can render its parent URL while its child layout reconciles
        // the still-addressed deep link. There is no committed navigation away.
        native.pathname = '/';
        window.history.replaceState(null, '', '/');
        mirrorRevision += 1;
        await screen.update(render());
    },
    admitPages: async () => { admittedPages = pages; await screen.update(render()); } };
}

it('delivers a fresh open only to the visible physical destination and does not replay it when a retained page returns', async () => {
    native.platform = 'web';
    Object.defineProperty(window.performance, 'getEntriesByType', { configurable: true,
        value: vi.fn(() => [{ type: 'navigate' }]) });
    const mounted = await mountIngress({ retained: true });
    expect(mounted.readHidden(), 'A retained hidden page has no renderer to receive this open').toBeNull();
    expect(mounted.read()).toMatchObject({ pageId: `plugin:${pluginId}:${localId}`, subPath });
    await mounted.visibility(false);
    expect(mounted.read()).toBeNull();
    await mounted.visibility(true);
    expect(mounted.read(), 'Restoring the retained page is not another explicit open').toBeNull();
});

it('delivers an inputless in-app open through the existing staged page launch', async () => {
    const mounted = await mountIngress();
    expect(mounted.read()).toBeNull();
    await act(async () => { expect(mounted.open()).toBe(true); });
    expect(mounted.read()).toMatchObject({ pageId: `plugin:${pluginId}:${localId}`, subPath, input: undefined });
    await mounted.move('');
    await mounted.move(subPath);
    expect(mounted.read(), 'Back must not restage a previously consumed open').toBeNull();
});

it('delivers an in-app root open across the source layout mirror before navigation settles', async () => {
    native.platform = 'web';
    const mounted = await mountIngress({ restoreLayout: true });
    const input = { entryRef: { entryId: '55' } };
    await act(async () => { expect(await mounted.openAt('', input)).toEqual({ ok: true }); });
    await mounted.reconcileParentMirror();
    expect(window.location.pathname).toBe(route);
    await mounted.move('');
    expect(mounted.read()).toMatchObject({ subPath: '', input });
    await mounted.move(subPath);
    await mounted.move('');
    expect(mounted.read(), 'Back does not replay a consumed input').toBeNull();
});

it.each(['web', 'ios'])('retains a staged root launch while the old source location is still observed before %s navigation', async platform => {
    native.platform = platform;
    const origin = 'e,acme.notes,notes,finding,repo:1,1';
    // The workspace and browser can publish different encodings of this SAME
    // source route before the destination commits (LIVE53 r88).
    native.pathname = `/plugins/${pluginId}/${localId}/${encodeURIComponent(origin)}`;
    window.history.replaceState(null, '', native.pathname);
    const mounted = await mountIngress({ initialSubPath: origin });
    const input = { entryRef: { entryId: '55' } };
    await act(async () => { expect(await mounted.openAt('', input)).toEqual({ ok: true }); });
    await mounted.move(origin);
    expect(mounted.read(), 'The source is not the addressed destination').toBeNull();
    await mounted.move('');
    expect(mounted.read()).toMatchObject({ pageId: `plugin:${pluginId}:${localId}`, subPath: '', input });
    await mounted.move(origin);
    await mounted.move('');
    expect(mounted.read(), 'Back must not replay the consumed launch').toBeNull();

    await act(async () => { expect(await mounted.openAt('entries/55', input)).toEqual({ ok: true }); });
    await mounted.move('entries/another');
    await mounted.move('entries/55');
    expect(mounted.read(), 'A departure from both origin and destination still withdraws the pending launch').toBeNull();
});

it('retires the origin exemption on arrival even while the destination renderer is hidden', async () => {
    native.platform = 'web';
    const mounted = await mountIngress({ retained: true });
    await mounted.visibility(false);
    await act(async () => { expect(await mounted.openAt('', { entryRef: { entryId: '55' } })).toEqual({ ok: true }); });
    await mounted.move('');
    expect(mounted.read()).toBeNull();
    await mounted.move(subPath);
    await mounted.move('');
    await mounted.visibility(true);
    expect(mounted.read(), 'Returning to the origin after arrival must not preserve an undelivered input for Back').toBeNull();
});

it.each(['initial URL', 'Linking event'] as const)('stages a native explicit plugin-page open from %s', async ingress => {
    const url = `happier://${route.slice(1)}`;
    if (ingress === 'initial URL') native.initialUrl = url;
    const mounted = await mountIngress();
    if (ingress === 'Linking event') {
        await act(async () => { for (const listener of native.listeners) listener({ url }); });
    }
    await vi.waitFor(() => expect(mounted.read()).toMatchObject({ pageId: `plugin:${pluginId}:${localId}`, subPath, input: undefined }));
    await mounted.move('');
    await mounted.move(subPath);
    expect(mounted.read(), 'Native route restoration must not replay the ingress').toBeNull();
});

it.each(['navigate', 'reload', 'back_forward'] as const)('stages only fresh web navigation, not restored %s', async navigationType => {
    native.platform = 'web';
    // PerformanceNavigationTiming is the genuine browser ingress boundary.
    Object.defineProperty(window.performance, 'getEntriesByType', { configurable: true,
        value: vi.fn(() => [{ type: navigationType }]) });
    const mounted = await mountIngress();
    if (navigationType === 'navigate') {
        await vi.waitFor(() => expect(mounted.read()).toMatchObject({ pageId: `plugin:${pluginId}:${localId}`, subPath, input: undefined }));
    } else expect(mounted.read()).toBeNull();
    await mounted.move('');
    await mounted.move(subPath);
    expect(mounted.read(), 'Restoring a visited page must stage zero explicit launches').toBeNull();
});

it('retains one native explicit open in the existing handoff until its page authority is admitted', async () => {
    const mounted = await mountIngress({ cold: true });
    await act(async () => { for (const listener of native.listeners) listener({ url: `happier://${route.slice(1)}` }); });
    expect(mounted.read()).toBeNull();
    await mounted.admitPages();
    await vi.waitFor(() => expect(mounted.read()).toMatchObject({ pageId: `plugin:${pluginId}:${localId}`, subPath, input: undefined }));
    await mounted.move('');
    await mounted.move(subPath);
    expect(mounted.read()).toBeNull();
});

it('retains a fresh web ingress through a parent URL mirror reconciled by the child layout', async () => {
    native.platform = 'web';
    Object.defineProperty(window.performance, 'getEntriesByType', { configurable: true,
        value: vi.fn(() => [{ type: 'navigate' }]) });
    const mounted = await mountIngress({ cold: true, restoreLayout: true });
    expect(mounted.read()).toBeNull();
    await mounted.reconcileParentMirror();
    expect(window.location.pathname).toBe(route);
    await mounted.admitPages();
    expect(mounted.read(), 'The committed deep link never left; its startup launch still belongs to this page')
        .toMatchObject({ pageId: `plugin:${pluginId}:${localId}`, subPath, input: undefined });
    await mounted.move('');
    await mounted.move(subPath);
    expect(mounted.read(), 'A real navigation away must still retire the launch before Back').toBeNull();
});

it.each(['native initial URL', 'fresh web navigate'] as const)('retains a startup explicit open before applied Account admission from %s', async ingress => {
    // Boot hydrates this Account before its carrier/transport can become applied.
    publishAppliedActiveServerRuntimeAvailability(false);
    expect(storage.getState().profileScope).toEqual({ serverId: 'server-1', accountId: 'ingress-account' });
    expect(captureActiveServerAccountScopeLifetime()).toBeNull();
    if (ingress === 'native initial URL') native.initialUrl = `happier://${route.slice(1)}`;
    else {
        native.platform = 'web';
        Object.defineProperty(window.performance, 'getEntriesByType', { configurable: true,
            value: vi.fn(() => [{ type: 'navigate' }]) });
    }
    const mounted = await mountIngress({ cold: true });
    expect(mounted.read()).toBeNull();
    await act(async () => {
        publishAppliedActiveServerSnapshot({ serverId: 'server-1', serverUrl: 'https://ingress.test', generation: 1 });
    });
    await mounted.admitPages();
    await vi.waitFor(() => expect(mounted.read()).toMatchObject({
        pageId: `plugin:${pluginId}:${localId}`, subPath, input: undefined,
        authority: { accountLifetime: { scope: { serverId: 'server-1', accountId: 'ingress-account' } } },
    }));
    await mounted.move('');
    await mounted.move(subPath);
    expect(mounted.read(), 'One startup open must not replay when Back restores its route').toBeNull();
});

it('refuses a startup explicit open naming a different Home before applied admission', async () => {
    publishAppliedActiveServerRuntimeAvailability(false);
    expect(storage.getState().profileScope).toEqual({ serverId: 'server-1', accountId: 'ingress-account' });
    expect(captureActiveServerAccountScopeLifetime()).toBeNull();
    // The URL, not the unadmitted local Profile, names the intended Home.
    const qualifiedRoute = withInternalRouteQueryParams(route, { serverId: 'other-home' });
    native.initialUrl = `happier://${qualifiedRoute.slice(1)}`;
    const mounted = await mountIngress({ cold: true });
    expect(mounted.read()).toBeNull();
    await act(async () => {
        storage.setState({ profileScope: { serverId: 'server-1', accountId: 'account-b' } });
        publishAppliedActiveServerSnapshot({ serverId: 'server-1', serverUrl: 'https://ingress.test', generation: 2 });
    });
    await mounted.admitPages();
    expect(mounted.read(), 'An explicitly different Home must not bind to the first admitted Account').toBeNull();
    await act(async () => {
        for (const listener of native.listeners) listener({ url: `happier://${route.slice(1)}` });
    });
    await vi.waitFor(() => expect(mounted.read()?.authority.accountLifetime?.scope.accountId).toBe('account-b'));
});

it('withdraws a cold explicit open synchronously when its captured Account retires', async () => {
    // Drive the real scope producers; no synthetic Account lifetime or store reader.
    storage.setState({ profileScope: { serverId: 'server-1', accountId: 'account-a' } });
    publishAppliedActiveServerSnapshot({ serverId: 'server-1', serverUrl: 'https://ingress.test', generation: 1 });
    const accountA = captureActiveServerAccountScopeLifetime();
    expect(accountA?.isCurrent()).toBe(true);
    const mounted = await mountIngress({ cold: true });
    const deliver = () => { for (const listener of native.listeners) listener({ url: `happier://${route.slice(1)}` }); };
    await act(async () => { deliver(); });
    publishAppliedActiveServerRuntimeAvailability(false);
    expect(accountA?.isCurrent()).toBe(false);
    storage.setState({ profileScope: { serverId: 'server-1', accountId: 'account-b' } });
    publishAppliedActiveServerSnapshot({ serverId: 'server-1', serverUrl: 'https://ingress.test', generation: 2 });
    await mounted.admitPages();
    expect(mounted.read(), 'Account A\'s unresolved open must not become Account B\'s launch').toBeNull();
    await act(async () => { deliver(); });
    await vi.waitFor(() => expect(mounted.read()?.authority.accountLifetime?.scope.accountId).toBe('account-b'));
});

it('does not deliver a cold explicit open on Back after its original navigation was left', async () => {
    const mounted = await mountIngress({ cold: true });
    await act(async () => { for (const listener of native.listeners) listener({ url: `happier://${route.slice(1)}` }); });
    await mounted.move('');
    await mounted.admitPages();
    await mounted.move(subPath);
    expect(mounted.read(), 'Back restores a route; it must not consume an abandoned explicit-open handoff').toBeNull();
});

it('does not turn a persisted layout restoration into a fresh document open', async () => {
    native.platform = 'web';
    native.pathname = '/';
    window.history.replaceState(null, '', '/');
    Object.defineProperty(window.performance, 'getEntriesByType', { configurable: true,
        value: vi.fn(() => [{ type: 'navigate' }]) });
    const mounted = await mountIngress({ restoreLayout: true });
    await mounted.admitPages();
    expect(window.location.pathname).toBe(route);
    expect(mounted.read()).toBeNull();
});

it('does not lend a guarded explicit open to an Account admitted while the decision was pending', async () => {
    const mounted = await mountIngress();
    const accountA = captureActiveServerAccountScopeLifetime();
    const decision = createDeferred<UnsavedChangesDecision>();
    const dirty = { current: true };
    setActiveUnsavedChangesGuard({ isDirtyRef: dirty, tag: 'ingress-page', requestDecision: () => decision.promise });
    await act(async () => { mounted.navigate(); });
    expect(native.pushes).toEqual([]);
    expect(mounted.read()).toBeNull();
    publishAppliedActiveServerRuntimeAvailability(false);
    expect(accountA?.isCurrent()).toBe(false);
    storage.setState({ profileScope: { serverId: 'server-1', accountId: 'account-b' } });
    publishAppliedActiveServerSnapshot({ serverId: 'server-1', serverUrl: 'https://ingress.test', generation: 2 });
    await mounted.admitPages();
    await act(async () => { decision.resolve('discard'); });
    await vi.waitFor(() => expect(dirty.current).toBe(false));
    expect(native.pushes).toEqual([]);
    expect(mounted.read()).toBeNull();
    await act(async () => { mounted.navigate(); });
    await vi.waitFor(() => expect(native.pushes).toEqual([route]));
    expect(mounted.read()?.authority.accountLifetime?.scope.accountId).toBe('account-b');
});

it('keeps the launch scope context still when its provider re-renders with an equal target', async () => {
    let renders = 0;
    const Consumer = React.memo(function Consumer() {
        usePluginPageLaunchInputStaging();
        renders += 1;
        return null;
    });
    // A caller that builds `{ kind: 'app' }` inline gives the scope a new target object on every render.
    const render = () => <PluginPageLaunchInputScope target={{ kind: 'app' }} pages={pages} pluginUiProjection={null}>
        <Consumer />
    </PluginPageLaunchInputScope>;
    const screen = await renderScreen(render());
    const mounted = renders;
    await screen.update(render());
    await screen.update(render());
    expect(renders).toBe(mounted);
});

it('keeps the launch scope context still when the projection re-resolves the same page authorities', async () => {
    let renders = 0;
    const Consumer = React.memo(function Consumer() {
        usePluginPageLaunchInputStaging();
        renders += 1;
        return null;
    });
    // A progressively populating projection hands the scope a new page list whose pages grant the same authority.
    const render = () => <PluginPageLaunchInputScope target={{ kind: 'app' }} pages={[...pages]} pluginUiProjection={null}>
        <Consumer />
    </PluginPageLaunchInputScope>;
    const screen = await renderScreen(render());
    const mounted = renders;
    await screen.update(render());
    await screen.update(render());
    expect(renders).toBe(mounted);
});
