import {
    BrowserDiagnosticEventV1Schema,
    BrowserDiagnosticsEvalResultV1Schema,
    type BrowserDiagnosticEventV1,
    type BrowserDiagnosticFamilyV1,
    type BrowserDiagnosticUnavailableReasonV1,
    type BrowserDiagnosticsEvalResultV1,
    type BrowserDiagnosticsRemoteObjectPreviewPropertyV1,
} from '@happier-dev/protocol';

import {
    createSidecarPrivateReference,
    redactSidecarDiagnosticsHeaders,
    redactSidecarDiagnosticsUrl,
    type SidecarDiagnosticsHeaders,
} from './redaction';

type SidecarDiagnosticBaseInput = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    capturedAtMs: number;
    eventOrdinal: number;
    rawCdpSessionId?: string;
    debuggerUrl?: string;
}>;

type SidecarNetworkRequestEvent = Readonly<{
    kind: 'network.requestWillBeSent';
    requestId: string;
    method: string;
    url: string;
    headers?: SidecarDiagnosticsHeaders;
    resourceType?: string;
}>;

type SidecarNetworkResponseEvent = Readonly<{
    kind: 'network.responseReceived';
    requestId: string;
    url: string;
    status: number;
    mimeType?: string;
    headers?: SidecarDiagnosticsHeaders;
}>;

type SidecarNetworkFailureEvent = Readonly<{
    kind: 'network.loadingFailed';
    requestId: string;
    url?: string;
    errorText?: string;
}>;

type SidecarWebSocketSummaryEvent = Readonly<{
    kind: 'network.webSocketSummary';
    requestId: string;
    url: string;
    framesSent: number;
    framesReceived: number;
    bytesSent?: number;
    bytesReceived?: number;
    payloadPreview?: string;
}>;

type SidecarConsoleEvent = Readonly<{
    kind: 'runtime.consoleEntry';
    level: 'debug' | 'error' | 'info' | 'log' | 'warning';
    text?: string;
    argCount?: number;
}>;

type SidecarPageErrorEvent = Readonly<{
    kind: 'runtime.exceptionThrown';
    message: string;
    stack?: string;
}>;

type SidecarPageInfoEvent = Readonly<{
    kind: 'page.info';
    url?: string;
    title?: string;
    faviconUrl?: string;
}>;

export type SidecarCdpDiagnosticEventInput = SidecarDiagnosticBaseInput & Readonly<{
    event:
        | SidecarNetworkRequestEvent
        | SidecarNetworkResponseEvent
        | SidecarNetworkFailureEvent
        | SidecarWebSocketSummaryEvent
        | SidecarConsoleEvent
        | SidecarPageErrorEvent
        | SidecarPageInfoEvent;
}>;

function eventId(input: SidecarDiagnosticBaseInput): string {
    return `sidecar_diag_${input.viewId}_${input.navigationGeneration}_${input.eventOrdinal}`;
}

