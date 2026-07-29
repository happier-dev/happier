import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { BrowserDiagnosticsSnapshotV1 } from '@happier-dev/protocol';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';

function snapshotWithOwnerConsoleText(): BrowserDiagnosticsSnapshotV1 {
    return {
        v: 1,
        machineId: 'machine_1',
        generatedAt: 1_000,
        refreshState: 'idle',
        events: [
            {
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
                data: { level: 'log', argCount: 1, textAvailable: true, text: 'bearer sk-secret-123' },
                redaction: { level: 'none', queryRedacted: true, headersRedacted: true, truncated: false },
            },
        ],
        diagnostics: [],
    };
}

function createRegistrar(): { handlers: Map<string, (payload: unknown) => Promise<unknown>>; registrar: RpcHandlerRegistrar } {
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    return {
        handlers,
        registrar: {
            registerHandler(method, handler) {
                handlers.set(method, handler as (payload: unknown) => Promise<unknown>);
            },
        },
    };
}

describe('daemon browser diagnostics snapshot rpc handler', () => {
    it('serves daemon-owned browser diagnostics snapshots over machine rpc', async () => {
        const module = await import('./daemonBrowserDiagnosticsSnapshot').catch(() => null);

        expect(module?.registerDaemonBrowserDiagnosticsSnapshotHandler).toBeTypeOf('function');
        if (!module?.registerDaemonBrowserDiagnosticsSnapshotHandler) return;

        const snapshot: BrowserDiagnosticsSnapshotV1 = {
            v: 1,
            machineId: 'machine_1',
            generatedAt: 1_000,
            refreshState: 'idle',
            events: [],
            diagnostics: [],
        };
        const { handlers, registrar } = createRegistrar();
        module.registerDaemonBrowserDiagnosticsSnapshotHandler(registrar, {
            browserDiagnostics: {
                getSnapshot: async () => snapshot,
            },
        });

        const method = (RPC_METHODS as Record<string, string>).DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT;
        expect(method).toBe('daemon.browser.diagnostics.snapshot');
        await expect(handlers.get(method)?.({ machineId: 'machine_1' })).resolves.toEqual({
            protocolVersion: 1,
            snapshot,
        });
    });

    it('defaults the requesting party fail-closed to agent and reduces the snapshot to metadataOnly', async () => {
        const module = await import('./daemonBrowserDiagnosticsSnapshot').catch(() => null);

        expect(module?.registerDaemonBrowserDiagnosticsSnapshotHandler).toBeTypeOf('function');
        if (!module?.registerDaemonBrowserDiagnosticsSnapshotHandler) return;

        const snapshot = snapshotWithOwnerConsoleText();
        const { handlers, registrar } = createRegistrar();
        module.registerDaemonBrowserDiagnosticsSnapshotHandler(registrar, {
            browserDiagnostics: { getSnapshot: async () => snapshot },
        });

        const raw = await handlers.get(RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT)?.({ machineId: 'machine_1' });
        const response = raw as { snapshot: BrowserDiagnosticsSnapshotV1 };
        const event = response.snapshot.events[0];
        expect(event.redaction.level).toBe('metadataOnly');
        expect(event.data?.text).toBeUndefined();
        expect(event.data?.level).toBe('log');
    });

    it('serves full owner fidelity when the resolver verifies the owning viewer (none)', async () => {
        const module = await import('./daemonBrowserDiagnosticsSnapshot').catch(() => null);

        expect(module?.registerDaemonBrowserDiagnosticsSnapshotHandler).toBeTypeOf('function');
        if (!module?.registerDaemonBrowserDiagnosticsSnapshotHandler) return;

        const snapshot = snapshotWithOwnerConsoleText();
        const { handlers, registrar } = createRegistrar();
        module.registerDaemonBrowserDiagnosticsSnapshotHandler(registrar, {
            browserDiagnostics: { getSnapshot: async () => snapshot },
            resolveViewerParty: () => 'owner',
        });

        const raw = await handlers.get(RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT)?.({ machineId: 'machine_1' });
        const response = raw as { snapshot: BrowserDiagnosticsSnapshotV1 };
        const event = response.snapshot.events[0];
        expect(event.redaction.level).toBe('none');
        expect(event.data?.text).toBe('bearer sk-secret-123');
    });

    it('fails closed when the browser diagnostics runtime is unavailable', async () => {
        const module = await import('./daemonBrowserDiagnosticsSnapshot').catch(() => null);

        expect(module?.registerDaemonBrowserDiagnosticsSnapshotHandler).toBeTypeOf('function');
        if (!module?.registerDaemonBrowserDiagnosticsSnapshotHandler) return;

        const { handlers, registrar } = createRegistrar();
        module.registerDaemonBrowserDiagnosticsSnapshotHandler(registrar);

        await expect(handlers.get(RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT)?.({
            machineId: 'machine_1',
        })).rejects.toThrow('Browser diagnostics runtime is unavailable');
    });
});
