import { describe, expect, it } from 'vitest';

describe('daemon browser sidecar diagnostics publication boundary', () => {
    it('publishes mapped diagnostics from the admitted source', async () => {
        const mod = await import('./publish');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const published: unknown[] = [];
        const publisher = mod.createSidecarDiagnosticsPublisher({
            publish: (event) => published.push(event),
        });

        const allowed = publisher.publishCdpEvent({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 1,
            capturedAtMs: 10_000,
            eventOrdinal: 2,
            rawCdpSessionId: 'cdp_session_secret',
            debuggerUrl: 'ws://127.0.0.1/devtools/page/debugger-secret',
            event: {
                kind: 'network.requestWillBeSent',
                requestId: 'cdp_request_secret',
                method: 'GET',
                url: 'https://example.test/api?token=secret',
                headers: { Authorization: 'Bearer secret', Accept: 'application/json' },
            },
        });

        expect(allowed).toMatchObject({ status: 'published', published: true });
        expect(published).toHaveLength(1);
        expect(JSON.stringify(published)).not.toContain('cdp_request_secret');
        expect(JSON.stringify(published)).not.toContain('cdp_session_secret');
        expect(JSON.stringify(published)).not.toContain('debugger-secret');
        expect(JSON.stringify(published)).not.toContain('Bearer secret');
        expect(JSON.stringify(published)).not.toContain('token=secret');
    });

    it('preserves runtime unavailable reasons from the source owner', async () => {
        const mod = await import('./publish');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const published: unknown[] = [];
        const publisher = mod.createSidecarDiagnosticsPublisher({
            publish: (event) => published.push(event),
        });

        const base = {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 2,
            capturedAtMs: 20_000,
            eventOrdinal: 1,
            family: 'network' as const,
        };

        expect(publisher.publishUnavailable({ ...base, reason: 'target_detached' }))
            .toMatchObject({ status: 'published', reason: 'target_detached' });
        expect(publisher.publishUnavailable({ ...base, eventOrdinal: 2, reason: 'page_crashed' }))
            .toMatchObject({ status: 'published', reason: 'page_crashed' });
        expect(publisher.publishUnavailable({ ...base, eventOrdinal: 3, reason: 'unsupported_fidelity' }))
            .toMatchObject({ status: 'published', reason: 'unsupported_fidelity' });

        expect(published.map((event) => (event as { unavailableReason: string }).unavailableReason)).toEqual([
            'target_detached',
            'page_crashed',
            'unsupported_fidelity',
        ]);
    });
});
