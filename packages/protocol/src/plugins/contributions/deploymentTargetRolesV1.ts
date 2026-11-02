import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { AccountPrincipalRefV1Schema, TeamPrincipalRefV1Schema } from '../../teams/principal.js';
import { QualifiedConnectedAccountPurposeBindingV1Schema, QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema } from '../../connect/connectedAccountPurposeBindings.js';
import { QualifiedConnectedAccountRefSchema } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision, DeploymentTimestampV1Schema as timestamp } from '../../deployments/deploymentIdentifiersV1.js';
import { DeploymentSourceIntentV1Schema } from '../../deployments/storedAppInputV1.js';
import { DeploymentStateV1Schema, DeploymentStepV1Schema } from '../../deployments/deploymentStateV1.js';
import { ScmHostingRepositoryIdentityV1Schema } from '../../scm/hostingRepositoryIdentity.js';
import { ScmBranchSourceRefSchema } from '../../scm/remoteNormalization.js';
import { asProtocolZod, projectZodProtocolSchema } from '../actions/internalProtocolZodAdapter.js';

export { DeploymentStepV1Schema, type DeploymentStepV1 } from '../../deployments/deploymentStateV1.js';

/** The recorded credential owner and its existing purpose selection; never requester attribution. */
export const DeploymentTargetCredentialPrincipalV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.extend(AccountPrincipalRefV1Schema, QualifiedConnectedAccountPurposeBindingV1Schema.shape),
    z.extend(TeamPrincipalRefV1Schema, QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema.shape),
]));
export type DeploymentTargetCredentialPrincipalV1 = z.infer<typeof DeploymentTargetCredentialPrincipalV1Schema>;

/** Plugin-normalized comparison tuple, separate from its operational native selector. */
export const DeploymentTargetProviderIdentityV1Schema = lazyZodSchema(() => z.strictObject({
    providerAccountId: id, providerResourceId: id, providerEnvironment: id,
}));
export type DeploymentTargetProviderIdentityV1 = z.infer<typeof DeploymentTargetProviderIdentityV1Schema>;

/** Native Preview and generic Git Preview share their wire kind but are closed alternatives. */
export const DeploymentTargetProviderEnvironmentV1Schema = lazyZodSchema(() => z.union([
    z.strictObject({ kind: z.literal('production') }),
    z.strictObject({ kind: z.literal('preview'), gitBranch: z.optional(id) }),
    z.strictObject({ kind: z.literal('custom'), id }),
    z.strictObject({ kind: z.literal('script'), scriptName: id }),
    z.strictObject({ kind: z.literal('preview'), scriptName: id, previewName: id }),
]));
export type DeploymentTargetProviderEnvironmentV1 = z.infer<typeof DeploymentTargetProviderEnvironmentV1Schema>;

const publicUrl = lazyZodSchema(() => z.string().check(z.url(), z.refine(value => {
    try {
        const url = new URL(value);
        return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
    } catch { return false; }
}, { message: 'Deployment URLs must be HTTP addresses without credentials.' })));

/** A provider observation of one authoritative SCM repository, not a credential or readiness grant. */
export const DeploymentTargetRepositoryAccessV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('ready'), repository: ScmHostingRepositoryIdentityV1Schema }),
    z.strictObject({ status: z.literal('needsGitAccess'), repository: ScmHostingRepositoryIdentityV1Schema, grantUrl: z.optional(publicUrl) }),
]));
export type DeploymentTargetRepositoryAccessV1 = z.infer<typeof DeploymentTargetRepositoryAccessV1Schema>;

/** Captured non-secret native request operands; never re-probed by lifecycle handlers. */
export const DeploymentTargetPreparedNativeV1Schema = lazyZodSchema(() => z.strictObject({
    projectName: id,
    gitSource: z.optional(z.strictObject({ type: z.literal('github'), repoId: id })),
    triggerUuid: z.optional(id),
    previewId: z.optional(id),
    gitBranch: z.optional(ScmBranchSourceRefSchema),
    workerTag: z.optional(id),
    scriptName: z.optional(id),
}));
export type DeploymentTargetPreparedNativeV1 = z.infer<typeof DeploymentTargetPreparedNativeV1Schema>;
export const DeploymentTargetPreparedNativeV1ProtocolSchema = projectZodProtocolSchema(DeploymentTargetPreparedNativeV1Schema);

