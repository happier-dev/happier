import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { BrowserEventV1Schema, BrowserTitleChangedEventV1Schema } from '@happier-dev/protocol/browser/events/v1';
import { BrowserHttpUrlV1Schema } from '@happier-dev/protocol/browser/url';
import type { BrowserEventV1, BrowserCommandDispatchResultV1, BrowserCommandErrorCodeV1, BrowserCommandV1, BrowserSidecarErrorCodeV1, BrowserProfileV1, BrowserViewTargetV1, BrowserPlatformV1 } from '@happier-dev/protocol';
import type { SurfaceInputControl } from '../../surfaces/inputControl';
import { isBrowserSidecarCdpCommandNotDispatched } from './cdpTransport';

import {
    browserCommandDispatchFailure,
    type BrowserDaemonControlAdapter,
} from '../control/types';

export type BrowserSidecarCdpPageHandle = Readonly<{
    targetId: string;
    sessionId?: string;
}>;

export type BrowserSidecarCdpCommandScope = Readonly<{
    /** Containing operation's absolute deadline, in Date.now() milliseconds. */
    deadlineMs?: number;
    signal?: AbortSignal;
}>;

export type BrowserSidecarCdpControlTransport = Readonly<{
    openPage(input: BrowserSidecarCdpCommandScope & Readonly<{ url: string; focus: boolean }>): Promise<BrowserSidecarCdpPageHandle>;
    dispatchPageCommand(input: BrowserSidecarCdpCommandScope & BrowserSidecarCdpPageHandle & Readonly<{
        method: string;
        params?: Record<string, unknown>;
    }>): Promise<unknown>;
    dispatchBrowserCommand(input: BrowserSidecarCdpCommandScope & Readonly<{
        method: string;
        params?: Record<string, unknown>;
    }>): Promise<unknown>;
}>;

/**
 * A raw CDP protocol notification (a message without an `id` — i.e. a Network/Runtime/Page event
 * rather than a command response). `params`/`sessionId` are passed verbatim from the wire; redaction
 * happens downstream in the diagnostics mapper, never here.
 */
export type BrowserSidecarCdpEventNotification = Readonly<{
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
}>;

export type BrowserSidecarCdpEventSubscriber = (notification: BrowserSidecarCdpEventNotification) => void;

/**
 * The live CDP transport optionally also surfaces the protocol event stream (not just command
 * responses) so the daemon can feed the offline diagnostics ring from the SAME connection. Absent ⇒
 * no live diagnostics source (fail-closed); the control transport itself stays request/response.
 */
export type BrowserSidecarCdpEventCapableTransport = BrowserSidecarCdpControlTransport & Readonly<{
    subscribeCdpEvents?(listener: BrowserSidecarCdpEventSubscriber): () => void;
}>;

/**
 * A view-binding transition emitted by the control adapter — the single owner of the
 * view ⇄ CDP page-handle mapping. The diagnostics runtime subscribes to learn exactly which view a
 * live CDP page session belongs to (CDP itself has no notion of a daemon `viewId`).
 */
export type BrowserSidecarViewLifecycleEvent = Readonly<{
    type: 'bound' | 'unbound';
    browserSessionId: string;
    viewId: string;
    /** Present only after the producer acknowledged destruction of this exact bound target. */
    sourceDestroyed?: boolean;
}>;

export type BrowserSidecarViewLifecycleSubscriber = (event: BrowserSidecarViewLifecycleEvent) => void;

export type BrowserSidecarControlAdapterFactoryInput = Readonly<{
    machineId: string;
    resolveInputControl?: (view: Readonly<{ browserSessionId: string; viewId: string }>) => SurfaceInputControl | undefined;
}>;

/**
 * Optional BRW-11 context-capture surface a sidecar control adapter result may carry. When present,
 * the daemon can build a real CDP context producer (page/screenshot/summary/selectedElement) over
 * the SAME live transport and view bindings used for control. Absent ⇒ no producer ⇒ context stays
 * fail-closed (the unavailable source).
 */
