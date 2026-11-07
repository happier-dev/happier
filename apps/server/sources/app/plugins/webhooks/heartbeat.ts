import type { PluginMachineMaterializationRefV1 } from '@happier-dev/protocol/plugins/availability/materializationRefV1';
import { PluginWebhookHeartbeatReceiptHintV1Schema, type PluginWebhookHeartbeatReadInputV1, type PluginWebhookHeartbeatReadResultV1 } from '@happier-dev/protocol/plugins/webhooks/endpointV1';

import { eventRouter } from '@/app/events/connectionEventRouter';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { afterTx, inTx, type Tx } from '@/storage/inTx';
import { persistPluginWebhookHeartbeatReceiptV1 } from './persistHeartbeatReceipt';
import { resolveCurrentPluginWebhookContributionTxV1 } from './currentContribution';
import { resolveCurrentPluginWebhookTargetTxV1 } from './currentTarget';
import { createPluginWebhookCheckIdDigestV1 } from './checkIdDigest';

/** Current capability endpoint admission shared by receipt ingress and the host's finite read. */
async function resolveHeartbeatEndpointTxV1(params: Readonly<{
    tx: Tx;
    serverIdentityId: string;
    routeId?: string;
    accountId?: string;
    caller?: PluginMachineMaterializationRefV1;
    input?: PluginWebhookHeartbeatReadInputV1;
}>) {
    const endpoint = await params.tx.pluginWebhookEndpoint.findFirst({
        where: {
            ...(params.routeId ? { routeId: params.routeId } : {}),
            ...(params.accountId ? { accountId: params.accountId } : {}),
            ...(params.input ? { id: params.input.webhookEndpointId, sourceInstanceId: params.input.sourceInstanceId,
                checkId: params.input.checkId, checkIdDigest: createPluginWebhookCheckIdDigestV1(params.input.checkId) } : {}),
            ...(params.caller ? { pluginId: params.caller.pluginId, targetMachineId: params.caller.machineId,
                targetMaterializationId: params.caller.materializationId } : {}),
            setupKind: 'capabilityUrlV1', routingKind: 'accountEndpoint', handlerActionId: null,
            enabled: true, revokedAt: null, releasedAt: null,
            route: { enabled: true, revokedAt: null, verifierKind: 'capabilityUrl_v1' },
        },
        select: { id: true, accountId: true, pluginId: true, webhookContributionId: true, sourceInstanceId: true,
            checkId: true, lastAcceptedAt: true, targetMachineId: true, targetMachineInstallationId: true,
            targetMaterializationId: true, targetPluginVersion: true },
    });
    if (!endpoint?.accountId || !endpoint.pluginId || !endpoint.webhookContributionId || !endpoint.sourceInstanceId
        || !endpoint.checkId || !endpoint.targetMachineId || !endpoint.targetMachineInstallationId
        || !endpoint.targetMaterializationId || !endpoint.targetPluginVersion) return null;
    const target = await resolveCurrentPluginWebhookTargetTxV1({ tx: params.tx, serverIdentityId: params.serverIdentityId,
        accountId: endpoint.accountId, target: { pluginId: endpoint.pluginId, machineId: endpoint.targetMachineId,
            materializationId: endpoint.targetMaterializationId } });
    if (!target || target.machineInstallationId !== endpoint.targetMachineInstallationId
        || target.pluginVersion !== endpoint.targetPluginVersion) return null;
    const contribution = await resolveCurrentPluginWebhookContributionTxV1({ tx: params.tx, accountId: endpoint.accountId,
        target, contribution: { pluginId: endpoint.pluginId, localId: endpoint.webhookContributionId } });
    if (contribution?.verifierKind !== 'capabilityUrl_v1') return null;
    return { endpoint, accountId: endpoint.accountId, sourceInstanceId: endpoint.sourceInstanceId, target };
}

/** Record receipt only; no confirmation, delivery, Account change, health classification or Workflow. */
export async function recordPluginWebhookHeartbeatReceiptV1(params: Readonly<{
    routeId: string;
    now?: Date;
    deadlineAtMs?: number;
}>): Promise<boolean> {
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);
    const receivedAt = params.now ?? new Date();
    return await inTx(async tx => {
        const current = await resolveHeartbeatEndpointTxV1({ tx, serverIdentityId, routeId: params.routeId });
        if (!current) return false;
        const changed = await persistPluginWebhookHeartbeatReceiptV1(tx, { endpointId: current.endpoint.id, receivedAt });
        if (changed > 0) {
            const hint = PluginWebhookHeartbeatReceiptHintV1Schema.parse({ webhookEndpointId: current.endpoint.id,
                sourceInstanceId: current.sourceInstanceId, checkId: current.endpoint.checkId, lastAcceptedAt: receivedAt.getTime() });
            afterTx(tx, () => {
                eventRouter.emitEphemeral({ userId: current.accountId, payload: { type: 'health-check-heartbeat-received', ...hint },
                    recipientFilter: { type: 'machine-only', machineId: current.target.materialization.machineId } });
            });
        }
        return true;
    }, { isolationLevel: 'Serializable', ...(params.deadlineAtMs === undefined ? {} : { deadlineAtMs: params.deadlineAtMs }) });
}

/** Only the exact current observation host may read this source/check's liveness timestamp. */
export async function readPluginWebhookHeartbeatReceiptV1(params: Readonly<{
    accountId: string;
    caller: PluginMachineMaterializationRefV1;
    input: PluginWebhookHeartbeatReadInputV1;
}>): Promise<PluginWebhookHeartbeatReadResultV1> {
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);
    return await inTx(async tx => {
        const current = await resolveHeartbeatEndpointTxV1({ tx, serverIdentityId, ...params });
        return current ? { kind: 'ready', lastAcceptedAt: current.endpoint.lastAcceptedAt?.getTime() ?? null }
            : { kind: 'unavailable', code: 'endpoint_unavailable' };
    });
}
