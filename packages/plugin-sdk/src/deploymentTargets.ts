import type { ReadonlyAuthorDeclaration } from './authorDeclaration.js';
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
} from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
export { hasDeploymentTargetPreparationCoordinatesV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
export const DeploymentTargetRoleInputProtocolSchemasV1: Readonly<{
    [TRole in keyof typeof canonicalRoleInputs]: ProtocolComposableSchema<
        ReturnType<(typeof canonicalRoleInputs)[TRole]['parse']>
    >;
}> = canonicalRoleInputs;
export { DeploymentTargetLogsResultV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
export const DeploymentTargetRoleResultV1ProtocolSchema: ProtocolComposableSchema<DeploymentTargetRoleResultV1> = canonicalRoleResult;
export const DeploymentTargetPreparationBaseV1ProtocolSchema: ProtocolComposableSchema<DeploymentTargetPreparationBaseV1> = canonicalPreparationBase;
export const DeploymentDataParentBranchRefV1ProtocolSchema: ProtocolComposableSchema<DeploymentDataParentBranchRefV1> = canonicalParentBranch;

/** Development-only declarations; admission does not grant invocation authority. */
export type DeploymentTargetContributionV1 = ReadonlyAuthorDeclaration<CanonicalDeploymentTargetContributionV1>;
export type DeploymentTargetCommonV1 = Pick<DeploymentTargetContributionV1,
    'id' | 'title' | 'description' | 'icon' | 'targetKind' | 'targetSchema' | 'linkSchema'>;

export type DeploymentTargetAuthorDefinitionV1 = DeploymentTargetContributionV1 extends infer T
    ? T extends unknown ? Omit<T, 'id'> : never : never;
