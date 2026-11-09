import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { ProviderGatewayPlacementV1, ProviderRoleModelsV1, ProviderConnectionV1,
    ProviderConnectionPurposeBindingDefaultsV1 } from '@happier-dev/protocol/providers/connections/v1';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';
import { PROVIDER_ACTION_INPUT_SCHEMAS_V1, type ProviderActionInputByIdV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import type { AccountProviderDeclarationV1 } from '@happier-dev/protocol/providers/catalog/accountModelProjectionV1';
import { readProviderGatewayContributionPurposesV1,
    type ProviderGatewayContributionV1 } from '@happier-dev/protocol/providers/gatewayContributionsV1';
export { listProviderGatewayContributionsV1, chooseProviderGatewayContributionV1 } from '@happier-dev/protocol/providers/gatewayContributionsV1';
import { readAccountAgentProviderDeclarations, readAccountProviderDeclarations,
    type ProviderDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import type { AgentProviderRequirementsV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import type { useProviderConnectionMutation } from '@/providers/hooks/useProviderConnectionMutation';

export type ProviderGatewayConfigurationPatch = Readonly<{
    gatewayPlacement?: ProviderGatewayPlacementV1 | null;
    roleModels?: ProviderRoleModelsV1 | null;
}>;
export type ProviderGatewayConfigurationConnection = ProviderConnectionV1 | DaemonProviderConnectionViewV1;

/** Role selections belong to the connection, including roles shared by several Agents. */
export function readProviderGatewayModelRoles(context: ProviderDeclarationContext): NonNullable<AgentProviderRequirementsV1['modelRoles']> {
    const roles = new Map<string, NonNullable<AgentProviderRequirementsV1['modelRoles']>[number]>();
    for (const declaration of readAccountAgentProviderDeclarations(context)) {
        for (const role of declaration.requirements.modelRoles ?? []) {
            if (!roles.has(role.id)) roles.set(role.id, role);
        }
    }
    return [...roles.values()];
}

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
    /** `null` changes no slot: the connection becomes (or stays) a gateway with the slots it has. */
    purpose: string | null;
    target: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
}>): ProviderActionInputByIdV1['providers.connections.update'] {
    const purposeBindingDefaults = { ...input.purposeBindingDefaults };
    if (input.purpose !== null && input.target) purposeBindingDefaults[input.purpose] = input.target;
    else if (input.purpose !== null) delete purposeBindingDefaults[input.purpose];
    const request: ProviderActionInputByIdV1['providers.connections.update'] = {
        action: 'update', ...(input.machineId ? { machineId: input.machineId } : {}), connectionId: input.connectionId,
        expectedRevision: input.expectedRevision,
        deployment: { kind: 'managedLocal', purposeBindingDefaults },
    };
    PROVIDER_ACTION_INPUT_SCHEMAS_V1['providers.connections.update'].parse(request);
    return request;
}

export type ProviderGatewayContribution = ProviderGatewayContributionV1;
export type ProviderGatewayDraftConfiguration = Extract<NonNullable<ProviderActionInputByIdV1['providers.connections.create_contribution']['deployment']>, { kind: 'managedLocal' }>
    & Pick<ProviderActionInputByIdV1['providers.connections.create_contribution'], 'gatewayPlacement' | 'roleModels'>;

/** The caller supplies its admitted declarations; Account-only callers use bundled identity. */
export function readProviderGatewayContributionPurposes(contributionKey: string,
    declarations: readonly AccountProviderDeclarationV1[] = readAccountProviderDeclarations({ kind: 'account' }),
): NonNullable<DaemonProviderConnectionViewV1['managedLocalOption']>['connectedAccountPurposes'] | null {
    return readProviderGatewayContributionPurposesV1(contributionKey, declarations);
}

/**
 * One Account create Action covers the managed deployment, slots and enablement. The existing
 * catalog owner rejoins an exact managed-identity retry and preserves independent external sources.
 */
export async function createProviderGateway(input: Readonly<{
    run: ReturnType<typeof useProviderConnectionMutation>['run'];
    contribution: ProviderGatewayContribution;
    connectionId: string;
    displayName: string | null;
    machineId?: string | null;
    configuration: ProviderGatewayDraftConfiguration;
    key: string;
}>): Promise<ProviderConnectionV1['id'] | null> {
    const configuration = input.configuration;
    const created = await input.run({ action: 'createContribution', connectionId: input.connectionId,
        ...(input.machineId ? { machineId: input.machineId } : {}),
        contributionKey: input.contribution.contributionKey, displayName: input.displayName,
        savedSecretId: null, enable: true, deployment: { kind: 'managedLocal', purposeBindingDefaults: configuration.purposeBindingDefaults },
        ...(configuration.gatewayPlacement !== undefined ? { gatewayPlacement: configuration.gatewayPlacement } : {}),
        ...(configuration.roleModels !== undefined ? { roleModels: configuration.roleModels } : {}),
    }, input.key);
    if (created?.status !== 'success' || !('connection' in created)) return null;
    return created.connection.connectionId;
}
