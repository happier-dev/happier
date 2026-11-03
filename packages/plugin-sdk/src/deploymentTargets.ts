import type { ReadonlyAuthorDeclaration } from './definePlugin.js';
import type { DeploymentTargetContributionV1 as CanonicalDeploymentTargetContributionV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargets';
import type { ProtocolComposableSchema } from './protocol/protocolFacade.js';
import {
    DeploymentTargetFailureTransitionV1ProtocolSchema as canonicalFailureTransition,
    DeploymentTargetRoleInputProtocolSchemasV1 as canonicalRoleInputs,
    DeploymentTargetRoleResultV1ProtocolSchema as canonicalRoleResult,
    DeploymentTargetPreparationBaseV1ProtocolSchema as canonicalPreparationBase,
    type DeploymentTargetFailureTransitionV1,
    type DeploymentTargetInspectInputV1,
    type DeploymentTargetLinkRoleInputV1,
    type DeploymentTargetDeployInputV1,
    type DeploymentTargetUploadDeployInputV1,
    type DeploymentTargetObserveInputV1,
    type DeploymentTargetCancelInputV1,
    type DeploymentTargetRollbackInputV1,
    type DeploymentTargetPromoteInputV1,
    type DeploymentTargetTeardownInputV1,
    type DeploymentTargetRoleResultV1,
    type DeploymentTargetPreparationBaseV1,
} from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';

export type {
    DeploymentTargetFailureTransitionV1, DeploymentTargetCredentialPrincipalV1,
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
export const DeploymentTargetFailureTransitionV1ProtocolSchema: ProtocolComposableSchema<DeploymentTargetFailureTransitionV1> = canonicalFailureTransition;
export const DeploymentTargetRoleInputProtocolSchemasV1: Readonly<{
    inspect: ProtocolComposableSchema<DeploymentTargetInspectInputV1>;
    link: ProtocolComposableSchema<DeploymentTargetLinkRoleInputV1>;
    deploy: ProtocolComposableSchema<DeploymentTargetDeployInputV1>;
    uploadDeploy: ProtocolComposableSchema<DeploymentTargetUploadDeployInputV1>;
    observe: ProtocolComposableSchema<DeploymentTargetObserveInputV1>;
    cancel: ProtocolComposableSchema<DeploymentTargetCancelInputV1>;
    rollback: ProtocolComposableSchema<DeploymentTargetRollbackInputV1>;
    promote: ProtocolComposableSchema<DeploymentTargetPromoteInputV1>;
    teardown: ProtocolComposableSchema<DeploymentTargetTeardownInputV1>;
}> = canonicalRoleInputs;
export const DeploymentTargetRoleResultV1ProtocolSchema: ProtocolComposableSchema<DeploymentTargetRoleResultV1> = canonicalRoleResult;
export const DeploymentTargetPreparationBaseV1ProtocolSchema: ProtocolComposableSchema<DeploymentTargetPreparationBaseV1> = canonicalPreparationBase;

/** Development-only declarations; admission does not grant invocation authority. */
export type DeploymentTargetContributionV1 = ReadonlyAuthorDeclaration<CanonicalDeploymentTargetContributionV1>;
export type DeploymentTargetCommonV1 = Pick<DeploymentTargetContributionV1,
    'id' | 'title' | 'description' | 'icon' | 'targetKind' | 'targetSchema' | 'linkSchema'>;

export type DeploymentTargetAuthorDefinitionV1 = DeploymentTargetContributionV1 extends infer T
    ? T extends unknown ? Omit<T, 'id'> : never : never;