export type BrowserSidecarContextCaptureSurface = Readonly<{
    /** Private actual-launch fact for the exact live owned view, never caller metadata. */
    resolveNativeObservation?(view: Readonly<{ browserSessionId: string; viewId: string }>): 'not_observable' | undefined;
    transport: Pick<BrowserSidecarCdpControlTransport, 'dispatchPageCommand'>;
    resolvePageHandle(
        view: Readonly<{ browserSessionId: string; viewId: string }>,
    ): BrowserSidecarCdpPageHandle | null;
    /** Profile of the same owned view; callers cannot supply a different profile policy. */
    resolveProfile?(view: Readonly<{ browserSessionId: string; viewId: string }>): BrowserProfileV1 | null;
    /**
     * Optional live CDP event stream over the SAME transport, used by the offline-diagnostics lane
     * to feed the daemon diagnostics ring. Present only for the real CDP sidecar; absent for
     * in-memory/QA adapters ⇒ no live diagnostics source (fail-closed, ring stays empty).
     */
    subscribeCdpEvents?(listener: BrowserSidecarCdpEventSubscriber): () => void;
    /**
     * Optional view-binding lifecycle from the control adapter so the diagnostics runtime can attach
     * a per-view event source the moment a view's CDP page handle exists (and detach on close).
     */
    subscribeViewLifecycle?(listener: BrowserSidecarViewLifecycleSubscriber): () => void;
    getNavigationState?(view: Readonly<{ browserSessionId: string; viewId: string }>): BrowserSidecarNavigationState | null;
    subscribeBrowserEvents?(listener: (event: BrowserEventV1) => void): () => void;
}>;

export type BrowserSidecarControlAdapterFactoryResult =
    | Readonly<{
        ok: true;
        adapter: BrowserDaemonControlAdapter;
        dispose?: () => void | Promise<void>;
        contextCapture?: BrowserSidecarContextCaptureSurface;
    }>
    | Readonly<{
        ok: false;
        errorCode: BrowserSidecarErrorCodeV1;
        disabledReason: string;
    }>;

export type BrowserSidecarControlAdapterFactory = (
    input: BrowserSidecarControlAdapterFactoryInput
) => BrowserSidecarControlAdapterFactoryResult | Promise<BrowserSidecarControlAdapterFactoryResult>;

type BrowserSidecarCdpControlAdapterInput = Readonly<{
    browserSessionId: string;
    sidecarId: string;
    transport: BrowserSidecarCdpEventCapableTransport;
    resolveInputControl?: BrowserSidecarControlAdapterFactoryInput['resolveInputControl'];
}>;

/**
 * The control adapter is the single owner of the view → CDP page-handle binding. The BRW-11 context
 * producer needs the same mapping to capture page/screenshot/summary/selectedElement for a view, so
 * the adapter exposes a read-only resolver instead of the producer duplicating (and drifting from)
 * the binding state. Returns `null` for an unbound view so the producer stays fail-closed.
 */
export type BrowserSidecarCdpControlAdapter = BrowserDaemonControlAdapter & Readonly<{
    getNavigationState(view: Readonly<{ browserSessionId: string; viewId: string }>): BrowserSidecarNavigationState | null;
    subscribeBrowserEvents(listener: (event: BrowserEventV1) => void): () => void;
    resolvePageHandle(
        view: Readonly<{ browserSessionId: string; viewId: string }>,
    ): BrowserSidecarCdpPageHandle | null;
    /**
     * Subscribe to view-binding transitions (bind on openView, unbind on closeView). Returns an
     * unsubscribe handle. Listener errors never break control dispatch.
     */
    subscribeViewLifecycle(listener: BrowserSidecarViewLifecycleSubscriber): () => void;
    /** Invalidates all bindings before the owning connection/process is torn down. */
    dispose(): void;
}>;

export type BrowserSidecarNavigationState = Readonly<{
    navigationGeneration: number;
    currentUrl?: string;
    title?: string;
    loadingState: 'idle' | 'loading' | 'ready' | 'failed';
    canGoBack: boolean;
    canGoForward: boolean;
}>;

type BoundView = BrowserSidecarCdpPageHandle & {
    browserSessionId: string;
    viewId: string;
    target: BrowserViewTargetV1;
    platform: BrowserPlatformV1;
    state: BrowserSidecarNavigationState;
    loaderId?: string;
    frameId?: string;
};

function dispatched(command: BrowserCommandV1): Extract<BrowserCommandDispatchResultV1, { status: 'dispatched' }> {
    return {
        v: 1,
        commandId: command.commandId,
        status: 'dispatched',
        adapterKind: 'chromiumSidecar',
        events: [],
    };
}

