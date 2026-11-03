import type {
    BrowserSidecarCdpEventNotification,
    BrowserSidecarCdpEventSubscriber,
    BrowserSidecarCdpPageHandle,
} from '../controlAdapter';
import type { SidecarCdpDiagnosticEventInput, SidecarDiagnosticSource, SidecarNetworkResponse } from './mapEvents';
import type { BrowserDiagnosticFamilyV1 } from '@happier-dev/protocol/browser/diagnostics/v1';
import { capturePrivateNetworkRequest } from './requestDetails';
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
const DIAGNOSTICS_CDP_DOMAINS: Readonly<Record<string, readonly BrowserDiagnosticFamilyV1[]>> = {
    'Network.enable': ['network'], 'Runtime.enable': ['console', 'pageError'], 'Page.enable': ['pageInfo'],
};
export const SIDECAR_CDP_DIAGNOSTIC_FAMILIES = Object.values(DIAGNOSTICS_CDP_DOMAINS).flat();

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

function consoleArgs(args: readonly unknown[]): (string | number | boolean | null)[] {
    const parts: (string | number | boolean | null)[] = [];
    for (const arg of args) {
        const r = record(arg);
        if (!r) continue;
        if (r.value === null || typeof r.value === 'string' || typeof r.value === 'boolean'
            || typeof r.value === 'number' && Number.isFinite(r.value)) parts.push(r.value);
        else if (typeof r.unserializableValue === 'string') parts.push(r.unserializableValue);
        else if (typeof r.description === 'string') parts.push(r.description);
        else if (r.type === 'undefined') parts.push('undefined');
    }
    return parts;
}

function sourceLocation(value: unknown): SidecarDiagnosticSource | undefined {
    const source = record(value);
    if (!source) return undefined;
    return {
        ...(stringField(source.url) ? { url: source.url as string } : {}),
        ...(typeof source.functionName === 'string' ? { functionName: source.functionName } : {}),
        ...(numberField(source.lineNumber) === undefined ? {} : { lineNumber: source.lineNumber as number }),
        ...(numberField(source.columnNumber) === undefined ? {} : { columnNumber: source.columnNumber as number }),
    };
}

function stackFrames(value: unknown): SidecarDiagnosticSource[] {
    const frames: SidecarDiagnosticSource[] = [];
    let stack = record(value);
    while (stack) {
        if (Array.isArray(stack.callFrames)) {
            for (const frame of stack.callFrames) {
                const source = sourceLocation(frame);
                if (source) frames.push(source);
            }
        }
        stack = record(stack.parent);
    }
    return frames;
}

function networkResponse(value: unknown): SidecarNetworkResponse | undefined {
    const response = record(value);
    const url = stringField(response?.url);
    const status = numberField(response?.status);
    if (!response || !url || status === undefined) return undefined;
    const timing = Object.fromEntries(Object.entries(record(response.timing) ?? {})
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])));
    const securityDetails = Object.fromEntries(Object.entries(record(response.securityDetails) ?? {})
        .filter((entry): entry is [string, string | number] => typeof entry[1] === 'string'
            || typeof entry[1] === 'number' && Number.isFinite(entry[1])));
    return { url, status, headers: headersField(response.headers),
        mimeType: stringField(response.mimeType), transportProtocol: stringField(response.protocol),
        securityState: stringField(response.securityState), timing,
        ...(Object.keys(securityDetails).length ? { securityDetails } : {}),
        ...(typeof response.fromDiskCache === 'boolean' ? { fromDiskCache: response.fromDiskCache } : {}),
        ...(typeof response.fromServiceWorker === 'boolean' ? { fromServiceWorker: response.fromServiceWorker } : {}),
        ...(numberField(response.encodedDataLength) === undefined ? {} : { encodedDataLength: response.encodedDataLength as number }),
    };
}

