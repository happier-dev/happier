import {
    BrowserDiagnosticEventV1Schema,
    stripBrowserDiagnosticUrlValues,
    type BrowserDiagnosticEventV1,
    type BrowserDiagnosticUnavailableReasonV1,
} from '@happier-dev/protocol';

type NativeWebViewDiagnosticBaseInput = Readonly<{
    eventId: string;
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    capturedAtMs: number;
}>;

export function createNativeWebViewPageInfoDiagnosticEvent(
    input: NativeWebViewDiagnosticBaseInput & Readonly<{
        url: string;
        loading: boolean;
        title?: string;
    }>,
): BrowserDiagnosticEventV1 {
    return BrowserDiagnosticEventV1Schema.parse({
        v: 1,
        eventId: input.eventId,
        browserSessionId: input.browserSessionId,
        viewId: input.viewId,
        navigationGeneration: input.navigationGeneration,
        capturedAtMs: input.capturedAtMs,
        family: 'pageInfo',
        kind: 'pageInfo.snapshot',
        fidelity: 'nativeCallback',
        trusted: true,
        data: {
            url: stripBrowserDiagnosticUrlValues(input.url),
            loading: input.loading,
            ...(input.title ? { title: input.title } : {}),
        },
        redaction: {
            level: 'metadataOnly',
        },
    });
}

export function createNativeWebViewUnavailableDiagnosticEvent(
    input: NativeWebViewDiagnosticBaseInput & Readonly<{
        unavailableReason: BrowserDiagnosticUnavailableReasonV1;
        errorCode?: string;
    }>,
): BrowserDiagnosticEventV1 {
    return BrowserDiagnosticEventV1Schema.parse({
        v: 1,
        eventId: input.eventId,
        browserSessionId: input.browserSessionId,
        viewId: input.viewId,
        navigationGeneration: input.navigationGeneration,
        capturedAtMs: input.capturedAtMs,
        family: 'pageInfo',
        kind: 'diagnostics.unavailable',
        fidelity: 'nativeCallback',
        trusted: true,
        data: {
            ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        },
        redaction: {
            level: 'metadataOnly',
        },
        unavailableReason: input.unavailableReason,
    });
}
