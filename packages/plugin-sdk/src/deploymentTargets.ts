import type { ReadonlyAuthorDeclaration } from './authorDeclaration.js';
import type { PluginAccountActionContext } from './actions/contracts.js';
import type { DatabaseEnginesServiceV1 } from './databaseEngines.js';
import type {
    DatabaseDescriptorV1, DatabaseEngineIdV1, DatabaseManagedDeploymentTargetV1,
    DatabaseOperationClassV1, DatabaseOperationInputV1, DatabaseOperationResultV1,
    DatabaseTargetsListResultV1,
} from './database/index.js';
import { isPluginError, PluginError, projectActionFailureCauseV1 } from './errors.js';
import type { ProtocolComposableSchema } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import type { DeploymentTargetContributionV1 as CanonicalDeploymentTargetContributionV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargets';
import { DeploymentDataParentBranchRefV1ProtocolSchema as canonicalParentBranch,
    type DeploymentDataParentBranchRefV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargets';
import {
    DeploymentTargetRoleInputProtocolSchemasV1 as canonicalRoleInputs,
    DeploymentTargetRoleResultV1ProtocolSchema as canonicalRoleResult,
    DeploymentTargetPreparationBaseV1ProtocolSchema as canonicalPreparationBase,
    type DeploymentTargetRoleResultV1,
    type DeploymentTargetPreparationBaseV1,
} from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';

export type {
    DeploymentTargetCredentialPrincipalV1,
    DeploymentTargetProviderIdentityV1, DeploymentTargetProviderEnvironmentV1,
    DeploymentTargetRepositoryAccessV1, DeploymentTargetRoleCommonInputV1,
    DeploymentTargetPreparationBaseV1, DeploymentTargetInspectInputV1,
    DeploymentTargetLinkRoleInputV1, DeploymentTargetLifecycleInputV1,
    DeploymentTargetDeployInputV1, DeploymentTargetUploadDeployInputV1,
    DeploymentTargetObserveInputV1, DeploymentTargetCancelInputV1,
    DeploymentTargetPriorDeploymentRefV1, DeploymentTargetRollbackInputV1,
    DeploymentTargetPromoteInputV1, DeploymentTargetTeardownInputV1,
    DeploymentTargetRuntimeRoleV1, DeploymentTargetRoleInputV1,
    DeploymentTargetRoleResultV1, DeploymentTargetRoleFailureV1,
    DeploymentTargetVariablesReadInputV1, DeploymentTargetVariablesSyncInputV1,
    DeploymentTargetVariablesReadResultV1, DeploymentTargetVariablesSyncResultV1,
    DeploymentTargetOwnedVariableV1, DeploymentTargetVariableMetadataV1,
} from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
export { hasDeploymentTargetPreparationCoordinatesV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
export { DeploymentDomainTunnelOwnershipV1ProtocolSchema, DeploymentDomainTunnelDispositionV1ProtocolSchema,
    type DeploymentDomainTunnelOwnershipV1, type DeploymentDomainTunnelDispositionV1 }
    from '@happier-dev/protocol/deployments/deploymentDomainV1';

/** Response limits are detected after sending the request. A write may already have taken effect. */
export function projectDeploymentTargetHttpFailureV1(error: unknown, intent: 'read' | 'write', phase: string): unknown {
    if (intent !== 'write' || !isPluginError(error) || error.code !== 'plugin_fetch_response_too_large') return error;
    return new PluginError({ code: 'outcome_unknown', retryable: false, details: { phase },
        failureCause: projectActionFailureCauseV1(error, `deployment.provider.${phase}`) });
}

/** A Domain removal settles from the provider's absence fact, including a lost DELETE response. */
export async function settleDeploymentTargetDomainRemovalV1(input: Readonly<{
    remove(): Promise<unknown>;
    observeAbsent(): Promise<boolean>;
}>): Promise<void> {
    let failure: { error: unknown } | undefined;
    try { await input.remove(); } catch (error) { failure = { error }; }
    if (await input.observeAbsent()) return;
    if (failure) throw failure.error;
    throw new PluginError({ code: 'outcome_unknown', retryable: false });
}
export const DeploymentTargetRoleInputProtocolSchemasV1: Readonly<{
    [TRole in keyof typeof canonicalRoleInputs]: ProtocolComposableSchema<
        ReturnType<(typeof canonicalRoleInputs)[TRole]['parse']>
    >;
}> = canonicalRoleInputs;
export { DeploymentTargetLogsResultV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
export { DeploymentTargetLinkProviderContentV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
export { DeploymentTargetDomainResultV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
export type { DeploymentTargetDomainInputV1, DeploymentTargetDomainResultV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
export { DeploymentTargetVariablesReadResultV1ProtocolSchema,
    DeploymentTargetVariablesSyncResultV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
export const DeploymentTargetRoleResultV1ProtocolSchema: ProtocolComposableSchema<DeploymentTargetRoleResultV1> = canonicalRoleResult;
export const DeploymentTargetPreparationBaseV1ProtocolSchema: ProtocolComposableSchema<DeploymentTargetPreparationBaseV1> = canonicalPreparationBase;
export const DeploymentDataParentBranchRefV1ProtocolSchema: ProtocolComposableSchema<DeploymentDataParentBranchRefV1> = canonicalParentBranch;

/** Development-only declarations; admission does not grant invocation authority. */
export type DeploymentTargetContributionV1 = ReadonlyAuthorDeclaration<CanonicalDeploymentTargetContributionV1>;
export type DeploymentTargetCommonV1 = Pick<DeploymentTargetContributionV1,
    'id' | 'title' | 'description' | 'icon' | 'targetKind' | 'targetSchema' | 'linkSchema'>;

/** An in-process connection; credentials and native transports never enter Action JSON. */
export interface DeploymentDatabaseConnectionV1 {
    readonly engine: DatabaseEngineIdV1;
    execute(input: DatabaseOperationInputV1, signal?: AbortSignal): Promise<DatabaseOperationResultV1>;
    close(): Promise<void>;
}

export type DeploymentDatabaseResolutionV1 = Readonly<{
    descriptor: DatabaseDescriptorV1;
    connection: DeploymentDatabaseConnectionV1;
}>;

/** The deployment owner supplies its admitted selection and captured invocation custody. */
export interface DeploymentTargetDatabaseRuntimeV1 {
    listTargets(input: Readonly<{
        preparation: DeploymentTargetPreparationBaseV1;
        target: Omit<DatabaseManagedDeploymentTargetV1, 'database'>;
        placement: DatabaseDescriptorV1['placement'];
    }>, context: PluginAccountActionContext): Promise<DatabaseTargetsListResultV1>;
    open(input: Readonly<{
        preparation: DeploymentTargetPreparationBaseV1;
        target: DatabaseManagedDeploymentTargetV1;
        access: DatabaseOperationClassV1;
        placement: DatabaseDescriptorV1['placement'];
    }>, context: PluginAccountActionContext & Readonly<{
        /** The daemon's native engine service, when available for the admitted open. */
        services: Readonly<{ databaseEngines?: DatabaseEnginesServiceV1 }>;
    }>): Promise<DeploymentDatabaseResolutionV1>;
}

type DeploymentDataTargetDeclarationV1 = Extract<DeploymentTargetContributionV1, { role: 'data' }>;
type DeploymentTargetDataV1 = NonNullable<DeploymentDataTargetDeclarationV1['dataV1']>;

export type DeploymentTargetAuthorDefinitionV1 =
    | Omit<Extract<DeploymentTargetContributionV1, { role: 'runtime' }>, 'id'>
    | (Omit<DeploymentDataTargetDeclarationV1, 'id' | 'dataV1'> & Readonly<{
        dataV1?: Omit<DeploymentTargetDataV1, 'database'> & Readonly<{
            database?: NonNullable<DeploymentTargetDataV1['database']> & Readonly<{
                runtime: DeploymentTargetDatabaseRuntimeV1;
            }>;
        }>;
    }>);

export { DeploymentDomainDnsRecordInputV1ProtocolSchema, DeploymentDomainDnsRecordResultV1ProtocolSchema,
    type DeploymentDomainDnsRecordInputV1, type DeploymentDomainDnsRecordResultV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
