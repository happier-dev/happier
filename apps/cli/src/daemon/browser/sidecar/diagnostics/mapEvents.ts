import { BrowserDiagnosticEventV1Schema, BrowserDiagnosticsEvalResultV1Schema } from '@happier-dev/protocol/browser/diagnostics/v1';
import type { BrowserDiagnosticEventV1, BrowserDiagnosticFamilyV1, BrowserDiagnosticUnavailableReasonV1, BrowserDiagnosticsEvalResultV1, BrowserDiagnosticsRemoteObjectPreviewPropertyV1 } from '@happier-dev/protocol';

import {
    createSidecarPrivateReference,
    redactSidecarDiagnosticsUrl,
    type SidecarDiagnosticsHeaders,
} from './redaction';
import { mapSidecarNetworkEvent } from './networkEvents';

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
    hasPostData?: boolean;
    timestamp?: number;
    initiator?: SidecarDiagnosticSource & Readonly<{ type?: string; stackFrames?: readonly SidecarDiagnosticSource[] }>;
    redirectResponse?: SidecarNetworkResponse;
    redirectHasExtraInfo?: boolean;
}>;

export type SidecarNetworkResponse = Readonly<{
    url: string;
    status: number;
    mimeType?: string;
    headers?: SidecarDiagnosticsHeaders;
    timestamp?: number;
    timing?: Readonly<Record<string, number>>;
    transportProtocol?: string;
    fromDiskCache?: boolean;
    fromServiceWorker?: boolean;
    securityState?: string;
    securityDetails?: Readonly<Record<string, string | number>>;
    hasExtraInfo?: boolean;
    encodedDataLength?: number;
}>;
type SidecarNetworkResponseEvent = SidecarNetworkResponse & Readonly<{ kind: 'network.responseReceived'; requestId: string }>;

type SidecarNetworkExtraInfoEvent = Readonly<{
    kind: 'network.requestExtraInfo' | 'network.responseExtraInfo';
    requestId: string;
    headers?: SidecarDiagnosticsHeaders;
    statusCode?: number;
}>;

type SidecarNetworkFinishedEvent = Readonly<{
    kind: 'network.loadingFinished'; requestId: string; timestamp?: number; encodedDataLength?: number;
}>;

export type SidecarDiagnosticSource = Readonly<{
    url?: string; functionName?: string; lineNumber?: number; columnNumber?: number;
}>;

type SidecarNetworkFailureEvent = Readonly<{
    kind: 'network.loadingFailed';
    requestId: string;
    url?: string;
    errorText?: string;
    timestamp?: number;
    canceled?: boolean;
    blockedReason?: string;
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
    args?: readonly (string | number | boolean | null)[];
    stackFrames?: readonly SidecarDiagnosticSource[];
    source?: SidecarDiagnosticSource;
}>;

type SidecarPageErrorEvent = Readonly<{
    kind: 'runtime.exceptionThrown';
    message: string;
    stack?: string;
    stackFrames?: readonly SidecarDiagnosticSource[];
    source?: SidecarDiagnosticSource;
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
        | SidecarNetworkFinishedEvent
        | SidecarNetworkExtraInfoEvent
        | SidecarWebSocketSummaryEvent
        | SidecarConsoleEvent
        | SidecarPageErrorEvent
        | SidecarPageInfoEvent
        | Readonly<{ kind: 'diagnostics.available'; family: BrowserDiagnosticFamilyV1 }>;
}>;
export type SidecarNetworkEvent = Extract<SidecarCdpDiagnosticEventInput['event'], { requestId: string }>;

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

export function mapSidecarCdpDiagnosticEvent(input: SidecarCdpDiagnosticEventInput, previousNetworkEvent?: BrowserDiagnosticEventV1): BrowserDiagnosticEventV1 {
    const common = baseEvent(input);

    switch (input.event.kind) {
        case 'network.requestWillBeSent':
        case 'network.responseReceived':
        case 'network.loadingFailed':
        case 'network.loadingFinished':
        case 'network.requestExtraInfo':
        case 'network.responseExtraInfo':
            return mapSidecarNetworkEvent(input.event, common, previousNetworkEvent);
        case 'diagnostics.available':
            return BrowserDiagnosticEventV1Schema.parse({
                ...common,
                family: input.event.family,
                kind: 'diagnostics.available',
                data: {},
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
                    ...(input.event.text === undefined ? {} : { text: input.event.text }),
                    ...(input.event.args ? { args: input.event.args } : {}),
                    ...(input.event.stackFrames ? { stackFrames: input.event.stackFrames } : {}),
                    ...(input.event.source ? { source: input.event.source } : {}),
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
                    message: input.event.message,
                    ...(input.event.stack ? { stack: input.event.stack } : {}),
                    ...(input.event.stackFrames ? { stackFrames: input.event.stackFrames } : {}),
                    ...(input.event.source ? { source: input.event.source } : {}),
                },
            });
        case 'page.info':
            return BrowserDiagnosticEventV1Schema.parse({
                ...common,
                family: 'pageInfo',
                kind: 'pageInfo.snapshot',
                data: {
                    ...(input.event.url ? { url: redactSidecarDiagnosticsUrl(input.event.url) } : {}),
                    ...(input.event.title === undefined ? {} : { title: input.event.title }),
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
