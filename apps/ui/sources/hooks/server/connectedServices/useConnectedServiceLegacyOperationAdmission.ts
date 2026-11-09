import * as React from 'react';

import { BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID, type BuiltInLegacyConnectedAccountOperation } from '@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility';
import { assertConnectedAccountOperationTransportV1, type ConnectedAccountExpectedOperationTransport } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import type { ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import {
    runConnectedAccountControlCommand,
} from '@/sync/ops/connectedAccounts/connectedAccountDaemon';
import { getStorage } from '@/sync/domains/state/storage';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { captureServerProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';

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

export type { ConnectedAccountExpectedOperationTransport } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';

export function useConnectedAccountOperationAdmission(): (
    service: PluginContributionIdentityV1,
    expectedTransport: ConnectedAccountExpectedOperationTransport,
    operation: BuiltInLegacyConnectedAccountOperation,
    signal?: AbortSignal,
) => Promise<void> {
    const activeServer = useActiveServerSnapshot();
    const serverId = String(activeServer.serverId ?? '').trim();
    const activeServerGeneration = activeServer.generation;
    const store = getStorage();
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const lifetime = React.useMemo(() => ({ controller: new AbortController() }), [activeServerGeneration, binding, serverId]);
    React.useEffect(() => {
        if (lifetime.controller.signal.aborted) lifetime.controller = new AbortController();
        const controller = lifetime.controller;
        return () => controller.abort();
    }, [lifetime]);

    return React.useCallback(async (
        service: PluginContributionIdentityV1,
        expectedTransport: ConnectedAccountExpectedOperationTransport,
        operation: BuiltInLegacyConnectedAccountOperation,
        signal?: AbortSignal,
    ) => {
        // A refresh admission is an invocation, not a displayed Machine fact.
        // Resolve the current owned target only when asked; passive quota readers
        // must not subscribe to fleet presence or its expiry clock for this callback.
        const scope = binding?.isCurrent() ? binding.scope : null;
        const resolveScopeId = captureServerProfileScopeResolver();
        const nowMs = Date.now();
        let machineId = '';
        for (const candidate of resolveVisibleMachinesForActiveServerFromState(store.getState())) {
            if (candidate.isShared !== false || !isMachineSelectableForFleet(scope, candidate, nowMs, resolveScopeId)) continue;
            if (!machineId) machineId = candidate.id;
            if (candidate.active === true) { machineId = candidate.id; break; }
        }
        if (!serverId || !scope || !machineId) {
            throw admissionError(
                'connected_account_service_identity_unsupported',
            );
        }
        const result = await runConnectedAccountControlCommand({
            serverId,
            machineId,
            signal: signal ?? lifetime.controller.signal,
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
        assertConnectedAccountOperationTransportV1(result, service, expectedTransport);
    }, [activeServerGeneration, binding, lifetime, serverId, store]);
}

export function useConnectedServiceLegacyOperationAdmission(): (
    serviceId: ConnectedServiceId,
    operation: BuiltInLegacyConnectedAccountOperation,
    signal?: AbortSignal,
) => Promise<void> {
    const assertOperationAllowed = useConnectedAccountOperationAdmission();

    return React.useCallback(async (
        serviceId: ConnectedServiceId,
        operation: BuiltInLegacyConnectedAccountOperation,
        signal?: AbortSignal,
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
            signal,
        );
    }, [assertOperationAllowed]);
}
