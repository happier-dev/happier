import type {
    BrowserAdapterCapabilitiesV1,
    BrowserCommandV1,
    BrowserEventV1,
    BrowserRenderEngineKindV1,
    BrowserSemanticAdapterKindV1,
    BrowserViewTargetV1,
} from '@happier-dev/protocol';
import { BrowserRenderEngineKindV1Schema } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import {
    applyBrowserControlEvent,
    browserViewLifecycleEvent,
    createBrowserControlState,
    dispatchBrowserControlCommand,
    isClientRenderedBrowserEngine,
    type BrowserControlState,
    type BrowserViewLifecycleTarget,
} from '@/sync/domains/browser/control';
import { selectBrowserToolbarModel } from '@/sync/domains/browser/shell';

/**
 * ENGINE×CAPABILITY×NAVIGATION CLOSURE (§13.5.2 / §16) — a BUILD-FAILING matrix over EVERY
 * {@link BrowserRenderEngineKindV1} crossing the four navigation properties that B-1 + B-2 turned
 * on:
 *   - loadingState transitions on a URL-bearing open (B-2 cause-1: client-rendered → `loading`,
 *     daemon-authoritative → already-`ready`),
 *   - onLoadEnd → `ready` / onError → `failed` (B-2 cause-2: the engine lifecycle reaches the
 *     reducer via {@link browserViewLifecycleEvent}),
 *   - in-place-nav dispatches to the engine (client-local) vs the daemon, and
 *   - the address bar is enabled-with-no-view through the in-place seam (B-1).
 *
 * The matrix is keyed by the engine enum, so a NEW engine kind fails to compile until it is
 * classified here, and the runtime iteration fails if a cell drifts from the live reducer/selector
 * behavior (a doc table would NOT catch the §13.1-class split-brain this guards).
 */
/** A render engine that actually mounts a view (the `viewOpened` event excludes `unavailable`). */
type MountableEngineKind = Exclude<BrowserRenderEngineKindV1, 'unavailable'>;

type EngineNavigationContract = Readonly<{
    /** Owns its own page-load lifecycle (feeds it back) vs daemon-authoritative (already rendered). */
    clientRendered: boolean;
    /** The semantic adapter a view on this engine carries, or `null` for the no-engine sentinel. */
    adapterKind: BrowserSemanticAdapterKindV1 | null;
    target: BrowserViewTargetV1 | null;
    /** loadingState a URL-bearing open seeds for this engine. */
    openLoadingState: 'loading' | 'ready';
    /** Effect kind a navigate command produces, or `null` when navigation is not applicable. */
    inPlaceNavEffect: 'clientLocalNavigation' | 'daemonCommand' | null;
}>;

const EXTERNAL_TARGET = {
    kind: 'externalUrl',
    targetId: 'external_1',
    url: 'https://example.test/',
    display: { title: 'Example', addressLabel: 'example.test' },
} satisfies BrowserViewTargetV1;

const PREVIEW_TARGET = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: { title: 'Preview', addressLabel: 'localhost:5173' },
} satisfies BrowserViewTargetV1;

const ENGINE_NAVIGATION_MATRIX: Record<BrowserRenderEngineKindV1, EngineNavigationContract> = {
    webIframe: {
        clientRendered: true,
        adapterKind: 'localPreview',
        target: PREVIEW_TARGET,
        openLoadingState: 'loading',
        inPlaceNavEffect: 'clientLocalNavigation',
    },
    nativeWebView: {
        clientRendered: true,
        adapterKind: 'externalUrl',
        target: EXTERNAL_TARGET,
        openLoadingState: 'loading',
        inPlaceNavEffect: 'clientLocalNavigation',
    },
    desktopWebView: {
        clientRendered: true,
        adapterKind: 'externalUrl',
        target: EXTERNAL_TARGET,
        openLoadingState: 'loading',
        inPlaceNavEffect: 'clientLocalNavigation',
    },
    electronWebContentsView: {
        clientRendered: true,
        adapterKind: 'externalUrl',
        target: EXTERNAL_TARGET,
        openLoadingState: 'loading',
        inPlaceNavEffect: 'clientLocalNavigation',
    },
    streamedSurface: {
        // CDP sidecar / streamed surface: the daemon emits real navigation events, so the open is
        // already rendered and navigation is dispatched to the daemon, not an in-app engine.
        clientRendered: false,
        adapterKind: 'chromiumSidecar',
        target: EXTERNAL_TARGET,
        openLoadingState: 'ready',
        inPlaceNavEffect: 'daemonCommand',
    },
    unavailable: {
        clientRendered: false,
        adapterKind: null,
        target: null,
        openLoadingState: 'ready',
        inPlaceNavEffect: null,
    },
};

const NAVIGABLE = {
    canNavigate: true,
    canGoBack: false,
    canGoForward: false,
    canReload: true,
    canStop: true,
} as const;

