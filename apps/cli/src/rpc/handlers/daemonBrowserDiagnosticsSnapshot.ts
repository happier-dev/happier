import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    DaemonBrowserDiagnosticsSnapshotRequestV1Schema,
    DaemonBrowserDiagnosticsSnapshotResponseV1Schema,
    type DaemonBrowserDiagnosticsSnapshotRequestV1,
    type DaemonBrowserDiagnosticsSnapshotResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { BrowserDiagnosticsRoutes } from '@/daemon/browser/diagnostics/routes';
import {
    redactBrowserDiagnosticsSnapshotForViewer,
    type BrowserDiagnosticsViewerParty,
} from '@/daemon/browser/diagnostics/snapshotEgress';

export type DaemonBrowserDiagnosticsSnapshotHandlerOptions = Readonly<{
    browserDiagnostics?: BrowserDiagnosticsRoutes | null;
    /**
     * Resolves the requesting party's identity for the viewer-identity-gated egress fidelity (X1).
     * The cross-device snapshot RPC is, by transport, a cross-device egress; it therefore defaults
     * fail-closed to `'agent'` (metadata-only). A verified local-owner control plane may supply a
     * resolver that returns `'owner'` to surface full owner fidelity — owner-full fidelity is never
     * emitted for any party that is not the resolved, verified owning viewer, so it cannot leak
     * cross-device.
     */
    resolveViewerParty?: (
        request: DaemonBrowserDiagnosticsSnapshotRequestV1,
    ) => BrowserDiagnosticsViewerParty;
}>;

export function registerDaemonBrowserDiagnosticsSnapshotHandler(
    rpc: RpcHandlerRegistrar,
    options: DaemonBrowserDiagnosticsSnapshotHandlerOptions = {},
): void {
    rpc.registerHandler(
        RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT,
        async (raw: unknown): Promise<DaemonBrowserDiagnosticsSnapshotResponseV1> => {
            const request = DaemonBrowserDiagnosticsSnapshotRequestV1Schema.parse(raw);
            if (!options.browserDiagnostics) {
                throw new Error('Browser diagnostics runtime is unavailable');
            }
            const party: BrowserDiagnosticsViewerParty = options.resolveViewerParty?.(request) ?? 'agent';
            const snapshot = redactBrowserDiagnosticsSnapshotForViewer(
                await options.browserDiagnostics.getSnapshot(),
                party,
            );
            return DaemonBrowserDiagnosticsSnapshotResponseV1Schema.parse({
                protocolVersion: 1,
                snapshot,
            });
        },
    );
}
