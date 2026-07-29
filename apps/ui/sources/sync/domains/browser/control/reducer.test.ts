import type { BrowserAdapterCapabilitiesV1, BrowserCommandV1, BrowserEventV1, BrowserViewTargetV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { buildBrowserAdapterCapabilities } from '../adapters/capabilities';

const previewTarget = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: {
        title: 'Preview',
        addressLabel: 'localhost:5173',
    },
} satisfies BrowserViewTargetV1;

const secondPreviewTarget = {
    ...previewTarget,
    targetId: 'preview_2',
    display: {
        title: 'Second Preview',
        addressLabel: 'localhost:5174',
    },
} satisfies BrowserViewTargetV1;

const externalTarget = {
    kind: 'externalUrl',
    targetId: 'external_example',
    url: 'https://example.com/',
    display: {
        title: 'example.com',
        addressLabel: 'example.com',
    },
} satisfies BrowserViewTargetV1;

const localPreviewCapabilities = {
    ...buildBrowserAdapterCapabilities({
        adapterKind: 'localPreview',
        supportedTargetKinds: ['localServicePreview'],
        supportedRenderEngines: ['webIframe'],
    }),
    navigation: {
        canNavigate: true,
        canGoBack: false,
        canGoForward: false,
        canReload: true,
        canStop: true,
    },
} satisfies BrowserAdapterCapabilitiesV1;

function openLocalPreviewEvents(): readonly BrowserEventV1[] {
    return [{
        kind: 'sessionCreated',
        eventId: 'event_session',
        browserSessionId: 'browser_session_1',
        profileId: 'profile_1',
        occurredAt: 1_000,
    }, {
        kind: 'viewOpened',
        eventId: 'event_view',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        target: previewTarget,
        platform: 'web',
        currentUrl: 'https://preview.happier.test/',
        adapterKind: 'localPreview',
        engineKind: 'webIframe',
        adapterCapabilities: localPreviewCapabilities,
        occurredAt: 1_001,
    }, {
        kind: 'viewFocused',
        eventId: 'event_focus',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        occurredAt: 1_002,
    }];
}

function openTwoLocalPreviewEvents(): readonly BrowserEventV1[] {
    return [
        ...openLocalPreviewEvents(),
        {
            kind: 'viewOpened',
            eventId: 'event_view_2',
            browserSessionId: 'browser_session_1',
            viewId: 'view_2',
            target: secondPreviewTarget,
            platform: 'web',
            currentUrl: 'https://second-preview.happier.test/',
            adapterKind: 'localPreview',
            engineKind: 'webIframe',
            adapterCapabilities: localPreviewCapabilities,
            occurredAt: 1_003,
        },
    ];
}