function buildNavigableCapabilities(
    adapterKind: BrowserSemanticAdapterKindV1,
    target: BrowserViewTargetV1,
    engineKind: MountableEngineKind,
): BrowserAdapterCapabilitiesV1 {
    return {
        ...buildBrowserAdapterCapabilities({
            adapterKind,
            supportedTargetKinds: [target.kind],
            supportedRenderEngines: [engineKind],
            ...(engineKind === 'desktopWebView'
                ? {
                    desktopWebViewSupport: {
                        navigation: true,
                        goBackForward: false,
                        reload: false,
                        stop: false,
                        pageInfoDiagnostics: true,
                        nativeDevtools: false,
                        capture: false,
                        recording: false,
                        automation: false,
                    },
                }
                : {}),
        }),
        navigation: NAVIGABLE,
    };
}

function openView(
    engineKind: MountableEngineKind,
    contract: EngineNavigationContract,
): { state: BrowserControlState; target: BrowserViewLifecycleTarget } {
    if (!contract.adapterKind || !contract.target) {
        throw new Error(`engine ${engineKind} has no renderable adapter`);
    }
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
        target: contract.target,
        platform: 'web',
        currentUrl: 'https://example.test/',
        adapterKind: contract.adapterKind,
        engineKind,
        adapterCapabilities: buildNavigableCapabilities(contract.adapterKind, contract.target, engineKind),
        occurredAt: 1_001,
    }];
    const state = events.reduce(
        (next, event) => applyBrowserControlEvent(next, event),
        createBrowserControlState(),
    );
    return { state, target: { browserSessionId: 'browser_session_1', viewId: 'view_1' } };
}

describe('engine × capability × navigation closure', () => {
    it('classifies every render engine kind (build-fails until a new engine is added to the matrix)', () => {
        for (const engineKind of BrowserRenderEngineKindV1Schema.options) {
            const contract = ENGINE_NAVIGATION_MATRIX[engineKind];
            expect(isClientRenderedBrowserEngine(engineKind), `client-rendered for ${engineKind}`)
                .toBe(contract.clientRendered);
        }
    });

    it('B-1: the no-view toolbar model is non-navigable, forcing the in-place seam for the new-tab entry', () => {
        // selectBrowserToolbarModel(null) cannot navigate, so the shell MUST route a typed address
        // through the onNavigateInPlace seam (not toolbar.canNavigate) when no view exists.
        expect(selectBrowserToolbarModel(null).canNavigate).toBe(false);
    });

    for (const engineKind of BrowserRenderEngineKindV1Schema.options) {
        const contract = ENGINE_NAVIGATION_MATRIX[engineKind];
        if (engineKind === 'unavailable' || !contract.adapterKind || !contract.target) {
            // The `unavailable` sentinel has no renderable adapter; classification (above) is the
            // only contract it carries.
            continue;
        }

        it(`B-2 cause-1: seeds loadingState='${contract.openLoadingState}' on a URL-bearing open for ${engineKind}`, () => {
            const { state } = openView(engineKind, contract);
            expect(state.viewsById.view_1?.loadingState).toBe(contract.openLoadingState);
        });

        it(`in-place navigate dispatches '${contract.inPlaceNavEffect}' for ${engineKind}`, () => {
            const { state } = openView(engineKind, contract);
            const sendDaemonCommand = vi.fn();
            const command = {
                kind: 'navigate',
                commandId: 'command_navigate',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                url: 'https://example.test/next',
            } satisfies BrowserCommandV1;

            const result = dispatchBrowserControlCommand(state, command, { sendDaemonCommand });

            expect(result.effects[0]?.kind).toBe(contract.inPlaceNavEffect);
            if (contract.inPlaceNavEffect === 'daemonCommand') {
                expect(sendDaemonCommand).toHaveBeenCalledWith(command);
            } else {
                expect(sendDaemonCommand).not.toHaveBeenCalled();
            }
        });

        if (contract.clientRendered) {
            it(`B-2 cause-2: onLoadEnd→ready and onError→failed reach the reducer for ${engineKind}`, () => {
                const { state, target } = openView(engineKind, contract);
                expect(state.viewsById.view_1?.loadingState).toBe('loading');

                const finishedEvent = browserViewLifecycleEvent(target, {
                    kind: 'loadFinished',
                    url: 'https://example.test/',
                });
                expect(finishedEvent).not.toBeNull();
                const readyState = applyBrowserControlEvent(state, finishedEvent!);
                expect(readyState.viewsById.view_1?.loadingState).toBe('ready');

                const failedEvent = browserViewLifecycleEvent(target, {
                    kind: 'loadFailed',
                    errorCode: 'webview_load_failed',
                    url: 'https://example.test/',
                });
                expect(failedEvent).not.toBeNull();
                const failedState = applyBrowserControlEvent(state, failedEvent!);
                expect(failedState.viewsById.view_1?.loadingState).toBe('failed');
                expect(failedState.viewsById.view_1?.lastError).toBe('webview_load_failed');
            });
        }
    }
});
