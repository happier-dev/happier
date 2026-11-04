import type { BrowserSidecarCdpEventCapableTransport } from './controlAdapter';
import {
    createBrowserSidecarCdpControlAdapter,
    type BrowserSidecarControlAdapterFactory,
} from './controlAdapter';
import type { BrowserSidecarCdpPipe } from './cdpTransport';
import { connectBrowserSidecarCdpTransport } from './cdpTransport';
import { createBrowserSidecarInteractions } from './interactions';

type ConnectedBrowserSidecarCdpTransport = Readonly<{
    transport: BrowserSidecarCdpEventCapableTransport;
    dispose?: () => void | Promise<void>;
}>;

export type ConnectBrowserSidecarCdpTransport = (
    pipe: BrowserSidecarCdpPipe,
    scope?: Readonly<{ signal?: AbortSignal; deadlineMs?: number }>,
) => Promise<ConnectedBrowserSidecarCdpTransport>;

function unavailable() {
    return {
        ok: false as const,
        errorCode: 'cdp_unavailable' as const,
        disabledReason: 'Browser sidecar CDP pipe is unavailable.',
    };
}

async function defaultConnectTransport(pipe: BrowserSidecarCdpPipe, scope?: Readonly<{ signal?: AbortSignal; deadlineMs?: number }>): Promise<ConnectedBrowserSidecarCdpTransport> {
    const transport = await connectBrowserSidecarCdpTransport({ pipe, signal: scope?.signal });
    try {
        // Readiness is a reply from this child, under the containing launch's lifetime.
        await transport.dispatchBrowserCommand({ method: 'Browser.getVersion', ...scope });
        return { transport, dispose: () => transport.dispose() };
    } catch (error) {
        transport.dispose();
        throw error;
    }
}

export function createBrowserSidecarCdpControlAdapterFactory(input: Readonly<{
    browserSessionId: string;
    sidecarId: string;
    pipe: BrowserSidecarCdpPipe;
    signal?: AbortSignal;
    deadlineMs?: number;
    connectTransport?: ConnectBrowserSidecarCdpTransport;
}>): BrowserSidecarControlAdapterFactory {
    return async (factoryInput) => {
        const connectTransport = input.connectTransport ?? defaultConnectTransport;
        let connected: ConnectedBrowserSidecarCdpTransport;
        try {
            connected = await connectTransport(input.pipe, { signal: input.signal, deadlineMs: input.deadlineMs });
        } catch {
            return unavailable();
        }

        const adapter = createBrowserSidecarCdpControlAdapter({
            browserSessionId: input.browserSessionId,
            sidecarId: input.sidecarId,
            transport: connected.transport,
            ...(factoryInput.resolveInputControl ? { resolveInputControl: factoryInput.resolveInputControl } : {}),
        });

        const interactions = createBrowserSidecarInteractions({
            transport: connected.transport,
            resolvePageHandle: (view) => adapter.resolvePageHandle(view),
            subscribeViewLifecycle: (listener) => adapter.subscribeViewLifecycle(listener),
        });
        const subscribeCdpEvents = connected.transport.subscribeCdpEvents;
        return {
            ok: true as const,
            adapter,
            extensions: adapter.extensions,
            // Same live transport + view bindings power the BRW-11 context producer AND the offline
            // diagnostics lane; no second transport is opened and the binding map is never duplicated.
            contextCapture: {
                resolveViewportOwner: view => adapter.ownsView(view) ? adapter.viewportOwner : undefined,
                interactions,
                transport: connected.transport,
                resolvePageHandle: (view) => adapter.resolvePageHandle(view),
                // The diagnostics ring is fed from the SAME live CDP connection (event stream) +
                // the control adapter's view-binding lifecycle. Surfaced only when the transport can
                // emit events; absent ⇒ no live diagnostics source (fail-closed).
                ...(subscribeCdpEvents
                    ? { subscribeCdpEvents: (listener) => subscribeCdpEvents(listener) }
                    : {}),
                subscribeViewLifecycle: (listener) => adapter.subscribeViewLifecycle(listener),
                getNavigationState: (view) => adapter.getNavigationState(view),
                subscribeBrowserEvents: (listener) => adapter.subscribeBrowserEvents(listener),
            },
            dispose: async () => {
                adapter.dispose();
                await interactions.dispose();
                await connected.dispose?.();
            },
        };
    };
}
