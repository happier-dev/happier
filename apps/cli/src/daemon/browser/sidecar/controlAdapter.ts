import type {
    BrowserCommandDispatchResultV1,
    BrowserCommandErrorCodeV1,
    BrowserCommandV1,
    BrowserSidecarErrorCodeV1,
} from '@happier-dev/protocol';

import {
    browserCommandDispatchFailure,
    type BrowserDaemonControlAdapter,
} from '../control/types';

export type BrowserSidecarCdpPageHandle = Readonly<{
    targetId: string;
    sessionId?: string;
}>;

export type BrowserSidecarCdpControlTransport = Readonly<{
    openPage(input: Readonly<{ url: string; focus: boolean }>): Promise<BrowserSidecarCdpPageHandle>;
    dispatchPageCommand(input: BrowserSidecarCdpPageHandle & Readonly<{
        method: string;
        params?: Record<string, unknown>;
    }>): Promise<unknown>;
    dispatchBrowserCommand(input: Readonly<{
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
}>;

export type BrowserSidecarViewLifecycleSubscriber = (event: BrowserSidecarViewLifecycleEvent) => void;

export type BrowserSidecarControlAdapterFactoryInput = Readonly<{
    machineId: string;
}>;

/**
 * Optional BRW-11 context-capture surface a sidecar control adapter result may carry. When present,
 * the daemon can build a real CDP context producer (page/screenshot/summary/selectedElement) over
 * the SAME live transport and view bindings used for control. Absent ⇒ no producer ⇒ context stays
 * fail-closed (the unavailable source).
 */
export type BrowserSidecarContextCaptureSurface = Readonly<{
    transport: Pick<BrowserSidecarCdpControlTransport, 'dispatchPageCommand'>;
    resolvePageHandle(
        view: Readonly<{ browserSessionId: string; viewId: string }>,
    ): BrowserSidecarCdpPageHandle | null;
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
    transport: BrowserSidecarCdpControlTransport;
}>;

/**
 * The control adapter is the single owner of the view → CDP page-handle binding. The BRW-11 context
 * producer needs the same mapping to capture page/screenshot/summary/selectedElement for a view, so
 * the adapter exposes a read-only resolver instead of the producer duplicating (and drifting from)
 * the binding state. Returns `null` for an unbound view so the producer stays fail-closed.
 */
export type BrowserSidecarCdpControlAdapter = BrowserDaemonControlAdapter & Readonly<{
    resolvePageHandle(
        view: Readonly<{ browserSessionId: string; viewId: string }>,
    ): BrowserSidecarCdpPageHandle | null;
    /**
     * Subscribe to view-binding transitions (bind on openView, unbind on closeView). Returns an
     * unsubscribe handle. Listener errors never break control dispatch.
     */
    subscribeViewLifecycle(listener: BrowserSidecarViewLifecycleSubscriber): () => void;
}>;

type BoundView = BrowserSidecarCdpPageHandle & Readonly<{
    browserSessionId: string;
    viewId: string;
}>;

function viewKey(input: Readonly<{ browserSessionId: string; viewId: string }>): string {
    return `${input.browserSessionId}\u0000${input.viewId}`;
}

function dispatched(command: BrowserCommandV1): BrowserCommandDispatchResultV1 {
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
): BrowserCommandDispatchResultV1 {
    return browserCommandDispatchFailure({
        commandId: command.commandId,
        adapterKind: 'chromiumSidecar',
        code,
        message,
        ...(typeof retryable === 'boolean' ? { retryable } : {}),
    });
}

function cdpFailure(command: BrowserCommandV1): BrowserCommandDispatchResultV1 {
    return failed(command, 'adapter_unavailable', 'Browser sidecar CDP command failed.', true);
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
        return boundViews.get(viewKey(command)) ?? null;
    }

    async function dispatchPage(
        command: Extract<BrowserCommandV1, { browserSessionId: string; viewId: string }>,
        method: string,
        params?: Record<string, unknown>,
    ): Promise<BrowserCommandDispatchResultV1> {
        const boundView = readBoundView(command);
        if (!boundView) {
            return failed(command, 'view_not_found', 'Browser sidecar does not own this view.');
        }

        try {
            await input.transport.dispatchPageCommand({
                targetId: boundView.targetId,
                ...(boundView.sessionId ? { sessionId: boundView.sessionId } : {}),
                method,
                ...(params ? { params } : {}),
            });
            return dispatched(command);
        } catch {
            return cdpFailure(command);
        }
    }

    async function dispatchHistoryNavigation(
        command: Extract<BrowserCommandV1, { kind: 'goBack' | 'goForward' }>,
        offset: -1 | 1,
    ): Promise<BrowserCommandDispatchResultV1> {
        const boundView = readBoundView(command);
        if (!boundView) {
            return failed(command, 'view_not_found', 'Browser sidecar does not own this view.');
        }

        try {
            const history = await input.transport.dispatchPageCommand({
                targetId: boundView.targetId,
                ...(boundView.sessionId ? { sessionId: boundView.sessionId } : {}),
                method: 'Page.getNavigationHistory',
            });
            const entryId = readHistoryEntryId(history, offset);
            if (entryId === null) {
                return failed(command, 'unsupported_command', 'Browser sidecar history entry is unavailable.');
            }
            await input.transport.dispatchPageCommand({
                targetId: boundView.targetId,
                ...(boundView.sessionId ? { sessionId: boundView.sessionId } : {}),
                method: 'Page.navigateToHistoryEntry',
                params: { entryId },
            });
            return dispatched(command);
        } catch {
            return cdpFailure(command);
        }
    }

    async function dispatchBrowserTargetCommand(
        command: Extract<BrowserCommandV1, { browserSessionId: string; viewId: string }>,
        method: 'Target.activateTarget' | 'Target.closeTarget',
    ): Promise<BrowserCommandDispatchResultV1> {
        const boundView = readBoundView(command);
        if (!boundView) {
            return failed(command, 'view_not_found', 'Browser sidecar does not own this view.');
        }

        try {
            await input.transport.dispatchBrowserCommand({
                method,
                params: { targetId: boundView.targetId },
            });
            if (command.kind === 'closeView') {
                boundViews.delete(viewKey(command));
                emitLifecycle({
                    type: 'unbound',
                    browserSessionId: command.browserSessionId,
                    viewId: command.viewId,
                });
            }
            return dispatched(command);
        } catch {
            return cdpFailure(command);
        }
    }

    return {
        adapterKind: 'chromiumSidecar',
        subscribeViewLifecycle(listener) {
            lifecycleListeners.add(listener);
            return () => {
                lifecycleListeners.delete(listener);
            };
        },
        resolvePageHandle(view) {
            if (view.browserSessionId !== input.browserSessionId) return null;
            const bound = boundViews.get(viewKey(view));
            if (!bound) return null;
            return {
                targetId: bound.targetId,
                ...(bound.sessionId ? { sessionId: bound.sessionId } : {}),
            };
        },
        ownsView(ownerInput) {
            return ownerInput.browserSessionId === input.browserSessionId && boundViews.has(viewKey(ownerInput));
        },
        supportsOpenView(command) {
            return supportsOpenViewCommand(command, input.browserSessionId);
        },
        async dispatchCommand(command) {
            switch (command.kind) {
                case 'createSession':
                case 'closeSession':
                    return failed(command, 'unsupported_command', 'Browser session commands do not have a sidecar CDP owner.');
                case 'openView': {
                    if (command.browserSessionId !== input.browserSessionId || command.target.kind !== 'externalUrl') {
                        return failed(command, 'unsupported_command', 'Browser sidecar supports only external URL views.');
                    }
                    try {
                        const page = await input.transport.openPage({
                            url: command.target.url,
                            focus: command.focus ?? true,
                        });
                        boundViews.set(viewKey(command), {
                            browserSessionId: command.browserSessionId,
                            viewId: command.viewId,
                            targetId: page.targetId,
                            ...(page.sessionId ? { sessionId: page.sessionId } : {}),
                        });
                        emitLifecycle({
                            type: 'bound',
                            browserSessionId: command.browserSessionId,
                            viewId: command.viewId,
                        });
                        return dispatched(command);
                    } catch {
                        return cdpFailure(command);
                    }
                }
                case 'closeView':
                    return dispatchBrowserTargetCommand(command, 'Target.closeTarget');
                case 'focusView':
                    return dispatchBrowserTargetCommand(command, 'Target.activateTarget');
                case 'navigate':
                    return dispatchPage(command, 'Page.navigate', { url: command.url });
                case 'goBack':
                    return dispatchHistoryNavigation(command, -1);
                case 'goForward':
                    return dispatchHistoryNavigation(command, 1);
                case 'reload':
                    return dispatchPage(command, 'Page.reload');
                case 'stop':
                    return dispatchPage(command, 'Page.stopLoading');
                case 'setTarget':
                    return failed(command, 'unsupported_command', 'Browser sidecar CDP setTarget is not backed.');
            }
        },
    };
}
