import { describe, expect, it } from 'vitest';

describe('daemon browser sidecar diagnostics mapping', () => {
    it('maps CDP network requests through cdp fidelity while redacting unsafe URL and header material', async () => {
        const mod = await import('./mapEvents');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const event = mod.mapSidecarCdpDiagnosticEvent({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 4,
            capturedAtMs: 1_900_000,
            eventOrdinal: 7,
            rawCdpSessionId: 'cdp_session_secret',
            debuggerUrl: 'ws://127.0.0.1/devtools/page/debugger-secret',
            event: {
                kind: 'network.requestWillBeSent',
                requestId: 'cdp_request_secret',
                method: 'POST',
                url: 'https://example.test/api/search?ok=1&token=secret&api_key=secret',
                headers: {
                    Authorization: 'Bearer secret',
                    Cookie: 'sid=secret',
                    'Content-Type': 'application/json',
                    'X-Request-Id': 'request-123',
                    'X-Api-Key': 'secret',
                },
                resourceType: 'fetch',
            },
        });

        expect(event).toMatchObject({
            v: 1,
            eventId: 'sidecar_diag_view_1_4_7',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 4,
            capturedAtMs: 1_900_000,
            family: 'network',
            kind: 'network.requestStarted',
            fidelity: 'cdp',
            trusted: true,
            redaction: {
                level: 'metadataOnly',
                queryRedacted: true,
                headersRedacted: true,
            },
        });
        expect(event.data).toMatchObject({
            requestId: expect.stringMatching(/^sidecar_request_[a-f0-9]{12}$/),
            method: 'POST',
            resourceType: 'fetch',
            url: {
                origin: 'https://example.test',
                path: '/api/search',
                queryKeys: ['ok'],
            },
            headers: {
                'content-type': 'application/json',
                'x-request-id': 'request-123',
            },
        });
        expect(JSON.stringify(event)).not.toContain('secret');
        expect(JSON.stringify(event)).not.toContain('cdp_request_secret');
        expect(JSON.stringify(event)).not.toContain('cdp_session_secret');
        expect(JSON.stringify(event)).not.toContain('debugger-secret');
    });

    it('maps WebSocket summaries without exposing frame payloads or raw CDP socket ids', async () => {
        const mod = await import('./mapEvents');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const event = mod.mapSidecarCdpDiagnosticEvent({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 8,
            capturedAtMs: 2_000_000,
            eventOrdinal: 2,
            event: {
                kind: 'network.webSocketSummary',
                requestId: 'cdp_socket_secret',
                url: 'wss://example.test/socket?channel=dev&grantToken=secret',
                framesSent: 3,
                framesReceived: 5,
                bytesSent: 128,
                bytesReceived: 512,
                payloadPreview: 'Bearer secret payload',
            },
        });

        expect(event).toMatchObject({
            family: 'network',
            kind: 'network.websocketSummary',
            fidelity: 'cdp',
            trusted: true,
            data: {
                socketId: expect.stringMatching(/^sidecar_socket_[a-f0-9]{12}$/),
                framesSent: 3,
                framesReceived: 5,
                bytesSent: 128,
                bytesReceived: 512,
                url: {
                    origin: 'wss://example.test',
                    path: '/socket',
                    queryKeys: ['channel'],
                },
            },
        });
        expect(JSON.stringify(event)).not.toContain('payload');
        expect(JSON.stringify(event)).not.toContain('cdp_socket_secret');
        expect(JSON.stringify(event)).not.toContain('secret');
    });

    it('maps CDP eval object results to daemon-owned remote object references', async () => {
        const mod = await import('./mapEvents');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const result = mod.mapSidecarCdpEvalResult({
            evalRequestId: 'eval_1',
            viewId: 'view_1',
            navigationGeneration: 9,
            rawCdpObjectId: '{"injectedScriptId":1,"id":42}',
            className: 'HTMLDivElement',
            description: 'div#root',
            preview: [{ name: 'id', valuePreview: 'root', truncated: false }],
        });

        expect(result).toMatchObject({
            v: 1,
            evalRequestId: 'eval_1',
            viewId: 'view_1',
            navigationGeneration: 9,
            status: 'completed',
            tier: 'cdp',
            audited: true,
            result: {
                type: 'object',
                objectId: expect.stringMatching(/^sidecar_object_[a-f0-9]{12}$/),
                className: 'HTMLDivElement',
                description: 'div#root',
                preview: [{ name: 'id', valuePreview: 'root', truncated: false }],
            },
        });
        expect(JSON.stringify(result)).not.toContain('injectedScriptId');
    });

    it('maps console entries without publishing raw console argument text', async () => {
        const mod = await import('./mapEvents');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const event = mod.mapSidecarCdpDiagnosticEvent({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 10,
            capturedAtMs: 2_050_000,
            eventOrdinal: 4,
            event: {
                kind: 'runtime.consoleEntry',
                level: 'error',
                text: 'token=secret should stay daemon-private',
                argCount: 2,
            },
        });

        expect(event).toMatchObject({
            family: 'console',
            kind: 'console.entry',
            data: {
                level: 'error',
                argCount: 2,
            },
            redaction: {
                level: 'valuesRedacted',
            },
        });
        expect(JSON.stringify(event)).not.toContain('secret');
        expect(JSON.stringify(event)).not.toContain('token');
    });

    it('maps page errors without publishing raw message or stack text', async () => {
        const mod = await import('./mapEvents');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const event = mod.mapSidecarCdpDiagnosticEvent({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 10,
            capturedAtMs: 2_050_000,
            eventOrdinal: 5,
            event: {
                kind: 'runtime.exceptionThrown',
                message: 'password=secret',
                stack: 'Error: password=secret\n    at app.js:1',
            },
        });

        expect(event).toMatchObject({
            family: 'pageError',
            kind: 'pageError.thrown',
            data: {
                messageAvailable: true,
                stackAvailable: true,
            },
            redaction: {
                level: 'valuesRedacted',
            },
        });
        expect(JSON.stringify(event)).not.toContain('secret');
        expect(JSON.stringify(event)).not.toContain('password');
    });

    it('emits explicit unavailable diagnostics for detached or policy-denied sidecar targets', async () => {
        const mod = await import('./mapEvents');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const event = mod.mapSidecarCdpDiagnosticUnavailable({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 11,
            capturedAtMs: 2_100_000,
            eventOrdinal: 3,
            family: 'network',
            reason: 'target_detached',
        });

        expect(event).toMatchObject({
            family: 'network',
            kind: 'diagnostics.unavailable',
            fidelity: 'unavailable',
            trusted: true,
            unavailableReason: 'target_detached',
            redaction: { level: 'unavailable' },
        });
    });
});
