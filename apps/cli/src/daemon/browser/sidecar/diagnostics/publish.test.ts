import { describe, expect, it } from 'vitest';

describe('daemon browser sidecar diagnostics publication boundary', () => {
    it('publishes mapped sidecar CDP diagnostics only for the owning account', async () => {
        const mod = await import('./publish');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const published: unknown[] = [];
        const publisher = mod.createSidecarDiagnosticsPublisher({
            publish: (event) => published.push(event),
            ownerAccountId: 'account_owner',
        });

        const denied = publisher.publishCdpEvent({
            requesterAccountId: 'account_other',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 1,
            capturedAtMs: 10_000,
            eventOrdinal: 1,
            featureEnabled: true,
            policyAllowed: true,
            runtimeAvailable: true,
            event: {
                kind: 'network.requestWillBeSent',
                requestId: 'cdp_request_secret',
                method: 'GET',
                url: 'https://example.test/api?token=secret',
                headers: { Authorization: 'Bearer secret' },
            },
        });

        expect(denied).toEqual({
            status: 'denied',
            reason: 'not_owner',
            published: false,
        });
        expect(published).toEqual([]);

        const allowed = publisher.publishCdpEvent({
            requesterAccountId: 'account_owner',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 1,
            capturedAtMs: 10_000,
            eventOrdinal: 2,
            featureEnabled: true,
            policyAllowed: true,
            runtimeAvailable: true,
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

    it('publishes explicit unavailable diagnostics when feature, policy, or runtime gates fail', async () => {
        const mod = await import('./publish');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const published: unknown[] = [];
        const publisher = mod.createSidecarDiagnosticsPublisher({
            publish: (event) => published.push(event),
            ownerAccountId: 'account_owner',
        });

        const base = {
            requesterAccountId: 'account_owner',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 2,
            capturedAtMs: 20_000,
            eventOrdinal: 1,
            family: 'network' as const,
        };

        expect(publisher.publishUnavailable({ ...base, featureEnabled: false, policyAllowed: true, runtimeAvailable: true }))
            .toMatchObject({ status: 'published', reason: 'feature_disabled' });
        expect(publisher.publishUnavailable({ ...base, eventOrdinal: 2, featureEnabled: true, policyAllowed: false, runtimeAvailable: true }))
            .toMatchObject({ status: 'published', reason: 'policy_denied' });
        expect(publisher.publishUnavailable({ ...base, eventOrdinal: 3, featureEnabled: true, policyAllowed: true, runtimeAvailable: false }))
            .toMatchObject({ status: 'published', reason: 'adapter_unavailable' });
        expect(publisher.publishUnavailable({ ...base, eventOrdinal: 4, featureEnabled: true, policyAllowed: true, runtimeAvailable: true }))
            .toMatchObject({ status: 'published', reason: 'adapter_unavailable' });

        expect(published).toHaveLength(4);
        expect(published.map((event) => (event as { unavailableReason: string }).unavailableReason)).toEqual([
            'feature_disabled',
            'policy_denied',
            'adapter_unavailable',
            'adapter_unavailable',
        ]);
    });

    it('preserves runtime unavailable reasons after feature and policy gates pass', async () => {
        const mod = await import('./publish');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const published: unknown[] = [];
        const publisher = mod.createSidecarDiagnosticsPublisher({
            publish: (event) => published.push(event),
            ownerAccountId: 'account_owner',
        });

        const base = {
            requesterAccountId: 'account_owner',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 2,
            capturedAtMs: 20_000,
            eventOrdinal: 1,
            family: 'network' as const,
            featureEnabled: true,
            policyAllowed: true,
            runtimeAvailable: true,
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
