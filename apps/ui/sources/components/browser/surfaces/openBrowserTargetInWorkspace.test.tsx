import type {
    BrowserTargetPolicyDecisionV1,
    BrowserViewTargetV1,
    FeatureDecision,
    LocalServiceLaunchTargetV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

// The OS-tab handoff is a genuine platform boundary (`window.open` / `Linking.openURL`); the
// selection and fulfilment logic beneath it stays real.
const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));

import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { resolveBrowserViewIdForTarget } from '@/sync/domains/browser/store';

import {
    bindServicesOpenInBrowser,
    createOpenBrowserTargetInWorkspace,
    mapLocalServiceLaunchTargetToBrowserTarget,
    resolveBrowserViewTargetOpen,
    resolveBrowserViewTargetOpenTab,
} from './openBrowserTargetInWorkspace';
import { readBrowserViewDetailsResource } from './browserSurfaceDetailsTabModel';

const localServicePreviewTarget = {
    kind: 'localServicePreview',
    targetId: 'preview_123',
    sessionId: 'session_123',
    machineId: 'machine_123',
    display: {
        title: 'Kitchen Sink',
        addressLabel: 'localhost:5173',
        folderLabel: 'happier',
    },
} satisfies BrowserViewTargetV1;

const externalTarget = {
    kind: 'externalUrl',
    targetId: 'external_1',
    url: 'https://example.com/',
    display: {
        title: 'Example',
        addressLabel: 'example.com',
    },
} satisfies BrowserViewTargetV1;

const enabledBrowserDecision = {
    featureId: 'browser',
    state: 'enabled',
    blockedBy: null,
    blockerCode: 'none',
    diagnostics: [],
    evaluatedAt: 1_000,
    scope: { scopeKind: 'runtime' },
} satisfies FeatureDecision;

