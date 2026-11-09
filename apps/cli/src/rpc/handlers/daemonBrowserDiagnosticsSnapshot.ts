import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { DaemonBrowserDiagnosticsSnapshotRequestV1Schema, DaemonBrowserDiagnosticsSnapshotResponseV1Schema } from '@happier-dev/protocol/browser/diagnostics/v1';
import type { DaemonBrowserDiagnosticsSnapshotResponseV1 } from '@happier-dev/protocol/browser/diagnostics/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { resolveBrowserDiagnosticsPersonDestination } from '@happier-dev/protocol/browser/diagnostics/egress/classifier';

import type { BrowserDiagnosticsRoutes } from '@/daemon/browser/diagnostics/routes';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import { createBrowserRawRequestAdmission } from './daemonBrowserRequestAdmission';
import {
    redactBrowserDiagnosticsSnapshotForViewer,
    type BrowserDiagnosticsViewerParty,
} from '@/daemon/browser/diagnostics/snapshotEgress';

export type DaemonBrowserDiagnosticsSnapshotHandlerOptions = Readonly<{
    browserDiagnostics?: BrowserDiagnosticsRoutes | null;
    resolveBrowserControl?: () => BrowserDaemonControlRoutes | null | undefined;
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
            const admission = createBrowserRawRequestAdmission(options.resolveBrowserControl, context);
            if (request.view) admission.requireTarget(request.view);
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
            const globalSnapshot = await options.browserDiagnostics.getSnapshot();
            const snapshot = redactBrowserDiagnosticsSnapshotForViewer(
                { ...globalSnapshot, events: globalSnapshot.events.filter(admission.allowsTarget),
                    diagnostics: globalSnapshot.diagnostics.filter(diagnostic => typeof diagnostic.browserSessionId !== 'string'
                        || admission.allowsTarget({ browserSessionId: diagnostic.browserSessionId })) },
                party,
            );
            return DaemonBrowserDiagnosticsSnapshotResponseV1Schema.parse({
                protocolVersion: 1,
                snapshot,
            });
        },
    );
}
