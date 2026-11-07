import type { ManagedProviderRuntimeOperationClaim } from './runtimeTypes';
import type { SharedManagedProviderGatewayBinding } from '../invocation/services/managedServicesAdapter';
import { resolveProviderManagedRuntimeDeclarationV1 } from '@happier-dev/protocol/providers/contributions';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';

export function canonicalSharedManagedProviderGatewayBinding(gateway: SharedManagedProviderGatewayBinding): SharedManagedProviderGatewayBinding {
    // Acquisition and retirement construct these fields independently.
    // Object insertion order must not change the existing semantic claim.
    return { homeId: gateway.homeId, accountId: gateway.accountId,
        connectionId: gateway.connectionId, machineId: gateway.machineId, consumerId: gateway.consumerId };
}

export function createExplicitManagedProviderOperationClaimId(
    identity: PluginContributionRef,
    machineId: string,
    sharedGateway?: SharedManagedProviderGatewayBinding,
): string | null {
    const normalizedMachineId = machineId.trim();
    return normalizedMachineId
        ? JSON.stringify([
            'managed-provider-explicit-start',
            normalizedMachineId,
            identity.pluginId,
            identity.localId,
            ...(sharedGateway ? [canonicalSharedManagedProviderGatewayBinding(sharedGateway)] : []),
        ])
        : null;
}

export function resolveExplicitManagedProviderOperationClaimId(input: Readonly<{
    identity: PluginContributionRef;
    machineId: string;
    sharedGateway?: SharedManagedProviderGatewayBinding;
    operationClaim?: Extract<
        ManagedProviderRuntimeOperationClaim,
        { kind: 'providerBroker' }
    >;
}>): string | null {
    const operation = input.operationClaim?.operation;
    if (!operation) {
        return createExplicitManagedProviderOperationClaimId(
            input.identity,
            input.machineId,
            input.sharedGateway,
        );
    }
    const operationIdentity = operation.kind === 'session'
        ? operation.sessionId.trim()
        : operation.kind === 'execution_run'
            ? operation.executionRunId.trim()
            : operation.kind === 'external_api_key'
                ? JSON.stringify([operation.externalApiKeyId, operation.operationId])
                : operation.requestId.trim();
    return createManagedProviderBrokerOperationClaimId({
        identity: input.identity,
        operationKind: operation.kind,
        operationIdentity,
        sharedGateway: input.sharedGateway,
    });
}

export function createManagedProviderBrokerOperationClaimId(input: Readonly<{
    identity: PluginContributionRef;
    operationKind: 'session' | 'execution_run' | 'external_api_key' | 'resource_test';
    operationIdentity: string;
    sharedGateway?: SharedManagedProviderGatewayBinding;
}>): string | null {
    const operationIdentity = input.operationIdentity.trim();
    if (!operationIdentity) return null;
    return JSON.stringify([
        'managed-provider-broker',
        input.operationKind,
        operationIdentity,
        input.identity.pluginId,
        input.identity.localId,
        ...(input.sharedGateway ? [canonicalSharedManagedProviderGatewayBinding(input.sharedGateway)] : []),
    ]);
}

export function qualifyManagedProviderRequestAuthUses(identity: PluginContributionRef,
    declaration: ReturnType<typeof resolveProviderManagedRuntimeDeclarationV1>) {
    return Object.freeze(declaration.requestAuthUses.map(use => Object.freeze({
        purpose: Object.freeze({ consumer: Object.freeze({ ...identity }), purpose: use.purpose }),
        materialization: Object.freeze({ ...use.materialization, headerNames: Object.freeze([...use.materialization.headerNames]) }),
    })));
}

export function isSharedProviderAdmission(declaration: ReturnType<typeof resolveProviderManagedRuntimeDeclarationV1>,
    purposeBindings: QualifiedConnectedAccountPurposeBindingsV1,
    uses: NonNullable<import('../invocation/services/managedServicesAdapter').ManagedProviderRequestAuthCapabilityPathBinding['qualifiedRequestAuthUses']>) {
    return declaration.sharing === 'connectionMachine' && uses.some(use => purposeBindings.bindings.some(binding => (
        qualifiedPurposeKey(binding.purpose) === qualifiedPurposeKey(use.purpose)
    )));
}
