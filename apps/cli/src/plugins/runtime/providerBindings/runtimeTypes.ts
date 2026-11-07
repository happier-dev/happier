import type { ProviderBrokerRetainedCurrentnessInvalidation } from '@/providers/broker/brokerRetainedCurrentnessInvalidation';
import type { SharedManagedProviderGatewayBinding } from '../invocation/services/managedServicesAdapter';
import type { PluginSourceCustody } from '../sourceAuthority';
import type { QualifiedConnectedAccountPurposeBindingsV1, ConnectedAccountRequestAuthUseV1, ProviderRuntimeBindingBasisV1 } from '@happier-dev/protocol';
import type { readStoredCredentials } from '@/persistence';
import type { ManagedProviderRuntimeInvocationServices } from '../invocation/services/production';
import type { StablePluginConnectedAccountsOwner } from '../invocation/services/connectedAccounts';
import type { createManagedServicesOwner, ManagedProviderExplicitStartOperationInput, ManagedProviderExplicitStartOperationResult } from '../invocation/services/managedServicesOwner';
import type { ManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';

export type ResolvedManagedProviderRuntimeInvocationServices =
    ManagedProviderRuntimeInvocationServices & Readonly<{
        bootstrap: Readonly<{
            identity: PluginContributionRef;
            occurrenceId: string;
            sourceCustody: PluginSourceCustody;
            manifestAuthority: 'external' | 'bundled_first_party';
            operationClaimId: string;
            requestAuth: Readonly<{
                capabilityPath: string;
                requestAuthUses:
                    readonly ConnectedAccountRequestAuthUseV1[];
            }> | null;
        }>;
        lifetime?: 'sharedConsumer';
        materializeManagedProviderAgentBinding?: ReturnType<
            typeof createManagedServicesOwner
        >['materializeManagedProviderAgentBinding'];
        adoptService?(serviceId: string): Promise<void>;
        cleanup(): void | Promise<void>;
    }>;

export type ManagedProviderSessionCustodyBinding = Readonly<{
    managedServices:
        ManagedProviderRuntimeInvocationServices['managedServices'];
    projectEndpointAccess:
        ManagedProviderRuntimeInvocationServices['projectEndpointAccess'];
    adoptService(serviceId: string): Promise<void>;
    cleanup?(): void | Promise<void>;
}>;

export type ManagedProviderSessionBootstrapPreparation = Readonly<{
    sessionId: string;
    runtimeBindingBasis: ProviderRuntimeBindingBasisV1;
    retainedScope?: RetainedManagedProviderRuntimeInvocationScope;
    signal: AbortSignal;
    isCurrent(): boolean;
}>;

export type ManagedProviderRuntimeOperationClaim = Readonly<
    | {
        kind: 'explicitStart';
        machineId: string;
    }
    | {
        kind: 'providerBroker';
        operation:
            | Readonly<{ kind: 'session'; sessionId: string }>
            | Readonly<{
                kind: 'execution_run';
                executionRunId: string;
            }>
            | Readonly<{
                kind: 'external_api_key';
                externalApiKeyId: string;
                operationId: string;
                assignedAccountId: string;
                assignedTeamMembershipId: string;
            }>
            | Readonly<{
                kind: 'resource_test';
                actorAccountId: string;
                requestId: string;
            }>;
    }
    | {
        kind: 'sessionDemand';
        sessionId: string;
        runtimeBindingBasis: ProviderRuntimeBindingBasisV1;
        bindSessionCustody(
            scope: RetainedManagedProviderRuntimeInvocationScope,
            dependencies: ManagedProviderRuntimeInvocationServices[
                'managedServices'
            ]['dependencies'],
        ): Promise<ManagedProviderSessionCustodyBinding>;
    }
>;

/**
 * Host-private result from the canonical SVC09 explicit-start operation
 * claim. A caller may join the winner's pending or settled effect only when
 * its exact authorization input is still current.
 */
export type ManagedProviderExplicitStartJoinResult =
    ManagedProviderExplicitStartOperationResult;

export type ManagedProviderExplicitStartJoinInput = Readonly<{
    existingOnly?: true;
    retirementGroup?: ManagedProviderExplicitStartOperationInput['retirementGroup'];
    identity: PluginContributionRef;
    purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
    machineId: string;
    sharedGateway?: SharedManagedProviderGatewayBinding;
    operationClaim?: Extract<
        ManagedProviderRuntimeOperationClaim,
        { kind: 'providerBroker' }
    >;
    signal?: AbortSignal;
    isCurrent(): boolean;
    revalidateRetainedCurrentness?(signal?: AbortSignal, invalidation?: ProviderBrokerRetainedCurrentnessInvalidation): Promise<boolean>;
    establish: ManagedProviderExplicitStartOperationInput['establish'];
}>;

export type RetainedManagedProviderRuntimeInvocationScope = Readonly<{
    sessionId: string;
    runtimeBindingBasis: ProviderRuntimeBindingBasisV1;
    identity: PluginContributionRef;
    occurrenceId: string;
    sourceCustody: PluginSourceCustody;
    manifestAuthority: 'external' | 'bundled_first_party';
    operationClaimId: string;
}>;

export type ManagedProviderAdoptedPublicOutcome = Readonly<{
    operationClaimId: string;
    serviceId: string;
    endpointTemplateIds: readonly string[];
    endpoints: readonly Readonly<{
        endpointTemplateId: string;
        servicePath: string;
    }>[];
    endpointAccess: 'runnerProjected';
}>;

/** Host-issued Account custody for one bounded managed Provider invocation. */
export type ManagedProviderInvocationAccountAuthority = Readonly<{
    readCredentials: typeof readStoredCredentials;
    operationAuthority: ManagedProviderOperationAuthority;
    connectedAccountsOwner: StablePluginConnectedAccountsOwner;
}>;
