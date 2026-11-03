import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { DaemonBrowserDiagnosticsSnapshotRequestV1Schema, DaemonBrowserDiagnosticsSnapshotResponseV1Schema } from '@happier-dev/protocol/browser/diagnostics/v1';
import type { DaemonBrowserDiagnosticsSnapshotResponseV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { resolveBrowserDiagnosticsPersonDestination } from '@happier-dev/protocol/browser/diagnostics/egress/classifier';

import type { BrowserDiagnosticsRoutes } from '@/daemon/browser/diagnostics/routes';
import {
    redactBrowserDiagnosticsSnapshotForViewer,
    type BrowserDiagnosticsViewerParty,
} from '@/daemon/browser/diagnostics/snapshotEgress';

export type DaemonBrowserDiagnosticsSnapshotHandlerOptions = Readonly<{
    browserDiagnostics?: BrowserDiagnosticsRoutes | null;
}>;

export function registerDaemonBrowserDiagnosticsSnapshotHandler(
    rpc: RpcHandlerRegistrar,
    options: DaemonBrowserDiagnosticsSnapshotHandlerOptions = {},
): void {
    rpc.registerHandler(
        RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT,
        async (raw: unknown, context): Promise<DaemonBrowserDiagnosticsSnapshotResponseV1> => {
            const request = DaemonBrowserDiagnosticsSnapshotRequestV1Schema.parse(raw);
            if (!options.browserDiagnostics) {
                throw new Error('Browser diagnostics runtime is unavailable');
            }
            const destination = resolveBrowserDiagnosticsPersonDestination(context?.callerAuthority);
            const party: BrowserDiagnosticsViewerParty = destination === 'localOwner'
                ? 'owner' : 'agent';
            if (request.requestId && request.view) {
                // Home admitted Machine access and stamped this caller authority. A caller cannot
                // opt into person-only data in its decrypted request. No Action exposes this branch.
                const requestDetail = destination !== 'localOwner'
                    ? { status: 'unavailable' as const, reason: 'permission_denied' as const }
                    : await options.browserDiagnostics.readRequestDetail?.({ ...request.view, requestId: request.requestId })
                        ?? { status: 'unavailable' as const, reason: 'unsupported_engine' as const };
                return DaemonBrowserDiagnosticsSnapshotResponseV1Schema.parse({ protocolVersion: 1, requestDetail,
                    snapshot: { v: 1, machineId: request.machineId, generatedAt: Date.now(), refreshState: 'idle', events: [], diagnostics: [] } });
            }
            if (request.view) {
                const result = await options.browserDiagnostics.readViewSnapshot({ ...request.view,
                    ...(request.sinceRevision === undefined ? {} : { sinceRevision: request.sinceRevision }),
                    ...(context ? { signal: context.signal } : {}),
                });
                return DaemonBrowserDiagnosticsSnapshotResponseV1Schema.parse({ protocolVersion: 1,
                    revision: result.revision, snapshot: redactBrowserDiagnosticsSnapshotForViewer(result.snapshot, party) });
            }
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
