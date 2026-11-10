import axios from '@/api/client/credentialAxios';
import { DeploymentChildRpcV1Schema, DeploymentNativeSnapshotOfferV1Schema,
    type ActionExecutorContext, type DeploymentChildRpcV1,
    type DeploymentBackupRestoreInputV1,
    type DeploymentNativeSnapshotOfferV1 } from '@happier-dev/protocol';
import { ManagedListOutputV1Schema, ManagedGetOutputV1Schema, managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineProvisionerSnapshotResultV1Schema, type MachineProvisionerSnapshotResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { ManagedNativeSnapshotRequest } from '@/machines/managed/acquire';

export type ExecuteManagedNativeSnapshot = (request: ManagedNativeSnapshotRequest) => Promise<MachineProvisionerSnapshotResultV1>;

/** Restore spends its retained admission through the incumbent signed child transport. */
export function createDaemonDeploymentNativeSnapshot(host: Readonly<{
    serverHttpBaseUrl: string;
    executeManagedSnapshot?: ExecuteManagedNativeSnapshot;
}>, ports: Readonly<{
    headers(context: ActionExecutorContext, actionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>): Promise<Record<string, string>>;
    sendChild(job: DeploymentChildRpcV1, context: ActionExecutorContext): Promise<unknown>;
}>) {
    async function read(input: Extract<DeploymentBackupRestoreInputV1, { mode: 'prepare' }>, context: ActionExecutorContext): Promise<DeploymentNativeSnapshotOfferV1 | null> {
        const body = { homeId: input.serverId, enrolledMachineId: input.machineId };
        const path = managedMachineActionEndpointPathV1('machines.managed.list');
        const response = await axios.post(`${host.serverHttpBaseUrl}${path}`, body, {
            headers: await ports.headers(context, 'deployments.backups.restore', { method: 'POST', path, body }), signal: context.signal,
        });
        const machine = ManagedListOutputV1Schema.parse(response.data).machines.find(row => row.enrolledMachineId === input.machineId);
        const provisioner = machine?.reviewedFacts?.provisioner;
        if (!machine?.controller || !machine.resource || !provisioner?.actions.snapshot || !provisioner.snapshot) return null;
        return DeploymentNativeSnapshotOfferV1Schema.parse({ managedId: machine.id, intentRevision: machine.intentRevision,
            controller: machine.controller, resource: machine.resource, contribution: machine.launch.provider,
            ...provisioner.snapshot,
            consistency: machine.observation?.power === 'running' ? 'running'
                : machine.observation?.power === 'stopped' ? 'stopped' : 'unknown' });
    }
    async function execute(request: Readonly<{ input: Extract<DeploymentBackupRestoreInputV1, { mode: 'confirm' }>; offer: DeploymentNativeSnapshotOfferV1;
        label: string; reason: string; context: ActionExecutorContext }>): Promise<MachineProvisionerSnapshotResultV1> {
        const { input, offer, label, reason, context } = request;
        try {
            const actionOperationId = context.operationAcceptance?.operationId;
            if (!actionOperationId) return { kind: 'refused', code: 'admission_unavailable' };
            const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'snapshot', actionId: 'deployments.backups.restore',
                ...offer.controller, actionOperationId, input, offer, label, reason });
            return MachineProvisionerSnapshotResultV1Schema.parse(await ports.sendChild(job, context));
        } catch {
            context.signal?.throwIfAborted();
            return { kind: 'unknown', code: 'native_snapshot_outcome_unknown' };
        }
    }
    async function executeChild(job: Extract<DeploymentChildRpcV1, { kind: 'snapshot' }>, context: ActionExecutorContext): Promise<MachineProvisionerSnapshotResultV1> {
        try {
            if (!host.executeManagedSnapshot) return { kind: 'unsupported', code: 'native_snapshot_unsupported' };
            const body = { homeId: job.input.serverId, managedId: job.offer.managedId };
            const path = managedMachineActionEndpointPathV1('machines.managed.get');
            const response = await axios.post(`${host.serverHttpBaseUrl}${path}`, body, {
                headers: await ports.headers(context, job.actionId, { method: 'POST', path, body }), signal: context.signal,
            });
            // Home returns the exact managed projection captured at child admission,
            // including incumbent credential references. No second manage check.
            const machine = ManagedGetOutputV1Schema.parse(response.data);
            return await host.executeManagedSnapshot({ machine, label: job.label, reason: job.reason,
                options: { requestId: job.actionOperationId, signal: context.signal, context: { ...context,
                    operationAcceptance: { actionId: job.actionId, operationId: job.actionOperationId, accept() {} } } } });
        } catch {
            context.signal?.throwIfAborted();
            return { kind: 'unknown', code: 'native_snapshot_outcome_unknown' };
        }
    }
    return { read, execute, executeChild };
}
