import type {
    BrowserViewTargetV1,
    LocalServiceLauncherSnapshotV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import {
    applyLocalServiceLauncherSnapshot,
    createLocalServiceLauncherState,
    type LocalServiceLauncherState,
} from '@/sync/domains/local/services/launch';
import { createLocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import {
    EMPTY_PLUGIN_BROWSER_PROJECTION,
    type PluginBrowserProjectionModel,
} from '@/sync/domains/plugins/browser/targets';

import {
    resolveBrowserSurfacePlatform,
    useBrowserSurfaceHostProps,
} from '../useBrowserSurfaceHostProps';

const runningServiceTarget = {
    kind: 'localServicePreview',
    targetId: 'preview_vite',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: {
        title: 'Vite app',
        addressLabel: 'localhost:5173',
    },
} satisfies BrowserViewTargetV1;

const runningLauncherSnapshot = {
    v: 1,
    machineId: 'machine_1',
    sessionId: 'session_1',
    updatedAt: 1_000,
    targets: [{
        id: 'launcher_preview',
        source: 'registered_preview',
        machineId: 'machine_1',
        sessionId: 'session_1',
        title: 'Vite app',
        subtitle: 'localhost:5173',
        kind: 'vite',
        confidence: 'high',
        state: 'available',
        actions: ['open_preview'],
        browserTarget: runningServiceTarget,
    }],
} satisfies LocalServiceLauncherSnapshotV1;

const hostedPluginProjection = {
    ...EMPTY_PLUGIN_BROWSER_PROJECTION,
    generation: 3,
    targetsById: {
        'browserTarget:acme.preview:pane': {
            id: 'browserTarget:acme.preview:pane',
            pluginId: 'acme.preview',
            contributionKind: 'browserTarget',
            contributionId: 'pane',
            target: {
                kind: 'hostedPluginWeb',
                targetId: 'plugin_pane',
                pluginId: 'acme.preview',
                contributionId: 'pane',
                display: {
                    title: 'Plugin Preview',
                    addressLabel: 'plugin://acme.preview/pane',
                },
            },
            display: {
                title: 'Plugin Preview',
                addressLabel: 'plugin://acme.preview/pane',
            },
            endpointUrl: 'https://preview.happier.test/plugin/acme/',
            endpointExpiresAt: 1_700_000_000_000,
        },
    },
} satisfies PluginBrowserProjectionModel;

function buildRunningLauncherState(): LocalServiceLauncherState {
    return applyLocalServiceLauncherSnapshot(
        createLocalServiceLauncherState(),
        runningLauncherSnapshot,
    );
}

const TAURI_INTERNALS_KEY = '__TAURI_INTERNALS__';

function setTauriDesktop(enabled: boolean): void {
    if (enabled) {
        (globalThis as Record<string, unknown>)[TAURI_INTERNALS_KEY] = { invoke: () => undefined };
    } else {
        delete (globalThis as Record<string, unknown>)[TAURI_INTERNALS_KEY];
    }
}

describe('resolveBrowserSurfacePlatform', () => {
    const originalInternals = (globalThis as Record<string, unknown>)[TAURI_INTERNALS_KEY];

    afterEach(() => {
        if (originalInternals === undefined) {
            delete (globalThis as Record<string, unknown>)[TAURI_INTERNALS_KEY];
        } else {
            (globalThis as Record<string, unknown>)[TAURI_INTERNALS_KEY] = originalInternals;
        }
    });

    it('returns an explicit browser platform override unchanged when NOT under Tauri', () => {
        setTauriDesktop(false);
        expect(resolveBrowserSurfacePlatform('ios')).toBe('ios');
        expect(resolveBrowserSurfacePlatform('android')).toBe('android');
        expect(resolveBrowserSurfacePlatform('web')).toBe('web');
        expect(resolveBrowserSurfacePlatform('desktop')).toBe('desktop');
    });

    it('returns desktop inside Tauri even though the web bundle reports Platform.OS === "web" (B-RC1)', () => {
        setTauriDesktop(true);
        // No explicit override, web bundle (Platform.OS === 'web' in the testkit RN mock) → desktop.
        expect(resolveBrowserSurfacePlatform()).toBe('desktop');
        expect(resolveBrowserSurfacePlatform(null)).toBe('desktop');
    });

    it('ignores a leaked explicit "web" override under Tauri (B-3 root cause)', () => {
        setTauriDesktop(true);
        // The details/workspace surface renderers pass through a `LocalServicePreviewPlatform`
        // (`"web" | "ios" | "android"`) which cannot represent `'desktop'`, so inside Tauri it always
        // carries `'web'`. That leaked `'web'` must NOT defeat the Tauri verdict — otherwise the
        // selector picks `webIframe` and renders the sandboxed iframe instead of the Wry webview.
        expect(resolveBrowserSurfacePlatform('web')).toBe('desktop');
    });

    it('still honors a genuine cross-platform override (ios/android/desktop) under Tauri', () => {
        setTauriDesktop(true);
        // ios/android/desktop are meaningful explicit targets (e.g. a forced mobile preview); only the
        // structurally-ambiguous `'web'` is treated as a leak under Tauri.
        expect(resolveBrowserSurfacePlatform('ios')).toBe('ios');
        expect(resolveBrowserSurfacePlatform('android')).toBe('android');
        expect(resolveBrowserSurfacePlatform('desktop')).toBe('desktop');
    });

    it('resolves web in a plain browser (no Tauri host)', () => {
        setTauriDesktop(false);
        expect(resolveBrowserSurfacePlatform(undefined)).toBe('web');
    });

    it('keeps the vestigial fallback option from overriding the resolved (non-Tauri) verdict', () => {
        setTauriDesktop(false);
        // The fallback no longer decides the desktop verdict — the web bundle still resolves to web.
        expect(resolveBrowserSurfacePlatform(undefined, { fallback: 'web' })).toBe('web');
    });
});

describe('useBrowserSurfaceHostProps', () => {
    it('resolves platform, derives stable keys, and assembles a non-empty launchpad feed', async () => {
        const rendered = await renderHook(() => useBrowserSurfaceHostProps({
            scope: 'sessionMobile',
            sessionId: 'session_1',
            machineId: 'machine_1',
            serverId: 'server_1',
            launcherState: buildRunningLauncherState(),
            localServicePreviewState: createLocalServicePreviewState(),
            nowMs: () => 1_500,
        }));

        const props = rendered.getCurrent();
        // No Tauri host in the test env → the web bundle resolves to 'web' (desktop is Tauri-only now).
        expect(props.platform).toBe('web');
        expect(props.browserSessionId).toBe('session:session_1:mobile-cockpit');
        expect(typeof props.surfaceKey).toBe('string');
        expect(props.surfaceKey.length).toBeGreaterThan(0);
        expect(props.presentationSlotId.length).toBeGreaterThan(0);
        expect(props.launchpadRows.length).toBeGreaterThanOrEqual(1);
        expect(props.launchpadRows.some((row) => row.target?.targetId === 'preview_vite')).toBe(true);
        expect(typeof props.onLifecycleChange).toBe('function');
        await rendered.unmount();
    });

    it('keeps surfaceKey and initialBrowserState referentially stable across re-renders (continuity)', async () => {
        const launcherState = buildRunningLauncherState();
        const previewState = createLocalServicePreviewState();
        const rendered = await renderHook(() => useBrowserSurfaceHostProps({
            scope: 'sessionMobile',
            sessionId: 'session_1',
            machineId: 'machine_1',
            serverId: 'server_1',
            launcherState,
            localServicePreviewState: previewState,
            nowMs: () => 1_500,
        }));

        const first = rendered.getCurrent();
        const second = await rendered.rerender();

        expect(second.surfaceKey).toBe(first.surfaceKey);
        expect(second.initialBrowserState).toBe(first.initialBrowserState);
        expect(second.onLifecycleChange).toBe(first.onLifecycleChange);
        await rendered.unmount();
    });

    it('retains the logical view across a visible -> hidden lifecycle transition (keep-alive)', async () => {
        const rendered = await renderHook(() => useBrowserSurfaceHostProps({
            scope: 'sessionMobile',
            sessionId: 'session_1',
            machineId: 'machine_1',
            serverId: 'server_1',
            launcherState: buildRunningLauncherState(),
            localServicePreviewState: createLocalServicePreviewState(),
            nowMs: () => 1_500,
        }));

        const props = rendered.getCurrent();
        expect(props.isLogicalViewRetained()).toBe(false);

        // Host emits a visible snapshot for the logical view, then a hidden one (pane switched away).
        props.onLifecycleChange({
            logicalViewId: 'browser_view:preview_vite',
            lifecycleState: 'visible',
            slotsById: {
                [props.presentationSlotId]: {
                    presentationSlotId: props.presentationSlotId,
                    visible: true,
                    active: true,
                    measuredRect: { x: 0, y: 0, width: 800, height: 600 },
                },
            },
            cleanupReason: null,
        });
        expect(props.isLogicalViewRetained()).toBe(true);

        props.onLifecycleChange({
            logicalViewId: 'browser_view:preview_vite',
            lifecycleState: 'hidden',
            slotsById: {
                [props.presentationSlotId]: {
                    presentationSlotId: props.presentationSlotId,
                    visible: false,
                    active: false,
                    measuredRect: null,
                },
            },
            cleanupReason: null,
        });
        // Hiding the pane must NOT drop the retained logical view.
        expect(props.isLogicalViewRetained()).toBe(true);

        // A real close drops it.
        props.onLifecycleChange({
            logicalViewId: 'browser_view:preview_vite',
            lifecycleState: 'closed',
            slotsById: {},
            cleanupReason: 'logical_view_closed',
        });
        expect(props.isLogicalViewRetained()).toBe(false);
        await rendered.unmount();
    });

    it('includes hosted-plugin browser targets for the project scope feed', async () => {
        const rendered = await renderHook(() => useBrowserSurfaceHostProps({
            scope: 'projectSidebar',
            workspaceRefId: 'workspace_1',
            machineId: 'machine_1',
            serverId: 'server_1',
            launcherState: buildRunningLauncherState(),
            localServicePreviewState: createLocalServicePreviewState(),
            pluginBrowserProjection: hostedPluginProjection,
            nowMs: () => 1_500,
        }));

        const props = rendered.getCurrent();
        expect(props.browserSessionId).toBe('project:workspace_1:right-sidebar');
        expect(props.launchpadRows.some((row) => row.target?.kind === 'hostedPluginWeb')).toBe(true);
        await rendered.unmount();
    });
});
