import * as React from 'react';
import { act } from 'react-test-renderer';
import type { BrowserViewTargetV1, FeatureDecision } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets/suggestions';
import { resolveBrowserViewIdForTarget } from '@/sync/domains/browser/store';
import {
    createOpenBrowserTargetInWorkspace,
    resolveBrowserViewTargetOpen,
} from '@/components/browser/surfaces/openBrowserTargetInWorkspace';
import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import type { BrowserLaunchpadOpenTargetOptions } from './BrowserLaunchpad';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key });
});

const localPreviewTarget = {
    kind: 'localServicePreview',
    targetId: 'preview_vite',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: {
        title: 'Vite app',
        addressLabel: 'localhost:5173',
    },
} satisfies BrowserViewTargetV1;

const externalTarget = {
    kind: 'externalUrl',
    targetId: 'external_docs',
    url: 'https://docs.happier.test/',
    display: {
        title: 'Docs',
        addressLabel: 'docs.happier.test',
    },
} satisfies BrowserViewTargetV1;

const hostedPluginTarget = {
    kind: 'hostedPluginWeb',
    targetId: 'hosted_preview',
    pluginId: 'acme.preview',
    contributionId: 'previewPane',
    display: {
        title: 'Plugin preview',
        addressLabel: 'plugin://acme.preview/previewPane',
    },
} satisfies BrowserViewTargetV1;

const hostedPluginProfile = {
    profileId: 'profile_plugin_1',
    storageMode: 'plugin',
    owner: {
        kind: 'plugin',
        id: 'acme.preview',
        contributionId: 'previewPane',
    },
    createdAt: 1_000,
    updatedAt: 1_000,
    cleanupOnSessionClose: true,
} as const;

