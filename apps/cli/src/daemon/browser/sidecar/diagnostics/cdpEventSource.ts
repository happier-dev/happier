import type {
    BrowserSidecarCdpEventNotification,
    BrowserSidecarCdpEventSubscriber,
    BrowserSidecarCdpPageHandle,
} from '../controlAdapter';
import type { SidecarCdpDiagnosticEventInput } from './mapEvents';
import type {
    SidecarDiagnosticsEventSource,
    SidecarDiagnosticsEventSourceSubscriber,
    SidecarDiagnosticsEventSourceSubscription,
} from './eventSource';

/**
 * Live CDP → diagnostics event source (offline-diagnostics lane). Translates the raw CDP protocol
 * event stream of ONE bound page session into the intermediate diagnostics event shape consumed by
 * the bridge/mapper. The mapper owns redaction; this translator only reshapes wire fields and never
 * decides what is safe to surface. Built over the SAME live transport as control/context capture —
 * no second Chromium/CDP connection is opened.
 */
type IntermediateCdpEvent = SidecarCdpDiagnosticEventInput['event'];

type SidecarCdpDiagnosticsTransport = Readonly<{
    dispatchPageCommand(input: BrowserSidecarCdpPageHandle & Readonly<{
        method: string;
        params?: Record<string, unknown>;
    }>): Promise<unknown>;
    subscribeCdpEvents(listener: BrowserSidecarCdpEventSubscriber): () => void;
}>;

export type SidecarCdpDiagnosticsEventSourceInput = Readonly<{
    sourceId: string;
    pageHandle: BrowserSidecarCdpPageHandle;
    transport: SidecarCdpDiagnosticsTransport;
    /** Live `browser.diagnostics` gate; re-read per event for fail-closed publication. */
    isEnabled?: () => boolean;
    now?: () => number;
    onError?: (error: unknown) => void;
}>;

