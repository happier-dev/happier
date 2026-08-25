import * as React from 'react';
import type {
    BrowserCommandV1,
    BrowserContextCapabilities,
    BrowserDiagnosticEventV1,
    BrowserDiagnosticsSnapshotV1,
    BrowserEventV1,
    BrowserRecordingCapabilities,
    BrowserViewTargetV1,
} from '@happier-dev/protocol';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import { AnnotationCaptureSurface } from '@/components/browser/annotation';
import {
    createBrowserContextState,
    selectBrowserContextComposerAttachments,
    type BrowserContextState,
    type BrowserContextUnavailableReason,
} from '@/sync/domains/browser/context';
import {
    applyBrowserDiagnosticEvents,
    createBrowserDiagnosticsUiStore,
} from '@/sync/domains/browser/diagnostics';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/actions';

const testState = vi.hoisted(() => ({
    useLocalServicePreviewState: vi.fn(),
    fetchBrowserDiagnosticsSnapshotViaMachineRpc: vi.fn(),
}));

function stubCryptoRandomUuid(): void {
    let sequence = 0;
    vi.stubGlobal('crypto', {
        randomUUID: vi.fn(() => {
            sequence += 1;
            return `uuid_${sequence}`;
        }),
    });
}

function stubBrowserDiagnosticsWebEnvironment(): void {
    stubCryptoRandomUuid();
    vi.stubGlobal('window', {
        location: {
            origin: 'https://app.happier.test',
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    });
}

function findBrowserIframe(screen: RenderScreenResult): ReturnType<RenderScreenResult['findByType']> {
    return screen.findByType('iframe');
}

// The diagnostics drawer now renders the canonical `SegmentedTabBar`, which reads the app's motion
// preferences from the settings store. The canonical testkit stub is the boundary owner — without it
// the store initialisation never settles and the drawer cases time out.
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/sync/domains/local/services/preview/useLocalServicePreviewState', () => ({
    useLocalServicePreviewState: (...args: readonly unknown[]) =>
        testState.useLocalServicePreviewState(...args),
}));

vi.mock('@/sync/domains/browser/diagnostics/machineRpc', () => ({
    fetchBrowserDiagnosticsSnapshotViaMachineRpc: (...args: readonly unknown[]) =>
        testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc(...args),
}));

const target = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: {
        title: 'Preview',
        addressLabel: 'localhost:5173',
    },
} as const;

const simulatorPreviewTarget = {
    kind: 'simulatorPreview',
    targetId: 'simulator_preview_1',
    deviceId: 'simulator_1',
    sourceId: 'simulator_capture_source_1',
    display: {
        title: 'Simulator Preview',
        addressLabel: 'Pixel 8',
    },
} as const;

const contextCapabilities = {
    enabled: true,
    available: true,
    supportedContextKinds: ['browserPageReference'],
    supportedAdapterKinds: ['localPreview'],
    screenshot: {
        supported: false,
        requiresAttachmentUploads: true,
    },
    text: {
        maxSelectionChars: 2048,
        maxSummaryChars: 8192,
    },
    disabledReasons: [],
    policyDeniedReasons: [],
} satisfies BrowserContextCapabilities;

const unavailableRecordingCapabilities = {
    enabled: true,
    attachmentsEnabled: false,
    available: false,
    supportedCaptureKinds: [],
    supportedMimeTypes: [],
    supportedAdapterKinds: [],
    maxDurationMs: 30_000,
    maxBytes: 16_000_000,
    maxFps: 12,
    audioSupported: false,
    cursorOverlaySupported: false,
    actionTimelineChaptersSupported: false,
    supportedRetentionClasses: [],
    disabledReasons: ['capture_unavailable'],
    policyDeniedReasons: [],
} satisfies BrowserRecordingCapabilities;

const availableRecordingCapabilities = {
    enabled: true,
    attachmentsEnabled: true,
    available: true,
    supportedCaptureKinds: ['streamFrameCapture'],
    supportedMimeTypes: ['video/webm'],
    supportedAdapterKinds: ['simulatorPreview'],
    maxDurationMs: 30_000,
    maxBytes: 16_000_000,
    maxFps: 12,
    audioSupported: false,
    cursorOverlaySupported: true,
    actionTimelineChaptersSupported: true,
    supportedRetentionClasses: ['preSend', 'attached'],
    disabledReasons: [],
    policyDeniedReasons: [],
} satisfies BrowserRecordingCapabilities;

const secondTarget = {
    ...target,
    targetId: 'preview_2',
    display: {
        title: 'Second Preview',
        addressLabel: 'localhost:5174',
    },
} as const;

function createDaemonDiagnosticsEvent(
    overrides: Partial<BrowserDiagnosticEventV1> = {},
): BrowserDiagnosticEventV1 {
    return {
        v: 1,
        eventId: 'evt_daemon_console_1',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        navigationGeneration: 0,
        capturedAtMs: 3_000,
        family: 'console',
        kind: 'console.entry',
        fidelity: 'cdp',
        trusted: true,
        data: {
            level: 'log',
            textPreview: 'daemon console entry',
        },
        redaction: {
            level: 'metadataOnly',
            queryRedacted: true,
            headersRedacted: true,
            truncated: false,
        },
        ...overrides,
    };
}

function createDaemonDiagnosticsSnapshot(
    events: readonly BrowserDiagnosticEventV1[],
): BrowserDiagnosticsSnapshotV1 {
    return {
        v: 1,
        machineId: 'machine_1',
        generatedAt: 3_100,
        refreshState: 'idle',
        events: [...events],
        diagnostics: [{
            code: 'daemon_browser_diagnostics_snapshot_ready',
        }],
    };
}

async function createShellState() {
    const reducer = await import('@/sync/domains/browser/control/reducer');
    const events: readonly BrowserEventV1[] = [{
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
        target,
        platform: 'web',
	        currentUrl: 'https://preview.happier.test/',
	        adapterKind: 'localPreview',
        engineKind: 'webIframe',
        adapterCapabilities: {
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
                canStop: false,
            },
        },
        occurredAt: 1_001,
    }, {
        kind: 'viewFocused',
        eventId: 'event_focus',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        occurredAt: 1_002,
    }, {
        // B-2 cause-1: a URL-bearing open on a client-rendered (webIframe) engine now seeds
        // `loading`; the engine's load-end is what reaches `ready`. This shared fixture models a
        // SETTLED (loaded) view — the precondition for the reload affordance — by finishing the
        // load, exactly as the in-app engine lifecycle wiring does in product (B-2 cause-2).
        kind: 'navigationFinished',
        eventId: 'event_loaded',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        currentUrl: 'https://preview.happier.test/',
        occurredAt: 1_003,
    }];

    return events.reduce(
        (state, event) => reducer.applyBrowserControlEvent(state, event),
        reducer.createBrowserControlState(),
    );
}

async function createAnnotationCapableShellState(): Promise<Awaited<ReturnType<typeof createShellState>>> {
    const state = await createShellState();
    const activeView = state.viewsById.view_1;
    if (!activeView) {
        throw new Error('expected test browser view');
    }
    return {
        ...state,
        viewsById: {
            ...state.viewsById,
            view_1: {
                ...activeView,
                adapterCapabilities: {
                    ...activeView.adapterCapabilities,
                    diagnosticsFidelityByFamily: {
                        ...activeView.adapterCapabilities.diagnosticsFidelityByFamily,
                        screenshot: 'injectedPage',
                    },
                    contextKinds: ['browserPageReference', 'browserAnnotation'],
                },
            },
        },
    };
}

async function createTwoTabShellState() {
    const reducer = await import('@/sync/domains/browser/control/reducer');
    const base = await createShellState();
    return [{
        kind: 'viewOpened',
        eventId: 'event_view_2',
        browserSessionId: 'browser_session_1',
        viewId: 'view_2',
        target: secondTarget,
        platform: 'web',
	        currentUrl: 'https://second-preview.happier.test/',
	        adapterKind: 'localPreview',
        engineKind: 'webIframe',
        adapterCapabilities: {
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
                canStop: false,
            },
        },
        occurredAt: 1_003,
    } satisfies BrowserEventV1].reduce(
        (state, event) => reducer.applyBrowserControlEvent(state, event),
        base,
    );
}

