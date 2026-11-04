import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { BrowserDiagnosticsSnapshotV1 } from '@happier-dev/protocol';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';

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

function createRegistrar(): { handlers: Map<string, RpcHandler<unknown, unknown>>; registrar: RpcHandlerRegistrar } {
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    return {
        handlers,
        registrar: {
            registerHandler(method, handler) {
                // Erase the registrar's generic at this RPC boundary; the real handler parses input.
                handlers.set(method, handler as RpcHandler<unknown, unknown>);
            },
        },
    };
}

describe('daemon browser diagnostics snapshot rpc handler', () => {
    it('reads only the requested view and keeps viewer redaction on the pushed path', async () => {
        const { createBrowserDiagnosticsDaemonStore } = await import('@/daemon/browser/diagnostics/store');
        const { createBrowserDiagnosticsRoutes } = await import('@/daemon/browser/diagnostics/routes');
        const { registerDaemonBrowserDiagnosticsSnapshotHandler } = await import('./daemonBrowserDiagnosticsSnapshot');
        const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine_1' });
        const event = snapshotWithOwnerConsoleText().events[0];
        store.publishEvent({ ...event, browserSessionId: 'other' });
        for (let n = 0; n < 1_000; n++) store.publishEvent({ ...event, eventId: `history-${n}`, capturedAtMs: n });
        let wholeMachineReads = 0;
        const routes = createBrowserDiagnosticsRoutes({ store: { ...store, getSnapshot() {
            wholeMachineReads++; return store.getSnapshot();
        } } });
        const { handlers, registrar } = createRegistrar();
        registerDaemonBrowserDiagnosticsSnapshotHandler(registrar, { browserDiagnostics: routes });
        const read = handlers.get(RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT)!;
        const request = { machineId: 'machine_1', view: { browserSessionId: event.browserSessionId,
            viewId: event.viewId, navigationGeneration: event.navigationGeneration } };
        const initial = await read(request) as { revision: number; snapshot: BrowserDiagnosticsSnapshotV1 };
        expect(initial.snapshot.events).toHaveLength(1_000);
        const pushed = read({ ...request, sinceRevision: initial.revision });
        store.publishEvent({ ...event, capturedAtMs: 1_001 });
        const response = await pushed as { snapshot: BrowserDiagnosticsSnapshotV1 };
        expect(response.snapshot.events).toHaveLength(1);
        expect(response.snapshot.events).toEqual([expect.objectContaining({ eventId: event.eventId,
            redaction: expect.objectContaining({ level: 'metadataOnly' }) })]);
        expect(response.snapshot.events[0].data.text).toBeUndefined();
        const reconnected = await read(request) as { snapshot: BrowserDiagnosticsSnapshotV1 };
        expect(reconnected.snapshot.events).toHaveLength(1_000);
        expect(wholeMachineReads).toBe(0);
    });
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
                readViewSnapshot: async () => ({ snapshot, revision: 0 }),
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
            browserDiagnostics: { getSnapshot: async () => snapshot, readViewSnapshot: async () => ({ snapshot, revision: 0 }) },
        });

        const raw = await handlers.get(RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT)?.({ machineId: 'machine_1' });
        const response = raw as { snapshot: BrowserDiagnosticsSnapshotV1 };
        const event = response.snapshot.events[0];
        expect(event.redaction.level).toBe('metadataOnly');
        expect(event.data?.text).toBeUndefined();
        expect(event.data?.level).toBe('log');
    });

    it('serves person fidelity when the transport verifies present-user authority', async () => {
        const module = await import('./daemonBrowserDiagnosticsSnapshot').catch(() => null);

        expect(module?.registerDaemonBrowserDiagnosticsSnapshotHandler).toBeTypeOf('function');
        if (!module?.registerDaemonBrowserDiagnosticsSnapshotHandler) return;

        const snapshot = snapshotWithOwnerConsoleText();
        const { handlers, registrar } = createRegistrar();
        module.registerDaemonBrowserDiagnosticsSnapshotHandler(registrar, {
            browserDiagnostics: { getSnapshot: async () => snapshot, readViewSnapshot: async () => ({ snapshot, revision: 0 }) },
        });

        const raw = await handlers.get(RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT)?.({ machineId: 'machine_1' },
            { callerAuthority: 'present_user', signal: new AbortController().signal });
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
