import { describe, expect, it } from 'vitest';

import type { BrowserDiagnosticEventV1, BrowserDiagnosticsSnapshotV1 } from '@happier-dev/protocol';

import {
    browserDiagnosticsEgressDestinationForViewer,
    redactBrowserDiagnosticsSnapshotForViewer,
} from './snapshotEgress';

function injectedConsoleEvent(): BrowserDiagnosticEventV1 {
    return {
        v: 1,
        eventId: 'event_console',
        browserSessionId: 'session_1',
        viewId: 'view_1',
        navigationGeneration: 0,
        capturedAtMs: 10,
        family: 'console',
        kind: 'console.entry',
        fidelity: 'injectedPage',
        trusted: false,
        collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
        // The owner-only length-capped console rendering plus its allowlisted metadata.
        data: { level: 'log', argCount: 1, textAvailable: true, text: 'bearer sk-secret-123' },
        redaction: { level: 'none', queryRedacted: true, headersRedacted: true, truncated: false },
    };
}

function cdpNetworkEvent(): BrowserDiagnosticEventV1 {
    return {
        v: 1,
        eventId: 'event_network',
        browserSessionId: 'session_1',
        viewId: 'view_1',
        navigationGeneration: 0,
        capturedAtMs: 20,
        family: 'network',
        kind: 'network.websocketOpened',
        fidelity: 'cdp',
        trusted: true,
        // `protocol` is a credential-egress vector that must never survive, even for the owner.
        data: { socketId: 'ws_1', url: 'wss://example.test/socket', protocol: 'chat, sk-leak-token' },
        redaction: { level: 'none', queryRedacted: true, headersRedacted: true, truncated: false },
    };
}

function injectedOwnerNetworkEvent(): BrowserDiagnosticEventV1 {
    return {
        v: 1,
        eventId: 'event_owner_network',
        browserSessionId: 'session_1',
        viewId: 'view_1',
        navigationGeneration: 0,
        capturedAtMs: 30,
        family: 'network',
        kind: 'network.response',
        fidelity: 'injectedPage',
        trusted: false,
        collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
        data: {
            requestId: 'req_1',
            method: 'POST',
            url: 'https://example.test/api',
            statusCode: 201,
            requestHeaders: { 'content-type': 'application/json' },
            responseHeaders: { 'x-request-id': 'res-1' },
            requestBodyText: 'agent must not see request body',
            responseBodyText: 'agent must not see response body',
        },
        redaction: { level: 'none', queryRedacted: true, headersRedacted: false, truncated: false },
    };
}

function injectedOwnerStorageEvent(): BrowserDiagnosticEventV1 {
    return {
        v: 1,
        eventId: 'event_owner_storage',
        browserSessionId: 'session_1',
        viewId: 'view_1',
        navigationGeneration: 0,
        capturedAtMs: 40,
        family: 'storage',
        kind: 'storage.keyInventory',
        fidelity: 'injectedPage',
        trusted: false,
        collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
        data: {
            storageType: 'localStorage',
            keyCount: 1,
            keys: ['theme'],
            keysTruncated: false,
            entries: [{ key: 'theme', value: 'agent must not see storage value', valueTruncated: false }],
        },
        redaction: { level: 'none', queryRedacted: true, headersRedacted: true, truncated: false },
    };
}

function snapshotWith(events: readonly BrowserDiagnosticEventV1[]): BrowserDiagnosticsSnapshotV1 {
    return {
        v: 1,
        machineId: 'machine_1',
        generatedAt: 100,
        refreshState: 'idle',
        events: [...events],
        diagnostics: [],
    };
}

describe('browser diagnostics snapshot egress (X1 viewer-identity-gated fidelity)', () => {
    it('maps the viewer party onto the egress destination', () => {
        expect(browserDiagnosticsEgressDestinationForViewer('owner')).toBe('localOwner');
        expect(browserDiagnosticsEgressDestinationForViewer('agent')).toBe('remoteSnapshot');
    });

    it('serves full owner fidelity to the verified owning viewer (none, owner-only console text kept)', () => {
        const redacted = redactBrowserDiagnosticsSnapshotForViewer(
            snapshotWith([injectedConsoleEvent()]),
            'owner',
        );

        const event = redacted.events[0];
        expect(event.redaction.level).toBe('none');
        expect(event.data?.text).toBe('bearer sk-secret-123');
        expect(event.data?.textAvailable).toBe(true);
    });

    it('reduces an agent/remote viewer to metadataOnly and strips the owner-only console text', () => {
        const redacted = redactBrowserDiagnosticsSnapshotForViewer(
            snapshotWith([injectedConsoleEvent()]),
            'agent',
        );

        const event = redacted.events[0];
        expect(event.redaction.level).toBe('metadataOnly');
        // Owner-only value-bearing field is dropped for the non-owner viewer...
        expect(event.data?.text).toBeUndefined();
        // ...while the allowlisted metadata survives.
        expect(event.data?.level).toBe('log');
        expect(event.data?.argCount).toBe(1);
        expect(event.data?.textAvailable).toBe(true);
    });

    it('strips owner-only network and storage values from agent/remote snapshots', () => {
        const redacted = redactBrowserDiagnosticsSnapshotForViewer(
            snapshotWith([injectedOwnerNetworkEvent(), injectedOwnerStorageEvent()]),
            'agent',
        );

        const serialized = JSON.stringify(redacted);
        expect(serialized).not.toContain('agent must not see');
        expect(redacted.events[0].data?.requestHeaders).toBeUndefined();
        expect(redacted.events[0].data?.responseBodyText).toBeUndefined();
        expect(redacted.events[1].data?.entries).toBeUndefined();
        expect(redacted.events[0].data?.method).toBe('POST');
        expect(redacted.events[1].data?.keys).toEqual(['theme']);
    });

    it('always strips credential-egress vectors even for the verified owner', () => {
        const ownerView = redactBrowserDiagnosticsSnapshotForViewer(snapshotWith([cdpNetworkEvent()]), 'owner');
        const agentView = redactBrowserDiagnosticsSnapshotForViewer(snapshotWith([cdpNetworkEvent()]), 'agent');

        // The WS subprotocol smuggling vector is dropped at every destination.
        expect(ownerView.events[0].data?.protocol).toBeUndefined();
        expect(agentView.events[0].data?.protocol).toBeUndefined();
        // Structural cdp metadata survives; the per-party level still differs.
        expect(ownerView.events[0].data?.socketId).toBe('ws_1');
        expect(ownerView.events[0].redaction.level).toBe('none');
        expect(agentView.events[0].redaction.level).toBe('metadataOnly');
    });
});