const sessionBrowserProfile = {
    profileId: 'profile_session_1',
    storageMode: 'session',
    owner: { kind: 'session', id: 'session_1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    cleanupOnSessionClose: true,
} as const;

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

/** A RESOLVED desktop probe that says this host cannot embed a third-party site (Windows/X11). */
const unembeddableDesktopWebView = {
    ...availableDesktopWebView,
    available: false,
    platform: 'windows',
    primitive: 'windowsHwndWebView2',
    renderEngine: 'unavailable',
    producer: 'none',
    supports: { ...availableDesktopWebView.supports, navigation: false },
    disabledReasons: ['desktop_webview_child_view_unverified'],
} as const;

const serviceTargetWithBrowserTarget = {
    id: 'inventory:svc_1',
    source: 'inventory_entry',
    machineId: 'machine_123',
    sessionId: 'session_123',
    title: 'Kitchen Sink',
    subtitle: 'localhost:5173',
    confidence: 'high',
    state: 'available',
    actions: ['open_preview'],
    browserTarget: localServicePreviewTarget,
} satisfies LocalServiceLaunchTargetV1;

const serviceTargetWithoutBrowserTarget = {
    id: 'inventory:svc_2',
    source: 'inventory_entry',
    machineId: 'machine_123',
    sessionId: 'session_123',
    title: 'Detached Service',
    subtitle: 'localhost:6000',
    confidence: 'medium',
    state: 'unavailable',
    unavailableReason: 'preview_unregistered',
    actions: [],
} satisfies LocalServiceLaunchTargetV1;

function readTabTarget(tab: DetailsTab): BrowserViewTargetV1 | undefined {
    const resource = tab.resource as { target?: BrowserViewTargetV1 };
    return resource.target;
}

function readTabBrowserSessionId(tab: DetailsTab): string | undefined {
    const resource = tab.resource as { browserSessionId?: string };
    return resource.browserSessionId;
}

describe('openBrowserTargetInWorkspace', () => {
    it('resolves a target into BOTH a details-workspace tab AND a live content record (one identity)', () => {
        const resolved = resolveBrowserViewTargetOpen({
            scope: 'sessionDetails',
            platform: 'web',
        }, localServicePreviewTarget);

        // (a) a canonical browser-view details tab carrying the target + a stable browserSessionId
        expect(resolved.tab.kind).toBe('browser-view');
        expect(readTabTarget(resolved.tab)).toEqual(localServicePreviewTarget);
        const browserSessionId = readTabBrowserSessionId(resolved.tab);
        expect(browserSessionId).toEqual(expect.any(String));
        expect((browserSessionId ?? '').length).toBeGreaterThan(0);

        // (b) the live content record materializes for that exact browserSessionId/viewId
        const viewId = resolveBrowserViewIdForTarget(localServicePreviewTarget);
        const record = resolved.seededState.viewsById[viewId];
        expect(record).toBeDefined();
        expect(record?.target).toEqual(localServicePreviewTarget);
        expect(record?.browserSessionId).toBe(browserSessionId);
        expect(resolved.seededState.currentTarget).toEqual(localServicePreviewTarget);
    });

    it('opens the tab once with intent default and remembers the recent target', () => {
        const openDetailsTab = vi.fn();
        const remembered: BrowserViewTargetV1[] = [];
        const openBrowserViewTarget = createOpenBrowserTargetInWorkspace({
            openDetailsTab,
            scope: 'sessionDetails',
            platform: 'web',
            onRememberRecentTarget: (target) => {
                remembered.push(target);
            },
        });

        openBrowserViewTarget(localServicePreviewTarget);

        expect(openDetailsTab).toHaveBeenCalledTimes(1);
        const [tab, options] = openDetailsTab.mock.calls[0] as [DetailsTab, { intent?: string } | undefined];
        expect(tab.kind).toBe('browser-view');
        expect(readTabTarget(tab)).toEqual(localServicePreviewTarget);
        expect(options?.intent).toBe('default');
        expect(remembered).toEqual([localServicePreviewTarget]);
    });

    it('DV-OPEN-SEAM: the opened tab resource carries ONLY the deterministic inputs (target + identity), no state blob', () => {
        const openDetailsTab = vi.fn();
        const openBrowserViewTarget = createOpenBrowserTargetInWorkspace({
            openDetailsTab,
            scope: 'sessionDetails',
            platform: 'web',
        });

        openBrowserViewTarget(localServicePreviewTarget);

        const [tab] = openDetailsTab.mock.calls[0] as [DetailsTab];
        // The resource narrows to the canonical single-view shape: { kind, browserSessionId, viewId, target }.
        const resource = readBrowserViewDetailsResource(tab.resource);
        expect(resource).not.toBeNull();
        expect(resource?.target).toEqual(localServicePreviewTarget);
        // No materialized BrowserViewState / seededState blob is attached to the resource (the divergent
        // second content path DV-OPEN-SEAM forbids).
        const rawKeys = Object.keys(tab.resource as Record<string, unknown>).sort();
        expect(rawKeys).toEqual(['browserSessionId', 'kind', 'target', 'viewId']);
        expect((tab.resource as Record<string, unknown>).seededState).toBeUndefined();
        expect((tab.resource as Record<string, unknown>).browserState).toBeUndefined();
        expect((tab.resource as Record<string, unknown>).viewsById).toBeUndefined();
    });

    it('DV-OPEN-SEAM: the tab-only opener path does not expose a materialized state (the opener does no throwaway seed)', () => {
        const resolvedTab = resolveBrowserViewTargetOpenTab({
            scope: 'sessionDetails',
            platform: 'web',
        }, localServicePreviewTarget);
        expect('seededState' in resolvedTab).toBe(false);
        expect(resolvedTab.tab.kind).toBe('browser-view');
    });

    it('maps a service launch target to its browserTarget, with localServicePreview fallback and null', () => {
        expect(mapLocalServiceLaunchTargetToBrowserTarget(serviceTargetWithBrowserTarget))
            .toEqual(localServicePreviewTarget);

        const fallback = mapLocalServiceLaunchTargetToBrowserTarget(serviceTargetWithoutBrowserTarget);
        expect(fallback?.kind).toBe('localServicePreview');
        expect(fallback?.targetId).toBe(serviceTargetWithoutBrowserTarget.id);

        expect(mapLocalServiceLaunchTargetToBrowserTarget({
            ...serviceTargetWithoutBrowserTarget,
            machineId: '',
        } as LocalServiceLaunchTargetV1)).toBeNull();
    });

    it('binds the Services open seam to BOTH records and no-ops on an unmappable target', () => {
        const openDetailsTab = vi.fn();
        const openInBrowser = bindServicesOpenInBrowser({
            openDetailsTab,
            scope: 'sessionDetails',
            platform: 'web',
        });

        openInBrowser(serviceTargetWithBrowserTarget);
        expect(openDetailsTab).toHaveBeenCalledTimes(1);
        const [tab] = openDetailsTab.mock.calls[0] as [DetailsTab];
        expect(readTabTarget(tab)).toEqual(localServicePreviewTarget);

        openDetailsTab.mockClear();
        openInBrowser({
            ...serviceTargetWithoutBrowserTarget,
            machineId: '',
        } as LocalServiceLaunchTargetV1);
        expect(openDetailsTab).not.toHaveBeenCalled();
    });

    it('honors a caller-resolved open: a row-provided policy + url seed the record without re-evaluating', () => {
        // The launchpad row resolves its own policy (it has the profile) and passes it via options.
        // The opener must trust that decision even though deps carries no profile/feature context.
        const allowedExternalPolicy = {
            targetKind: 'externalUrl',
            state: 'allowed',
            profileId: 'profile_session_1',
            profileMode: 'session',
            origin: 'https://example.com',
            security: {
                url: 'https://example.com/',
                origin: 'https://example.com',
                securityLevel: 'secure',
                reasonCodes: [],
            },
            permissions: {
                downloads: 'deny',
                uploads: 'deny',
                clipboard: 'deny',
                camera: 'deny',
                microphone: 'deny',
                fileAccess: 'deny',
                popups: 'deny',
                browserUse: 'prompt',
            },
            disabledReasons: [],
        } satisfies BrowserTargetPolicyDecisionV1;

        const resolved = resolveBrowserViewTargetOpen(
            { scope: 'sessionDetails', platform: 'desktop' },
            externalTarget,
            {
                platform: 'desktop',
                currentUrl: 'https://example.com/',
                targetPolicyDecision: allowedExternalPolicy,
                desktopWebViewAvailability: availableDesktopWebView,
            },
        );

        const viewId = resolveBrowserViewIdForTarget(externalTarget);
        const record = resolved.seededState.viewsById[viewId];
        expect(record).toBeDefined();
        expect(record?.engineKind).toBe('desktopWebView');
        expect(record?.currentUrl).toBe('https://example.com/');
        // The browser-view tab seam is URL-free (the live URL lives on the seeded content record);
        // the tab carries the target + the same view identity, and the opener returns the URL.
        expect(readTabTarget(resolved.tab)).toEqual(externalTarget);
        expect(resolved.currentUrl).toBe('https://example.com/');
    });

    it('routes external-URL targets through policy: a denied target seeds no navigating content record', () => {
        const resolved = resolveBrowserViewTargetOpen({
            scope: 'sessionDetails',
            platform: 'desktop',
            browserFeatureDecision: enabledBrowserDecision,
            browserProfile: sessionBrowserProfile,
            // external browsing disabled => evaluateBrowserTargetPolicy denies the target
            allowExternalUrlBrowsing: false,
        }, externalTarget);

        // A tab still resolves (the user asked to open it)…
        expect(resolved.tab.kind).toBe('browser-view');
        // …but the denied policy yields no navigating content record (fail-closed).
        const viewId = resolveBrowserViewIdForTarget(externalTarget);
        expect(resolved.seededState.viewsById[viewId]).toBeUndefined();
    });

    it('seeds a navigating content record for an allowed external-URL target', () => {
        const resolved = resolveBrowserViewTargetOpen({
            scope: 'sessionDetails',
            platform: 'desktop',
            browserFeatureDecision: enabledBrowserDecision,
            browserProfile: sessionBrowserProfile,
            allowExternalUrlBrowsing: true,
            desktopWebViewAvailability: availableDesktopWebView,
        }, externalTarget);

        const viewId = resolveBrowserViewIdForTarget(externalTarget);
        const record = resolved.seededState.viewsById[viewId];
        expect(record).toBeDefined();
        expect(record?.currentUrl).toBe('https://example.com/');
        expect(record?.engineKind).toBe('desktopWebView');
    });

    // R-3 (G9), second half. The selector already resolves an allowed site a desktop host cannot
    // embed to the fulfilled `openExternalTab` outcome, and `BrowserSurfaceHost` performs it for the
    // in-place seam. This NEW-TAB opener is the other production caller — reached by every ordinary
    // launchpad external row, the Services "open in browser" seam and the session-header button —
    // and it did not. The launchpad enables those rows (the selection is `ok`), so on Windows/Linux
    // clicking one opened a workspace tab whose `openView` is rejected as `adapter_unavailable`,
    // leaving an empty tab: the same dead end the fix was supposed to remove, one seam over.
    it('R-3: hands an allowed external URL to the system browser instead of opening a dead tab where the desktop host cannot embed it', () => {
        openExternalUrlMock.mockClear();
        const openDetailsTab = vi.fn();
        const remembered: BrowserViewTargetV1[] = [];
        const openBrowserViewTarget = createOpenBrowserTargetInWorkspace({
            openDetailsTab,
            scope: 'sessionDetails',
            platform: 'desktop',
            browserFeatureDecision: enabledBrowserDecision,
            browserProfile: sessionBrowserProfile,
            allowExternalUrlBrowsing: true,
            desktopWebViewAvailability: unembeddableDesktopWebView,
            onRememberRecentTarget: (target) => {
                remembered.push(target);
            },
        });

        openBrowserViewTarget(externalTarget);

        expect(openExternalUrlMock).toHaveBeenCalledWith('https://example.com/');
        expect(openDetailsTab).not.toHaveBeenCalled();
        // An OS tab is not a workspace tab; it must not enter the recents rail as one.
        expect(remembered).toEqual([]);
    });

    // The neighbouring case: a host that CAN embed still opens the in-app tab. Discriminates
    // against "always hand external URLs to the OS".
    it('still opens a workspace tab for an allowed external URL the desktop host can embed', () => {
        openExternalUrlMock.mockClear();
        const openDetailsTab = vi.fn();
        const openBrowserViewTarget = createOpenBrowserTargetInWorkspace({
            openDetailsTab,
            scope: 'sessionDetails',
            platform: 'desktop',
            browserFeatureDecision: enabledBrowserDecision,
            browserProfile: sessionBrowserProfile,
            allowExternalUrlBrowsing: true,
            desktopWebViewAvailability: availableDesktopWebView,
        });

        openBrowserViewTarget(externalTarget);

        expect(openExternalUrlMock).not.toHaveBeenCalled();
        expect(openDetailsTab).toHaveBeenCalledTimes(1);
    });
});
