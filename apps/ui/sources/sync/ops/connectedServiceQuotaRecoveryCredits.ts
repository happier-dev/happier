import { buildRecoveryCreditConsumeIdempotencyKey } from '@happier-dev/protocol/connect/recoveryCreditConsumeIdempotencyKey';
import { ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema, ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema, type ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1, type ConnectedServiceQuotaRecoveryCreditConsumeResponseV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { t } from '@/text';
import { sanitizeEndpointErrorMessage } from '@/sync/runtime/connectivity/sanitizeEndpointErrorMessage';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { reloadQualifiedQuotaSnapshotAfterRecovery } from '@/hooks/server/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';
import {
    getActiveServerSnapshot,
    type ActiveServerSnapshot,
} from '@/sync/domains/server/serverRuntime';

function failure(
    errorCode: string,
    error: unknown = errorCode,
    receipt?: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1,
): ConnectedServiceQuotaRecoveryCreditConsumeResponseV1 {
    return {
        ok: false,
        errorCode,
        error: sanitizeEndpointErrorMessage(error) ?? t('common.error'),
        ...(receipt ? { receipt } : {}),
    };
}

export function buildConnectedServiceQuotaRecoveryCreditIdempotencyKey(params: Readonly<{
    surface: string;
    sessionId?: string | null;
    serviceId: ConnectedServiceId;
    profileId: string;
    providerCreditId?: string | null;
    snapshotFetchedAtMs?: number | null;
}>): string {
    return buildRecoveryCreditConsumeIdempotencyKey({
        serviceId: params.serviceId,
        profileId: params.profileId,
        providerCreditId: params.providerCreditId,
        sourceSnapshotFetchedAtMs: params.snapshotFetchedAtMs,
    });
}

export async function connectedServiceQuotaRecoveryCreditConsume(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    expectedActiveServer?: Pick<
        ActiveServerSnapshot,
        'serverId' | 'generation'
    >;
    serviceId: ConnectedServiceId;
    profileId: string;
    providerCreditId?: string | null;
    sourceSnapshotFetchedAtMs?: number | null;
}>): Promise<ConnectedServiceQuotaRecoveryCreditConsumeResponseV1> {
    const profileId = params.profileId.trim();
    const providerCreditId = typeof params.providerCreditId === 'string' && params.providerCreditId.trim().length > 0
        ? params.providerCreditId.trim()
        : null;
    const request = ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema.safeParse({
        serviceId: params.serviceId,
        profileId,
        idempotencyKey: buildConnectedServiceQuotaRecoveryCreditIdempotencyKey({
            surface: 'connected-service-quota-recovery-credit',
            serviceId: params.serviceId,
            profileId,
            providerCreditId,
            snapshotFetchedAtMs: params.sourceSnapshotFetchedAtMs,
        }),
        ...(providerCreditId
            ? { providerCreditId }
            : {}),
    });
    if (!request.success) return failure('invalid_parameters');
    const serverBasis = params.expectedActiveServer ?? getActiveServerSnapshot();

    try {
        const assertExpectedServerIsCurrent = (): void => {
            if (!params.expectedActiveServer) return;
            const activeServer = getActiveServerSnapshot();
            if (
                activeServer.serverId
                    !== params.expectedActiveServer.serverId
                || activeServer.generation
                    !== params.expectedActiveServer.generation
            ) {
                throw Object.assign(
                    new Error(
                        'Connected-service quota recovery server basis is stale',
                    ),
                    { code: 'STALE_SERVER_GENERATION' },
                );
            }
        };
        assertExpectedServerIsCurrent();
        const response = await machineRpcWithServerScope<ConnectedServiceQuotaRecoveryCreditConsumeResponseV1, typeof request.data>({
            machineId: params.machineId,
            serverId: params.serverId ?? null,
            method: RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME,
            payload: request.data,
            ...(params.expectedActiveServer
                ? { onIssued: assertExpectedServerIsCurrent }
                : {}),
        });
        const parsed = ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema.safeParse(response);
        if (!parsed.success) return failure('invalid_response');
        const service = parseQualifiedPluginContributionKey(request.data.serviceId);
        const currentServer = getActiveServerSnapshot();
        if (service && parsed.data.receipt
            && currentServer.serverId === serverBasis.serverId
            && currentServer.generation === serverBasis.generation
            && (params.serverId == null || params.serverId === serverBasis.serverId)) {
            await reloadQualifiedQuotaSnapshotAfterRecovery({
                ref: { service, accountId: profileId },
                serverBasis,
            });
        }
        if (!parsed.data.ok) return failure(parsed.data.errorCode, parsed.data.error, parsed.data.receipt);
        return parsed.data;
    } catch (error) {
        return failure(
            'machine_rpc_failed',
            error,
        );
    }
}
