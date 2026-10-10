import type {
    BrowserCommandV1,
    BrowserEventV1,
    BrowserTargetPolicyDecisionV1,
} from '@happier-dev/protocol';

import type { DesktopWebViewNativeAvailability } from '../adapters/desktopWebView';
import type { BrowserAutomationControlService } from '../automation/controlService';
import { selectBrowserTargetAdapter, type BrowserAdapterSelection } from '../adapters/selection';
import { LOCAL_BROWSER_PROFILE_ID } from '../profiles/localBrowserProfile';
import { isClientRenderedBrowserEngine } from './lifecycle';
import { applyBrowserControlEvent } from './reducer';
import type { BrowserControlState, BrowserControlViewState } from './state';

type BrowserNavigationCommand = Extract<
    BrowserCommandV1,
    { kind: 'navigate' | 'goBack' | 'goForward' | 'reload' | 'stop' }
>;

type BrowserFocusViewCommand = Extract<BrowserCommandV1, { kind: 'focusView' }>;
type BrowserViewLifecycleCommand = Extract<BrowserCommandV1, { kind: 'openView' | 'closeView' | 'setTarget' }>;

export type BrowserControlCommandEffect =
    | Readonly<{
        kind: 'openExternalTab';
        selection: Extract<BrowserAdapterSelection, { outcome: 'openExternalTab' }>;
        command: Extract<BrowserCommandV1, { kind: 'openView' }>;
      }>
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
        reasonCode: 'adapter_unavailable' | 'view_not_found' | 'automation_busy';
      }>;

export type BrowserControlCommandDispatchResult = Readonly<{
    state: BrowserControlState;
    effects: readonly BrowserControlCommandEffect[];
}>;

export type BrowserControlCommandDispatchOptions = Readonly<{
    clientControlService?: Pick<BrowserAutomationControlService, 'recordHumanInput' | 'releaseHumanControl'>;
    sendDaemonCommand?: (command: BrowserCommandV1) => void;
    targetPolicyDecision?: BrowserTargetPolicyDecisionV1 | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
    nativeViewCaptureHandlerRegistered?: boolean;
}>;

function isFocusViewCommand(command: BrowserCommandV1): command is BrowserFocusViewCommand {
    return command.kind === 'focusView';
}

/** A view the daemon owns (its managed Chromium): it runs on a machine and is shown as a stream. */
export function isDaemonAuthoritativeBrowserView(view: Pick<BrowserControlViewState, 'adapterKind'> | null | undefined): boolean {
    return view?.adapterKind === 'chromiumSidecar' || view?.adapterKind === 'streamedBrowserSurface';
}

function isDaemonAuthoritativeView(state: BrowserControlState, viewId: string): boolean {
    return isDaemonAuthoritativeBrowserView(state.viewsById[viewId]);
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
        profileId: LOCAL_BROWSER_PROFILE_ID,
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
        nativeViewCaptureHandlerRegistered: options.nativeViewCaptureHandlerRegistered,
    });
    if (!selectedAdapter.ok) {
        return {
            state,
            effects: [{ kind: 'commandRejected', command, reasonCode: 'adapter_unavailable' }],
        };
    }
    // Fulfill the selector's OS handoff below Action admission; it never materializes a view.
    if (selectedAdapter.outcome === 'openExternalTab') {
        return { state, effects: [{ kind: 'openExternalTab', selection: selectedAdapter, command }] };
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
        nativeViewCaptureHandlerRegistered: options.nativeViewCaptureHandlerRegistered,
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

    if (command.kind === 'takeControl' || command.kind === 'handBack') {
        if (!isDaemonAuthoritativeView(state, command.viewId)) {
            const controller = options.clientControlService;
            if (!controller) return { state, effects: [{ kind: 'commandRejected', command, reasonCode: 'adapter_unavailable' }] };
            if (command.kind === 'takeControl') {
                controller.recordHumanInput({ ...command, inputKind: 'takeControl', occurredAtMs: Date.now() });
            } else if (!controller.releaseHumanControl(command)) {
                return { state, effects: [{ kind: 'commandRejected', command, reasonCode: 'automation_busy' }] };
            }
            return { state, effects: [] };
        }
        options.sendDaemonCommand?.(command);
        return { state, effects: [{ kind: 'daemonCommand', command }] };
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
