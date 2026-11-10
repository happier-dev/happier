import type { PluginMachineMaterializationRefV1 } from '@happier-dev/protocol/plugins/availability/materializationRefV1';
import type { PluginWebhookHeartbeatManageInputV1, PluginWebhookHeartbeatManageResultV1 } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { inTx } from '@/storage/inTx';
import { resolveHeartbeatEndpointTxV1 } from './heartbeat';
import { PluginWebhookEndpointStoreError, revokePluginWebhookEndpointV1, rotatePluginWebhookHeartbeatEndpointV1 } from './endpointStore';

/** Exact observation-host control; capability URLs remain person-only. */
export async function managePluginWebhookHeartbeatV1(params: Readonly<{
    accountId: string; caller: PluginMachineMaterializationRefV1; input: PluginWebhookHeartbeatManageInputV1;
}>): Promise<PluginWebhookHeartbeatManageResultV1> {
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);
    try {
        return await inTx(async tx => {
            const current = await resolveHeartbeatEndpointTxV1({ tx, serverIdentityId, ...params, includeRevoked: true });
            if (!current) return { kind: 'unavailable', code: 'endpoint_unavailable' };
            if (params.input.operation === 'status') return { kind: current.endpoint.revokedAt ? 'revoked' : 'ready',
                webhookEndpointId: current.endpoint.id, revision: current.endpoint.revision };
            const request = { tx, accountId: params.accountId, webhookEndpointId: current.endpoint.id,
                expectedRevision: params.input.expectedRevision, idempotencyKey: params.input.idempotencyKey };
            return params.input.operation === 'rotate' ? rotatePluginWebhookHeartbeatEndpointV1(request)
                : revokePluginWebhookEndpointV1(request);
        }, { isolationLevel: 'Serializable' });
    } catch (error) {
        if (!(error instanceof PluginWebhookEndpointStoreError)) throw error;
        return { kind: 'unavailable', code: error.code === 'idempotency_conflict' ? 'idempotency_conflict' : 'endpoint_unavailable' };
    }
}
