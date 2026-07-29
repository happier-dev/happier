import type {
    BrowserCommandV1,
    BrowserEventV1,
    BrowserTargetPolicyDecisionV1,
} from '@happier-dev/protocol';

import type { DesktopWebViewNativeAvailability } from '../adapters/desktopWebView';
import {
    selectBrowserTargetAdapter,
    type StreamedBrowserSurfaceAvailability,
} from '../adapters/selection';
import { isClientRenderedBrowserEngine } from './lifecycle';
import { applyBrowserControlEvent } from './reducer';
import type { BrowserControlState } from './state';

type BrowserNavigationCommand = Extract<
    BrowserCommandV1,
    { kind: 'navigate' | 'goBack' | 'goForward' | 'reload' | 'stop' }
>;

type BrowserFocusViewCommand = Extract<BrowserCommandV1, { kind: 'focusView' }>;
type BrowserViewLifecycleCommand = Extract<BrowserCommandV1, { kind: 'openView' | 'closeView' | 'setTarget' }>;

const DEFAULT_BROWSER_PROFILE_ID = 'browser_profile_default';

export type BrowserControlCommandEffect =
    | Readonly<{
        kind: 'clientLocalNavigation';
        viewId: string;
        command: BrowserNavigationCommand;
      }>
    | Readonly<{
        kind: 'clientLocalFocus';
        viewId: string;
        command: BrowserFocusViewCommand;
      }>
    | Readonly<{
        kind: 'clientLocalView';
        viewId: string;
        command: BrowserViewLifecycleCommand;
      }>
    | Readonly<{
        kind: 'daemonCommand';
        command: BrowserCommandV1;
      }>
    | Readonly<{
        kind: 'commandRejected';
        command: BrowserCommandV1;
        reasonCode: 'adapter_unavailable' | 'view_not_found' | 'unsupported_command';
      }>;

export type BrowserControlCommandDispatchResult = Readonly<{
    state: BrowserControlState;
    effects: readonly BrowserControlCommandEffect[];
}>;

export type BrowserControlCommandDispatchOptions = Readonly<{
    sendDaemonCommand?: (command: BrowserCommandV1) => void;
    targetPolicyDecision?: BrowserTargetPolicyDecisionV1 | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
}>;

function isNavigationCommand(command: BrowserCommandV1): command is BrowserNavigationCommand {
    return command.kind === 'navigate'
        || command.kind === 'goBack'
        || command.kind === 'goForward'
        || command.kind === 'reload'
        || command.kind === 'stop';
}

function isFocusViewCommand(command: BrowserCommandV1): command is BrowserFocusViewCommand {
    return command.kind === 'focusView';
}

function isViewLifecycleCommand(command: BrowserCommandV1): command is BrowserViewLifecycleCommand {
    return command.kind === 'openView'
        || command.kind === 'closeView'
        || command.kind === 'setTarget';
}

function isDaemonAuthoritativeView(state: BrowserControlState, viewId: string): boolean {
    const view = state.viewsById[viewId];
    return view?.adapterKind === 'chromiumSidecar' || view?.adapterKind === 'streamedBrowserSurface';
}

/**
 * A streamed browser surface is daemon-authoritative: its render + control both live on the daemon.
 * It is selectable only when a daemon control transport is wired here, because that is the SAME
 * transport its navigation/lifecycle commands are routed over (`sendDaemonCommand`). Gating
 * availability on the transport's presence keeps the seam honest — no daemon-authoritative view is
 * ever opened without a reachable control plane to drive it.
 */
function resolveStreamedBrowserSurfaceAvailability(
    options: BrowserControlCommandDispatchOptions,
): StreamedBrowserSurfaceAvailability {
    return { daemonControlReachable: options.sendDaemonCommand !== undefined };
}

function supportsNavigationCommand(
    state: BrowserControlState,
    command: BrowserNavigationCommand,
): boolean {
    const navigation = state.viewsById[command.viewId]?.adapterCapabilities.navigation;
    switch (command.kind) {
        case 'navigate':
            return navigation?.canNavigate === true;
        case 'goBack':
            return navigation?.canGoBack === true;
        case 'goForward':
            return navigation?.canGoForward === true;
        case 'reload':
            return navigation?.canReload === true;
        case 'stop':
            return navigation?.canStop === true;
    }
}

