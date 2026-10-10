import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { ProviderGatewayPlacementV1, ProviderClaudeHelperModelsV1, ProviderConnectionV1,
    ProviderConnectionPurposeBindingDefaultsV1 } from '@happier-dev/protocol/providers/connections/v1';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';
import { PROVIDER_ACTION_INPUT_SCHEMAS_V1, type ProviderActionInputByIdV1 } from '@happier-dev/protocol/providers/providerActionsV1';

export type ProviderGatewayConfigurationPatch = Readonly<{
    gatewayPlacement?: ProviderGatewayPlacementV1 | null;
    claudeHelperModels?: ProviderClaudeHelperModelsV1 | null;
}>;
export type ProviderGatewayConfigurationConnection = ProviderConnectionV1 | DaemonProviderConnectionViewV1;

/** Vendor slots and unedited configuration stay at the connection's existing update owner. */
export function buildProviderGatewayConfigurationMutation(input: Readonly<{
    connection: ProviderGatewayConfigurationConnection;
    machineId?: string | null;
    patch: ProviderGatewayConfigurationPatch;
}>): ProviderActionInputByIdV1['providers.connections.update'] {
    const connectionId = 'id' in input.connection ? input.connection.id : input.connection.connectionId;
    if (input.connection.deployment.kind !== 'managedLocal') {
        throw createProviderErrorV1('provider_connection_invalid', { connectionId });
    }
    const request: ProviderActionInputByIdV1['providers.connections.update'] = {
        action: 'update', ...(input.machineId ? { machineId: input.machineId } : {}), connectionId,
        expectedRevision: input.connection.revision, ...input.patch,
    };
    PROVIDER_ACTION_INPUT_SCHEMAS_V1['providers.connections.update'].parse(request);
    return request;
}

/**
 * One vendor slot changes and the others ride along unchanged: the connection's slot map is written
 * whole, at the revision the caller read. Both the gateway's own page and a pool's switch use this.
 */
export function buildProviderGatewaySlotMutation(input: Readonly<{
    connectionId: ProviderConnectionV1['id'];
    expectedRevision: number;
    purposeBindingDefaults: ProviderConnectionPurposeBindingDefaultsV1;
    machineId?: string | null;
    purpose: string;
    target: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
}>): ProviderActionInputByIdV1['providers.connections.update'] {
    const purposeBindingDefaults = { ...input.purposeBindingDefaults };
    if (input.target) purposeBindingDefaults[input.purpose] = input.target;
    else delete purposeBindingDefaults[input.purpose];
    const request: ProviderActionInputByIdV1['providers.connections.update'] = {
        action: 'update', ...(input.machineId ? { machineId: input.machineId } : {}), connectionId: input.connectionId,
        expectedRevision: input.expectedRevision,
        deployment: { kind: 'managedLocal', purposeBindingDefaults },
    };
    PROVIDER_ACTION_INPUT_SCHEMAS_V1['providers.connections.update'].parse(request);
    return request;
}