function failed(
    command: BrowserCommandV1,
    code: BrowserCommandErrorCodeV1,
    message: string,
    retryable?: boolean,
    completion?: 'known' | 'unknown',
): BrowserCommandDispatchResultV1 {
    return browserCommandDispatchFailure({
        commandId: command.commandId,
        adapterKind: 'chromiumSidecar',
        code,
        message,
        ...(typeof retryable === 'boolean' ? { retryable } : {}),
        ...(completion ? { completion } : {}),
    });
}

function cdpFailure(command: BrowserCommandV1, completion: 'known' | 'unknown' = 'unknown'): BrowserCommandDispatchResultV1 {
    return failed(command, 'adapter_unavailable', 'Browser sidecar CDP command failed.', true, completion);
}

function recordValue(input: unknown): Record<string, unknown> | null {
    return input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : null;
}

function readHistoryEntryId(result: unknown, offset: -1 | 1): number | null {
    const history = recordValue(result);
    if (!history) return null;
    const currentIndex = history.currentIndex;
    const entries = history.entries;
    if (typeof currentIndex !== 'number' || !Number.isInteger(currentIndex) || !Array.isArray(entries)) {
        return null;
    }
    const entry = recordValue(entries[currentIndex + offset]);
    const id = entry?.id;
    return typeof id === 'number' && Number.isInteger(id) ? id : null;
}

function isOwnedSession(input: Readonly<{ browserSessionId: string }>, browserSessionId: string): boolean {
    return input.browserSessionId === browserSessionId;
}

function supportsOpenViewCommand(
    command: Extract<BrowserCommandV1, { kind: 'openView' }>,
    browserSessionId: string,
): boolean {
    return command.browserSessionId === browserSessionId && command.target.kind === 'externalUrl';
}