function applyLocalNavigationIntent(
    state: BrowserControlState,
    command: BrowserNavigationCommand,
): BrowserControlState {
    const view = state.viewsById[command.viewId];
    if (!view) {
        return state;
    }
    if (command.kind !== 'navigate') {
        if (command.kind !== 'reload') {
            return state;
        }
        return {
            ...state,
            viewsById: {
                ...state.viewsById,
                [command.viewId]: {
                    ...view,
                    navigationGeneration: view.navigationGeneration + 1,
                    pendingUrl: null,
                    loadingState: 'loading',
                    loadingProgress: 0,
                    lastError: null,
                },
            },
        };
    }
    return {
        ...state,
        viewsById: {
            ...state.viewsById,
            [command.viewId]: {
                ...view,
                pendingUrl: command.url,
                loadingState: 'loading',
                loadingProgress: 0,
                lastError: null,
            },
        },
    };
}

function applyLocalFocusIntent(
    state: BrowserControlState,
    command: BrowserFocusViewCommand,
): BrowserControlState {
    const view = state.viewsById[command.viewId];
    if (!view || view.browserSessionId !== command.browserSessionId) {
        return state;
    }
    // Tab focus/order is owned by the workspace engine; a focus command only updates the derived
    // current-target convenience pointer here (no parallel focus map).
    return {
        ...state,
        currentTarget: view.target,
    };
}

function ensureSessionForOpenView(
    state: BrowserControlState,
    command: Extract<BrowserViewLifecycleCommand, { kind: 'openView' }>,
): BrowserControlState {
    if (state.sessionsById[command.browserSessionId]) {
        return state;
    }
    return applyBrowserControlEvent(state, {
        kind: 'sessionCreated',
        eventId: `${command.commandId}:sessionCreated`,
        browserSessionId: command.browserSessionId,
        profileId: DEFAULT_BROWSER_PROFILE_ID,
        occurredAt: 0,
    } satisfies BrowserEventV1);
}

function dispatchOpenViewCommand(
    state: BrowserControlState,
    command: Extract<BrowserViewLifecycleCommand, { kind: 'openView' }>,
    options: BrowserControlCommandDispatchOptions,
): BrowserControlCommandDispatchResult {
    const selectedAdapter = selectBrowserTargetAdapter({
        target: command.target,
        platform: command.platform,
        targetPolicyDecision: options.targetPolicyDecision,
        desktopWebViewAvailability: options.desktopWebViewAvailability,
        streamedBrowserSurfaceAvailability: resolveStreamedBrowserSurfaceAvailability(options),
    });
    // `openExternalTab` is a side-effect OS-tab handoff (the host opens it via the canonical
    // opener before dispatch); it is not a renderable in-app view, so opening one is rejected here.
    if (!selectedAdapter.ok || selectedAdapter.outcome === 'openExternalTab') {
        return {
            state,
            effects: [{ kind: 'commandRejected', command, reasonCode: 'adapter_unavailable' }],
        };
    }

    const stateWithSession = ensureSessionForOpenView(state, command);
    const openedState = applyBrowserControlEvent(stateWithSession, {
        kind: 'viewOpened',
        eventId: `${command.commandId}:viewOpened`,
        browserSessionId: command.browserSessionId,
        viewId: command.viewId,
        target: command.target,
        platform: command.platform,
        currentUrl: command.currentUrl,
        currentUrlExpiresAt: command.currentUrlExpiresAt,
        adapterKind: selectedAdapter.adapterKind,
        engineKind: selectedAdapter.engineKind,
        adapterCapabilities: selectedAdapter.capabilities,
        openerViewId: command.openerViewId,
        occurredAt: 0,
    } satisfies BrowserEventV1);
    const nextState = command.focus === false
        ? openedState
        : applyBrowserControlEvent(openedState, {
            kind: 'viewFocused',
            eventId: `${command.commandId}:viewFocused`,
            browserSessionId: command.browserSessionId,
            viewId: command.viewId,
            occurredAt: 0,
        } satisfies BrowserEventV1);

    return {
        state: nextState,
        effects: [{
            kind: 'clientLocalView',
            viewId: command.viewId,
            command,
        }],
    };
}

