import { describe, expect, it } from 'vitest';

type NativeWebViewDiagnosticsModule = Readonly<{
    createNativeWebViewPageInfoDiagnosticEvent?: (input: Readonly<{
        eventId: string;
        browserSessionId: string;
        viewId: string;
        navigationGeneration: number;
        capturedAtMs: number;
        url: string;
        loading: boolean;
        title?: string;
    }>) => Record<string, unknown>;
    createNativeWebViewUnavailableDiagnosticEvent?: (input: Readonly<{
        eventId: string;
        browserSessionId: string;
        viewId: string;
        navigationGeneration: number;
        capturedAtMs: number;
        unavailableReason: string;
        errorCode?: string;
    }>) => Record<string, unknown>;
}>;

async function loadNativeWebViewDiagnosticsModule(): Promise<NativeWebViewDiagnosticsModule | null> {
    const path = './nativeWebView';
    return import(path).catch(() => null) as Promise<NativeWebViewDiagnosticsModule | null>;
}

describe('native WebView browser diagnostics callbacks', () => {
    it('creates trusted nativeCallback page-info diagnostics without page payloads', async () => {
        const mod = await loadNativeWebViewDiagnosticsModule();

        expect(mod?.createNativeWebViewPageInfoDiagnosticEvent).toBeTypeOf('function');
        if (!mod?.createNativeWebViewPageInfoDiagnosticEvent) return;

        expect(mod.createNativeWebViewPageInfoDiagnosticEvent({
            eventId: 'evt_page_1',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 4,
            capturedAtMs: 2_000,
            url: 'https://example.test/dashboard',
            loading: false,
            title: 'Dashboard',
        })).toMatchObject({
            v: 1,
            eventId: 'evt_page_1',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 4,
            capturedAtMs: 2_000,
            family: 'pageInfo',
            kind: 'pageInfo.snapshot',
            fidelity: 'nativeCallback',
            trusted: true,
            data: {
                url: 'https://example.test/dashboard',
                loading: false,
                title: 'Dashboard',
            },
            redaction: {
                level: 'metadataOnly',
            },
        });
    });

    it('strips query and fragment values from nativeCallback page-info URLs', async () => {
        const mod = await loadNativeWebViewDiagnosticsModule();

        expect(mod?.createNativeWebViewPageInfoDiagnosticEvent).toBeTypeOf('function');
        if (!mod?.createNativeWebViewPageInfoDiagnosticEvent) return;

        expect(mod.createNativeWebViewPageInfoDiagnosticEvent({
            eventId: 'evt_page_redacted_1',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 4,
            capturedAtMs: 2_000,
            url: 'https://example.test/dashboard?token=secret#section',
            loading: false,
        })).toMatchObject({
            data: {
                url: 'https://example.test/dashboard',
            },
        });
    });

    it('redacts token-shaped path segments from nativeCallback page-info URLs', async () => {
        const mod = await loadNativeWebViewDiagnosticsModule();

        expect(mod?.createNativeWebViewPageInfoDiagnosticEvent).toBeTypeOf('function');
        if (!mod?.createNativeWebViewPageInfoDiagnosticEvent) return;

        const event = mod.createNativeWebViewPageInfoDiagnosticEvent({
            eventId: 'evt_page_path_redacted_1',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 4,
            capturedAtMs: 2_000,
            url: 'https://example.test/reset/tok9f8e7d6c5b4a3210ffeeddcc?token=secret#section',
            loading: false,
        });

        expect(event).toMatchObject({
            data: {
                url: 'https://example.test/reset/:redacted',
            },
        });
        expect(JSON.stringify(event)).not.toContain('tok9f8e7d6c5b4a3210ffeeddcc');
        expect(JSON.stringify(event)).not.toContain('token=secret');
    });

    it('creates explicit nativeCallback unavailable diagnostics for WebView load failures', async () => {
        const mod = await loadNativeWebViewDiagnosticsModule();

        expect(mod?.createNativeWebViewUnavailableDiagnosticEvent).toBeTypeOf('function');
        if (!mod?.createNativeWebViewUnavailableDiagnosticEvent) return;

        expect(mod.createNativeWebViewUnavailableDiagnosticEvent({
            eventId: 'evt_unavailable_1',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 4,
            capturedAtMs: 2_100,
            unavailableReason: 'collector_unavailable',
            errorCode: 'webview_load_failed',
        })).toMatchObject({
            family: 'pageInfo',
            kind: 'diagnostics.unavailable',
            fidelity: 'nativeCallback',
            trusted: true,
            unavailableReason: 'collector_unavailable',
            data: {
                errorCode: 'webview_load_failed',
            },
        });
    });
});
