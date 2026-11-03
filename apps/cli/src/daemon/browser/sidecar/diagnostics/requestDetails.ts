import {
    BrowserDiagnosticsCookieV1Schema,
    type BrowserDiagnosticsCookieExtraInfoV1,
    type BrowserDiagnosticsCookieV1,
    type BrowserDiagnosticsRequestDetailV1,
} from '@happier-dev/protocol/browser/diagnostics/v1';
import type { BrowserDiagnosticsDaemonStore, BrowserDiagnosticsPrivateNetworkRequest } from '../../diagnostics/store';
import type { BrowserSidecarCdpEventNotification, BrowserSidecarCdpPageHandle } from '../controlAdapter';

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cookies(value: unknown): BrowserDiagnosticsCookieV1[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap(entry => {
        const outer = record(entry);
        const raw = { ...record(outer.cookie), blockedReasons: outer.blockedReasons ?? [],
            ...(typeof outer.cookieLine === 'string' ? { cookieLine: outer.cookieLine } : {}),
            ...(typeof outer.exemptionReason === 'string' ? { exemptionReason: outer.exemptionReason } : {}) };
        const result = BrowserDiagnosticsCookieV1Schema.safeParse(Object.fromEntries(
            Object.keys(BrowserDiagnosticsCookieV1Schema.shape).filter(key => key in raw).map(key => [key, record(raw)[key]])));
        return result.success ? [result.data] : [];
    });
}

/** Source-private ExtraInfo: CDP pushes it already; the person fetches it only on selection.
 * Keep it beside the existing ring record, never inside event.data or an error/log payload.
 */
export function capturePrivateNetworkRequest(notification: BrowserSidecarCdpEventNotification): BrowserDiagnosticsPrivateNetworkRequest | undefined {
    const params = notification.params ?? {};
    if (!notification.method.startsWith('Network.') || typeof params.requestId !== 'string') return undefined;
    const requestId = params.requestId;
    if (notification.method !== 'Network.requestWillBeSentExtraInfo' && notification.method !== 'Network.responseReceivedExtraInfo') return { requestId };
    const headers = record(params.headers);
    const header = (name: string) => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
    const cookie = header('cookie');
    const setCookie = header('set-cookie');
    const extra: BrowserDiagnosticsCookieExtraInfoV1 = {
        cookies: [...cookies(params.associatedCookies), ...cookies(params.blockedCookies), ...cookies(params.exemptedCookies)],
        ...(typeof cookie === 'string' ? { cookieHeader: cookie } : {}),
        ...(typeof setCookie === 'string' ? { setCookieHeaders: setCookie.split('\n') }
            : Array.isArray(setCookie) ? { setCookieHeaders: setCookie.filter((line): line is string => typeof line === 'string') } : {}),
    };
    return { requestId, ...(notification.method === 'Network.requestWillBeSentExtraInfo'
        ? { requestExtraInfo: [extra] } : { responseExtraInfo: [extra] }) };
}

export type BrowserDiagnosticsRequestDetailInput = Readonly<{
    browserSessionId: string; viewId: string; navigationGeneration: number; requestId: string;
}>;

export async function readSidecarRequestDetail(input: BrowserDiagnosticsRequestDetailInput, deps: Readonly<{
    store: Pick<BrowserDiagnosticsDaemonStore, 'getPrivateNetworkRequest'>;
    resolvePageHandle(view: Readonly<{ browserSessionId: string; viewId: string }>): BrowserSidecarCdpPageHandle | null;
    dispatchPageCommand(input: BrowserSidecarCdpPageHandle & Readonly<{ method: string; params?: Record<string, unknown> }>): Promise<unknown>;
}>): Promise<BrowserDiagnosticsRequestDetailV1> {
    const retained = deps.store.getPrivateNetworkRequest(input);
    if (!retained) return { status: 'unavailable', reason: 'request_evicted' };
    const handle = deps.resolvePageHandle(input);
    if (!handle) return { status: 'unavailable', reason: 'page_unavailable' };
    const { event, privateRequest } = retained;
    type Body = Extract<BrowserDiagnosticsRequestDetailV1, { status: 'available' }>['requestBody'];
    const body = async (method: string, field: string): Promise<Body> => {
        try {
            const result = record(await deps.dispatchPageCommand({ ...handle, method, params: { requestId: privateRequest.requestId } }));
            if (typeof result[field] !== 'string') return { status: 'unavailable', reason: 'body_unavailable' };
            return { status: 'available', text: result[field], encoding: result.base64Encoded === true ? 'base64' : 'utf8' };
        } catch {
            // CDP errors may contain page content; only this stable cause crosses the boundary.
            return { status: 'unavailable', reason: 'body_unavailable' };
        }
    };
    const requestBody: Body = event.data.hasPostData === true
        ? await body('Network.getRequestPostData', 'postData') : { status: 'unavailable', reason: 'not_captured' };
    const responseBody: Body = event.kind === 'network.finished'
        ? await body('Network.getResponseBody', 'body') : { status: 'unavailable', reason: 'not_finished' };
    return { status: 'available', requestId: input.requestId, requestBody, responseBody,
        requestExtraInfo: [...privateRequest.requestExtraInfo ?? []], responseExtraInfo: [...privateRequest.responseExtraInfo ?? []] };
}
