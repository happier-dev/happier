import type { BrowserSidecarCdpEventCapableTransport } from './controlAdapter';
import {
    createBrowserSidecarCdpControlAdapter,
    type BrowserSidecarControlAdapterFactory,
} from './controlAdapter';
import {
    discoverBrowserSidecarCdpEndpoint,
    type BrowserSidecarCdpEndpoint,
    type BrowserSidecarCdpEndpointSource,
} from './cdpEndpoint';
import { connectBrowserSidecarCdpTransport } from './cdpTransport';

type ConnectedBrowserSidecarCdpTransport = Readonly<{
    transport: BrowserSidecarCdpEventCapableTransport;
    dispose?: () => void | Promise<void>;
}>;

export type ConnectBrowserSidecarCdpTransport = (
    endpoint: BrowserSidecarCdpEndpoint
) => Promise<ConnectedBrowserSidecarCdpTransport>;

function unavailable() {
    return {
        ok: false as const,
        errorCode: 'cdp_unavailable' as const,
        disabledReason: 'Browser sidecar CDP endpoint is unavailable.',
    };
}

async function defaultConnectTransport(endpoint: BrowserSidecarCdpEndpoint): Promise<ConnectedBrowserSidecarCdpTransport> {
    const transport = await connectBrowserSidecarCdpTransport({ endpoint });
    return {
        transport,
        dispose: () => transport.dispose(),
    };
}

export function createBrowserSidecarCdpControlAdapterFactory(input: Readonly<{
    browserSessionId: string;
    sidecarId: string;
    endpointSource: BrowserSidecarCdpEndpointSource;
    connectTransport?: ConnectBrowserSidecarCdpTransport;
}>): BrowserSidecarControlAdapterFactory {
    return async () => {
        const discovered = discoverBrowserSidecarCdpEndpoint(input.endpointSource);
        if (!discovered.ok) {
            return unavailable();
        }

        const connectTransport = input.connectTransport ?? defaultConnectTransport;
        let connected: ConnectedBrowserSidecarCdpTransport;
        try {
            connected = await connectTransport(discovered.endpoint);
        } catch {
            return unavailable();
        }

        const adapter = createBrowserSidecarCdpControlAdapter({
            browserSessionId: input.browserSessionId,
            sidecarId: input.sidecarId,
            transport: connected.transport,
        });

        const subscribeCdpEvents = connected.transport.subscribeCdpEvents;
        return {
            ok: true as const,
            adapter,
            // Same live transport + view bindings power the BRW-11 context producer AND the offline
            // diagnostics lane; no second transport is opened and the binding map is never duplicated.
            contextCapture: {
                transport: connected.transport,
                resolvePageHandle: (view) => adapter.resolvePageHandle(view),
                // The diagnostics ring is fed from the SAME live CDP connection (event stream) +
                // the control adapter's view-binding lifecycle. Surfaced only when the transport can
                // emit events; absent ⇒ no live diagnostics source (fail-closed).
                ...(subscribeCdpEvents
                    ? { subscribeCdpEvents: (listener) => subscribeCdpEvents(listener) }
                    : {}),
                subscribeViewLifecycle: (listener) => adapter.subscribeViewLifecycle(listener),
            },
            ...(connected.dispose ? { dispose: connected.dispose } : {}),
        };
    };
}