// The CDP domains required for the network/console/pageError/pageInfo diagnostics families.
const DIAGNOSTICS_CDP_DOMAINS: readonly string[] = ['Network.enable', 'Runtime.enable', 'Page.enable'];

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function stringField(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function headersField(value: unknown): Record<string, string | readonly string[]> | undefined {
    const headers = record(value);
    if (!headers) return undefined;
    const out: Record<string, string | readonly string[]> = {};
    for (const [name, raw] of Object.entries(headers)) {
        if (typeof raw === 'string') out[name] = raw;
        else if (Array.isArray(raw)) out[name] = raw.filter((item): item is string => typeof item === 'string');
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function mapConsoleLevel(type: unknown): 'debug' | 'error' | 'info' | 'log' | 'warning' {
    switch (type) {
        case 'error':
        case 'assert':
            return 'error';
        case 'warning':
            return 'warning';
        case 'debug':
            return 'debug';
        case 'info':
            return 'info';
        default:
            return 'log';
    }
}

function consoleArgPreview(args: readonly unknown[]): string | undefined {
    const parts: string[] = [];
    for (const arg of args) {
        const r = record(arg);
        if (!r) continue;
        const value = stringField(r.value) ?? stringField(r.description);
        if (value) parts.push(value);
    }
    return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * Reshape a raw CDP notification into the intermediate diagnostics event. Raw url/headers/requestId/
 * console text are passed through verbatim; the diagnostics mapper redacts them (origin/path/keys,
 * safe-header allowlist, hashed references, text-availability-only). Returns null for events outside
 * the supported families (and for non-main-frame navigations).
 */
export function translateSidecarCdpNotification(
    notification: BrowserSidecarCdpEventNotification,
): IntermediateCdpEvent | null {
    const params = notification.params ?? {};
    switch (notification.method) {
        case 'Network.requestWillBeSent': {
            const request = record(params.request);
            const url = stringField(request?.url);
            const requestId = stringField(params.requestId);
            if (!url || !requestId) return null;
            const headers = headersField(request?.headers);
            const resourceType = stringField(params.type);
            return {
                kind: 'network.requestWillBeSent',
                requestId,
                method: stringField(request?.method) ?? 'GET',
                url,
                ...(headers ? { headers } : {}),
                ...(resourceType ? { resourceType } : {}),
            };
        }
        case 'Network.responseReceived': {
            const response = record(params.response);
            const url = stringField(response?.url);
            const requestId = stringField(params.requestId);
            const status = numberField(response?.status);
            if (!url || !requestId || status === undefined) return null;
            const headers = headersField(response?.headers);
            const mimeType = stringField(response?.mimeType);
            return {
                kind: 'network.responseReceived',
                requestId,
                url,
                status,
                ...(mimeType ? { mimeType } : {}),
                ...(headers ? { headers } : {}),
            };
        }
        case 'Network.loadingFailed': {
            const requestId = stringField(params.requestId);
            if (!requestId) return null;
            const errorText = stringField(params.errorText);
            return {
                kind: 'network.loadingFailed',
                requestId,
                ...(errorText ? { errorText } : {}),
            };
        }
        case 'Runtime.consoleAPICalled': {
            const args = Array.isArray(params.args) ? params.args : [];
            const text = consoleArgPreview(args);
            return {
                kind: 'runtime.consoleEntry',
                level: mapConsoleLevel(params.type),
                ...(text ? { text } : {}),
                argCount: args.length,
            };
        }
        case 'Runtime.exceptionThrown': {
            const details = record(params.exceptionDetails);
            const exception = record(details?.exception);
            const message = stringField(details?.text) ?? stringField(exception?.description) ?? 'Uncaught exception';
            const stack = record(details?.stackTrace) ? 'available' : undefined;
            return {
                kind: 'runtime.exceptionThrown',
                message,
                ...(stack ? { stack } : {}),
            };
        }
        case 'Page.frameNavigated': {
            const frame = record(params.frame);
            // Only the main frame (no parent) is a page-level navigation; subframes are ignored.
            if (!frame || stringField(frame.parentId)) return null;
            const url = stringField(frame.url);
            return {
                kind: 'page.info',
                ...(url ? { url } : {}),
            };
        }
        default:
            return null;
    }
}

export function createSidecarCdpDiagnosticsEventSource(
    input: SidecarCdpDiagnosticsEventSourceInput,
): SidecarDiagnosticsEventSource {
    const now = input.now ?? (() => Date.now());
    const handle = input.pageHandle;

    function pageTarget(): BrowserSidecarCdpPageHandle {
        return {
            targetId: handle.targetId,
            ...(handle.sessionId ? { sessionId: handle.sessionId } : {}),
        };
    }

    async function enableDiagnosticsDomains(): Promise<void> {
        for (const method of DIAGNOSTICS_CDP_DOMAINS) {
            try {
                await input.transport.dispatchPageCommand({ ...pageTarget(), method });
            } catch (error) {
                // Best-effort: a sidecar that rejects a domain enable simply yields fewer events. The
                // transport stays usable; never throw out of start() and never write to stdout/stderr.
                input.onError?.(error);
            }
        }
    }

    function isForBoundSession(notification: BrowserSidecarCdpEventNotification): boolean {
        if (!handle.sessionId) return true;
        return notification.sessionId === handle.sessionId;
    }

    return {
        sourceId: input.sourceId,
        start(subscriber: SidecarDiagnosticsEventSourceSubscriber): SidecarDiagnosticsEventSourceSubscription {
            void enableDiagnosticsDomains();

            const unsubscribe = input.transport.subscribeCdpEvents((notification) => {
                if (!isForBoundSession(notification)) return;
                // Per-event fail-closed: honour a live gate flip without tearing down the binding.
                if (input.isEnabled && !input.isEnabled()) return;
                const event = translateSidecarCdpNotification(notification);
                if (!event) return;
                subscriber.onCdpEvent({ capturedAtMs: now(), event });
            });

            let stopped = false;
            return {
                stop() {
                    if (stopped) return;
                    stopped = true;
                    unsubscribe();
                },
            };
        },
    };
}
