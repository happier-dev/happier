import { signMachineInstallationProof, type MachineInstallationIdentityV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { DaemonMachineLiveStreamSourceAdmitRequestV1Schema, DaemonMachineLiveStreamSourceAdmitResponseV1Schema,
    type DaemonMachineLiveStreamSourceAdmitResponseV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/relayStartRpcV1';
import { MachineLiveStreamSourceAdmissionPayloadV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { MACHINE_VITALS_STREAM_FAMILY } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ComputerRoutes } from '@/daemon/computer/routes';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import type { MachineLiveStreamCaptureRegistry } from './captureRegistry';

export type MachineLiveStreamSourceAdmissionHandlerOptions = Readonly<{
    machineId: string;
    resolveComputer: () => ComputerRoutes | null;
    resolveBrowser?: () => BrowserDaemonControlRoutes | null;
    resolveCaptureRegistry?: () => MachineLiveStreamCaptureRegistry | null;
    readHomeServerIdentityId?: () => string | null | undefined;
    readInstallationIdentity: () => MachineInstallationIdentityV1 | null;
}>;

export function registerMachineLiveStreamSourceAdmissionHandler(
    rpc: RpcHandlerRegistrar,
    options: MachineLiveStreamSourceAdmissionHandlerOptions,
): void {
    rpc.registerHandler(RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT, async (raw, context): Promise<DaemonMachineLiveStreamSourceAdmitResponseV1> => {
        const request = DaemonMachineLiveStreamSourceAdmitRequestV1Schema.parse(raw);
        const refuse = (reasonCode: string): DaemonMachineLiveStreamSourceAdmitResponseV1 => ({
            protocolVersion: 1, result: { ok: false, reasonCode },
        });
        const admission = context?.machineAdmission;
        const sessionBrowserAccess = context?.authorization?.kind === 'session.browser' ? context.authorization : undefined;
        const sourceAuthority = sessionBrowserAccess ?? admission;
        const installation = options.readInstallationIdentity();
        if (context?.callerAuthority !== 'present_user' || !sourceAuthority || !installation
            || request.machineId !== options.machineId || sourceAuthority.machineId !== options.machineId
            || sourceAuthority.installationId !== installation.installationId
            || sessionBrowserAccess && request.streamFamily !== 'browser.streamed') return refuse('capture_source_denied');
        const actionContext = buildActionExecutorContextForRpc(context);
        const admitSource = async () => {
            if (request.streamFamily === MACHINE_VITALS_STREAM_FAMILY) {
                const source = options.resolveCaptureRegistry?.()?.resolve({ streamFamily: request.streamFamily, sourceId: request.sourceId });
                const homeServerIdentityId = options.readHomeServerIdentityId?.();
                if (!source?.ok || !source.source.sourceOccurrenceId || !homeServerIdentityId) {
                    return { ok: false as const, reasonCode: 'capture_source_unavailable' };
                }
                return { ok: true as const, source: source.source, sourceOccurrenceId: source.source.sourceOccurrenceId, homeServerIdentityId };
            }
            if (request.streamFamily === 'browser.streamed') {
                const browser = options.resolveBrowser?.();
                const admitted = browser?.admitSourceViewing?.(request, actionContext);
                if (!admitted) return { ok: false as const, reasonCode: 'capture_source_unavailable' };
                if (!admitted.ok) return admitted;
                const homeServerIdentityId = options.readHomeServerIdentityId?.();
                return homeServerIdentityId ? { ...admitted, homeServerIdentityId }
                    : { ok: false as const, reasonCode: 'capture_source_unavailable' };
            }
            const computer = options.resolveComputer();
            return computer ? await computer.admitSourceViewing(request, actionContext)
                : { ok: false as const, reasonCode: 'capture_source_unavailable' };
        };
        const admitted = await admitSource();
        if (!admitted.ok) return { protocolVersion: 1, result: admitted };
        const payload = MachineLiveStreamSourceAdmissionPayloadV1Schema.parse({
            version: 1, machineId: options.machineId, installationId: installation.installationId,
            accountId: sourceAuthority.custodianAccountId, liveStreamSourceAdmission: {
                homeServerIdentityId: admitted.homeServerIdentityId, actorAccountId: sourceAuthority.actorAccountId,
                streamFamily: admitted.source.streamFamily, sourceId: admitted.source.sourceId,
                sourceOccurrenceId: admitted.source.sourceOccurrenceId,
                ...(sessionBrowserAccess ? { sessionBrowserSessionId: sessionBrowserAccess.sessionId } : {}),
            },
        });
        return DaemonMachineLiveStreamSourceAdmitResponseV1Schema.parse({ protocolVersion: 1,
            result: { ok: true, sourceAdmission: { payload, proof: signMachineInstallationProof({ payload, privateKey: installation.privateKey }) } },
        });
    });
}