function truncateText(value: string | undefined, limit = 1024): string | undefined {
    if (!value) return undefined;
    return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function baseEvent(input: SidecarDiagnosticBaseInput): Pick<
    BrowserDiagnosticEventV1,
    | 'v'
    | 'eventId'
    | 'browserSessionId'
    | 'viewId'
    | 'navigationGeneration'
    | 'capturedAtMs'
    | 'fidelity'
    | 'trusted'
    | 'redaction'
> {
    return {
        v: 1,
        eventId: eventId(input),
        browserSessionId: input.browserSessionId,
        viewId: input.viewId,
        navigationGeneration: input.navigationGeneration,
        capturedAtMs: input.capturedAtMs,
        fidelity: 'cdp',
        trusted: true,
        redaction: {
            level: 'metadataOnly',
            queryRedacted: true,
            headersRedacted: true,
            truncated: false,
        },
    };
}

export function mapSidecarCdpDiagnosticEvent(input: SidecarCdpDiagnosticEventInput): BrowserDiagnosticEventV1 {
    const common = baseEvent(input);

    switch (input.event.kind) {
        case 'network.requestWillBeSent':
            return BrowserDiagnosticEventV1Schema.parse({
                ...common,
                family: 'network',
                kind: 'network.requestStarted',
                data: {
                    requestId: createSidecarPrivateReference('request', input.event.requestId),
                    method: input.event.method,
                    resourceType: input.event.resourceType,
                    url: redactSidecarDiagnosticsUrl(input.event.url),
                    headers: redactSidecarDiagnosticsHeaders(input.event.headers),
                },
            });
        case 'network.responseReceived':
            return BrowserDiagnosticEventV1Schema.parse({
                ...common,
                family: 'network',
                kind: 'network.response',
                data: {
                    requestId: createSidecarPrivateReference('request', input.event.requestId),
                    status: input.event.status,
                    mimeType: input.event.mimeType,
                    url: redactSidecarDiagnosticsUrl(input.event.url),
                    headers: redactSidecarDiagnosticsHeaders(input.event.headers),
                },
            });
        case 'network.loadingFailed':
            return BrowserDiagnosticEventV1Schema.parse({
                ...common,
                family: 'network',
                kind: 'network.failed',
                data: {
                    requestId: createSidecarPrivateReference('request', input.event.requestId),
                    ...(input.event.url ? { url: redactSidecarDiagnosticsUrl(input.event.url) } : {}),
                    ...(input.event.errorText ? { errorText: truncateText(input.event.errorText, 512) } : {}),
                },
            });
        case 'network.webSocketSummary':
            return BrowserDiagnosticEventV1Schema.parse({
                ...common,
                family: 'network',
                kind: 'network.websocketSummary',
                data: {
                    socketId: createSidecarPrivateReference('socket', input.event.requestId),
                    url: redactSidecarDiagnosticsUrl(input.event.url),
                    framesSent: input.event.framesSent,
                    framesReceived: input.event.framesReceived,
                    ...(input.event.bytesSent !== undefined ? { bytesSent: input.event.bytesSent } : {}),
                    ...(input.event.bytesReceived !== undefined ? { bytesReceived: input.event.bytesReceived } : {}),
                },
            });
        case 'runtime.consoleEntry':
            return BrowserDiagnosticEventV1Schema.parse({
                ...common,
                family: 'console',
                kind: 'console.entry',
                redaction: {
                    ...common.redaction,
                    level: 'valuesRedacted',
                },
                data: {
                    level: input.event.level,
                    textAvailable: Boolean(input.event.text),
                    ...(input.event.argCount !== undefined ? { argCount: input.event.argCount } : {}),
                },
            });
        case 'runtime.exceptionThrown':
            return BrowserDiagnosticEventV1Schema.parse({
                ...common,
                family: 'pageError',
                kind: 'pageError.thrown',
                redaction: {
                    ...common.redaction,
                    level: 'valuesRedacted',
                },
                data: {
                    messageAvailable: Boolean(input.event.message),
                    stackAvailable: Boolean(input.event.stack),
                },
            });
        case 'page.info':
            return BrowserDiagnosticEventV1Schema.parse({
                ...common,
                family: 'pageInfo',
                kind: 'pageInfo.snapshot',
                data: {
                    ...(input.event.url ? { url: redactSidecarDiagnosticsUrl(input.event.url) } : {}),
                    ...(input.event.title ? { title: truncateText(input.event.title, 512) } : {}),
                    ...(input.event.faviconUrl ? { faviconUrl: redactSidecarDiagnosticsUrl(input.event.faviconUrl) } : {}),
                },
            });
    }
}

export function mapSidecarCdpDiagnosticUnavailable(input: SidecarDiagnosticBaseInput & Readonly<{
    family: BrowserDiagnosticFamilyV1;
    reason: BrowserDiagnosticUnavailableReasonV1;
}>): BrowserDiagnosticEventV1 {
    return BrowserDiagnosticEventV1Schema.parse({
        v: 1,
        eventId: eventId(input),
        browserSessionId: input.browserSessionId,
        viewId: input.viewId,
        navigationGeneration: input.navigationGeneration,
        capturedAtMs: input.capturedAtMs,
        family: input.family,
        kind: 'diagnostics.unavailable',
        fidelity: 'unavailable',
        trusted: true,
        data: {},
        redaction: {
            level: 'unavailable',
            queryRedacted: true,
            headersRedacted: true,
            truncated: false,
        },
        unavailableReason: input.reason,
    });
}

export type SidecarCdpEvalObjectResultInput = Readonly<{
    evalRequestId: string;
    viewId: string;
    navigationGeneration: number;
    rawCdpObjectId: string;
    className?: string;
    description?: string;
    preview?: readonly BrowserDiagnosticsRemoteObjectPreviewPropertyV1[];
}>;

export function mapSidecarCdpEvalResult(input: SidecarCdpEvalObjectResultInput): BrowserDiagnosticsEvalResultV1 {
    return BrowserDiagnosticsEvalResultV1Schema.parse({
        v: 1,
        evalRequestId: input.evalRequestId,
        viewId: input.viewId,
        navigationGeneration: input.navigationGeneration,
        status: 'completed',
        tier: 'cdp',
        audited: true,
        result: {
            type: 'object',
            objectId: createSidecarPrivateReference('object', input.rawCdpObjectId),
            ...(input.className ? { className: truncateText(input.className, 256) } : {}),
            ...(input.description ? { description: truncateText(input.description, 1024) } : {}),
            preview: input.preview ?? [],
        },
    });
}
