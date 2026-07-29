import * as React from 'react';

import {
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    type BuiltInLegacyConnectedAccountOperation,
    type ConnectedServiceId,
    type PluginContributionIdentityV1,
} from '@happier-dev/protocol';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import {
    runConnectedAccountControlCommand,
} from '@/sync/ops/connectedAccounts/connectedAccountDaemon';
import { useAllMachines } from '@/sync/store/hooks';

function resolveQualifiedService(
    serviceId: ConnectedServiceId,
): PluginContributionIdentityV1 | null {
    const compatibility =
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
            serviceId
        ];
    return compatibility?.service ?? null;
}

function admissionError(code: string): Error & Readonly<{ code: string }> {
    return Object.assign(new Error(code), { code });
}

export type ConnectedAccountExpectedOperationTransport =
    | Readonly<{ kind: 'v4' }>
    | Readonly<{
        kind: 'legacy';
        serviceId: ConnectedServiceId;
    }>;

export function useConnectedAccountOperationAdmission(): (
    service: PluginContributionIdentityV1,
    expectedTransport: ConnectedAccountExpectedOperationTransport,
    operation: BuiltInLegacyConnectedAccountOperation,
) => Promise<void> {
    const activeServer = useActiveServerSnapshot();
    const machines = useAllMachines();
    const serverId = String(activeServer.serverId ?? '').trim();
    const activeServerGeneration = activeServer.generation;
    const machine = machines.find(
        (candidate) => candidate.active === true,
    ) ?? machines[0] ?? null;
    const machineId = machine?.id ?? '';

    return React.useCallback(async (
        service: PluginContributionIdentityV1,
        expectedTransport: ConnectedAccountExpectedOperationTransport,
        operation: BuiltInLegacyConnectedAccountOperation,
    ) => {
        if (!serverId || !machineId) {
            throw admissionError(
                'connected_account_service_identity_unsupported',
            );
        }
        const result = await runConnectedAccountControlCommand({
            serverId,
            machineId,
            expectedActiveServer: {
                serverId,
                generation: activeServerGeneration,
            },
            command: {
                operation: 'describeService',
                service,
                requiredOperation: operation,
            },
        });
        if (result.status !== 'described') {
            throw admissionError(
                result.status === 'unavailable'
                || result.status === 'conflict'
                    ? result.code
                    : 'connected_account_peer_operation_admission_unavailable',
            );
        }
        if (
            result.service.pluginId !== service.pluginId
            || result.service.localId !== service.localId
        ) {
            throw admissionError(
                expectedTransport.kind === 'v4'
                    ? 'connected_account_v4_operation_unsupported'
                    : 'connected_account_legacy_operation_unsupported',
            );
        }
        if (expectedTransport.kind === 'v4') {
            if (result.operationTransport?.kind !== 'v4') {
                throw admissionError(
                    'connected_account_v4_operation_unsupported',
                );
            }
            return;
        }
        if (
            result.operationTransport?.kind !== 'legacy'
            || result.operationTransport.peerClass !== 'revisioned_v2_v3'
            || result.operationTransport.serviceId
                !== expectedTransport.serviceId
        ) {
            throw admissionError(
                'connected_account_legacy_operation_unsupported',
            );
        }
    }, [activeServerGeneration, machineId, serverId]);
}

export function useConnectedServiceLegacyOperationAdmission(): (
    serviceId: ConnectedServiceId,
    operation: BuiltInLegacyConnectedAccountOperation,
) => Promise<void> {
    const assertOperationAllowed = useConnectedAccountOperationAdmission();

    return React.useCallback(async (
        serviceId: ConnectedServiceId,
        operation: BuiltInLegacyConnectedAccountOperation,
    ) => {
        const service = resolveQualifiedService(serviceId);
        if (!service) {
            throw admissionError(
                'connected_account_service_identity_unsupported',
            );
        }
        await assertOperationAllowed(
            service,
            { kind: 'legacy', serviceId },
            operation,
        );
    }, [assertOperationAllowed]);
}
