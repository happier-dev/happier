import * as React from 'react';
import type { BrowserViewTargetV1, FeatureDecision } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { BrowserSurfaceProductModels } from './BrowserSurfaceHost';
import {
    BROWSER_LAUNCHPAD_DETAILS_TAB_KEY,
    createBrowserLaunchpadDetailsTab,
    createBrowserViewDetailsTab,
} from './browserSurfaceDetailsTabModel';

vi.mock('@/components/browser/surfaces/BrowserSurfaceHost', () => ({
    BrowserSurfaceHost: (props: Record<string, unknown>) => (
        React.createElement('BrowserSurfaceHostMock', { ...props, testID: props.testID ?? 'browser-view-details-surface' })
    ),
    mergeBrowserSurfaceProductModels: (
        primary: Record<string, unknown> | null | undefined,
        fallback: Record<string, unknown> | null | undefined,
    ) => primary ?? fallback,
}));

const externalTarget = {
    kind: 'externalUrl',
    targetId: 'external_docs',
    url: 'https://docs.happier.test/',
    display: {
        title: 'Docs',
        addressLabel: 'docs.happier.test',
    },
} satisfies BrowserViewTargetV1;

const sessionBrowserProfile = {
    profileId: 'profile_session_1',
    storageMode: 'session',
    owner: { kind: 'session', id: 'session_1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    cleanupOnSessionClose: true,
} as const;

const enabledBrowserDecision = {
    featureId: 'browser',
    state: 'enabled',
    blockedBy: null,
    blockerCode: 'none',
    diagnostics: [],
    evaluatedAt: 1_000,
    scope: { scopeKind: 'runtime' },
} satisfies FeatureDecision;

const availableDesktopWebView = {
    available: true,
    platform: 'macos',
    primitive: 'macosNsViewWebKit',
    renderEngine: 'desktopWebView',
    producer: 'tauriWryNativeChildView',
    privilegedIpc: false,
    supports: {
        navigation: true,
        goBackForward: false,
        reload: false,
        stop: false,
        pageInfoDiagnostics: true,
        nativeDevtools: true,
        capture: false,
        recording: false,
        automation: false,
    },
    disabledReasons: [],
} as const;

function descriptorFor(surfaceId: string) {
    return {
        surfaceId,
        resourceKey: surfaceId,
        scope: { kind: 'session', sessionId: 's1' },
        region: 'details',
        status: 'available',
    } as const;
}

describe('browser-view details surface renderer — launchpad (new-tab) empty state', () => {
    function launchpadInput() {
        const tab = createBrowserLaunchpadDetailsTab();
        return {
            tab: {
                ...tab,
                isPinned: true,
                isPreview: false,
            },
            descriptor: descriptorFor('session:s1:details:browser:launchpad'),
            scope: { kind: 'session', sessionId: 's1' } as const,
            region: 'details' as const,
            active: true,
            callbacks: {},
        };
    }

    it('renders the launchpad browser-view resource through the reusable browser host (empty view)', async () => {
        const { createBrowserViewDetailsSurfaceRenderer } = await import('./browserDetailsSurfaceRenderer');
        const renderer = createBrowserViewDetailsSurfaceRenderer({ platform: 'web' });
        const input = launchpadInput();

        expect(input.tab.key).toBe(BROWSER_LAUNCHPAD_DETAILS_TAB_KEY);
        expect(renderer.canRender(input)).toBe(true);

        const screen = await renderScreen(<>{renderer.render(input)}</>);
        const host = screen.findByTestId('browser-view-details-surface');

        expect(host).not.toBeNull();
        expect(host?.props.initialBrowserState.currentTarget).toBeNull();
        expect(host?.props.presentationSlotId).toBe('session:s1:details:browser:launchpad');
        expect(host?.props.keepAliveAboveRouter).toBe(true);
    });

    it('forwards browser product models through the reusable browser host', async () => {
        const { createBrowserViewDetailsSurfaceRenderer } = await import('./browserDetailsSurfaceRenderer');
        const { LOCAL_BROWSER_PROFILE_ID } = await import('@/sync/domains/browser/profiles/localBrowserProfile');
        const browserContext = { state: { activeAnnotationByViewId: {} } } as unknown as NonNullable<BrowserSurfaceProductModels['browserContext']>;
        const productModels = {
            browserContext,
            browserDiagnostics: null,
            browserAutomation: null,
            browserRecording: null,
            browserProfile: null,
            supplementalDiagnostics: null,
        } satisfies BrowserSurfaceProductModels;
        const renderer = createBrowserViewDetailsSurfaceRenderer({ platform: 'web', productModels });

        const screen = await renderScreen(<>{renderer.render(launchpadInput())}</>);
        const host = screen.findByTestId('browser-view-details-surface');

        // Non-profile product models are forwarded unchanged…
        expect(host?.props.productModels?.browserContext).toBe(browserContext);
        expect(host?.props.productModels?.browserDiagnostics).toBeNull();
        // …and an absent (null) profile is backfilled with the host-local default so the in-app
        // browser is never left profile-less (which would deny external-URL navigation).
        expect(host?.props.productModels?.browserProfile?.profile?.profileId).toBe(LOCAL_BROWSER_PROFILE_ID);
    });

    it('threads browser action projection and machine scope into the live host', async () => {
        const { createBrowserViewDetailsSurfaceRenderer } = await import('./browserDetailsSurfaceRenderer');
        const pluginBrowserProjection = {
            generation: 14,
            targetsById: {},
            actionsById: {},
            unknownEntriesById: {},
        } as const;
        const renderer = createBrowserViewDetailsSurfaceRenderer({
            platform: 'web',
            machineId: 'machine-1',
            serverId: 'server-a',
            pluginBrowserActionSessionId: 'session-1',
            pluginBrowserProjection,
        });

        const screen = await renderScreen(<>{renderer.render(launchpadInput())}</>);
        const host = screen.findByTestId('browser-view-details-surface');

        expect(host?.props.pluginBrowserProjection).toBe(pluginBrowserProjection);
        expect(host?.props.pluginBrowserActionContext).toEqual({
            machineId: 'machine-1',
            serverId: 'server-a',
            sessionId: 'session-1',
        });
    });

    it('forwards onOpenTarget to the host ONLY as the external-surface new-tab seam (DV-NAV)', async () => {
        const { createBrowserViewDetailsSurfaceRenderer } = await import('./browserDetailsSurfaceRenderer');
        const onOpenTarget = vi.fn();
        const renderer = createBrowserViewDetailsSurfaceRenderer({ platform: 'web', onOpenTarget });

        const screen = await renderScreen(<>{renderer.render(launchpadInput())}</>);
        const host = screen.findByTestId('browser-view-details-surface');

        // The injected workspace opener is the NEW-TAB seam reserved for external surfaces (Services
        // rows, session-header button). It is passed to the host as `onOpenTarget`, but the
        // launchpad/new-tab URL submit does NOT route here — it navigates the CURRENT tab in place
        // via the host's own in-place `openView` seam (asserted in BrowserLaunchpad /
        // BrowserLaunchpadUrlEntry tests). The renderer never wires the URL entry to `onOpenTarget`.
        expect(host?.props.onOpenTarget).toBe(onOpenTarget);
    });

    it('requests a durable tab replacement when the launchpad retargets to a browser view', async () => {
        const { createBrowserViewDetailsSurfaceRenderer } = await import('./browserDetailsSurfaceRenderer');
        const replaceTab = vi.fn();
        const renderer = createBrowserViewDetailsSurfaceRenderer({ platform: 'web' });
        const input = {
            ...launchpadInput(),
            callbacks: { replaceTab },
        };

        const screen = await renderScreen(<>{renderer.render(input)}</>);
        const host = screen.findByTestId('browser-view-details-surface');
        host?.props.onViewTargetChange?.({
            browserSessionId: 'browser_surface:details:externalUrl:external_docs',
            viewId: 'browser_view:external_docs',
            target: externalTarget,
        });

        expect(replaceTab).toHaveBeenCalledTimes(1);
        const [oldTabKey, nextTab, options] = replaceTab.mock.calls[0] ?? [];
        expect(oldTabKey).toBe(BROWSER_LAUNCHPAD_DETAILS_TAB_KEY);
        expect(nextTab).toMatchObject({
            kind: 'browser-view',
            title: 'Docs',
            resource: {
                kind: 'browser-view',
                browserSessionId: 'browser_surface:details:externalUrl:external_docs',
                viewId: 'browser_view:external_docs',
                target: externalTarget,
            },
        });
        expect(nextTab.key).not.toBe(BROWSER_LAUNCHPAD_DETAILS_TAB_KEY);
        expect(options).toEqual({ intent: 'pinned' });
    });
});

describe('browser-view details surface renderer — single view', () => {
    const target = {
        kind: 'localServicePreview',
        targetId: 'preview_view',
        sessionId: 'session_1',
        machineId: 'machine_1',
        display: { title: 'Preview' },
    } satisfies BrowserViewTargetV1;

    function browserViewInput() {
        const tab = createBrowserViewDetailsTab({ target, browserSessionId: 'browser_session_view' });
        return {
            tab: {
                ...tab,
                isPinned: false,
                isPreview: false,
            },
            descriptor: descriptorFor('session:s1:details:browser-view:preview_view'),
            scope: { kind: 'session', sessionId: 's1' } as const,
            region: 'details' as const,
            active: true,
            callbacks: {},
        };
    }

    it('canRender matches both single-view and launchpad browser-view resources', async () => {
        const { createBrowserViewDetailsSurfaceRenderer } = await import('./browserDetailsSurfaceRenderer');
        const renderer = createBrowserViewDetailsSurfaceRenderer({ platform: 'web' });

        expect(renderer.canRender(browserViewInput())).toBe(true);
        // The legacy `browserSurface` tab kind is gone — it must not match.
        expect(renderer.canRender({
            ...browserViewInput(),
            tab: {
                ...browserViewInput().tab,
                kind: 'browserSurface',
                resource: { kind: 'browserSurface', mode: 'launchpad' },
            },
        })).toBe(false);
    });

    it('renders the single-view browser content for the resource viewId under its browserSessionId', async () => {
        const { createBrowserViewDetailsSurfaceRenderer } = await import('./browserDetailsSurfaceRenderer');
        const renderer = createBrowserViewDetailsSurfaceRenderer({ platform: 'web' });

        const screen = await renderScreen(<>{renderer.render(browserViewInput())}</>);
        const host = screen.findByTestId('browser-view-details-surface');

        expect(host?.props.browserSessionId).toBe('browser_session_view');
        expect(host?.props.initialBrowserState.viewsById['browser_view:preview_view']?.browserSessionId)
            .toBe('browser_session_view');
        expect(host?.props.initialBrowserState.currentTarget).toEqual(target);
        expect(host?.props.keepAliveAboveRouter).toBe(true);
    });

    it('seeds remounted browser content under the resource viewId when the resource target changes', async () => {
        const { createBrowserViewDetailsSurfaceRenderer } = await import('./browserDetailsSurfaceRenderer');
        const renderer = createBrowserViewDetailsSurfaceRenderer({
            platform: 'web',
            browserFeatureDecision: enabledBrowserDecision,
            productModels: {
                browserProfile: { profile: sessionBrowserProfile, activePermissionGrantCount: 0 },
            },
        });
        const tab = createBrowserViewDetailsTab({
            target: externalTarget,
            browserSessionId: 'browser_session_view',
            viewId: 'browser_view:preview_1',
        });
        const input = {
            tab: { ...tab, isPinned: false, isPreview: false },
            descriptor: descriptorFor('session:s1:details:browser-view:preview_1'),
            scope: { kind: 'session', sessionId: 's1' } as const,
            region: 'details' as const,
            active: true,
            callbacks: {},
        };

        const screen = await renderScreen(<>{renderer.render(input)}</>);
        const host = screen.findByTestId('browser-view-details-surface');
        const remountedView = host?.props.initialBrowserState.viewsById['browser_view:preview_1'];

        expect(remountedView).toBeDefined();
        expect(remountedView?.target).toEqual(externalTarget);
        expect(remountedView?.currentUrl).toBe('https://docs.happier.test/');
        expect(host?.props.initialBrowserState.viewsById['browser_view:external_docs']).toBeUndefined();
    });

    it('requests a durable same-tab resource replacement when the active browser view retargets', async () => {
        const { createBrowserViewDetailsSurfaceRenderer } = await import('./browserDetailsSurfaceRenderer');
        const replaceTab = vi.fn();
        const renderer = createBrowserViewDetailsSurfaceRenderer({ platform: 'web' });
        const input = {
            ...browserViewInput(),
            callbacks: { replaceTab },
        };

        const screen = await renderScreen(<>{renderer.render(input)}</>);
        const host = screen.findByTestId('browser-view-details-surface');
        host?.props.onViewTargetChange?.({
            browserSessionId: 'browser_session_view',
            viewId: 'browser_view:preview_view',
            target: externalTarget,
        });

        expect(replaceTab).toHaveBeenCalledTimes(1);
        const [oldTabKey, nextTab, options] = replaceTab.mock.calls[0] ?? [];
        expect(oldTabKey).toBe(input.tab.key);
        expect(nextTab).toMatchObject({
            key: input.tab.key,
            kind: 'browser-view',
            title: 'Docs',
            resource: {
                kind: 'browser-view',
                browserSessionId: 'browser_session_view',
                viewId: 'browser_view:preview_view',
                target: externalTarget,
            },
        });
        expect(options).toEqual({ intent: 'default' });
    });

    it('OWNER-OPEN mount-and-render: an opened web external URL materializes a viewsById entry (no "No view")', async () => {
        // Proves the atomic open is observable end-to-end at the rendered-view level: the record is
        // DERIVED on mount from the tab resource's deterministic `target` via the one resolver — the
        // surface does not strand on the launchpad/"No view" empty state for an opened target. On web
        // the external URL selects the renderable iframe engine (B-RC4), not a dead `openExternalTab`.
        const { createBrowserViewDetailsSurfaceRenderer } = await import('./browserDetailsSurfaceRenderer');
        const renderer = createBrowserViewDetailsSurfaceRenderer({
            platform: 'web',
            browserFeatureDecision: enabledBrowserDecision,
            productModels: {
                browserProfile: { profile: sessionBrowserProfile, activePermissionGrantCount: 0 },
            },
        });
        const tab = createBrowserViewDetailsTab({ target: externalTarget, browserSessionId: 'browser_session_external_web' });
        const input = {
            tab: { ...tab, isPinned: true, isPreview: false },
            descriptor: descriptorFor('session:s1:details:browser-view:external_docs'),
            scope: { kind: 'session', sessionId: 's1' } as const,
            region: 'details' as const,
            active: true,
            callbacks: {},
        };

        const screen = await renderScreen(<>{renderer.render(input)}</>);
        const host = screen.findByTestId('browser-view-details-surface');
        const view = host?.props.initialBrowserState.viewsById['browser_view:external_docs'];

        expect(view).toBeDefined();
        expect(view?.browserSessionId).toBe('browser_session_external_web');
        expect(view?.adapterKind).toBe('externalUrl');
        expect(view?.engineKind).toBe('webIframe');
        expect(host?.props.initialBrowserState.currentTarget).toEqual(externalTarget);
    });

    it('opens desktop external URL views with policy and native WebView context', async () => {
        const { createBrowserViewDetailsSurfaceRenderer } = await import('./browserDetailsSurfaceRenderer');
        const renderer = createBrowserViewDetailsSurfaceRenderer({
            platform: 'desktop',
            browserFeatureDecision: enabledBrowserDecision,
            desktopWebViewAvailability: availableDesktopWebView,
            productModels: {
                browserProfile: {
                    profile: sessionBrowserProfile,
                    activePermissionGrantCount: 0,
                },
            },
        });
        const tab = createBrowserViewDetailsTab({ target: externalTarget, browserSessionId: 'browser_session_external' });
        const input = {
            tab: { ...tab, isPinned: true, isPreview: false },
            descriptor: descriptorFor('session:s1:details:browser-view:external_docs'),
            scope: { kind: 'session', sessionId: 's1' } as const,
            region: 'details' as const,
            active: true,
            callbacks: {},
        };

        const screen = await renderScreen(<>{renderer.render(input)}</>);
        const host = screen.findByTestId('browser-view-details-surface');
        const focusedView = host?.props.initialBrowserState.viewsById['browser_view:external_docs'];

        expect(focusedView?.adapterKind).toBe('externalUrl');
        expect(focusedView?.engineKind).toBe('desktopWebView');
        expect(focusedView?.currentUrl).toBe('https://docs.happier.test/');
        expect(focusedView?.lastError).toBeNull();
        expect(host?.props.browserFeatureDecision).toBe(enabledBrowserDecision);
        expect(host?.props.desktopWebViewAvailability).toBe(availableDesktopWebView);
    });

    it('seeds a navigating external-URL view with the host default profile when no explicit profile is supplied (production parity)', async () => {
        // Production registration sites (createSessionDetailsSurfaceRenderers /
        // createWorkspaceDetailsSurfaceRenderers / BrowserScopedWorkspace) wire neither a
        // browserProfile productModel nor allowExternalUrlBrowsing. The feature decision and
        // desktop availability are still resolved (here passed explicitly to mirror the runtime
        // hooks). Without a profile the policy previously denied with `profile_missing`, so the
        // view never materialized and the tab fell back to the launchpad empty-state. The host now
        // resolves a local (user-owned) default browser profile so an opened external URL mounts.
        const { createBrowserViewDetailsSurfaceRenderer } = await import('./browserDetailsSurfaceRenderer');
        const renderer = createBrowserViewDetailsSurfaceRenderer({
            platform: 'desktop',
            browserFeatureDecision: enabledBrowserDecision,
            desktopWebViewAvailability: availableDesktopWebView,
            // No productModels.browserProfile and no allowExternalUrlBrowsing — exactly as production.
        });
        const tab = createBrowserViewDetailsTab({ target: externalTarget, browserSessionId: 'browser_session_external' });
        const input = {
            tab: { ...tab, isPinned: true, isPreview: false },
            descriptor: descriptorFor('session:s1:details:browser-view:external_docs'),
            scope: { kind: 'session', sessionId: 's1' } as const,
            region: 'details' as const,
            active: true,
            callbacks: {},
        };

        const screen = await renderScreen(<>{renderer.render(input)}</>);
        const host = screen.findByTestId('browser-view-details-surface');
        const focusedView = host?.props.initialBrowserState.viewsById['browser_view:external_docs'];

        expect(focusedView).toBeDefined();
        expect(focusedView?.adapterKind).toBe('externalUrl');
        expect(focusedView?.engineKind).toBe('desktopWebView');
        expect(focusedView?.currentUrl).toBe('https://docs.happier.test/');
        expect(focusedView?.lastError).toBeNull();
    });
});