/** Protected provider link content; the host remains the sole association writer. */
export const DeploymentTargetLinkProviderContentV1Schema = lazyZodSchema(() => z.strictObject({
    credentialPrincipal: DeploymentTargetCredentialPrincipalV1Schema,
    providerIdentity: DeploymentTargetProviderIdentityV1Schema,
    providerEnvironment: DeploymentTargetProviderEnvironmentV1Schema,
    repositoryAccess: z.optional(DeploymentTargetRepositoryAccessV1Schema),
    preparedNative: z.optional(DeploymentTargetPreparedNativeV1Schema),
}));
export type DeploymentTargetLinkProviderContentV1 = z.infer<typeof DeploymentTargetLinkProviderContentV1Schema>;
export const DeploymentTargetLinkProviderContentV1ProtocolSchema = projectZodProtocolSchema(DeploymentTargetLinkProviderContentV1Schema);

/** P43 composes product-specific inspect/link operands from these same protected identities. */
export const DeploymentTargetRoleCommonInputV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), serverId: id, environmentId: id, expectedRevision: revision,
    credentialRef: asProtocolZod(QualifiedConnectedAccountRefSchema),
    credentialPrincipal: DeploymentTargetCredentialPrincipalV1Schema,
    providerIdentity: DeploymentTargetProviderIdentityV1Schema,
    providerEnvironment: DeploymentTargetProviderEnvironmentV1Schema,
    repositoryAccess: z.optional(DeploymentTargetRepositoryAccessV1Schema),
    preparedNative: z.optional(DeploymentTargetPreparedNativeV1Schema),
}));
export type DeploymentTargetRoleCommonInputV1 = z.infer<typeof DeploymentTargetRoleCommonInputV1Schema>;

/** Product preparation extends this unrefined base before its own final semantic checks. */
export const DeploymentTargetPreparationBaseV1Schema = lazyZodSchema(() => z.extend(z.omit(DeploymentTargetRoleCommonInputV1Schema, {
    providerIdentity: true,
}), {
    providerAccountId: z.optional(id), providerIdentity: z.optional(DeploymentTargetProviderIdentityV1Schema),
    targetLinkId: z.optional(id), expectedTargetLinkRevision: z.optional(revision),
}));
export type DeploymentTargetPreparationBaseV1 = z.infer<typeof DeploymentTargetPreparationBaseV1Schema>;
export const DeploymentTargetPreparationBaseV1ProtocolSchema = projectZodProtocolSchema(DeploymentTargetPreparationBaseV1Schema);
/** Initial create has a known provider Account but no fabricated provider resource id. */
export function hasDeploymentTargetPreparationCoordinatesV1(value: DeploymentTargetPreparationBaseV1): boolean {
    return (value.targetLinkId === undefined) === (value.expectedTargetLinkRevision === undefined)
        && (value.targetLinkId !== undefined ? value.providerIdentity !== undefined
            : value.providerAccountId !== undefined || value.providerIdentity !== undefined)
        && (value.providerAccountId === undefined || value.providerIdentity === undefined
            || value.providerAccountId === value.providerIdentity.providerAccountId);
}
const preparationInput = lazyZodSchema(() => DeploymentTargetPreparationBaseV1Schema.check(
    z.refine(hasDeploymentTargetPreparationCoordinatesV1,
        { message: 'Preparation requires the actual provider Account and complete coordinates for an existing link.' })));
export const DeploymentTargetInspectInputV1Schema = preparationInput;
export const DeploymentTargetLinkRoleInputV1Schema = preparationInput;
export type DeploymentTargetInspectInputV1 = z.infer<typeof DeploymentTargetInspectInputV1Schema>;
export type DeploymentTargetLinkRoleInputV1 = z.infer<typeof DeploymentTargetLinkRoleInputV1Schema>;

/** Data operations consume one selected link without inventing a runtime receipt. */
export const DeploymentTargetDataInputV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetRoleCommonInputV1Schema, {
    targetLinkId: id, expectedTargetLinkRevision: revision,
}));
export type DeploymentTargetDataInputV1 = z.infer<typeof DeploymentTargetDataInputV1Schema>;
export const DeploymentTargetDataInputV1ProtocolSchema = projectZodProtocolSchema(DeploymentTargetDataInputV1Schema);

