import { BrowserDiagnosticEventV1Schema, type BrowserDiagnosticEventV1 } from '@happier-dev/protocol/browser/diagnostics/v1';
import type { SidecarNetworkEvent, SidecarNetworkResponse } from './mapEvents';
import { createSidecarPrivateReference, redactSidecarDiagnosticsHeadersWithResult, redactSidecarDiagnosticsUrl, type SidecarDiagnosticsHeaders } from './redaction';

type Common = Omit<BrowserDiagnosticEventV1, 'family' | 'kind' | 'data'>;

function responseData(response: SidecarNetworkResponse, headers: (input: SidecarDiagnosticsHeaders | undefined) => Readonly<Record<string, string>>): Record<string, unknown> {
    return {
        url: redactSidecarDiagnosticsUrl(response.url), status: response.status,
        ...(response.mimeType ? { mimeType: response.mimeType } : {}),
        responseHeaders: headers(response.headers),
        ...(response.timing ? { timing: response.timing } : {}),
        ...(response.transportProtocol ? { transportProtocol: response.transportProtocol } : {}),
        ...(response.securityState ? { securityState: response.securityState } : {}),
        ...(response.securityDetails ? { securityDetails: response.securityDetails } : {}),
        ...(response.fromDiskCache === undefined ? {} : { fromDiskCache: response.fromDiskCache }),
        ...(response.fromServiceWorker === undefined ? {} : { fromServiceWorker: response.fromServiceWorker }),
        ...(response.hasExtraInfo === undefined ? {} : { hasExtraInfo: response.hasExtraInfo }),
        ...(response.encodedDataLength === undefined ? {} : { responseBytes: response.encodedDataLength }),
    };
}

function records(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry)).map(entry => ({ ...entry })) : [];
}

/** Correlation lives in the mapper; its only retained input is the daemon's existing per-view ring.
 * ExtraInfo streams keep their CDP order independently of request/response arrival. Redirect flags
 * identify the hops which have extra information. Ambiguous partial history is exposed, not guessed.
 */
export function mapSidecarNetworkEvent(event: Exclude<SidecarNetworkEvent, { kind: 'network.webSocketSummary' }>, common: Common, previous?: BrowserDiagnosticEventV1): BrowserDiagnosticEventV1 {
    let truncated = previous?.redaction.truncated === true;
    const headers = (input: SidecarDiagnosticsHeaders | undefined) => {
        const result = redactSidecarDiagnosticsHeadersWithResult(input);
        truncated ||= result.truncated;
        return result.headers;
    };
    const requestId = createSidecarPrivateReference('request', event.requestId);
    let data: Record<string, unknown> = { ...previous?.data, requestId };
    let kind = previous?.kind ?? 'network.requestStarted';
    const requestExtraInfo = records(data.requestExtraInfo);
    const responseExtraInfo = records(data.responseExtraInfo);
    let redirects = records(data.redirects);
    switch (event.kind) {
        case 'network.requestWillBeSent': {
            if (event.redirectResponse) {
                const { redirects: _redirects, requestExtraInfo: _requestExtraInfo, responseExtraInfo: _responseExtraInfo, ...hop } = data;
                redirects = [...redirects, { ...hop, ...responseData(event.redirectResponse, headers),
                    ...(event.redirectHasExtraInfo === undefined ? {} : { hasExtraInfo: event.redirectHasExtraInfo }),
                    ...(event.timestamp === undefined || typeof hop.startedAtSeconds !== 'number' ? {} : {
                        durationMs: (event.timestamp - hop.startedAtSeconds) * 1000,
                    }) }];
                data = { requestId };
            }
            const requestHeaders = headers(event.headers);
            data = { ...data, method: event.method, url: redactSidecarDiagnosticsUrl(event.url),
                headers: requestHeaders, requestHeaders,
                ...(event.resourceType ? { resourceType: event.resourceType } : {}),
                ...(event.hasPostData === undefined ? {} : { hasPostData: event.hasPostData }),
                ...(event.timestamp === undefined ? {} : { startedAtSeconds: event.timestamp }),
                ...(event.initiator ? { initiator: { ...event.initiator,
                    ...(event.initiator.url ? { url: redactSidecarDiagnosticsUrl(event.initiator.url) } : {}),
                    ...(event.initiator.stackFrames ? { stackFrames: event.initiator.stackFrames.map(source => ({ ...source,
                        ...(source.url ? { url: redactSidecarDiagnosticsUrl(source.url) } : {}) })) } : {}) } } : {}),
            };
            if (!previous || event.redirectResponse) kind = 'network.requestStarted';
            break;
        }
        case 'network.responseReceived':
            data = { ...data, ...responseData(event, headers) };
            if (kind !== 'network.finished' && kind !== 'network.failed') kind = 'network.response';
            break;
        case 'network.loadingFinished':
            kind = 'network.finished';
            if (event.encodedDataLength !== undefined) data.responseBytes = event.encodedDataLength;
            break;
        case 'network.loadingFailed':
            kind = 'network.failed';
            if (event.errorText !== undefined) data.errorText = event.errorText;
            if (event.blockedReason !== undefined) data.blockedReason = event.blockedReason;
            if (event.canceled !== undefined) data.canceled = event.canceled;
            if (event.url) data.url = redactSidecarDiagnosticsUrl(event.url);
            break;
        case 'network.requestExtraInfo':
            requestExtraInfo.push({ headers: headers(event.headers) });
            break;
        case 'network.responseExtraInfo':
            responseExtraInfo.push({ headers: headers(event.headers),
                ...(event.statusCode === undefined ? {} : { statusCode: event.statusCode }) });
            break;
    }
    if ('timestamp' in event && event.timestamp !== undefined) {
        data.timestamp = event.timestamp;
        if (typeof data.startedAtSeconds === 'number' && (kind === 'network.finished' || kind === 'network.failed')) {
            data.durationMs = (event.timestamp - data.startedAtSeconds) * 1000;
        }
    }
    // Re-project from the independent ExtraInfo streams, including arrivals before requestStarted.
    const hops = [...redirects, data];
    let requestIndex = 0;
    let responseIndex = 0;
    for (const hop of hops) {
        if (hop.hasExtraInfo === false) continue;
        if (hop.hasExtraInfo !== true && (hops.length > 1 || kind !== 'network.finished' && kind !== 'network.failed')) continue;
        const requestExtra = requestExtraInfo[requestIndex++];
        const responseExtra = responseExtraInfo[responseIndex++];
        if (requestExtra) hop.requestHeaders = { ...hop.requestHeaders as object, ...requestExtra.headers as object };
        if (responseExtra) {
            hop.responseHeaders = { ...hop.responseHeaders as object, ...responseExtra.headers as object };
            if (responseExtra.statusCode !== undefined) hop.statusCode = responseExtra.statusCode;
        }
    }
    if (redirects.length) data.redirects = redirects;
    if (requestExtraInfo.length) data.requestExtraInfo = requestExtraInfo;
    if (responseExtraInfo.length) data.responseExtraInfo = responseExtraInfo;
    data.incomplete = !data.method || !data.url || typeof data.startedAtSeconds !== 'number'
        || requestIndex < requestExtraInfo.length || responseIndex < responseExtraInfo.length;
    return BrowserDiagnosticEventV1Schema.parse({ ...common,
        eventId: `sidecar_network_${common.viewId}_${common.navigationGeneration}_${requestId}`,
        family: 'network', kind, data,
        redaction: { ...common.redaction, truncated },
    });
}