export function createBrowserSidecarCdpControlAdapter(
    input: BrowserSidecarCdpControlAdapterInput,
): BrowserSidecarCdpControlAdapter {
    const boundViews = new Map<string, BoundView>();
    const lifecycleListeners = new Set<BrowserSidecarViewLifecycleSubscriber>();
    const eventListeners = new Set<(event: BrowserEventV1) => void>();
    let eventSequence = 0;
    let disposed = false;

    function stateEvent(view: BoundView): BrowserEventV1 {
        // Page script can copy entered material into title or a navigation URL. Public events,
        // inventories and command results share this projection; private target proof/human
        // capture continue to read the unmodified engine state through getNavigationState.
        const state = input.resolveInputControl?.(view)?.isObservationHeld()
            ? { navigationGeneration: view.state.navigationGeneration, loadingState: view.state.loadingState,
                canGoBack: view.state.canGoBack, canGoForward: view.state.canGoForward }
            : view.state;
        return BrowserEventV1Schema.parse({ kind: 'navigationStateChanged', eventId: `cdp:${++eventSequence}`,
            browserSessionId: view.browserSessionId, viewId: view.viewId, occurredAt: Date.now(), ...state });
    }
    function publishState(view: BoundView): void {
        const event = stateEvent(view);
        for (const listener of [...eventListeners]) { try { listener(event); } catch { /* Observer cannot break control. */ } }
    }
    async function refreshHistory(view: BoundView, scope: BrowserSidecarCdpCommandScope = {}): Promise<void> {
        const generation = view.state.navigationGeneration;
        try {
            const history = recordValue(await input.transport.dispatchPageCommand({ ...scope, targetId: view.targetId, ...(view.sessionId ? { sessionId: view.sessionId } : {}), method: 'Page.getNavigationHistory' }));
            if (disposed || boundViews.get(browserViewKey(view)) !== view || view.state.navigationGeneration !== generation) return;
            const entries = history?.entries;
            const index = history?.currentIndex;
            if (!Array.isArray(entries) || typeof index !== 'number') return;
            const entry = recordValue(entries[index]);
            const title = BrowserTitleChangedEventV1Schema.shape.title.safeParse(entry?.title);
            view.state = { ...view.state, canGoBack: index > 0, canGoForward: index < entries.length - 1, ...(title.success ? { title: title.data } : {}) };
            publishState(view);
        } catch { /* Preserve the last engine state when the transport is unavailable. */ }
    }
    function updateFrame(view: BoundView, frame: Record<string, unknown>, bootstrap = false): void {
        if (disposed || boundViews.get(browserViewKey(view)) !== view || frame.parentId) return;
        // A live main-frame commit outranks the earlier bootstrap query's eventual reply.
        if (bootstrap && view.frameId !== undefined) return;
        const loaderId = typeof frame.loaderId === 'string' ? frame.loaderId : undefined;
        const changedDocument = !bootstrap && loaderId !== undefined && loaderId !== view.loaderId;
        view.loaderId = loaderId ?? view.loaderId;
        view.frameId = typeof frame.id === 'string' ? frame.id : view.frameId;
        const url = BrowserHttpUrlV1Schema.safeParse(frame.url);
        view.state = { ...view.state, navigationGeneration: view.state.navigationGeneration + (changedDocument ? 1 : 0),
            ...(url.success ? { currentUrl: url.data } : {}), loadingState: bootstrap ? view.state.loadingState : 'loading' };
        publishState(view);
    }
    const unsubscribeCdp = input.transport.subscribeCdpEvents?.(notification => {
        if (disposed) return;
        const params = notification.params ?? {};
        const target = recordValue(params.targetInfo);
        const view = [...boundViews.values()].find(candidate => notification.method === 'Target.targetInfoChanged'
            ? candidate.targetId === target?.targetId
            : candidate.sessionId !== undefined && candidate.sessionId === notification.sessionId);
        if (!view) return;
        if (notification.method === 'Page.frameNavigated') {
            const frame = recordValue(params.frame); if (frame) updateFrame(view, frame);
        } else if (notification.method === 'Page.navigatedWithinDocument' && params.frameId === view.frameId) {
            const url = BrowserHttpUrlV1Schema.safeParse(params.url);
            view.state = { ...view.state, navigationGeneration: view.state.navigationGeneration + 1, ...(url.success ? { currentUrl: url.data } : {}) };
            publishState(view);
        } else if ((notification.method === 'Page.frameStartedLoading' || notification.method === 'Page.frameStoppedLoading') && params.frameId === view.frameId) {
            view.state = { ...view.state, loadingState: notification.method === 'Page.frameStartedLoading' ? 'loading' : 'ready' }; publishState(view);
            if (notification.method === 'Page.frameStoppedLoading') void refreshHistory(view);
        } else if (notification.method === 'Target.targetInfoChanged') {
            const title = BrowserTitleChangedEventV1Schema.shape.title.safeParse(target?.title);
            view.state = { ...view.state, ...(title.success ? { title: title.data } : {}) };
            publishState(view);
        }
    });
    function dispatchState(command: BrowserCommandV1): BrowserCommandDispatchResultV1 {
        const view = 'viewId' in command ? boundViews.get(browserViewKey(command)) : undefined;
        return { ...dispatched(command), events: view ? [stateEvent(view)] : [] };
    }

    function emitLifecycle(event: BrowserSidecarViewLifecycleEvent): void {
        for (const listener of [...lifecycleListeners]) {
            try {
                listener(event);
            } catch {
                // A diagnostics subscriber must never be able to break browser control dispatch.
            }
        }
    }

    function readBoundView(command: Extract<BrowserCommandV1, { browserSessionId: string; viewId: string }>): BoundView | null {
        if (!isOwnedSession(command, input.browserSessionId)) return null;
        return boundViews.get(browserViewKey(command)) ?? null;
    }

    async function dispatchPage(
        command: Extract<BrowserCommandV1, { browserSessionId: string; viewId: string }>,
        method: string,
        params?: Record<string, unknown>,
        scope: BrowserSidecarCdpCommandScope = {},
    ): Promise<BrowserCommandDispatchResultV1> {
        const boundView = readBoundView(command);
        if (!boundView) {
            return failed(command, 'view_not_found', 'Browser sidecar does not own this view.');
        }

        let issued = false;
        try {
            scope.signal?.throwIfAborted();
            issued = true;
            await input.transport.dispatchPageCommand({
                // Once issued, abort must not discard the CDP acknowledgement before drain.
                ...(scope.deadlineMs !== undefined ? { deadlineMs: scope.deadlineMs } : {}),
                targetId: boundView.targetId,
                ...(boundView.sessionId ? { sessionId: boundView.sessionId } : {}),
                method,
                ...(params ? { params } : {}),
            });
            return dispatchState(command);
        } catch (error) {
            return cdpFailure(command, !issued || isBrowserSidecarCdpCommandNotDispatched(error) ? 'known' : 'unknown');
        }
    }

    async function dispatchHistoryNavigation(
        command: Extract<BrowserCommandV1, { kind: 'goBack' | 'goForward' }>,
        offset: -1 | 1,
        scope: BrowserSidecarCdpCommandScope = {},
    ): Promise<BrowserCommandDispatchResultV1> {
        const boundView = readBoundView(command);
        if (!boundView) {
            return failed(command, 'view_not_found', 'Browser sidecar does not own this view.');
        }

        let issued = false;
        try {
            scope.signal?.throwIfAborted();
            const history = await input.transport.dispatchPageCommand({
                ...(scope.deadlineMs !== undefined ? { deadlineMs: scope.deadlineMs } : {}),
                targetId: boundView.targetId,
                ...(boundView.sessionId ? { sessionId: boundView.sessionId } : {}),
                method: 'Page.getNavigationHistory',
            });
            const entryId = readHistoryEntryId(history, offset);
            if (entryId === null) {
                return failed(command, 'unsupported_command', 'Browser sidecar history entry is unavailable.');
            }
            scope.signal?.throwIfAborted();
            issued = true;
            await input.transport.dispatchPageCommand({
                ...(scope.deadlineMs !== undefined ? { deadlineMs: scope.deadlineMs } : {}),
                targetId: boundView.targetId,
                ...(boundView.sessionId ? { sessionId: boundView.sessionId } : {}),
                method: 'Page.navigateToHistoryEntry',
                params: { entryId },
            });
            return dispatchState(command);
        } catch (error) {
            return cdpFailure(command, !issued || isBrowserSidecarCdpCommandNotDispatched(error) ? 'known' : 'unknown');
        }
    }

    async function dispatchBrowserTargetCommand(
        command: Extract<BrowserCommandV1, { browserSessionId: string; viewId: string }>,
        method: 'Target.activateTarget' | 'Target.closeTarget',
        scope: BrowserSidecarCdpCommandScope = {},
    ): Promise<BrowserCommandDispatchResultV1> {
        const boundView = readBoundView(command);
        if (!boundView) {
            return failed(command, 'view_not_found', 'Browser sidecar does not own this view.');
        }

        try {
            const response = await input.transport.dispatchBrowserCommand({
                ...scope,
                method,
                params: { targetId: boundView.targetId },
            });
            if (command.kind === 'closeView') {
                if (recordValue(response)?.success !== true || boundViews.get(browserViewKey(command)) !== boundView) return cdpFailure(command);
                const event: BrowserEventV1 = { kind: 'viewClosed', eventId: `cdp:${++eventSequence}`, occurredAt: Date.now(),
                    browserSessionId: command.browserSessionId, viewId: command.viewId, navigationGeneration: boundView.state.navigationGeneration };
                for (const listener of [...eventListeners]) { try { listener(event); } catch { /* Observers cannot break close. */ } }
                boundViews.delete(browserViewKey(command));
                emitLifecycle({
                    type: 'unbound',
                    browserSessionId: command.browserSessionId,
                    viewId: command.viewId,
                    sourceDestroyed: true,
                });
                return { ...dispatched(command), events: [event] };
            }
            return dispatchState(command);
        } catch (error) {
            return cdpFailure(command, isBrowserSidecarCdpCommandNotDispatched(error) ? 'known' : 'unknown');
        }
    }

    return {
        adapterKind: 'chromiumSidecar',
        dispose() {
            if (disposed) return;
            disposed = true;
            unsubscribeCdp?.();
            eventListeners.clear();
            const views = [...boundViews.values()];
            boundViews.clear();
            for (const view of views) emitLifecycle({ type: 'unbound', browserSessionId: view.browserSessionId, viewId: view.viewId });
            lifecycleListeners.clear();
        },
        subscribeViewLifecycle(listener) {
            lifecycleListeners.add(listener);
            return () => {
                lifecycleListeners.delete(listener);
            };
        },
        subscribeBrowserEvents(listener) { eventListeners.add(listener); return () => { eventListeners.delete(listener); }; },
        listViews(browserSessionId) {
            if (disposed || browserSessionId !== input.browserSessionId) return [];
            return [...boundViews.values()].map(view => ({ browserSessionId: view.browserSessionId, viewId: view.viewId,
                sourceId: browserViewKey(view), target: view.target, platform: view.platform,
                adapterKind: 'chromiumSidecar' as const, events: [stateEvent(view)] }));
        },
        getNavigationState(view) { return boundViews.get(browserViewKey(view))?.state ?? null; },
        resolvePageHandle(view) {
            if (view.browserSessionId !== input.browserSessionId) return null;
            const bound = boundViews.get(browserViewKey(view));
            if (!bound) return null;
            return {
                targetId: bound.targetId,
                ...(bound.sessionId ? { sessionId: bound.sessionId } : {}),
            };
        },
        ownsView(ownerInput) {
            return ownerInput.browserSessionId === input.browserSessionId && boundViews.has(browserViewKey(ownerInput));
        },
        supportsOpenView(command) {
            return !disposed && supportsOpenViewCommand(command, input.browserSessionId);
        },
        async dispatchCommand(command, scope = {}) {
            if (disposed) return cdpFailure(command, 'known');
            switch (command.kind) {
                case 'openView': {
                    if (command.browserSessionId !== input.browserSessionId || command.target.kind !== 'externalUrl') {
                        return failed(command, 'unsupported_command', 'Browser sidecar supports only external URL views.');
                    }
                    if (input.resolveInputControl?.(command)?.isObservationHeld()) return cdpFailure(command, 'known');
                    try {
                        const page = await input.transport.openPage({
                            ...scope,
                            url: command.target.url,
                            focus: command.focus ?? true,
                        });
                        if (disposed || input.resolveInputControl?.(command)?.isObservationHeld()) {
                            try { await input.transport.dispatchBrowserCommand({ method: 'Target.closeTarget', params: { targetId: page.targetId } }); }
                            catch { /* The existing confidential binding remains retained on transport loss. */ }
                            return cdpFailure(command);
                        }
                        boundViews.set(browserViewKey(command), {
                            browserSessionId: command.browserSessionId,
                            viewId: command.viewId,
                            target: command.target,
                            platform: command.platform,
                            state: { navigationGeneration: 0, currentUrl: command.target.url, loadingState: 'loading', canGoBack: false, canGoForward: false },
                            targetId: page.targetId,
                            ...(page.sessionId ? { sessionId: page.sessionId } : {}),
                        });
                        emitLifecycle({
                            type: 'bound',
                            browserSessionId: command.browserSessionId,
                            viewId: command.viewId,
                        });
                        const bound = boundViews.get(browserViewKey(command));
                        if (bound && input.transport.subscribeCdpEvents) {
                            try {
                                await input.transport.dispatchBrowserCommand({ ...scope, method: 'Target.setDiscoverTargets', params: { discover: true } });
                                await input.transport.dispatchPageCommand({ ...scope, ...page, method: 'Page.enable' });
                                const tree = recordValue(await input.transport.dispatchPageCommand({ ...scope, ...page, method: 'Page.getFrameTree' }));
                                const frame = recordValue(recordValue(tree?.frameTree)?.frame);
                                if (frame) updateFrame(bound, frame, true);
                                await refreshHistory(bound, scope);
                            } catch {
                                if (boundViews.get(browserViewKey(command)) === bound) {
                                    boundViews.delete(browserViewKey(command));
                                    emitLifecycle({ type: 'unbound', browserSessionId: command.browserSessionId, viewId: command.viewId });
                                }
                                try { await input.transport.dispatchBrowserCommand({ method: 'Target.closeTarget', params: { targetId: page.targetId } }); }
                                catch { /* Disconnected transport cannot acknowledge cleanup; the open still fails. */ }
                                return cdpFailure(command);
                            }
                        }
                        return dispatchState(command);
                    } catch {
                        return cdpFailure(command);
                    }
                }
                case 'closeView':
                    return dispatchBrowserTargetCommand(command, 'Target.closeTarget', scope);
                case 'focusView':
                    return dispatchBrowserTargetCommand(command, 'Target.activateTarget', scope);
                case 'navigate':
                    return dispatchPage(command, 'Page.navigate', { url: command.url }, scope);
                case 'goBack':
                    return dispatchHistoryNavigation(command, -1, scope);
                case 'goForward':
                    return dispatchHistoryNavigation(command, 1, scope);
                case 'reload':
                    return dispatchPage(command, 'Page.reload', undefined, scope);
                case 'stop':
                    return dispatchPage(command, 'Page.stopLoading', undefined, scope);
                case 'setTarget':
                    return failed(command, 'unsupported_command', 'Browser sidecar CDP setTarget is not backed.');
                case 'takeControl':
                case 'handBack':
                    return failed(command, 'unsupported_command', 'Controller commands belong to the automation owner.');
            }
        },
    };
}