export const DeploymentTargetLifecycleInputV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetRoleCommonInputV1Schema, {
    targetLinkId: id, expectedTargetLinkRevision: revision,
    deploymentId: id, expectedDeploymentRevision: revision, actionOperationId: id,
    providerDeploymentId: z.optional(id),
}));
export type DeploymentTargetLifecycleInputV1 = z.infer<typeof DeploymentTargetLifecycleInputV1Schema>;
export const DeploymentTargetDeployInputV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetLifecycleInputV1Schema, {
    sourceIntent: DeploymentSourceIntentV1Schema, sourceMethod: z.literal('gitIntegration'),
}));
export const DeploymentTargetUploadDeployInputV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetLifecycleInputV1Schema, {
    sourceIntent: DeploymentSourceIntentV1Schema, sourceMethod: z.literal('upload'),
}));
export const DeploymentTargetObserveInputV1Schema = DeploymentTargetLifecycleInputV1Schema;
export const DeploymentTargetCancelInputV1Schema = DeploymentTargetLifecycleInputV1Schema;
export const DeploymentTargetTeardownInputV1Schema = DeploymentTargetLifecycleInputV1Schema;
export const DeploymentTargetPriorDeploymentRefV1Schema = lazyZodSchema(() => z.strictObject({
    environmentId: id, deploymentId: id, expectedRevision: revision, providerDeploymentId: id,
}));
export type DeploymentTargetPriorDeploymentRefV1 = z.infer<typeof DeploymentTargetPriorDeploymentRefV1Schema>;
export const DeploymentTargetRollbackInputV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetLifecycleInputV1Schema, {
    priorDeployment: DeploymentTargetPriorDeploymentRefV1Schema,
}));
export const DeploymentTargetPromoteInputV1Schema = DeploymentTargetRollbackInputV1Schema;
export type DeploymentTargetDeployInputV1 = z.infer<typeof DeploymentTargetDeployInputV1Schema>;
export type DeploymentTargetUploadDeployInputV1 = z.infer<typeof DeploymentTargetUploadDeployInputV1Schema>;
export type DeploymentTargetObserveInputV1 = z.infer<typeof DeploymentTargetObserveInputV1Schema>;
export type DeploymentTargetCancelInputV1 = z.infer<typeof DeploymentTargetCancelInputV1Schema>;
export type DeploymentTargetRollbackInputV1 = z.infer<typeof DeploymentTargetRollbackInputV1Schema>;
export type DeploymentTargetPromoteInputV1 = z.infer<typeof DeploymentTargetPromoteInputV1Schema>;
export type DeploymentTargetTeardownInputV1 = z.infer<typeof DeploymentTargetTeardownInputV1Schema>;

/** One role map is consumed by both routed execution and direct qualified-Action admission. */
export const DeploymentTargetRoleInputSchemasV1 = {
    inspect: DeploymentTargetInspectInputV1Schema, link: DeploymentTargetLinkRoleInputV1Schema,
    deploy: DeploymentTargetDeployInputV1Schema, uploadDeploy: DeploymentTargetUploadDeployInputV1Schema,
    observe: DeploymentTargetObserveInputV1Schema, cancel: DeploymentTargetCancelInputV1Schema,
    rollback: DeploymentTargetRollbackInputV1Schema, promote: DeploymentTargetPromoteInputV1Schema,
    teardown: DeploymentTargetTeardownInputV1Schema,
    'projects.list': preparationInput, 'projects.provisionOptions': preparationInput,
    'projects.provision': preparationInput, 'projects.link': preparationInput,
    'branches.list': DeploymentTargetDataInputV1Schema, 'branches.create': DeploymentTargetDataInputV1Schema,
    'branches.delete': DeploymentTargetDataInputV1Schema, 'query.readOnly': DeploymentTargetDataInputV1Schema,
    'connectionSecret.save': DeploymentTargetDataInputV1Schema,
} as const;
export type DeploymentTargetRuntimeRoleV1 = 'inspect' | 'link' | 'deploy' | 'uploadDeploy' | 'observe' | 'cancel'
    | 'rollback' | 'promote' | 'teardown';