describe('browser control reducer', () => {
    it('projects browser sessions, views, focus, and current target from events', async () => {
        const mod = await import('./reducer').catch(() => null);

        expect(mod).not.toBeNull();
        if (!mod) return;

        const state = openLocalPreviewEvents().reduce(
            (nextState, event) => mod.applyBrowserControlEvent(nextState, event),
            mod.createBrowserControlState(),
        );

        expect(state.sessionsById.browser_session_1?.state).toBe('active');
        expect(state.viewsById.view_1?.target).toEqual(previewTarget);
        expect(state.currentTarget).toEqual(previewTarget);
    });

    it('seeds a URL-bearing open on a client-rendered engine as loading (spinner shows until load-end)', async () => {
        const mod = await import('./reducer').catch(() => null);

        expect(mod).not.toBeNull();
        if (!mod) return;

        // B-2 cause-1: an in-place launchpad open of a client-rendered (webIframe) view must NOT be
        // marked already-loaded — it is `loading` until the engine reports load-end.
        const state = openLocalPreviewEvents().reduce(
            (nextState, event) => mod.applyBrowserControlEvent(nextState, event),
            mod.createBrowserControlState(),
        );

        expect(state.viewsById.view_1?.loadingState).toBe('loading');
        expect(state.viewsById.view_1?.loadingProgress).toBe(0);
    });

    it('keeps existing view state visible while adapter refresh is in flight', async () => {
        const mod = await import('./reducer').catch(() => null);

        expect(mod).not.toBeNull();
        if (!mod) return;

        const state = openLocalPreviewEvents().reduce(
            (nextState, event) => mod.applyBrowserControlEvent(nextState, event),
            mod.createBrowserControlState(),
        );
        const refreshing = mod.beginBrowserAdapterRefresh(state, 'view_1');

        expect(refreshing.viewsById.view_1?.target).toEqual(previewTarget);
        expect(refreshing.viewsById.view_1?.adapterRefreshStatus).toBe('refreshing');
        expect(refreshing.currentTarget).toEqual(previewTarget);
    });

    it('increments the view navigation generation when committed page identity changes', async () => {
        const mod = await import('./reducer').catch(() => null);

        expect(mod).not.toBeNull();
        if (!mod) return;

        const state = openLocalPreviewEvents().reduce(
            (nextState, event) => mod.applyBrowserControlEvent(nextState, event),
            mod.createBrowserControlState(),
        );

        const committed = mod.applyBrowserControlEvent(state, {
            kind: 'navigationCommitted',
            eventId: 'event_navigation_commit',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            currentUrl: 'https://preview.happier.test/dashboard',
            securityOrigin: 'https://preview.happier.test',
            occurredAt: 1_010,
        });
        const finished = mod.applyBrowserControlEvent(committed, {
            kind: 'navigationFinished',
            eventId: 'event_navigation_finish',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            currentUrl: 'https://preview.happier.test/dashboard',
            occurredAt: 1_011,
        });
        const titleOnly = mod.applyBrowserControlEvent(finished, {
            kind: 'titleChanged',
            eventId: 'event_title',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            title: 'Dashboard',
            occurredAt: 1_012,
        });
        const replacedSameUrl = mod.applyBrowserControlEvent(titleOnly, {
            kind: 'navigationCommitted',
            eventId: 'event_navigation_replaced_same_url',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            currentUrl: 'https://preview.happier.test/dashboard',
            securityOrigin: 'https://preview.happier.test',
            occurredAt: 1_013,
        });

        expect(state.viewsById.view_1?.navigationGeneration).toBe(0);
        expect(committed.viewsById.view_1?.navigationGeneration).toBe(1);
        expect(finished.viewsById.view_1?.navigationGeneration).toBe(1);
        expect(titleOnly.viewsById.view_1?.navigationGeneration).toBe(1);
        expect(replacedSameUrl.viewsById.view_1?.navigationGeneration).toBe(2);
    });

    it('dispatches navigation to client-local engines without daemon RPC', async () => {
        const mod = await import('./commands').catch(() => null);
        const reducer = await import('./reducer').catch(() => null);

        expect(mod).not.toBeNull();
        expect(reducer).not.toBeNull();
        if (!mod || !reducer) return;

        const state = openLocalPreviewEvents().reduce(
            (nextState, event) => reducer.applyBrowserControlEvent(nextState, event),
            reducer.createBrowserControlState(),
        );
        const sendDaemonCommand = vi.fn();
        const command = {
            kind: 'navigate',
            commandId: 'command_1',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            url: 'https://preview.happier.test/dashboard',
        } satisfies BrowserCommandV1;

        const result = mod.dispatchBrowserControlCommand(state, command, { sendDaemonCommand });

        expect(sendDaemonCommand).not.toHaveBeenCalled();
        expect(result.effects).toEqual([{
            kind: 'clientLocalNavigation',
            viewId: 'view_1',
            command,
        }]);
        expect(result.state.viewsById.view_1?.pendingUrl).toBe('https://preview.happier.test/dashboard');
    });

    it('invalidates browser context generation for client-local reload commands', async () => {
        const mod = await import('./commands').catch(() => null);
        const reducer = await import('./reducer').catch(() => null);

        expect(mod).not.toBeNull();
        expect(reducer).not.toBeNull();
        if (!mod || !reducer) return;

        const state = openLocalPreviewEvents().reduce(
            (nextState, event) => reducer.applyBrowserControlEvent(nextState, event),
            reducer.createBrowserControlState(),
        );
        const command = {
            kind: 'reload',
            commandId: 'command_reload',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        } satisfies BrowserCommandV1;

        const result = mod.dispatchBrowserControlCommand(state, command);

        expect(result.effects).toEqual([{
            kind: 'clientLocalNavigation',
            viewId: 'view_1',
            command,
        }]);
        expect(result.state.viewsById.view_1?.navigationGeneration).toBe(1);
        expect(result.state.viewsById.view_1?.loadingState).toBe('loading');
        expect(result.state.viewsById.view_1?.loadingProgress).toBe(0);
        expect(result.state.currentTarget).toEqual(previewTarget);
    });

    it('rejects client-local navigation commands when the adapter does not expose that capability', async () => {
        const mod = await import('./commands').catch(() => null);
        const reducer = await import('./reducer').catch(() => null);

        expect(mod).not.toBeNull();
        expect(reducer).not.toBeNull();
        if (!mod || !reducer) return;

        const state = openLocalPreviewEvents().reduce(
            (nextState, event) => reducer.applyBrowserControlEvent(nextState, event),
            reducer.createBrowserControlState(),
        );
        const sendDaemonCommand = vi.fn();
        const command = {
            kind: 'goBack',
            commandId: 'command_back',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        } satisfies BrowserCommandV1;

        const result = mod.dispatchBrowserControlCommand(state, command, { sendDaemonCommand });

        expect(sendDaemonCommand).not.toHaveBeenCalled();
        expect(result.effects).toEqual([{
            kind: 'commandRejected',
            command,
            reasonCode: 'adapter_unavailable',
        }]);
        expect(result.state).toBe(state);
    });

    it('dispatches openView locally through adapter selection and materializes session, view, and focus state', async () => {
        const mod = await import('./commands').catch(() => null);
        const reducer = await import('./reducer').catch(() => null);

        expect(mod).not.toBeNull();
        expect(reducer).not.toBeNull();
        if (!mod || !reducer) return;

        const command = {
            kind: 'openView',
            commandId: 'command_open',
            browserSessionId: 'browser_session_open',
            viewId: 'view_open',
            target: previewTarget,
            platform: 'web',
            currentUrl: 'https://preview.happier.test/',
            focus: true,
        } satisfies BrowserCommandV1;

        const result = mod.dispatchBrowserControlCommand(reducer.createBrowserControlState(), command);

        expect(result.effects).toEqual([{
            kind: 'clientLocalView',
            viewId: 'view_open',
            command,
        }]);
        expect(result.state.sessionsById.browser_session_open?.state).toBe('active');
        expect(result.state.viewsById.view_open).toMatchObject({
            target: previewTarget,
            adapterKind: 'localPreview',
            engineKind: 'webIframe',
            currentUrl: 'https://preview.happier.test/',
        });
        expect(result.state.currentTarget).toEqual(previewTarget);
    });

    it('retargets an existing client-local view as a real URL-bearing navigation', async () => {
        const mod = await import('./commands').catch(() => null);
        const reducer = await import('./reducer').catch(() => null);

        expect(mod).not.toBeNull();
        expect(reducer).not.toBeNull();
        if (!mod || !reducer) return;

        const opened = openLocalPreviewEvents().reduce(
            (nextState, event) => reducer.applyBrowserControlEvent(nextState, event),
            reducer.createBrowserControlState(),
        );
        const ready = reducer.applyBrowserControlEvent(opened, {
            kind: 'navigationFinished',
            eventId: 'event_navigation_finish',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            currentUrl: 'https://preview.happier.test/',
            occurredAt: 1_010,
        });
        const command = {
            kind: 'setTarget',
            commandId: 'command_set_target',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            target: externalTarget,
            currentUrl: externalTarget.url,
        } satisfies BrowserCommandV1;

        const result = mod.dispatchBrowserControlCommand(ready, command);
        const view = result.state.viewsById.view_1;

        expect(result.effects).toEqual([{
            kind: 'clientLocalView',
            viewId: 'view_1',
            command,
        }]);
        expect(view).toMatchObject({
            target: externalTarget,
            adapterKind: 'externalUrl',
            engineKind: 'webIframe',
            currentUrl: 'https://example.com/',
            pendingUrl: null,
            title: 'example.com',
            loadingState: 'loading',
            loadingProgress: 0,
        });
        expect(view?.navigationGeneration).toBe(1);
        expect(result.state.currentTarget).toEqual(externalTarget);
    });

    it('dispatches closeView locally and removes the view content record', async () => {
        const mod = await import('./commands').catch(() => null);
        const reducer = await import('./reducer').catch(() => null);

        expect(mod).not.toBeNull();
        expect(reducer).not.toBeNull();
        if (!mod || !reducer) return;

        const baseState = openTwoLocalPreviewEvents().reduce(
            (nextState, event) => reducer.applyBrowserControlEvent(nextState, event),
            reducer.createBrowserControlState(),
        );
        const command = {
            kind: 'closeView',
            commandId: 'command_close',
            browserSessionId: 'browser_session_1',
            viewId: 'view_2',
        } satisfies BrowserCommandV1;

        const result = mod.dispatchBrowserControlCommand(baseState, command);

        expect(result.effects).toEqual([{
            kind: 'clientLocalView',
            viewId: 'view_2',
            command,
        }]);
        expect(result.state.viewsById.view_2).toBeUndefined();
        expect(result.state.viewsById.view_1?.target).toEqual(previewTarget);
        expect(result.state.currentTarget).toEqual(previewTarget);
    });

    it('dispatches focusView locally and updates the derived current target', async () => {
        const mod = await import('./commands').catch(() => null);
        const reducer = await import('./reducer').catch(() => null);

        expect(mod).not.toBeNull();
        expect(reducer).not.toBeNull();
        if (!mod || !reducer) return;

        const state = openTwoLocalPreviewEvents().reduce(
            (nextState, event) => reducer.applyBrowserControlEvent(nextState, event),
            reducer.createBrowserControlState(),
        );
        const command = {
            kind: 'focusView',
            commandId: 'command_focus',
            browserSessionId: 'browser_session_1',
            viewId: 'view_2',
        } satisfies BrowserCommandV1;

        const result = mod.dispatchBrowserControlCommand(state, command);

        expect(result.effects).toEqual([{
            kind: 'clientLocalFocus',
            viewId: 'view_2',
            command,
        }]);
        expect(result.state.currentTarget).toEqual(secondPreviewTarget);
    });
});