const sessionProfile = {
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

const rows: readonly BrowserLaunchpadRow[] = [{
    id: 'localService:launcher_preview',
    section: 'running',
    sourceKind: 'localService',
    title: 'Vite app',
    subtitle: 'localhost:5173',
    detail: 'Ready for preview',
    target: localPreviewTarget,
    currentUrl: 'https://preview.happier.test/app/',
    currentUrlExpiresAt: 1_700_000_000_000,
    disabledReason: null,
    lastSeenAt: 1_000,
}, {
    id: 'localService:launcher_stale',
    section: 'unavailable',
    sourceKind: 'localService',
    title: 'Old service',
    subtitle: 'localhost:4000',
    detail: 'Unavailable',
    target: {
        ...localPreviewTarget,
        targetId: 'preview_stale',
        display: {
            title: 'Old service',
            addressLabel: 'localhost:4000',
        },
    },
    disabledReason: 'stale_service',
    lastSeenAt: 900,
}];

describe('BrowserLaunchpad', () => {
    it('keeps rows visible while refreshing and opens only available browser targets', async () => {
        const { BrowserLaunchpad } = await import('./BrowserLaunchpad');
        const onOpenTarget = vi.fn<(target: BrowserViewTargetV1) => void>();

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="android"
                rows={rows}
                refreshStatus="refreshing"
                onOpenTarget={onOpenTarget}
                testID="browser-launchpad"
            />,
        );

        expect(screen.findByTestId('browser-launchpad-refreshing')).toBeTruthy();
        expect(screen.findByTestId('browser-launchpad-card:localService:launcher_preview')).toBeTruthy();
        expect(screen.findByTestId('browser-launchpad-card:localService:launcher_stale')).toBeTruthy();
        expect(screen.findByTestId('browser-launchpad-card:localService:launcher_stale-disabled')).toBeTruthy();

        await screen.pressByTestIdAsync('browser-launchpad-card:localService:launcher_preview');
        await screen.pressByTestIdAsync('browser-launchpad-card:localService:launcher_stale');

        expect(onOpenTarget).toHaveBeenCalledTimes(1);
        expect(onOpenTarget).toHaveBeenCalledWith(localPreviewTarget, {
            platform: 'android',
            currentUrl: 'https://preview.happier.test/app/',
            currentUrlExpiresAt: 1_700_000_000_000,
        });
    });

    it('disables target rows when the platform adapter is unavailable', async () => {
        const { BrowserLaunchpad } = await import('./BrowserLaunchpad');
        const onOpenTarget = vi.fn<(target: BrowserViewTargetV1) => void>();

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="web"
                rows={[{
                    id: 'recent:external_docs',
                    section: 'recent',
                    sourceKind: 'recent',
                    title: 'Docs',
                    subtitle: 'docs.happier.test',
                    detail: 'externalUrl',
                    target: externalTarget,
                    disabledReason: null,
                    lastSeenAt: 1_000,
                }]}
                refreshStatus="idle"
                onOpenTarget={onOpenTarget}
                testID="browser-launchpad"
            />,
        );

        expect(screen.findByTestId('browser-launchpad-card:recent:external_docs-disabled')).not.toBeNull();

        await screen.pressByTestIdAsync('browser-launchpad-card:recent:external_docs');

        expect(onOpenTarget).not.toHaveBeenCalled();
    });

    it('fails closed for hosted-plugin targets when no browser profile policy is supplied', async () => {
        const { BrowserLaunchpad } = await import('./BrowserLaunchpad');
        const onOpenTarget = vi.fn<(target: BrowserViewTargetV1) => void>();

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="web"
                rows={[{
                    id: 'pluginHostedWeb:preview',
                    section: 'plugin',
                    sourceKind: 'hostedPluginWeb',
                    title: 'Plugin preview',
                    subtitle: 'plugin://acme.preview/previewPane',
                    detail: 'acme.preview',
                    target: hostedPluginTarget,
                    currentUrl: 'https://plugins.happier.test/acme.preview/previewPane/',
                    disabledReason: null,
                    lastSeenAt: 1_000,
                }]}
                refreshStatus="idle"
                onOpenTarget={onOpenTarget}
                testID="browser-launchpad"
            />,
        );

        expect(screen.findByTestId('browser-launchpad-card:pluginHostedWeb:preview-disabled')).not.toBeNull();

        await screen.pressByTestIdAsync('browser-launchpad-card:pluginHostedWeb:preview');

        expect(onOpenTarget).not.toHaveBeenCalled();
    });

    it('opens hosted-plugin targets when the browser profile policy matches the plugin target', async () => {
        const { BrowserLaunchpad } = await import('./BrowserLaunchpad');
        const onOpenTarget = vi.fn<(target: BrowserViewTargetV1) => void>();

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="web"
                browserProfile={hostedPluginProfile}
                rows={[{
                    id: 'pluginHostedWeb:preview',
                    section: 'plugin',
                    sourceKind: 'hostedPluginWeb',
                    title: 'Plugin preview',
                    subtitle: 'plugin://acme.preview/previewPane',
                    detail: 'acme.preview',
                    target: hostedPluginTarget,
                    currentUrl: 'https://plugins.happier.test/acme.preview/previewPane/',
                    disabledReason: null,
                    lastSeenAt: 1_000,
                }]}
                refreshStatus="idle"
                onOpenTarget={onOpenTarget}
                testID="browser-launchpad"
            />,
        );

        expect(screen.findByTestId('browser-launchpad-card:pluginHostedWeb:preview-available')).not.toBeNull();

        await screen.pressByTestIdAsync('browser-launchpad-card:pluginHostedWeb:preview');

        expect(onOpenTarget).toHaveBeenCalledWith(hostedPluginTarget, {
            platform: 'web',
            currentUrl: 'https://plugins.happier.test/acme.preview/previewPane/',
        });
    });

    it('opens desktop external URL rows only with policy and native WebView context', async () => {
        const { BrowserLaunchpad } = await import('./BrowserLaunchpad');
        const onOpenTarget = vi.fn<(target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void>();

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="desktop"
                browserFeatureDecision={enabledBrowserDecision}
                browserProfile={sessionProfile}
                desktopWebViewAvailability={availableDesktopWebView}
                rows={[{
                    id: 'recent:external_docs',
                    section: 'recent',
                    sourceKind: 'recent',
                    title: 'Docs',
                    subtitle: 'docs.happier.test',
                    detail: 'externalUrl',
                    target: externalTarget,
                    disabledReason: null,
                    lastSeenAt: 1_000,
                }]}
                refreshStatus="idle"
                onOpenTarget={onOpenTarget}
                testID="browser-launchpad"
            />,
        );

        expect(screen.findByTestId('browser-launchpad-card:recent:external_docs-available')).not.toBeNull();

        await screen.pressByTestIdAsync('browser-launchpad-card:recent:external_docs');

        expect(onOpenTarget).toHaveBeenCalledWith(externalTarget, expect.objectContaining({
            platform: 'desktop',
            targetPolicyDecision: expect.objectContaining({
                state: 'allowed',
                profileId: 'profile_session_1',
            }),
            desktopWebViewAvailability: availableDesktopWebView,
        }));
    });

    it('honors plugin target launch and profile modes at the browser host boundary', async () => {
        const { BrowserLaunchpad } = await import('./BrowserLaunchpad');
        const onOpenTarget = vi.fn<(target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void>();
        const onNavigateInPlace = vi.fn<(target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void>();
        const pluginRow = {
            id: 'pluginExternalUrl:browserTarget:acme.preview:docs',
            section: 'plugin',
            sourceKind: 'pluginExternalUrl',
            title: 'Plugin docs',
            detail: 'acme.preview',
            target: externalTarget,
            currentUrl: externalTarget.url,
            launchMode: 'currentView',
            profileMode: 'session',
            disabledReason: null,
            lastSeenAt: 0,
        } satisfies BrowserLaunchpadRow;

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="desktop"
                browserFeatureDecision={enabledBrowserDecision}
                browserProfile={sessionProfile}
                desktopWebViewAvailability={availableDesktopWebView}
                rows={[pluginRow]}
                refreshStatus="idle"
                onOpenTarget={onOpenTarget}
                onNavigateInPlace={onNavigateInPlace}
                testID="browser-launchpad"
            />,
        );

        await screen.pressByTestIdAsync(`browser-launchpad-card:${pluginRow.id}`);
        expect(onOpenTarget).not.toHaveBeenCalled();
        expect(onNavigateInPlace).toHaveBeenCalledWith(externalTarget, expect.objectContaining({
            platform: 'desktop',
            currentUrl: externalTarget.url,
        }));

        const mismatched = await renderScreen(
            <BrowserLaunchpad
                platform="desktop"
                browserFeatureDecision={enabledBrowserDecision}
                browserProfile={sessionProfile}
                desktopWebViewAvailability={availableDesktopWebView}
                rows={[{ ...pluginRow, profileMode: 'plugin' }]}
                refreshStatus="idle"
                onOpenTarget={onOpenTarget}
                onNavigateInPlace={onNavigateInPlace}
                testID="browser-launchpad-mismatch"
            />,
        );
        expect(mismatched.findByTestId(`browser-launchpad-mismatch-card:${pluginRow.id}-disabled`)).not.toBeNull();
    });

    it('renders the workspace launcher (URL entry + guidance) instead of a dead banner when there are no rows', async () => {
        const { BrowserLaunchpad } = await import('./BrowserLaunchpad');

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="desktop"
                rows={[]}
                refreshStatus="idle"
                onOpenTarget={vi.fn()}
                testID="browser-launchpad"
            />,
        );

        // The launcher always offers an address box, even with zero detected targets.
        expect(screen.findByTestId('browser-launchpad-url-entry')).toBeTruthy();
        // Guidance replaces the dead "No browser targets" card.
        expect(screen.findByTestId('browser-launchpad-guidance')).toBeTruthy();
        // The old inert single banner is gone.
        expect(screen.findByTestId('browser-launchpad-empty')).toBeNull();
    });

    it('DV-NAV: a typed URL on the new-tab page navigates the CURRENT tab in place (onNavigateInPlace), NOT onOpenTarget', async () => {
        const { BrowserLaunchpad } = await import('./BrowserLaunchpad');
        const onOpenTarget = vi.fn<(target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void>();
        const onNavigateInPlace = vi.fn<(target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void>();

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="desktop"
                browserFeatureDecision={enabledBrowserDecision}
                browserProfile={sessionProfile}
                desktopWebViewAvailability={availableDesktopWebView}
                rows={[]}
                refreshStatus="idle"
                onOpenTarget={onOpenTarget}
                onNavigateInPlace={onNavigateInPlace}
                testID="browser-launchpad"
            />,
        );

        screen.changeTextByTestId('browser-launchpad-url-entry-input', 'https://example.test');
        const input = screen.findByTestId('browser-launchpad-url-entry-input');
        await act(async () => {
            (input?.props as { onSubmitEditing?: () => void }).onSubmitEditing?.();
        });

        // The URL submit turns the current new-tab page INTO the page — it must NOT spawn a sibling tab.
        expect(onOpenTarget).not.toHaveBeenCalled();
        expect(onNavigateInPlace).toHaveBeenCalledTimes(1);
        const [target] = onNavigateInPlace.mock.calls[0] as [BrowserViewTargetV1, BrowserLaunchpadOpenTargetOptions | undefined];
        expect(target.kind).toBe('externalUrl');
        expect(target.kind === 'externalUrl' ? target.url : null).toBe('https://example.test/');
    });

    it('shows a live listening pulse for running rows and a stale dot for unavailable rows', async () => {
        const { BrowserLaunchpad } = await import('./BrowserLaunchpad');

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="android"
                rows={rows}
                refreshStatus="idle"
                onOpenTarget={vi.fn()}
                testID="browser-launchpad"
            />,
        );

        expect(screen.findByTestId('browser-launchpad-card:localService:launcher_preview-dot-live')).toBeTruthy();
        expect(screen.findByTestId('browser-launchpad-card:localService:launcher_stale-dot-stale')).toBeTruthy();
    });

    it('opens a running row through the canonical opener, creating BOTH a details tab AND a live content record', async () => {
        const { BrowserLaunchpad } = await import('./BrowserLaunchpad');

        const openedTabs: DetailsTab[] = [];
        // Wire the launcher through the REAL FP-BRW-OPEN-TARGET-1 opener. The launcher only calls
        // props.onOpenTarget; the opener is the single owner of tab + content-record creation. No
        // open/dispatch path is re-implemented in the test — the opener does the work.
        const onOpenTarget = createOpenBrowserTargetInWorkspace({
            scope: 'sessionDetails',
            platform: 'android',
            openDetailsTab: (tab) => {
                openedTabs.push(tab);
            },
        });

        const screen = await renderScreen(
            <BrowserLaunchpad
                platform="android"
                rows={rows}
                refreshStatus="idle"
                onOpenTarget={onOpenTarget}
                testID="browser-launchpad"
            />,
        );

        await screen.pressByTestIdAsync('browser-launchpad-card:localService:launcher_preview');

        // (i) a canonical browser-view details-workspace tab for the target…
        expect(openedTabs).toHaveLength(1);
        expect(openedTabs[0]?.kind).toBe('browser-view');
        const tabResource = openedTabs[0]?.resource as { target?: BrowserViewTargetV1; browserSessionId?: string };
        expect(tabResource.target).toEqual(localPreviewTarget);

        // (ii) …AND a live browser content/view record under the same identity. The opener's pure
        // resolver is the authority for the seeded record; feed it the same scope/target the
        // launcher just routed and assert the content record materializes (store.openBrowserTarget).
        const resolved = resolveBrowserViewTargetOpen(
            { scope: 'sessionDetails', platform: 'android' },
            localPreviewTarget,
        );
        const viewId = resolveBrowserViewIdForTarget(localPreviewTarget);
        const record = resolved.seededState.viewsById[viewId];
        expect(record).toBeDefined();
        expect(record?.target).toEqual(localPreviewTarget);
        expect(record?.browserSessionId).toBe(tabResource.browserSessionId);
    });
});