export type DeploymentTargetRoleV1 = keyof typeof DeploymentTargetRoleInputSchemasV1;
export type DeploymentTargetDataRoleV1 = Exclude<DeploymentTargetRoleV1, DeploymentTargetRuntimeRoleV1>;
export type DeploymentTargetRoleInputV1 = z.infer<typeof DeploymentTargetRoleInputSchemasV1[DeploymentTargetRoleV1]>;
export const DeploymentTargetRoleInputProtocolSchemasV1 = {
    inspect: projectZodProtocolSchema(DeploymentTargetInspectInputV1Schema),
    link: projectZodProtocolSchema(DeploymentTargetLinkRoleInputV1Schema),
    deploy: projectZodProtocolSchema(DeploymentTargetDeployInputV1Schema),
    uploadDeploy: projectZodProtocolSchema(DeploymentTargetUploadDeployInputV1Schema),
    observe: projectZodProtocolSchema(DeploymentTargetObserveInputV1Schema),
    cancel: projectZodProtocolSchema(DeploymentTargetCancelInputV1Schema),
    rollback: projectZodProtocolSchema(DeploymentTargetRollbackInputV1Schema),
    promote: projectZodProtocolSchema(DeploymentTargetPromoteInputV1Schema),
    teardown: projectZodProtocolSchema(DeploymentTargetTeardownInputV1Schema),
    'projects.list': projectZodProtocolSchema(preparationInput),
    'projects.provisionOptions': projectZodProtocolSchema(preparationInput),
    'projects.provision': projectZodProtocolSchema(preparationInput),
    'projects.link': projectZodProtocolSchema(preparationInput),
    'branches.list': DeploymentTargetDataInputV1ProtocolSchema,
    'branches.create': DeploymentTargetDataInputV1ProtocolSchema,
    'branches.delete': DeploymentTargetDataInputV1ProtocolSchema,
    'query.readOnly': DeploymentTargetDataInputV1ProtocolSchema,
    'connectionSecret.save': DeploymentTargetDataInputV1ProtocolSchema,
} as const;

export const DeploymentTargetRoleResultV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), state: DeploymentStateV1Schema, providerDeploymentId: z.optional(id), observedAtMs: timestamp,
    urls: z.optional(z.array(publicUrl)), steps: z.optional(z.array(DeploymentStepV1Schema)),
}));
export type DeploymentTargetRoleResultV1 = z.infer<typeof DeploymentTargetRoleResultV1Schema>;
export const DeploymentTargetRoleResultV1ProtocolSchema = projectZodProtocolSchema(DeploymentTargetRoleResultV1Schema);

export const DeploymentTargetRoleFailureV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), code: z.enum(['deployment_invalid', 'deployment_unavailable', 'deployment_access_denied',
        'deployment_conflict', 'deployment_content_unavailable', 'unsupported_action', 'client_required',
        'needsGitAccess', 'provider_request_failed', 'provider_response_invalid', 'outcome_unknown',
        'secret_use_client_required', 'secret_save_client_required', 'authorityChanged']),
    phase: z.enum(['admission', 'link', 'source', 'build', 'send', 'observe', 'cancel', 'teardown']), retryable: z.boolean(),
}));
export type DeploymentTargetRoleFailureV1 = z.infer<typeof DeploymentTargetRoleFailureV1Schema>;

/** Descriptor-declared platform failures and recovery share one subject and bounded evidence vocabulary. */
export const DeploymentTargetFailureTransitionV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), environmentId: id, targetLinkId: id, providerDeploymentId: id, transitionId: id,
    protection: z.enum(['production', 'nonProduction']), state: z.enum(['failed', 'recovered']), observedAtMs: timestamp,
    evidence: z.optional(z.strictObject({
        sourceRevision: z.optional(id), phase: z.optional(DeploymentTargetRoleFailureV1Schema.shape.phase),
        category: z.optional(DeploymentTargetRoleFailureV1Schema.shape.code), providerUrl: z.optional(publicUrl), logRef: z.optional(id),
    })),
}));
export type DeploymentTargetFailureTransitionV1 = z.infer<typeof DeploymentTargetFailureTransitionV1Schema>;
export const DeploymentTargetFailureTransitionV1ProtocolSchema = projectZodProtocolSchema(DeploymentTargetFailureTransitionV1Schema);