function applyLocalSetTargetIntent(
    state: BrowserControlState,
    command: Extract<BrowserViewLifecycleCommand, { kind: 'setTarget' }>,
    options: BrowserControlCommandDispatchOptions,
): BrowserControlCommandDispatchResult {
    const view = state.viewsById[command.viewId];
    if (!view) {
        return {
            state,
            effects: [{ kind: 'commandRejected', command, reasonCode: 'view_not_found' }],
        };
    }
    const selectedAdapter = selectBrowserTargetAdapter({
        target: command.target,
        platform: view.platform,
        targetPolicyDecision: options.targetPolicyDecision,
        desktopWebViewAvailability: options.desktopWebViewAvailability,
        streamedBrowserSurfaceAvailability: resolveStreamedBrowserSurfaceAvailability(options),
    });
    // `openExternalTab` is an OS-tab handoff, not an in-app render target — reject retargeting to it.
    if (!selectedAdapter.ok || selectedAdapter.outcome === 'openExternalTab') {
        return {
            state,
            effects: [{ kind: 'commandRejected', command, reasonCode: 'adapter_unavailable' }],
        };
    }
    const nextCurrentUrl = command.currentUrl
        ?? (command.target.kind === 'externalUrl' ? command.target.url : view.currentUrl);
    const currentUrlChanged = Boolean(nextCurrentUrl && nextCurrentUrl !== view.currentUrl);
    const clientRendered = isClientRenderedBrowserEngine(selectedAdapter.engineKind);
    const nextView = {
        ...view,
        target: command.target,
        currentUrl: nextCurrentUrl,
        currentUrlExpiresAt: currentUrlChanged ? null : view.currentUrlExpiresAt,
        pendingUrl: null,
        title: command.target.display?.title ?? view.title,
        navigationGeneration: currentUrlChanged
            ? view.navigationGeneration + 1
            : view.navigationGeneration,
        lastError: null,
        adapterKind: selectedAdapter.adapterKind,
        engineKind: selectedAdapter.engineKind,
        adapterCapabilities: selectedAdapter.capabilities,
        adapterRefreshStatus: 'idle' as const,
        adapterRefreshError: null,
        loadingState: currentUrlChanged && clientRendered ? 'loading' as const : view.loadingState,
        loadingProgress: currentUrlChanged && clientRendered ? 0 : view.loadingProgress,
    };
    return {
        state: {
            ...state,
            viewsById: {
                ...state.viewsById,
                [command.viewId]: nextView,
            },
            currentTarget: command.target,
        },
        effects: [{
            kind: 'clientLocalView',
            viewId: command.viewId,
            command,
        }],
    };
}

export function dispatchBrowserControlCommand(
    state: BrowserControlState,
    command: BrowserCommandV1,
    options: BrowserControlCommandDispatchOptions = {},
): BrowserControlCommandDispatchResult {
    if (!isNavigationCommand(command) && !isFocusViewCommand(command) && !isViewLifecycleCommand(command)) {
        return {
            state,
            effects: [{ kind: 'commandRejected', command, reasonCode: 'unsupported_command' }],
        };
    }

    if (command.kind === 'openView') {
        return dispatchOpenViewCommand(state, command, options);
    }

    const view = state.viewsById[command.viewId];
    if (!view || view.browserSessionId !== command.browserSessionId) {
        return {
            state,
            effects: [{ kind: 'commandRejected', command, reasonCode: 'view_not_found' }],
        };
    }

    if (command.kind === 'closeView') {
        if (isDaemonAuthoritativeView(state, command.viewId)) {
            options.sendDaemonCommand?.(command);
            return {
                state,
                effects: [{ kind: 'daemonCommand', command }],
            };
        }
        return {
            state: applyBrowserControlEvent(state, {
                kind: 'viewClosed',
                eventId: `${command.commandId}:viewClosed`,
                browserSessionId: command.browserSessionId,
                viewId: command.viewId,
                occurredAt: 0,
            } satisfies BrowserEventV1),
            effects: [{
                kind: 'clientLocalView',
                viewId: command.viewId,
                command,
            }],
        };
    }

    if (command.kind === 'setTarget') {
        if (isDaemonAuthoritativeView(state, command.viewId)) {
            options.sendDaemonCommand?.(command);
            return {
                state,
                effects: [{ kind: 'daemonCommand', command }],
            };
        }
        return applyLocalSetTargetIntent(state, command, options);
    }

    if (isFocusViewCommand(command)) {
        return {
            state: applyLocalFocusIntent(state, command),
            effects: [{
                kind: 'clientLocalFocus',
                viewId: command.viewId,
                command,
            }],
        };
    }

    if (!supportsNavigationCommand(state, command)) {
        return {
            state,
            effects: [{ kind: 'commandRejected', command, reasonCode: 'adapter_unavailable' }],
        };
    }

    if (isDaemonAuthoritativeView(state, command.viewId)) {
        options.sendDaemonCommand?.(command);
        return {
            state,
            effects: [{ kind: 'daemonCommand', command }],
        };
    }

    return {
        state: applyLocalNavigationIntent(state, command),
        effects: [{
            kind: 'clientLocalNavigation',
            viewId: command.viewId,
            command,
        }],
    };
}