async function createSimulatorPreviewShellState(): Promise<Awaited<ReturnType<typeof createShellState>>> {
    const reducer = await import('@/sync/domains/browser/control/reducer');
    const events: readonly BrowserEventV1[] = [{
        kind: 'sessionCreated',
        eventId: 'event_session',
        browserSessionId: 'browser_session_1',
        profileId: 'profile_1',
        occurredAt: 1_000,
    }, {
        kind: 'viewOpened',
        eventId: 'event_simulator_view',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        target: simulatorPreviewTarget,
        platform: 'web',
        adapterKind: 'simulatorPreview',
        engineKind: 'streamedSurface',
        adapterCapabilities: buildBrowserAdapterCapabilities({
            adapterKind: 'simulatorPreview',
            supportedTargetKinds: ['simulatorPreview'],
            supportedRenderEngines: ['streamedSurface'],
        }),
        occurredAt: 1_001,
    }, {
        kind: 'viewFocused',
        eventId: 'event_focus',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        occurredAt: 1_002,
    }];

    return events.reduce(
        (state, event) => reducer.applyBrowserControlEvent(state, event),
        reducer.createBrowserControlState(),
    );
}

describe('BrowserShell', () => {
    beforeEach(async () => {
        vi.unstubAllGlobals();
        const { resetBrowserDiagnosticsDrawerStateForTests } = await import('./diagnostics/BrowserDiagnosticsDrawer');
        resetBrowserDiagnosticsDrawerStateForTests();
        testState.useLocalServicePreviewState.mockReset();
        testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc.mockReset();
        const { createLocalServicePreviewState } = await import('@/sync/domains/local/services/preview/store');
        testState.useLocalServicePreviewState.mockReturnValue(createLocalServicePreviewState());
        testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc.mockResolvedValue({
            ok: false,
            reason: 'unavailable',
        });

    });

    it('renders capability-conditioned chrome and dispatches navigate commands without touching frame engines directly', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const state = await createShellState();
        const onCommand = vi.fn<(command: BrowserCommandV1) => void>();

        const screen = await renderScreen(
	            <BrowserShell
	                browserSessionId="browser_session_1"
	                platform="web"
	                state={state}
                onCommand={onCommand}
                testID="browser-shell"
            />,
        );

        // No inner tab strip — the shell is a single-active-view renderer; tab order/active live on
        // the details-workspace engine. The sole view's content/address renders directly.
        expect(screen.findByTestId('browser-shell-tab-view_1')).toBeNull();
        // Blurred address field shows the pretty display URL (scheme/trailing-slash trimmed).
        expect(screen.findByTestId('browser-shell-address')?.props.value).toBe('preview.happier.test');
        // The `webIframe` engine in this fixture declares no history capability, and a control the
        // active engine can NEVER fulfil is HIDDEN, not shipped permanently disabled
        // (`selectBrowserToolbarModel`'s `showBackForward`). `disabled` is reserved for the
        // transient case — the engine supports history but there is nowhere to go yet.
        expect(screen.findByTestId('browser-shell-back')).toBeNull();
        expect(screen.findByTestId('browser-shell-forward')).toBeNull();
        expect(screen.findByTestId('browser-shell-reload')?.props.accessibilityState?.disabled).toBe(false);
        expect(findBrowserIframe(screen).props.src).toBe('https://preview.happier.test/');

        await act(async () => {
            screen.changeTextByTestId('browser-shell-address', 'https://preview.happier.test/dashboard');
        });
        await act(async () => {
            screen.findByTestId('browser-shell-address')?.props.onSubmitEditing?.();
        });

        expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'navigate',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            url: 'https://preview.happier.test/dashboard',
        }));
    });

    it('surfaces target-bound plugin browser actions in the live toolbar overflow', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const state = await createShellState();
        const onPluginBrowserAction = vi.fn();
        const pluginBrowserProjection = {
            generation: 14,
            targetsById: {},
            actionsById: {
                'browserAction:acme.preview:open-preview': {
                    id: 'browserAction:acme.preview:open-preview',
                    pluginId: 'acme.preview',
                    contributionKind: 'browserAction',
                    contributionId: 'open-preview',
                    actionIdentity: { pluginId: 'acme.preview', localId: 'open-preview' },
                    qualifiedActionId: 'acme.preview/open-preview',
                    targetId: 'preview_1',
                    placement: 'toolbar',
                    display: { title: 'Open preview', iconToken: 'browser' },
                    order: 10,
                },
            },
            unknownEntriesById: {},
        } satisfies PluginBrowserProjectionModel;

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={vi.fn()}
                pluginBrowserProjection={pluginBrowserProjection}
                onPluginBrowserAction={onPluginBrowserAction}
                testID="browser-shell"
            />,
        );

        await screen.pressByTestIdAsync('browser-shell-overflow');
        await screen.pressByTestIdAsync('browser-shell-overflow-item-browserAction:acme.preview:open-preview');

        expect(onPluginBrowserAction).toHaveBeenCalledWith(
            pluginBrowserProjection.actionsById['browserAction:acme.preview:open-preview'],
            {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                targetId: 'preview_1',
                currentUrl: 'https://preview.happier.test/',
            },
        );
    });

    it('surfaces target-bound plugin browser actions in the live details panel and context menu', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const state = await createShellState();
        const onPluginBrowserAction = vi.fn();
        const pluginBrowserProjection = {
            generation: 14,
            targetsById: {},
            actionsById: {
                'browserAction:acme.preview:inspect-preview': {
                    id: 'browserAction:acme.preview:inspect-preview',
                    pluginId: 'acme.preview',
                    contributionKind: 'browserAction',
                    contributionId: 'inspect-preview',
                    actionIdentity: { pluginId: 'acme.preview', localId: 'inspect-preview' },
                    qualifiedActionId: 'acme.preview/inspect-preview',
                    targetId: 'preview_1',
                    placement: 'detailsPanel',
                    display: { title: 'Inspect preview', iconToken: 'search' },
                    order: 10,
                },
                'browserAction:acme.preview:copy-preview-url': {
                    id: 'browserAction:acme.preview:copy-preview-url',
                    pluginId: 'acme.preview',
                    contributionKind: 'browserAction',
                    contributionId: 'copy-preview-url',
                    actionIdentity: { pluginId: 'acme.preview', localId: 'copy-preview-url' },
                    qualifiedActionId: 'acme.preview/copy-preview-url',
                    targetId: 'preview_1',
                    placement: 'contextMenu',
                    display: { title: 'Copy preview URL', iconToken: 'copy' },
                    order: 20,
                },
            },
            unknownEntriesById: {},
        } satisfies PluginBrowserProjectionModel;

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={vi.fn()}
                pluginBrowserProjection={pluginBrowserProjection}
                onPluginBrowserAction={onPluginBrowserAction}
                testID="browser-shell"
            />,
        );

        await screen.pressByTestIdAsync(
            'browser-shell-plugin-action-detailsPanel-browserAction:acme.preview:inspect-preview',
        );
        await screen.pressByTestIdAsync('browser-shell-plugin-action-contextMenu-trigger');
        await screen.pressByTestIdAsync(
            'browser-shell-plugin-action-contextMenu-browserAction:acme.preview:copy-preview-url',
        );

        expect(onPluginBrowserAction).toHaveBeenNthCalledWith(
            1,
            pluginBrowserProjection.actionsById['browserAction:acme.preview:inspect-preview'],
            {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                targetId: 'preview_1',
                currentUrl: 'https://preview.happier.test/',
            },
        );
        expect(onPluginBrowserAction).toHaveBeenNthCalledWith(
            2,
            pluginBrowserProjection.actionsById['browserAction:acme.preview:copy-preview-url'],
            {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                targetId: 'preview_1',
                currentUrl: 'https://preview.happier.test/',
            },
        );
    });

    it('keeps a policy-disabled plugin browser action visible with its authored unavailable reason', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const state = await createShellState();
        const pluginBrowserProjection = {
            generation: 14,
            targetsById: {},
            actionsById: {
                'browserAction:acme.preview:open-preview': {
                    id: 'browserAction:acme.preview:open-preview',
                    pluginId: 'acme.preview',
                    contributionKind: 'browserAction',
                    contributionId: 'open-preview',
                    actionIdentity: { pluginId: 'acme.preview', localId: 'open-preview' },
                    qualifiedActionId: 'acme.preview/open-preview',
                    targetId: 'preview_1',
                    placement: 'toolbar',
                    display: { title: 'Open preview', iconToken: 'browser' },
                    availability: {
                        disabledWhen: {
                            fact: 'host.platform',
                            operator: 'equals',
                            value: 'web',
                        },
                        disabledReason: 'Open preview is available on desktop only.',
                    },
                },
            },
            unknownEntriesById: {},
        } satisfies PluginBrowserProjectionModel;
        const onPluginBrowserAction = vi.fn();

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={vi.fn()}
                pluginBrowserProjection={pluginBrowserProjection}
                pluginBrowserPolicyContext={{ platform: 'web' }}
                onPluginBrowserAction={onPluginBrowserAction}
                testID="browser-shell"
            />,
        );

        await screen.pressByTestIdAsync('browser-shell-overflow');
        const action = screen.findByTestId(
            'browser-shell-overflow-item-browserAction:acme.preview:open-preview',
        );
        expect(action?.props.accessibilityState).toMatchObject({ disabled: true });
        expect(action?.props.accessibilityHint).toBe('Open preview is available on desktop only.');
        await screen.pressByTestIdAsync('browser-shell-overflow-item-browserAction:acme.preview:open-preview');
        expect(onPluginBrowserAction).not.toHaveBeenCalled();
    });

    it('B-RC5: surfaces a compact privacy trigger (not an always-on triad) for an actionable profile, and reveals the detail on open', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const state = await createShellState();

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={vi.fn()}
                browserProfile={{
                    profile: {
                        profileId: 'profile_1',
                        storageMode: 'session',
                        owner: { kind: 'session', id: 'session_1' },
                        displayName: 'Session preview',
                        lifecycleState: 'active',
                        cleanupOnSessionClose: true,
                    },
                    storagePartition: {
                        partitionId: 'partition_1',
                        profileId: 'profile_1',
                        originKey: 'https://preview.happier.test',
                        targetKind: 'localServicePreview',
                        persistence: 'session',
                        state: 'active',
                        createdAt: 1_000,
                        updatedAt: 1_000,
                    },
                    activePermissionGrantCount: 2,
                }}
                testID="browser-shell"
            />,
        );

        // The always-on Mode/Storage/Permissions triad is gone from the toolbar.
        expect(screen.findAllByTestId('browser-shell-profile-status')).toHaveLength(0);
        // A single compact privacy/security trigger is present instead.
        expect(screen.findByTestId('browser-shell-privacy')).toBeTruthy();

        // Opening the popover reveals the profile/permission/storage detail.
        await act(async () => {
            screen.pressByTestId('browser-shell-privacy');
        });
        expect(screen.findByTestId('browser-shell-privacy-status')).toBeTruthy();
        expect(screen.findByTestId('browser-shell-privacy-status-mode-session')).toBeTruthy();
        expect(screen.findByTestId('browser-shell-privacy-status-storage-session')).toBeTruthy();
        expect(screen.findByTestId('browser-shell-privacy-status-permissions-active')).toBeTruthy();
    });

    it('9.2: renders a security-origin indicator and consolidates secondary tools into an overflow menu', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const state = await createShellState();

        const annotationCapabilities = {
            ...contextCapabilities,
            supportedContextKinds: ['browserPageReference', 'browserAnnotation'],
        } satisfies BrowserContextCapabilities;

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={vi.fn()}
                browserContext={{
                    state: createBrowserContextState(),
                    contextCapabilities: annotationCapabilities,
                    enabled: true,
                    onStateChange: vi.fn(),
                }}
                testID="browser-shell"
            />,
        );

        // The security posture is now RENDERED (it was tracked but never shown) and the origin chip stays.
        expect(screen.findByTestId('browser-shell-security')).toBeTruthy();
        // The origin-kind pill and the in-toolbar page title were MERGED AWAY: the workspace tab
        // strip already owns the title, and the origin kind is now this chip's fallback label.
        // One identity chip, not three near-identical grey pills.
        expect(screen.findByTestId('browser-shell-origin')).toBeNull();
        expect(screen.findByTestId('browser-shell-title')).toBeNull();
        expect(screen.findByTestId('browser-shell-security')).toBeTruthy();

        // Secondary single-shot tools (attach-context, annotation) moved OFF the wrapping row into
        // an overflow Popover — they are not rendered inline anymore.
        expect(screen.findAllByTestId('browser-shell-attach-context')).toHaveLength(0);
        expect(screen.findByTestId('browser-shell-overflow')).toBeTruthy();

        await act(async () => {
            screen.pressByTestId('browser-shell-overflow');
        });
        expect(screen.findByTestId('browser-shell-overflow-item-attach-context')).toBeTruthy();
        expect(screen.findByTestId('browser-shell-overflow-item-start-annotation')).toBeTruthy();
    });

    it('B-RC5: renders no profile chrome for the host-local default profile (clean browser)', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const { LOCAL_BROWSER_PROFILE } = await import('@/sync/domains/browser/profiles/localBrowserProfile');
        const state = await createShellState();

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={vi.fn()}
                browserProfile={{ profile: LOCAL_BROWSER_PROFILE }}
                testID="browser-shell"
            />,
        );

        expect(screen.findAllByTestId('browser-shell-privacy')).toHaveLength(0);
        expect(screen.findAllByTestId('browser-shell-profile-status')).toHaveLength(0);
    });

    it('uses live local preview state for browser views without a current URL', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const reducer = await import('@/sync/domains/browser/control/reducer');
        const {
            applyLocalServicePreviewSnapshot,
            createLocalServicePreviewState,
        } = await import('@/sync/domains/local/services/preview/store');
        const livePreviewState = applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
            generatedAt: 1_000,
            refreshState: 'idle',
            previews: [{
                previewId: 'preview_1',
                accessUrl: 'https://preview.happier.test/live/',
                expiresAt: 2_000,
                diagnostics: [],
                resource: {
                    previewId: 'preview_1',
                    sessionId: 'session_1',
                    machineId: 'machine_1',
                    owner: { kind: 'session', id: 'session_1' },
                    target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                    initialPath: { pathname: '/', search: '' },
                    display: { title: 'Preview', addressLabel: 'localhost:5173' },
                    originMode: 'host',
                    browserTarget: target,
                },
            }],
            diagnostics: [],
        });
        testState.useLocalServicePreviewState.mockReturnValue(livePreviewState);
        const state = [{
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
            target,
            platform: 'web',
            currentUrl: null,
            adapterKind: 'localPreview',
            engineKind: 'webIframe',
            adapterCapabilities: buildBrowserAdapterCapabilities({
                adapterKind: 'localPreview',
                supportedTargetKinds: ['localServicePreview'],
                supportedRenderEngines: ['webIframe'],
            }),
            occurredAt: 1_001,
        }, {
            kind: 'viewFocused',
            eventId: 'event_focus',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            occurredAt: 1_002,
        } satisfies BrowserEventV1].reduce(
            (currentState, event) => reducer.applyBrowserControlEvent(currentState, event as BrowserEventV1),
            reducer.createBrowserControlState(),
        );
        const onCommand = vi.fn<(command: BrowserCommandV1) => void>();

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={onCommand}
                testID="browser-shell"
            />,
        );

        expect(testState.useLocalServicePreviewState).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            enabled: true,
        }));
        expect(findBrowserIframe(screen).props.src).toBe('https://preview.happier.test/live/');
    });


    it('mounts the browser launchpad when no browser view is focused', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const reducer = await import('@/sync/domains/browser/control/reducer');
	        const onCommand = vi.fn<(command: BrowserCommandV1) => void>();
	        const onOpenTarget = vi.fn();
	        const launchpadRows: readonly BrowserLaunchpadRow[] = [{
            id: 'localService:launcher_preview',
            section: 'running',
            sourceKind: 'localService',
            title: 'Preview',
            subtitle: 'localhost:5173',
            detail: 'vite',
            target,
	            currentUrl: 'https://preview.happier.test/app/',
	            currentUrlExpiresAt: 1_700_000_000_000,
	            disabledReason: null,
            lastSeenAt: 1_000,
        }];

        const screen = await renderScreen(
	            <BrowserShell
	                browserSessionId="browser_session_1"
	                platform="ios"
	                state={reducer.createBrowserControlState()}
                onCommand={onCommand}
                launchpadRows={launchpadRows}
                launchpadRefreshStatus="idle"
                onOpenTarget={onOpenTarget}
                testID="browser-shell"
            />,
        );

        expect(screen.findByTestId('browser-shell-launchpad')).toBeTruthy();

        await screen.pressByTestIdAsync('browser-shell-launchpad-card:localService:launcher_preview');

	        expect(onOpenTarget).toHaveBeenCalledWith(target, {
	            platform: 'ios',
	            currentUrl: 'https://preview.happier.test/app/',
	            currentUrlExpiresAt: 1_700_000_000_000,
	        });
        expect(onCommand).not.toHaveBeenCalled();
    });

    it('B-1: enables the toolbar address bar with no active view and opens the first view in place', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const reducer = await import('@/sync/domains/browser/control/reducer');
        const onCommand = vi.fn<(command: BrowserCommandV1) => void>();
        const onNavigateInPlace = vi.fn();

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="desktop"
                state={reducer.createBrowserControlState()}
                onCommand={onCommand}
                onNavigateInPlace={onNavigateInPlace}
                launchpadRows={[]}
                launchpadRefreshStatus="idle"
                testID="browser-shell"
            />,
        );

        // The address field is editable even with no active view (it is the new-tab entry point).
        const address = screen.findByTestId('browser-shell-address');
        expect((address?.props as { editable?: boolean }).editable).toBe(true);

        // Type then submit in separate flushes so the address field's editable draft commits before
        // the submit handler reads it (a single act batches the `setRawDraft` and submit would see an
        // empty draft).
        await act(async () => {
            screen.changeTextByTestId('browser-shell-address', 'https://example.test/start');
        });
        await act(async () => {
            screen.findByTestId('browser-shell-address')?.props.onSubmitEditing?.();
        });

        // The toolbar routes a typed address through the in-place open seam (NOT a navigate command,
        // which has no view to target), opening the first view in place.
        expect(onCommand).not.toHaveBeenCalled();
        expect(onNavigateInPlace).toHaveBeenCalledTimes(1);
        const [openedTarget, options] = onNavigateInPlace.mock.calls[0] as [BrowserViewTargetV1, { platform?: string } | undefined];
        expect(openedTarget.kind).toBe('externalUrl');
        expect(openedTarget.kind === 'externalUrl' ? openedTarget.url : null).toBe('https://example.test/start');
        expect(options?.platform).toBe('desktop');
    });

    it('B-1: keeps the toolbar address bar disabled with no active view when no in-place seam is provided', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const reducer = await import('@/sync/domains/browser/control/reducer');

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="desktop"
                state={reducer.createBrowserControlState()}
                onCommand={vi.fn()}
                launchpadRows={[]}
                launchpadRefreshStatus="idle"
                testID="browser-shell"
            />,
        );

        const address = screen.findByTestId('browser-shell-address');
        expect((address?.props as { editable?: boolean }).editable).toBe(false);
    });

    it('mounts the browser launchpad workspace launcher (URL entry + guidance) when no view or target suggestions exist', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const reducer = await import('@/sync/domains/browser/control/reducer');
        const onCommand = vi.fn<(command: BrowserCommandV1) => void>();

        const screen = await renderScreen(
	            <BrowserShell
	                browserSessionId="browser_session_1"
	                platform="web"
	                state={reducer.createBrowserControlState()}
                onCommand={onCommand}
                launchpadRows={[]}
                launchpadRefreshStatus="idle"
                testID="browser-shell"
            />,
        );

        // FP-BRW-LAUNCHER-1: the empty state is now the live workspace launcher (URL entry +
        // guidance), not the inert "No browser targets" banner.
        expect(screen.findByTestId('browser-shell-launchpad-url-entry')).toBeTruthy();
        expect(screen.findByTestId('browser-shell-launchpad-guidance')).toBeTruthy();
        expect(screen.findByTestId('browser-shell-launchpad-empty')).toBeNull();
        expect(screen.findByTestId('browser-shell-view-unavailable')).toBeNull();
    });

    it('disables launchpad target rows when no open-target handler is available', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const reducer = await import('@/sync/domains/browser/control/reducer');
        const onCommand = vi.fn<(command: BrowserCommandV1) => void>();
        const launchpadRows: readonly BrowserLaunchpadRow[] = [{
            id: 'localService:launcher_preview',
            section: 'running',
            sourceKind: 'localService',
            title: 'Preview',
            subtitle: 'localhost:5173',
            detail: 'vite',
            target,
            disabledReason: null,
            lastSeenAt: 1_000,
        }];

        const screen = await renderScreen(
	            <BrowserShell
	                browserSessionId="browser_session_1"
	                platform="web"
	                state={reducer.createBrowserControlState()}
                onCommand={onCommand}
                launchpadRows={launchpadRows}
                launchpadRefreshStatus="idle"
                testID="browser-shell"
            />,
        );

        expect(screen.findByTestId('browser-shell-launchpad-card:localService:launcher_preview-disabled')).toBeTruthy();
    });

    it('renders the workspace-selected active view (driven by the viewId prop), not an inner tab strip', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const state = await createTwoTabShellState();

        const screen = await renderScreen(
	            <BrowserShell
	                browserSessionId="browser_session_1"
	                viewId="view_2"
	                platform="web"
	                state={state}
                onCommand={vi.fn()}
                testID="browser-shell"
            />,
        );

        // The active content is the view the workspace selected (view_2), and there is no bespoke
        // inner browser tab strip — the details-workspace strip is the single tab system.
        expect(findBrowserIframe(screen).props.src)
            .toBe('https://second-preview.happier.test/');
        expect(screen.findByTestId('browser-shell-tab-view_1')).toBeNull();
        expect(screen.findByTestId('browser-shell-tab-view_2')).toBeNull();
    });

    it('captures the focused browser page into browser context state from shell chrome', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const state = await createShellState();
        const onContextStateChange = vi.fn<(state: BrowserContextState) => void>();
        const onAttachUnavailable = vi.fn<(reason: BrowserContextUnavailableReason) => void>();

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={vi.fn()}
                browserContext={{
                    state: createBrowserContextState(),
                    contextCapabilities,
                    onStateChange: onContextStateChange,
                    onAttachUnavailable,
                    nowMs: () => 7_000,
                }}
                testID="browser-shell"
            />,
        );

        await screen.pressByTestIdAsync('browser-shell-overflow');
        await screen.pressByTestIdAsync('browser-shell-overflow-item-attach-context');

        expect(onAttachUnavailable).not.toHaveBeenCalled();
        expect(onContextStateChange).toHaveBeenCalledTimes(1);
        const nextState = onContextStateChange.mock.calls[0]?.[0];
        expect(nextState).toBeDefined();
        if (!nextState) return;
        const [attachment] = selectBrowserContextComposerAttachments(nextState);
        expect(attachment).toEqual(expect.objectContaining({
            sourceViewId: 'view_1',
            capturedNavigationGeneration: 0,
            state: 'available',
        }));
        const item = nextState.itemsById[attachment!.contextId];
        expect(item).toEqual(expect.objectContaining({
            kind: 'browserPageReference',
            url: 'https://preview.happier.test/',
            title: 'Preview',
            capturedAtMs: 7_000,
        }));
    });

    it('does not re-register the composer page attachment handler when only browser context state changes', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const state = await createShellState();
        const onAttachPageReferenceChange = vi.fn<(handler: (() => void) | null) => void>();
        const onContextStateChange = vi.fn<(state: BrowserContextState) => void>();
        const initialContextState = createBrowserContextState();
        const renderShell = (contextState: BrowserContextState) => (
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={vi.fn()}
                browserContext={{
                    state: contextState,
                    contextCapabilities,
                    onStateChange: onContextStateChange,
                    onAttachPageReferenceChange,
                    nowMs: () => 7_000,
                }}
                testID="browser-shell"
            />
        );

        const screen = await renderScreen(renderShell(initialContextState));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(onAttachPageReferenceChange).toHaveBeenCalledTimes(1);
        expect(onAttachPageReferenceChange).toHaveBeenLastCalledWith(expect.any(Function));

        await screen.update(renderShell({
            ...initialContextState,
            navigationGenerationByViewId: {
                ...initialContextState.navigationGenerationByViewId,
                view_1: 0,
            },
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(onAttachPageReferenceChange).toHaveBeenCalledTimes(1);
    });

    it('marks attached browser context stale when the focused view navigates', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const reducer = await import('@/sync/domains/browser/control/reducer');
        const {
            attachActiveBrowserPageReference,
            selectBrowserContextComposerAttachments: selectAttachments,
        } = await import('@/sync/domains/browser/context');
        const initialState = await createShellState();
        const initialView = initialState.viewsById.view_1;
        expect(initialView).toBeDefined();
        if (!initialView) return;
        const attached = attachActiveBrowserPageReference({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            contextCapabilities,
            view: initialView,
            capturedAtMs: 7_000,
        });
        expect(attached.status).toBe('attached');
        if (attached.status !== 'attached') return;
        expect(selectAttachments(attached.state)[0]?.state).toBe('available');
        const navigatedState = reducer.applyBrowserControlEvent(initialState, {
            kind: 'navigationCommitted',
            eventId: 'event_navigation_committed',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            currentUrl: 'https://preview.happier.test/next',
            occurredAt: 8_000,
        } satisfies BrowserEventV1);
        const onContextStateChange = vi.fn<(state: BrowserContextState) => void>();

        await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={navigatedState}
                onCommand={vi.fn()}
                browserContext={{
                    state: attached.state,
                    contextCapabilities,
                    onStateChange: onContextStateChange,
                }}
                testID="browser-shell"
            />,
        );

        expect(onContextStateChange).toHaveBeenCalledTimes(1);
        const [staleState] = onContextStateChange.mock.calls[0] ?? [];
        expect(staleState).toBeDefined();
        if (!staleState) return;
        const [attachment] = selectAttachments(staleState);
        expect(attachment).toEqual(expect.objectContaining({
            sourceViewId: 'view_1',
            capturedNavigationGeneration: 0,
            currentNavigationGeneration: 1,
            state: 'navigationStale',
            requiresReconfirmBeforeSend: true,
        }));
    });

    it('marks attached browser context stale when a non-focused source view navigates', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const reducer = await import('@/sync/domains/browser/control/reducer');
        const {
            attachActiveBrowserPageReference,
            selectBrowserContextComposerAttachments: selectAttachments,
        } = await import('@/sync/domains/browser/context');
        const twoTabState = await createTwoTabShellState();
        const initialView = twoTabState.viewsById.view_1;
        expect(initialView).toBeDefined();
        if (!initialView) return;
        const attached = attachActiveBrowserPageReference({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            contextCapabilities,
            view: initialView,
            capturedAtMs: 7_000,
        });
        expect(attached.status).toBe('attached');
        if (attached.status !== 'attached') return;
        const focusedSecond = reducer.applyBrowserControlEvent(twoTabState, {
            kind: 'viewFocused',
            eventId: 'event_focus_second',
            browserSessionId: 'browser_session_1',
            viewId: 'view_2',
            occurredAt: 7_500,
        } satisfies BrowserEventV1);
        const navigatedFirst = reducer.applyBrowserControlEvent(focusedSecond, {
            kind: 'navigationCommitted',
            eventId: 'event_navigation_first',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            currentUrl: 'https://preview.happier.test/background',
            occurredAt: 8_000,
        } satisfies BrowserEventV1);
        const onContextStateChange = vi.fn<(state: BrowserContextState) => void>();

        await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={navigatedFirst}
                onCommand={vi.fn()}
                browserContext={{
                    state: attached.state,
                    contextCapabilities,
                    onStateChange: onContextStateChange,
                }}
                testID="browser-shell"
            />,
        );

        expect(onContextStateChange).toHaveBeenCalledTimes(1);
        const [staleState] = onContextStateChange.mock.calls[0] ?? [];
        expect(staleState).toBeDefined();
        if (!staleState) return;
        const [attachment] = selectAttachments(staleState);
        expect(attachment).toEqual(expect.objectContaining({
            sourceViewId: 'view_1',
            capturedNavigationGeneration: 0,
            currentNavigationGeneration: 1,
            state: 'navigationStale',
            requiresReconfirmBeforeSend: true,
        }));
    });

    it('mounts browser diagnostics for the focused view from the shared diagnostics store', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const state = await createShellState();
        const diagnosticsState = applyBrowserDiagnosticEvents(createBrowserDiagnosticsUiStore(), {
            events: [{
                v: 1,
                eventId: 'evt_page_1',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 0,
                capturedAtMs: 2_000,
                family: 'pageInfo',
                kind: 'pageInfo.snapshot',
                fidelity: 'nativeCallback',
                trusted: true,
                data: {
                    url: 'https://preview.happier.test/',
                    loading: false,
                },
                redaction: {
                    level: 'metadataOnly',
                },
            }],
        });

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={vi.fn()}
                browserDiagnostics={{
                    state: diagnosticsState,
                    requestEval: vi.fn(() => false),
                    requestGetProperties: vi.fn(() => false),
                    requestReleaseObjectGroup: vi.fn(() => false),
                }}
                testID="browser-shell"
            />,
        );

        // Diagnostics now render inside the collapsible bottom drawer; the
        // host-owned fidelity/trust badge stays on the active section.
        expect(screen.findByTestId('browser-shell-diagnostics-container-collapsed')).toBeTruthy();
        expect(screen.findByTestId('browser-shell-diagnostics-body')).toBeTruthy();
        expect(screen.findByTestId('browser-shell-diagnostics-body-fidelity-nativeCallback')).toBeTruthy();

        // The drawer shows one family at a time; select the pageInfo section to
        // reveal its family panel + event row.
        await screen.pressByTestIdAsync('browser-shell-diagnostics-tab:pageInfo');
        expect(screen.findByTestId('browser-shell-diagnostics-body-family-pageInfo')).toBeTruthy();
        expect(screen.findByTestId('browser-shell-diagnostics-body-pageInfo-row-evt_page_1')).toBeTruthy();
    });

    it('fails closed for browser diagnostics when no explicit diagnostics state is provided', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const state = await createShellState();
        stubBrowserDiagnosticsWebEnvironment();

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={vi.fn()}
                testID="browser-shell"
            />,
        );

        expect(screen.findByTestId('browser-shell-diagnostics')).toBeNull();
        expect(screen.findByTestId('browser-shell-diagnostics-status')).toBeNull();
        expect(testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc).not.toHaveBeenCalled();
    });

    it('renders explicit disabled browser recording states for capture and permission failures', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const { createBrowserRecordingState } = await import('@/sync/domains/browser/recording');
        const state = await createShellState();

        const captureUnavailable = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={vi.fn()}
                browserRecording={{
                    state: createBrowserRecordingState(),
                    recordingCapabilities: unavailableRecordingCapabilities,
                    enabled: true,
                    onStartRecording: vi.fn(),
                    onStopRecording: vi.fn(),
                    onCancelRecording: vi.fn(),
                }}
                testID="browser-shell"
            />,
        );

        expect(captureUnavailable.findByTestId('browser-shell-recording-status-capture-unavailable')).toBeTruthy();
        const captureStartButton = captureUnavailable.findByTestId('browser-shell-recording-start');
        expect(captureStartButton?.props.accessibilityState).toMatchObject({
            disabled: true,
        });
        expect(captureStartButton?.props.accessibilityHint).toBeTruthy();

        const permissionDenied = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={vi.fn()}
                browserRecording={{
                    state: createBrowserRecordingState(),
                    recordingCapabilities: availableRecordingCapabilities,
                    enabled: true,
                    policyState: 'permissionDenied',
                    onStartRecording: vi.fn(),
                    onStopRecording: vi.fn(),
                    onCancelRecording: vi.fn(),
                }}
                testID="browser-shell-permission"
            />,
        );

        expect(permissionDenied.findByTestId('browser-shell-permission-recording-status-permission-denied')).toBeTruthy();
        const permissionStartButton = permissionDenied.findByTestId('browser-shell-permission-recording-start');
        expect(permissionStartButton?.props.accessibilityState).toMatchObject({
            disabled: true,
        });
        expect(permissionStartButton?.props.accessibilityHint).toBeTruthy();
    });

    it('delegates recording starts with the focused browser target for source resolution', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const { createBrowserRecordingState } = await import('@/sync/domains/browser/recording');
        const state = await createSimulatorPreviewShellState();
        const onStartRecording = vi.fn();

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={vi.fn()}
                browserRecording={{
                    state: createBrowserRecordingState(),
                    recordingCapabilities: availableRecordingCapabilities,
                    enabled: true,
                    nowMs: () => 10_000,
                    isCaptureSourceAvailable: () => true,
                    onStartRecording,
                }}
                testID="browser-shell"
            />,
        );

        await screen.pressByTestIdAsync('browser-shell-recording-start');

        expect(onStartRecording).toHaveBeenCalledWith(expect.objectContaining({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            target: simulatorPreviewTarget,
            targetKind: simulatorPreviewTarget.kind,
            adapterKind: 'simulatorPreview',
            renderEngineKind: 'streamedSurface',
            captureKind: 'streamFrameCapture',
            navigationGeneration: 0,
        }));
    });

    it('renders active browser recording status and delegates stop or cancel actions', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const {
            createBrowserRecordingState,
            startBrowserRecordingSession,
        } = await import('@/sync/domains/browser/recording');
        const state = await createSimulatorPreviewShellState();
        const started = startBrowserRecordingSession({
            state: createBrowserRecordingState(),
            browserRecordingEnabled: true,
            recordingCapabilities: availableRecordingCapabilities,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            profileId: 'profile_1',
            targetKind: 'simulatorPreview',
            adapterKind: 'simulatorPreview',
            renderEngineKind: 'streamedSurface',
            captureKind: 'streamFrameCapture',
            fidelity: 'streamFrame',
            startedAtMs: 10_000,
            navigationGeneration: 0,
            mimeType: 'video/webm',
            retentionClass: 'preSend',
            captureSourceAvailable: true,
        });
        expect(started.status).toBe('started');
        if (started.status !== 'started') return;
        const onStopRecording = vi.fn();
        const onCancelRecording = vi.fn();

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={vi.fn()}
                browserRecording={{
                    state: started.state,
                    recordingCapabilities: availableRecordingCapabilities,
                    enabled: true,
                    nowMs: () => 12_300,
                    onStartRecording: vi.fn(),
                    onStopRecording,
                    onCancelRecording,
                }}
                testID="browser-shell"
            />,
        );

        expect(screen.findByTestId('browser-shell-recording-status-recording')).toBeTruthy();
        expect(screen.findByTestId('browser-shell-recording-status-temporary')).toBeTruthy();

        await screen.pressByTestIdAsync('browser-shell-recording-stop');
        await screen.pressByTestIdAsync('browser-shell-recording-cancel');

        expect(onStopRecording).toHaveBeenCalledWith(expect.objectContaining({
            recordingId: started.recordingId,
        }));
        expect(onCancelRecording).toHaveBeenCalledWith(expect.objectContaining({
            recordingId: started.recordingId,
        }));
        expect(onStopRecording.mock.calls[0]?.[0]).not.toHaveProperty('mediaRef');
        expect(onCancelRecording.mock.calls[0]?.[0]).not.toHaveProperty('mediaRef');
    });

    it('renders browser automation status, cancel control, and latest action timeline', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const { createBrowserAutomationControlService } = await import('@/sync/domains/browser/automation');
        const state = await createShellState();
        const controlService = createBrowserAutomationControlService({ nowMs: () => 20_000 });
        let resolvePending: (result: { status: 'succeeded' }) => void = () => undefined;
        const pending = new Promise<{ status: 'succeeded' }>((resolve) => {
            resolvePending = resolve;
        });

        expect(controlService.registerOwner({
            ownerId: 'owner_ui_1',
            authority: 'uiLocal',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 0,
            adapterKind: 'localPreview',
            fidelity: 'injectedPage',
            trustedInput: false,
            supportedActions: ['waitFor'],
            executeAction: async () => pending,
        })).toEqual({ ok: true });
        const action = controlService.executeAction({
            v: 1,
            automationRequestId: 'automation_request_wait_visible',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 0,
            requestedBy: 'agent',
            requesterRef: {
                kind: 'session',
                id: 'session_1',
            },
            actionKind: 'waitFor',
            timeoutMs: 10_000,
        });
        await Promise.resolve();

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={vi.fn()}
                browserAutomation={{
                    controlService,
                    enabled: true,
                }}
                testID="browser-shell"
            />,
        );

        expect(screen.findByTestId('browser-shell-automation-status-active')).toBeTruthy();
        expect(screen.findByTestId('browser-shell-automation-cancel')?.props.accessibilityState).toMatchObject({
            disabled: false,
        });

        await screen.pressByTestIdAsync('browser-shell-automation-cancel');
        await expect(action).resolves.toMatchObject({
            status: 'canceled',
            errorCode: 'user_canceled',
        });
        await flushHookEffects();

        expect(screen.findByTestId('browser-shell-automation-timeline-entry-automation_request_wait_visible')).toBeTruthy();
        expect(screen.findByTestId('browser-shell-automation-timeline-status-canceled')).toBeTruthy();
        resolvePending({ status: 'succeeded' });
    });

    it('mounts daemon browser diagnostics snapshots into the default product diagnostics panel', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const { useBrowserDiagnosticsRuntime } = await import('./diagnostics');
        const { selectActiveBrowserView } = await import('@/sync/domains/browser/shell');
        const state = await createShellState();
        stubBrowserDiagnosticsWebEnvironment();
        testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc.mockResolvedValueOnce({
            ok: true,
            snapshot: createDaemonDiagnosticsSnapshot([
                createDaemonDiagnosticsEvent(),
            ]),
        });
        function BrowserShellWithExplicitDiagnostics(): React.ReactElement {
            const diagnostics = useBrowserDiagnosticsRuntime({
                view: selectActiveBrowserView(state, 'browser_session_1'),
                enabled: true,
                daemonSnapshotServerId: 'server_1',
            });
            return (
                <BrowserShell
                    browserSessionId="browser_session_1"
                    platform="web"
                    state={state}
                    onCommand={vi.fn()}
                    localServicePreviewServerId="server_1"
                    browserDiagnostics={diagnostics}
                    testID="browser-shell"
                />
            );
        }

        const screen = await renderScreen(<BrowserShellWithExplicitDiagnostics />);
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(testState.fetchBrowserDiagnosticsSnapshotViaMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            serverId: 'server_1',
        }));
        // Console is the default drawer section; its family panel + row render
        // inside the drawer body with the trust/fidelity badge preserved.
        expect(screen.findByTestId('browser-shell-diagnostics-container-collapsed')).toBeTruthy();
        expect(screen.findByTestId('browser-shell-diagnostics-body-fidelity-cdp')).toBeTruthy();
        expect(screen.findByTestId('browser-shell-diagnostics-body-console-panel')).toBeTruthy();
        expect(screen.findByTestId('browser-shell-diagnostics-body-console-row-evt_daemon_console_1')).toBeTruthy();
    });

    it('starts host-owned annotation mode from browser shell context chrome', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const state = await createAnnotationCapableShellState();
        const onContextStateChange = vi.fn<(state: BrowserContextState) => void>();
        const captureAnnotation = vi.fn();

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={vi.fn()}
                browserContext={{
                    state: createBrowserContextState(),
                    contextCapabilities: {
                        ...contextCapabilities,
                        supportedContextKinds: ['browserPageReference', 'browserAnnotation'],
                        screenshot: {
                            supported: true,
                            requiresAttachmentUploads: true,
                            maxBytes: 5_000_000,
                        },
                    },
                    attachmentsUploadsEnabled: true,
                    annotationCaptureProvider: {
                        available: true,
                        captureAnnotation,
                    },
                    onStateChange: onContextStateChange,
                    nowMs: () => 8_000,
                }}
                testID="browser-shell"
            />,
        );

        await screen.pressByTestIdAsync('browser-shell-overflow');
        await screen.pressByTestIdAsync('browser-shell-overflow-item-start-annotation');

        expect(onContextStateChange).toHaveBeenCalledTimes(1);
        const nextState = onContextStateChange.mock.calls[0]?.[0] as (
            BrowserContextState & {
                activeAnnotationByViewId?: Readonly<Record<string, unknown>>;
            }
        ) | undefined;
        expect(nextState?.activeAnnotationByViewId?.view_1).toEqual(expect.objectContaining({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 0,
            startedAtMs: 8_000,
        }));
    });

    it('routes surfaced annotation toolbar actions through the runtime action front door', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const state = await createAnnotationCapableShellState();
        const onContextStateChange = vi.fn<(state: BrowserContextState) => void>();
        const annotationRuntimeActionExecute = vi.fn(async () => ({
            v: 1,
            actionId: 'browser.context.annotation.start',
            status: 'started',
        }));

        const browserContext = {
            state: createBrowserContextState(),
            contextCapabilities: {
                ...contextCapabilities,
                supportedContextKinds: ['browserPageReference', 'browserAnnotation'],
                screenshot: {
                    supported: true,
                    requiresAttachmentUploads: true,
                    maxBytes: 5_000_000,
                },
            } satisfies BrowserContextCapabilities,
            attachmentsUploadsEnabled: true,
            annotationCaptureProvider: {
                available: true,
                captureAnnotation: vi.fn(),
            },
            annotationRuntimeActionExecute,
            onStateChange: onContextStateChange,
            nowMs: () => 8_000,
        };

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={vi.fn()}
                browserContext={browserContext}
                testID="browser-shell"
            />,
        );

        await screen.pressByTestIdAsync('browser-shell-overflow');
        await screen.pressByTestIdAsync('browser-shell-overflow-item-start-annotation');

        expect(annotationRuntimeActionExecute).toHaveBeenCalledWith({
            actionId: 'browser.context.annotation.start',
            input: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
            },
            context: {
                surface: 'ui',
                placement: 'browser_context',
            },
        });
        expect(onContextStateChange).not.toHaveBeenCalled();
    });

    it('disables annotation start when the active browser engine cannot capture annotations', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const state = await createAnnotationCapableShellState();
        const onContextStateChange = vi.fn<(state: BrowserContextState) => void>();

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={state}
                onCommand={vi.fn()}
                browserContext={{
                    state: createBrowserContextState(),
                    contextCapabilities: {
                        ...contextCapabilities,
                        supportedContextKinds: ['browserPageReference', 'browserAnnotation'],
                        screenshot: {
                            supported: true,
                            requiresAttachmentUploads: true,
                            maxBytes: 5_000_000,
                        },
                    },
                    attachmentsUploadsEnabled: true,
                    onStateChange: onContextStateChange,
                    nowMs: () => 8_000,
                }}
                testID="browser-shell"
            />,
        );

        await screen.pressByTestIdAsync('browser-shell-overflow');

        expect(screen.findByTestId('browser-shell-overflow-item-start-annotation')?.props.accessibilityState).toMatchObject({
            disabled: true,
        });
        expect(screen.findByTestId('browser-shell-overflow-item-start-annotation')?.props.accessibilityHint).toBeTruthy();
        await screen.pressByTestIdAsync('browser-shell-overflow-item-start-annotation');

        expect(onContextStateChange).not.toHaveBeenCalled();
    });

    it('keeps Attach and disabled Annotate reachable from the overflow menu at a 390px mobile width', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const state = await createAnnotationCapableShellState();
        const onContextStateChange = vi.fn<(state: BrowserContextState) => void>();

        const screen = await renderScreen(
            <View style={{ width: 390, height: 844 }}>
                <BrowserShell
                    browserSessionId="browser_session_1"
                    platform="web"
                    state={state}
                    onCommand={vi.fn()}
                    browserContext={{
                        state: createBrowserContextState(),
                        contextCapabilities: {
                            ...contextCapabilities,
                            supportedContextKinds: ['browserPageReference', 'browserAnnotation'],
                            screenshot: {
                                supported: true,
                                requiresAttachmentUploads: true,
                                maxBytes: 5_000_000,
                            },
                        },
                        attachmentsUploadsEnabled: true,
                        onStateChange: onContextStateChange,
                        nowMs: () => 8_000,
                    }}
                    testID="browser-shell"
                />
            </View>,
        );

        await screen.pressByTestIdAsync('browser-shell-overflow');

        expect(screen.findByTestId('browser-shell-overflow-panel')).toBeTruthy();
        expect(screen.findByTestId('browser-shell-overflow-item-attach-context')).toBeTruthy();
        const annotationItem = screen.findByTestId('browser-shell-overflow-item-start-annotation');
        expect(annotationItem?.props.accessibilityState).toMatchObject({ disabled: true });
        expect(annotationItem?.props.accessibilityHint).toBeTruthy();
        expect(screen.getTextContent()).toContain('browserContext.composer.attachPageReference');
        expect(screen.getTextContent()).toContain('browserContext.composer.startAnnotation');
        expect(screen.getTextContent()).toContain(annotationItem?.props.accessibilityHint);

        await screen.pressByTestIdAsync('browser-shell-overflow-item-start-annotation');
        expect(onContextStateChange).not.toHaveBeenCalled();
    });

    it('disables annotation Select with a visible reason when the element picker is unavailable', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const {
            createBrowserContextState: createContextState,
            startBrowserAnnotationMode,
        } = await import('@/sync/domains/browser/context');
        const baseState = await createAnnotationCapableShellState();
        const activeView = baseState.viewsById.view_1;
        expect(activeView).toBeDefined();
        if (!activeView) return;
        const annotationCapabilities = {
            ...contextCapabilities,
            supportedContextKinds: ['browserPageReference', 'browserAnnotation'],
            screenshot: {
                supported: true,
                requiresAttachmentUploads: true,
                maxBytes: 5_000_000,
            },
        } satisfies BrowserContextCapabilities;
        const initialAnnotation = startBrowserAnnotationMode(createContextState(), {
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationCapabilities,
            adapterCapabilities: activeView.adapterCapabilities,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 0,
            startedAtMs: 8_000,
        });
        expect(initialAnnotation.status).toBe('started');
        if (initialAnnotation.status !== 'started') return;

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={baseState}
                onCommand={vi.fn()}
                browserContext={{
                    state: initialAnnotation.state,
                    contextCapabilities: annotationCapabilities,
                    attachmentsUploadsEnabled: true,
                    annotationCaptureProvider: {
                        available: true,
                        captureAnnotation: vi.fn(),
                    },
                    onStateChange: vi.fn(),
                    nowMs: () => 8_100,
                }}
                testID="browser-shell"
            />,
        );

        const selectTool = screen.findByTestId('browser-shell-annotation-editor-tool-select');
        expect(selectTool?.props.disabled).toBe(true);
        expect(selectTool?.props.accessibilityState).toEqual(expect.objectContaining({
            disabled: true,
            selected: true,
        }));
        expect(screen.findByTestId('browser-shell-annotation-editor-select-unavailable')).toBeTruthy();
        expect(screen.findByType(AnnotationCaptureSurface).props.disabled).toBe(true);
    });

    it('captures a host-owned annotation draft as a stale-safe composer attachment', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const {
            createBrowserContextState: createContextState,
            selectBrowserContextComposerAttachments: selectAttachments,
            startBrowserAnnotationMode,
        } = await import('@/sync/domains/browser/context');
        const baseState = await createAnnotationCapableShellState();
        const activeView = baseState.viewsById.view_1;
        expect(activeView).toBeDefined();
        if (!activeView) return;
        const annotationCapabilities = {
            ...contextCapabilities,
            supportedContextKinds: ['browserPageReference', 'browserAnnotation'],
            screenshot: {
                supported: true,
                requiresAttachmentUploads: true,
                maxBytes: 5_000_000,
            },
        } satisfies BrowserContextCapabilities;
        const initialAnnotation = startBrowserAnnotationMode(createContextState(), {
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationCapabilities,
            adapterCapabilities: {
                ...activeView.adapterCapabilities,
                diagnosticsFidelityByFamily: {
                    ...activeView.adapterCapabilities.diagnosticsFidelityByFamily,
                    screenshot: 'injectedPage',
                },
                contextKinds: ['browserPageReference', 'browserAnnotation'],
            },
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 0,
            startedAtMs: 8_000,
        });
        expect(initialAnnotation.status).toBe('started');
        if (initialAnnotation.status !== 'started') return;
        const onContextStateChange = vi.fn<(state: BrowserContextState) => void>();

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={baseState}
                onCommand={vi.fn()}
                browserContext={{
                    state: initialAnnotation.state,
                    contextCapabilities: annotationCapabilities,
                    attachmentsUploadsEnabled: true,
                    annotationDraft: {
                        media: {
                            mediaId: 'media_annotation_1',
                            mediaKind: 'image',
                            width: 1280,
                            height: 720,
                            sizeBytes: 300_000,
                        },
                        target: {
                            kind: 'region',
                            rect: { x: 12, y: 24, width: 240, height: 120 },
                        },
                        comment: '  Align the CTA with the card edge.  ',
                        pageUrl: 'https://preview.happier.test/?token=secret',
                        pageTitle: 'Preview',
                    },
                    onStateChange: onContextStateChange,
                    nowMs: () => 8_100,
                }}
                testID="browser-shell"
            />,
        );

        await screen.pressByTestIdAsync('browser-shell-overflow');
        await screen.pressByTestIdAsync('browser-shell-overflow-item-capture-annotation');

        expect(onContextStateChange).toHaveBeenCalledTimes(1);
        const nextState = onContextStateChange.mock.calls[0]?.[0];
        expect(nextState).toBeDefined();
        if (!nextState) return;
        const [attachment] = selectAttachments(nextState);
        expect(attachment).toEqual(expect.objectContaining({
            sourceViewId: 'view_1',
            capturedNavigationGeneration: 0,
            state: 'available',
        }));
        const item = nextState.itemsById[attachment!.contextId];
        expect(item).toEqual(expect.objectContaining({
            kind: 'browserAnnotation',
            browserSessionId: 'browser_session_1',
            sourceViewId: 'view_1',
            navigationGeneration: 0,
            media: expect.objectContaining({ mediaId: 'media_annotation_1' }),
            target: expect.objectContaining({
                kind: 'region',
                rect: expect.objectContaining({ width: 240, height: 120 }),
            }),
            comment: 'Align the CTA with the card edge.',
            pageUrl: 'https://preview.happier.test/',
        }));
        expect(JSON.stringify(item)).not.toContain('secret');
    });

    it('uses an injected annotation capture provider to produce the media draft before attaching', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const {
            createBrowserContextState: createContextState,
            selectBrowserContextComposerAttachments: selectAttachments,
            startBrowserAnnotationMode,
        } = await import('@/sync/domains/browser/context');
        const baseState = await createAnnotationCapableShellState();
        const activeView = baseState.viewsById.view_1;
        expect(activeView).toBeDefined();
        if (!activeView) return;
        const annotationCapabilities = {
            ...contextCapabilities,
            supportedContextKinds: ['browserPageReference', 'browserAnnotation'],
            screenshot: {
                supported: true,
                requiresAttachmentUploads: true,
                maxBytes: 5_000_000,
            },
        } satisfies BrowserContextCapabilities;
        const initialAnnotation = startBrowserAnnotationMode(createContextState(), {
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationCapabilities,
            adapterCapabilities: {
                ...activeView.adapterCapabilities,
                diagnosticsFidelityByFamily: {
                    ...activeView.adapterCapabilities.diagnosticsFidelityByFamily,
                    screenshot: 'injectedPage',
                },
                contextKinds: ['browserPageReference', 'browserAnnotation'],
            },
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 0,
            startedAtMs: 8_000,
        });
        expect(initialAnnotation.status).toBe('started');
        if (initialAnnotation.status !== 'started') return;
        const captureAnnotation = vi.fn(async (request: Readonly<{
            browserSessionId: string;
            viewId: string;
            navigationGeneration: number;
            currentUrl?: string | null;
            title?: string | null;
        }>) => ({
            status: 'captured' as const,
            browserSessionId: request.browserSessionId,
            viewId: request.viewId,
            navigationGeneration: request.navigationGeneration,
            media: {
                mediaId: 'media_provider_annotation_1',
                mediaKind: 'image' as const,
                width: 1280,
                height: 720,
                sizeBytes: 300_000,
            },
            target: {
                kind: 'region' as const,
                rect: { x: 16, y: 32, width: 320, height: 180 },
            },
            pageUrl: request.currentUrl,
            pageTitle: request.title,
        }));
        const onContextStateChange = vi.fn<(state: BrowserContextState) => void>();
        const onAttachUnavailable = vi.fn<(reason: BrowserContextUnavailableReason) => void>();

        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={baseState}
                onCommand={vi.fn()}
                browserContext={{
                    state: initialAnnotation.state,
                    contextCapabilities: annotationCapabilities,
                    attachmentsUploadsEnabled: true,
                    annotationCaptureProvider: {
                        available: true,
                        captureAnnotation,
                    },
                    onStateChange: onContextStateChange,
                    onAttachUnavailable,
                    nowMs: () => 8_100,
                }}
                testID="browser-shell"
            />,
        );

        await screen.pressByTestIdAsync('browser-shell-overflow');
        expect(screen.findByTestId('browser-shell-overflow-item-capture-annotation')?.props.accessibilityState?.disabled).toBe(false);

        await screen.pressByTestIdAsync('browser-shell-overflow-item-capture-annotation');

        expect(onAttachUnavailable).not.toHaveBeenCalled();
        expect(captureAnnotation).toHaveBeenCalledWith(expect.objectContaining({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 0,
            currentUrl: 'https://preview.happier.test/',
            title: 'Preview',
        }));
        expect(onContextStateChange).toHaveBeenCalledTimes(1);
        const nextState = onContextStateChange.mock.calls[0]?.[0];
        expect(nextState).toBeDefined();
        if (!nextState) return;
        const [attachment] = selectAttachments(nextState);
        expect(attachment).toEqual(expect.objectContaining({
            sourceViewId: 'view_1',
            capturedNavigationGeneration: 0,
            state: 'available',
        }));
        const item = nextState.itemsById[attachment!.contextId];
        expect(item).toEqual(expect.objectContaining({
            kind: 'browserAnnotation',
            browserSessionId: 'browser_session_1',
            sourceViewId: 'view_1',
            navigationGeneration: 0,
            media: expect.objectContaining({ mediaId: 'media_provider_annotation_1' }),
            target: expect.objectContaining({
                kind: 'region',
                rect: expect.objectContaining({ width: 320, height: 180 }),
            }),
        }));
    });
});
