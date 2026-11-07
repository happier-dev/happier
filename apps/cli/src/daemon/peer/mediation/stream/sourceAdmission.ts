import { signMachineInstallationProof, type MachineInstallationIdentityV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { DaemonMachineLiveStreamSourceAdmitRequestV1Schema, DaemonMachineLiveStreamSourceAdmitResponseV1Schema,
    type DaemonMachineLiveStreamSourceAdmitResponseV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/relayStartRpcV1';
import { MachineLiveStreamSourceAdmissionPayloadV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ComputerRoutes } from '@/daemon/computer/routes';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';

export type MachineLiveStreamSourceAdmissionHandlerOptions = Readonly<{
    machineId: string;
    resolveComputer: () => ComputerRoutes | null;
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
        const installation = options.readInstallationIdentity();
        if (context?.callerAuthority !== 'present_user' || !admission || !installation
            || request.machineId !== options.machineId || admission.machineId !== options.machineId
            || admission.installationId !== installation.installationId) return refuse('capture_source_denied');
        const computer = options.resolveComputer();
        if (!computer) return refuse('capture_source_unavailable');
        const admitted = await computer.admitSourceViewing(request, buildActionExecutorContextForRpc(context));
        if (!admitted.ok) return refuse(admitted.reasonCode);
        const payload = MachineLiveStreamSourceAdmissionPayloadV1Schema.parse({
            version: 1, machineId: options.machineId, installationId: installation.installationId,
            accountId: admission.custodianAccountId, liveStreamSourceAdmission: {
                homeServerIdentityId: admitted.homeServerIdentityId, actorAccountId: admission.actorAccountId,
                streamFamily: admitted.source.streamFamily, sourceId: admitted.source.sourceId,
                sourceOccurrenceId: admitted.source.sourceOccurrenceId,
            },
        });
        return DaemonMachineLiveStreamSourceAdmitResponseV1Schema.parse({ protocolVersion: 1,
            result: { ok: true, sourceAdmission: { payload, proof: signMachineInstallationProof({ payload, privateKey: installation.privateKey }) } },
        });
    });
}