/**
 * Reshape a raw CDP notification into the intermediate diagnostics event. Raw url/headers/requestId/
 * console text are passed through verbatim; the diagnostics mapper redacts them (origin/path/keys,
 * safe-header allowlist, hashed references, destination-classified owner values). Returns null for events outside
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
                ...(typeof request?.hasPostData === 'boolean' ? { hasPostData: request.hasPostData } : {}),
                ...(numberField(params.timestamp) === undefined ? {} : { timestamp: params.timestamp as number }),
                ...(params.initiator ? { initiator: { ...sourceLocation(params.initiator),
                    ...(stringField(record(params.initiator)?.type) ? { type: stringField(record(params.initiator)?.type) } : {}),
                    stackFrames: stackFrames(record(params.initiator)?.stack) } } : {}),
                ...(params.redirectResponse ? { redirectResponse: networkResponse(params.redirectResponse) } : {}),
                ...(typeof params.redirectHasExtraInfo === 'boolean' ? { redirectHasExtraInfo: params.redirectHasExtraInfo } : {}),
            };
        }
        case 'Network.responseReceived': {
            const response = networkResponse(params.response);
            const requestId = stringField(params.requestId);
            if (!response || !requestId) return null;
            return {
                kind: 'network.responseReceived',
                requestId,
                ...response,
                timestamp: numberField(params.timestamp),
                ...(typeof params.hasExtraInfo === 'boolean' ? { hasExtraInfo: params.hasExtraInfo } : {}),
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
                ...(numberField(params.timestamp) === undefined ? {} : { timestamp: params.timestamp as number }),
                ...(typeof params.canceled === 'boolean' ? { canceled: params.canceled } : {}),
                ...(stringField(params.blockedReason) ? { blockedReason: params.blockedReason as string } : {}),
            };
        }
        case 'Network.loadingFinished': {
            const requestId = stringField(params.requestId);
            return requestId ? { kind: 'network.loadingFinished', requestId, timestamp: numberField(params.timestamp),
                encodedDataLength: numberField(params.encodedDataLength) } : null;
        }
        case 'Network.requestWillBeSentExtraInfo':
        case 'Network.responseReceivedExtraInfo': {
            const requestId = stringField(params.requestId);
            return requestId ? { kind: notification.method === 'Network.requestWillBeSentExtraInfo'
                ? 'network.requestExtraInfo' : 'network.responseExtraInfo', requestId,
                headers: headersField(params.headers), statusCode: numberField(params.statusCode) } : null;
        }
        case 'Runtime.consoleAPICalled': {
            const args = Array.isArray(params.args) ? params.args : [];
            const values = consoleArgs(args);
            const text = values.map(value => value === null ? 'null' : String(value)).join(' ');
            const frames = stackFrames(params.stackTrace);
            return {
                kind: 'runtime.consoleEntry',
                level: mapConsoleLevel(params.type),
                text,
                args: values,
                ...(frames.length ? { stackFrames: frames, source: frames[0] } : {}),
                argCount: args.length,
            };
        }
        case 'Runtime.exceptionThrown': {
            const details = record(params.exceptionDetails);
            const exception = record(details?.exception);
            const message = stringField(exception?.description) ?? stringField(details?.text) ?? 'Uncaught exception';
            const frames = stackFrames(details?.stackTrace);
            const source = sourceLocation(details);
            const stack = frames.map(frame => `${frame.functionName ?? ''} (${frame.url ?? ''}:${frame.lineNumber ?? 0}:${frame.columnNumber ?? 0})`).join('\n');
            return {
                kind: 'runtime.exceptionThrown',
                message,
                ...(stack ? { stack } : {}),
                ...(frames.length ? { stackFrames: frames } : {}),
                ...(source ? { source } : {}),
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

    function isForBoundSession(notification: BrowserSidecarCdpEventNotification): boolean {
        if (!handle.sessionId) return true;
        return notification.sessionId === handle.sessionId;
    }

    return {
        sourceId: input.sourceId,
        start(subscriber: SidecarDiagnosticsEventSourceSubscriber): SidecarDiagnosticsEventSourceSubscription {
            let stopped = false;
            const active = () => !stopped && (!input.isEnabled || input.isEnabled());
            const publishTitle = async () => {
                if (!active()) return;
                try {
                    const result = record(await input.transport.dispatchPageCommand({ ...pageTarget(),
                        method: 'Runtime.evaluate', params: { expression: 'document.title', returnByValue: true } }));
                    const title = record(result?.result)?.value;
                    if (active() && typeof title === 'string') subscriber.onCdpEvent({ capturedAtMs: now(), event: { kind: 'page.info', title } });
                } catch (error) {
                    if (active()) input.onError?.(error);
                }
            };

            const unsubscribe = input.transport.subscribeCdpEvents((notification) => {
                if (!isForBoundSession(notification)) return;
                // Per-event fail-closed: honour a live gate flip without tearing down the binding.
                if (!active()) return;
                if (notification.method === 'Page.domContentEventFired') { void publishTitle(); return; }
                const event = translateSidecarCdpNotification(notification);
                if (!event) return;
                subscriber.onCdpEvent({ capturedAtMs: now(), event, privateRequest: capturePrivateNetworkRequest(notification) });
            });

            void (async () => {
                for (const [method, families] of Object.entries(DIAGNOSTICS_CDP_DOMAINS)) {
                    if (stopped) return;
                    try {
                        await input.transport.dispatchPageCommand({ ...pageTarget(), method });
                        if (active()) for (const family of families) subscriber.onCdpEvent({ capturedAtMs: now(), event: { kind: 'diagnostics.available', family } });
                    } catch (error) {
                        if (active()) {
                            input.onError?.(error);
                            for (const family of families) subscriber.onUnavailable({ capturedAtMs: now(), family, reason: 'collector_unavailable' });
                        }
                    }
                }
                await publishTitle();
            })();
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
