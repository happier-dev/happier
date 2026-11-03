import type { ReadonlyAuthorDeclaration } from './definePlugin.js';
import type { ProtocolComposableSchema, PluginJsonSchema } from './protocol/protocolFacade.js';
import type { PluginLocalizedStringV2 } from './manifest.js';
import {
    DeploymentTargetFailureTransitionV1ProtocolSchema as canonicalFailureTransition,
    DeploymentTargetRoleInputProtocolSchemasV1 as canonicalRoleInputs,
    DeploymentTargetRoleResultV1ProtocolSchema as canonicalRoleResult,
    DeploymentTargetPreparationBaseV1ProtocolSchema as canonicalPreparationBase,
    type DeploymentTargetFailureTransitionV1,
    type DeploymentTargetInspectInputV1,
    type DeploymentTargetDataInputV1,
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
} from '@happier-dev/protocol/plugins/contributions/v2';

export type {
    DeploymentTargetFailureTransitionV1, DeploymentTargetCredentialPrincipalV1,
    DeploymentTargetProviderIdentityV1, DeploymentTargetProviderEnvironmentV1,
    DeploymentTargetRepositoryAccessV1, DeploymentTargetRoleCommonInputV1,
    DeploymentTargetPreparationBaseV1, DeploymentTargetInspectInputV1, DeploymentTargetDataInputV1,
    DeploymentTargetLinkRoleInputV1, DeploymentTargetLifecycleInputV1,
    DeploymentTargetDeployInputV1, DeploymentTargetUploadDeployInputV1,
    DeploymentTargetObserveInputV1, DeploymentTargetCancelInputV1,
    DeploymentTargetPriorDeploymentRefV1, DeploymentTargetRollbackInputV1,
    DeploymentTargetPromoteInputV1, DeploymentTargetTeardownInputV1,
    DeploymentTargetRuntimeRoleV1, DeploymentTargetRoleInputV1,
    DeploymentTargetRoleResultV1, DeploymentTargetRoleFailureV1,
} from '@happier-dev/protocol/plugins/contributions/v2';
export { hasDeploymentTargetPreparationCoordinatesV1 } from '@happier-dev/protocol/plugins/contributions/v2';
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
    'projects.list': ProtocolComposableSchema<DeploymentTargetInspectInputV1>;
    'projects.provisionOptions': ProtocolComposableSchema<DeploymentTargetInspectInputV1>;
    'projects.provision': ProtocolComposableSchema<DeploymentTargetInspectInputV1>;
    'projects.link': ProtocolComposableSchema<DeploymentTargetInspectInputV1>;
    'branches.list': ProtocolComposableSchema<DeploymentTargetDataInputV1>;
    'branches.create': ProtocolComposableSchema<DeploymentTargetDataInputV1>;
    'branches.delete': ProtocolComposableSchema<DeploymentTargetDataInputV1>;
    'query.readOnly': ProtocolComposableSchema<DeploymentTargetDataInputV1>;
    'connectionSecret.save': ProtocolComposableSchema<DeploymentTargetDataInputV1>;
}> = canonicalRoleInputs;
export const DeploymentTargetRoleResultV1ProtocolSchema: ProtocolComposableSchema<DeploymentTargetRoleResultV1> = canonicalRoleResult;
export const DeploymentTargetPreparationBaseV1ProtocolSchema: ProtocolComposableSchema<DeploymentTargetPreparationBaseV1> = canonicalPreparationBase;

/** Development-only declarations; admission does not grant invocation authority. */
export type DeploymentTargetContributionV1 = ReadonlyAuthorDeclaration<{
    id: string;
    title: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    icon: string;
    targetKind: string;
    targetSchema: PluginJsonSchema;
    linkSchema: PluginJsonSchema;
} & (
    | {
        role: 'runtime';
        actions: {
            inspect: string; link: string; deploy: string; observe: string;
            uploadDeploy?: string; cancel?: string; rollback?: string;
            promote?: string; teardown?: string;
            variables?: { read?: string; sync?: string };
            domains?: { read?: string; add?: string; verify?: string; remove?: string };
            previews?: { read?: string; remove?: string };
            logs?: { build?: string; runtime?: string };
        };
        failureTransitionEvent?: string;
    }
    | {
        role: 'data';
        dataV1?: {
            projects?: {
                list?: string; listAction?: string;
                provisionOptions?: string; provisionOptionsAction?: string;
                provision?: string; link?: string;
            };
            branches?: {
                list?: string; listAction?: string;
                create?: string; delete?: string;
            };
            query?: { readOnly?: string };
            connectionSecret?: { save?: string };
        };
    }
)>;
export type DeploymentTargetCommonV1 = Pick<DeploymentTargetContributionV1,
    'id' | 'title' | 'description' | 'icon' | 'targetKind' | 'targetSchema' | 'linkSchema'>;

export type DeploymentTargetAuthorDefinitionV1 = DeploymentTargetContributionV1 extends infer T
    ? T extends unknown ? Omit<T, 'id'> : never : never;

export type { DeploymentTargetRoleV1 } from '@happier-dev/protocol/plugins/contributions/v2';
