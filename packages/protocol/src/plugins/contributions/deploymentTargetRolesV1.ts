import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { AccountPrincipalRefV1Schema, TeamPrincipalRefV1Schema } from '../../teams/principal.js';
import { QualifiedConnectedAccountPurposeBindingV1Schema, QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema } from '../../connect/connectedAccountPurposeBindings.js';
import { QualifiedConnectedAccountRefSchema } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision, DeploymentTimestampV1Schema as timestamp } from '../../deployments/deploymentIdentifiersV1.js';
import { DeploymentPlatformSourceIntentV1Schema, DeploymentSecretBindingSourceV1Schema, DeploymentSourceMethodV1Schema, EnvironmentVariableBindingV1Schema } from '../../deployments/storedAppInputV1.js';
import { DeploymentOwnedTelemetryDestinationsV1Schema, DeploymentTargetOwnedVariableV1Schema } from './deploymentTargetVariablesV1.js';
export * from './deploymentTargetVariablesV1.js';
import { DeploymentEffectStateV1Schema, DeploymentStepV1Schema, DeploymentReceiptOperationV1Schema } from '../../deployments/deploymentStateV1.js';
import { ScmHostingRepositoryIdentityV1Schema } from '../../scm/hostingRepositoryIdentity.js';
import { ActionFailureCauseV1Schema } from '../../actions/actionExecutionResult.js';
import { ScmBranchSourceRefSchema } from '../../scm/remoteNormalization.js';
import { ScmCommitOidSchema } from '../../scm/commitPublication.js';
import { asProtocolZod, projectZodProtocolSchema } from '../actions/internalProtocolZodAdapter.js';
import { defineProtocolJsonValue } from '../actions/protocolComposableSchema.js';
import { ManagedServiceNativeLogCursorV1Schema, ManagedServiceNativeLogResultV1Schema } from '../../local/services/nativeLogsV1.js';
import { MachineDeploymentServiceIdentityV1Schema } from '../../local/services/serviceIdentityV1.js';
import { DeploymentDomainProviderResultV1Schema, DeploymentDomainProviderZoneV1Schema } from '../../deployments/deploymentDomainProviderResultV1.js';
import { DeploymentVolumeRemovalOutcomeV1Schema } from '../../deployments/deploymentVolumeRemovalV1.js';
import type { DEPLOYMENT_DATA_PROJECT_TEARDOWN_PREVIEW_CHILD_ROLE_V1 } from '../../actions/specs/deploymentPreparationScope.js';

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

/** The selection is opaque to storage. The selected target's Action schema owns its native fields. */
export const DeploymentTargetNativeProviderEnvironmentV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('native'), selection: z.record(z.string(), asProtocolZod(defineProtocolJsonValue())),
}));
export type DeploymentTargetNativeProviderEnvironmentV1 = z.infer<typeof DeploymentTargetNativeProviderEnvironmentV1Schema>;
export const DeploymentTargetProviderEnvironmentV1Schema = DeploymentTargetNativeProviderEnvironmentV1Schema;
export type DeploymentTargetProviderEnvironmentV1 = DeploymentTargetNativeProviderEnvironmentV1;

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

/** Native creation acknowledgment survives a separately unconfirmed production-branch update. */
export const DeploymentTargetProductionBranchOutcomeV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('set'), branch: ScmBranchSourceRefSchema }),
    z.strictObject({ status: z.literal('defaultKept'), branch: ScmBranchSourceRefSchema,
        requestedBranch: ScmBranchSourceRefSchema, failureCause: ActionFailureCauseV1Schema }),
    z.strictObject({ status: z.literal('unconfirmed'), previousBranch: z.optional(ScmBranchSourceRefSchema),
        requestedBranch: ScmBranchSourceRefSchema, failureCause: ActionFailureCauseV1Schema }),
]));

/** Captured non-secret native request operands; never re-probed by lifecycle handlers. */
export const DeploymentTargetPreparedNativeV1Schema = lazyZodSchema(() => z.strictObject({
    projectName: id,
    productionBranchOutcome: z.optional(DeploymentTargetProductionBranchOutcomeV1Schema),
    /** Provider-owned explanation captured with preparation and shown during approval. */
    reviewNotice: z.optional(z.string()),
    gitSource: z.optional(z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('github'), repoId: id }),
        z.strictObject({ type: z.literal('gitlab'), projectId: id }),
        z.strictObject({ type: z.literal('bitbucket'), repoUuid: id, workspaceUuid: id }),
    ])),
    triggerUuid: z.optional(id),
    previewId: z.optional(id),
    gitBranch: z.optional(ScmBranchSourceRefSchema),
    workerTag: z.optional(id),
    scriptName: z.optional(id),
    pages: z.optional(z.strictObject({
        projectMode: z.enum(['directUpload', 'gitIntegration']),
        productionBranch: ScmBranchSourceRefSchema,
        buildCommand: z.optional(z.string()),
        buildOutputDirectory: z.optional(z.string()),
        rootDirectory: z.optional(z.string()),
    })),
}));
export type DeploymentTargetPreparedNativeV1 = z.infer<typeof DeploymentTargetPreparedNativeV1Schema>;
export const DeploymentTargetPreparedNativeV1ProtocolSchema = projectZodProtocolSchema(DeploymentTargetPreparedNativeV1Schema);

/** Inert provider facts captured with the protected data link, never connection credentials. */
export const DeploymentManagedDataPresentationV1Schema = lazyZodSchema(() => z.strictObject({
    engine: id, version: z.optional(id),
    providerConsole: z.optional(z.strictObject({ url: publicUrl, label: id })),
}));
export type DeploymentManagedDataPresentationV1 = z.infer<typeof DeploymentManagedDataPresentationV1Schema>;

/** Protected provider link content; the host remains the sole association writer. */
export const DeploymentTargetLinkProviderContentV1Schema = lazyZodSchema(() => z.strictObject({
    /** Recorded by the creation host; absence means an adopted or historical resource. */
    providerResourceOrigin: z.optional(z.literal('created')),
    credentialPrincipal: DeploymentTargetCredentialPrincipalV1Schema,
    providerIdentity: DeploymentTargetProviderIdentityV1Schema,
    providerEnvironment: DeploymentTargetProviderEnvironmentV1Schema,
    sourceMethod: z.optional(DeploymentSourceMethodV1Schema),
    repositoryAccess: z.optional(DeploymentTargetRepositoryAccessV1Schema),
    preparedNative: z.optional(DeploymentTargetPreparedNativeV1Schema),
    ownedVariables: z.optional(z.array(DeploymentTargetOwnedVariableV1Schema)),
    ownedTelemetryDestinations: z.optional(DeploymentOwnedTelemetryDestinationsV1Schema),
    data: z.optional(DeploymentManagedDataPresentationV1Schema),
    providerUrl: z.optional(publicUrl),
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
    // Inspection can prepare a provider choice before its Environment is created. Association and
    // lifecycle inputs retain their required Environment coordinates at their own boundary.
    environmentId: z.optional(id), expectedRevision: z.optional(revision),
    providerAccountId: z.optional(id), providerIdentity: z.optional(DeploymentTargetProviderIdentityV1Schema),
    targetLinkId: z.optional(id), expectedTargetLinkRevision: z.optional(revision),
    sourceMethod: z.optional(DeploymentSourceMethodV1Schema),
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
/**
 * Before Create, Inspect says what making a resource means (deploy auto-mode U8, e.g. "A Pages source is final at
 * creation"). The draft names its source method and provider environment only: no Environment, link or provider
 * resource exists yet, so it never stands in for a link or a lifecycle role.
 */
export const DeploymentTargetInspectDraftInputV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetPreparationBaseV1Schema, {
    environmentId: z.optional(z.never()), expectedRevision: z.optional(z.never()), providerAccountId: z.optional(z.never()),
    providerIdentity: z.optional(z.never()), targetLinkId: z.optional(z.never()), expectedTargetLinkRevision: z.optional(z.never()),
    sourceMethod: DeploymentSourceMethodV1Schema,
}));

/** A reviewed provider resource creation precedes the host-owned association write. */
export const DeploymentTargetCreateInputV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetPreparationBaseV1Schema, {
    environmentId: id, expectedRevision: revision, providerAccountId: id, requestKey: id, resourceName: id,
    providerIdentity: z.optional(z.never()), targetLinkId: z.optional(z.never()),
    expectedTargetLinkRevision: z.optional(z.never()),
    repository: z.optional(ScmHostingRepositoryIdentityV1Schema),
    productionBranch: z.optional(ScmBranchSourceRefSchema),
}));
export type DeploymentTargetCreateInputV1 = z.infer<typeof DeploymentTargetCreateInputV1Schema>;
export const DeploymentTargetCreateInputV1ProtocolSchema = projectZodProtocolSchema(DeploymentTargetCreateInputV1Schema);

/** Data operations consume one selected link without inventing a runtime receipt. */
export const DeploymentTargetDataInputV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetRoleCommonInputV1Schema, {
    targetLinkId: id, expectedTargetLinkRevision: revision,
}));
export type DeploymentTargetDataInputV1 = z.infer<typeof DeploymentTargetDataInputV1Schema>;
export const DeploymentTargetDataInputV1ProtocolSchema = projectZodProtocolSchema(DeploymentTargetDataInputV1Schema);
/** Only branch-list reads carry the provider's opaque continuation cursor. */
export const DeploymentTargetBranchesListInputV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetDataInputV1Schema, {
    cursor: z.optional(id),
}));
export const DeploymentTargetBranchesListInputV1ProtocolSchema = projectZodProtocolSchema(DeploymentTargetBranchesListInputV1Schema);
/** These are exact private-link operands supplied by the canonical bindings owner. */
export const DeploymentTargetVariablesReadInputV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetDataInputV1Schema, {
    owned: z.array(DeploymentTargetOwnedVariableV1Schema),
}));
export type DeploymentTargetVariablesReadInputV1 = z.infer<typeof DeploymentTargetVariablesReadInputV1Schema>;
export const DeploymentTargetVariablesSyncInputV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetVariablesReadInputV1Schema, {
    desiredRevision: revision, set: z.array(EnvironmentVariableBindingV1Schema), remove: z.array(id),
    useOurs: z.array(id), keepTheirs: z.array(id),
    telemetryDestination: z.optional(z.discriminatedUnion('decision', [
        z.strictObject({ decision: z.literal('allocate'), owned: DeploymentOwnedTelemetryDestinationsV1Schema,
            collectorUrl: z.string().check(z.url({ protocol: /^https$/u })) }),
        z.strictObject({ decision: z.literal('activate'), owned: DeploymentOwnedTelemetryDestinationsV1Schema,
            collectorUrl: z.string().check(z.url({ protocol: /^https$/u })), bearer: DeploymentSecretBindingSourceV1Schema }),
        z.strictObject({ decision: z.literal('remove'), owned: DeploymentOwnedTelemetryDestinationsV1Schema }),
    ])),
}));
export type DeploymentTargetVariablesSyncInputV1 = z.infer<typeof DeploymentTargetVariablesSyncInputV1Schema>;
export const DeploymentTargetLifecycleInputV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetRoleCommonInputV1Schema, {
    targetLinkId: id, expectedTargetLinkRevision: revision,
    deploymentId: id, expectedDeploymentRevision: revision, actionOperationId: id,
    /** The receipt owner supplies this on observation; older callers may omit it. */
    operation: z.optional(DeploymentReceiptOperationV1Schema),
    providerDeploymentId: z.optional(id),
}));
export type DeploymentTargetLifecycleInputV1 = z.infer<typeof DeploymentTargetLifecycleInputV1Schema>;
export const DeploymentTargetDeployInputV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetLifecycleInputV1Schema, {
    sourceIntent: DeploymentPlatformSourceIntentV1Schema, sourceMethod: z.literal('gitIntegration'),
}));
export const DeploymentTargetUploadDeployInputV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetLifecycleInputV1Schema, {
    sourceIntent: DeploymentPlatformSourceIntentV1Schema, sourceMethod: z.literal('upload'),
}));
export const DeploymentTargetObserveInputV1Schema = DeploymentTargetLifecycleInputV1Schema;
export const DeploymentTargetCancelInputV1Schema = DeploymentTargetLifecycleInputV1Schema;
export const DeploymentTargetTeardownInputV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetLifecycleInputV1Schema, {
    ownedTelemetryDestinations: z.optional(DeploymentOwnedTelemetryDestinationsV1Schema),
}));
const logsInput = lazyZodSchema(() => z.extend(DeploymentTargetLifecycleInputV1Schema, {
    cursor: z.optional(ManagedServiceNativeLogCursorV1Schema), ref: z.optional(id), tail: z.optional(z.literal(true)),
}));
const runtimeLogsInput = lazyZodSchema(() => z.extend(DeploymentTargetLifecycleInputV1Schema, {
    cursor: z.optional(ManagedServiceNativeLogCursorV1Schema), service: z.optional(MachineDeploymentServiceIdentityV1Schema),
}));
export const DeploymentTargetLogsResultV1ProtocolSchema = projectZodProtocolSchema(ManagedServiceNativeLogResultV1Schema);
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

export const DeploymentTargetDomainInputV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetDataInputV1Schema, {
    domainId: id, domain: z.strictObject({ hostname: id, zone: z.optional(DeploymentDomainProviderZoneV1Schema),
        providerAssigned: z.optional(z.literal(true)) }),
}));
export type DeploymentTargetDomainInputV1 = z.infer<typeof DeploymentTargetDomainInputV1Schema>;
const deploymentTargetDomainAddInput = lazyZodSchema(() => z.extend(DeploymentTargetDataInputV1Schema, {
    domainId: id, domain: z.strictObject({ hostname: z.nullable(id), zone: z.optional(DeploymentDomainProviderZoneV1Schema) }),
}).check(z.refine(value => value.domain.hostname !== null || value.domain.zone === undefined,
    { message: 'Provider-assigned Domains have no DNS zone.' })));
export type DeploymentTargetDomainAddInputV1 = z.infer<typeof deploymentTargetDomainAddInput>;
export const DeploymentTargetGeneratedDomainAddInputV1ProtocolSchema =
    projectZodProtocolSchema(deploymentTargetDomainAddInput);
export const DeploymentTargetDomainResultV1Schema = lazyZodSchema(() => DeploymentDomainProviderResultV1Schema);
export type DeploymentTargetDomainResultV1 = z.infer<typeof DeploymentTargetDomainResultV1Schema>;
export const DeploymentTargetDomainResultV1ProtocolSchema = projectZodProtocolSchema(DeploymentTargetDomainResultV1Schema);

/** One role map is consumed by both routed execution and direct qualified-Action admission. */
export const DeploymentTargetRuntimeRoleInputSchemasV1 = {
    create: DeploymentTargetCreateInputV1Schema, inspect: DeploymentTargetInspectInputV1Schema, link: DeploymentTargetLinkRoleInputV1Schema,
    deploy: DeploymentTargetDeployInputV1Schema, uploadDeploy: DeploymentTargetUploadDeployInputV1Schema,
    observe: DeploymentTargetObserveInputV1Schema, cancel: DeploymentTargetCancelInputV1Schema,
    rollback: DeploymentTargetRollbackInputV1Schema, promote: DeploymentTargetPromoteInputV1Schema,
    teardown: DeploymentTargetTeardownInputV1Schema,
    'logs.build': logsInput, 'logs.runtime': runtimeLogsInput,
    'domains.read': DeploymentTargetDomainInputV1Schema, 'domains.add': deploymentTargetDomainAddInput,
    'domains.verify': DeploymentTargetDomainInputV1Schema, 'domains.remove': DeploymentTargetDomainInputV1Schema,
    'variables.read': DeploymentTargetVariablesReadInputV1Schema,
    'variables.sync': DeploymentTargetVariablesSyncInputV1Schema,
} as const;
export type DeploymentTargetRuntimeRoleV1 = keyof typeof DeploymentTargetRuntimeRoleInputSchemasV1;
export function isDeploymentTargetRuntimeRoleV1(role: string): role is DeploymentTargetRuntimeRoleV1 {
    return Object.prototype.hasOwnProperty.call(DeploymentTargetRuntimeRoleInputSchemasV1, role);
}
// Keep the schema maps independent of eager initialization of the Action scope table.
const dataProjectTeardownPreviewRole = 'projects.teardownPreview' satisfies typeof DEPLOYMENT_DATA_PROJECT_TEARDOWN_PREVIEW_CHILD_ROLE_V1;
export const DeploymentTargetRoleInputSchemasV1 = {
    ...DeploymentTargetRuntimeRoleInputSchemasV1,
    'projects.list': preparationInput, 'projects.provisionOptions': preparationInput,
    'projects.provision': preparationInput, 'projects.link': preparationInput,
    'projects.delete': DeploymentTargetDataInputV1Schema,
    'projects.observe': DeploymentTargetDataInputV1Schema,
    [dataProjectTeardownPreviewRole]: DeploymentTargetDataInputV1Schema,
    'branches.list': DeploymentTargetBranchesListInputV1Schema, 'branches.create': DeploymentTargetDataInputV1Schema,
    'branches.delete': DeploymentTargetDataInputV1Schema,
    'connectionSecret.save': DeploymentTargetDataInputV1Schema,
    'connectionSecret.reference': DeploymentTargetPreparationBaseV1Schema,
} as const;
export type DeploymentTargetRoleV1 = keyof typeof DeploymentTargetRoleInputSchemasV1;
export type DeploymentTargetDataRoleV1 = Exclude<DeploymentTargetRoleV1, DeploymentTargetRuntimeRoleV1>;
export type DeploymentTargetRoleInputV1 = z.infer<typeof DeploymentTargetRoleInputSchemasV1[DeploymentTargetRoleV1]>;
export const DeploymentTargetRoleInputProtocolSchemasV1 = {
    create: DeploymentTargetCreateInputV1ProtocolSchema,
    inspect: projectZodProtocolSchema(DeploymentTargetInspectInputV1Schema),
    link: projectZodProtocolSchema(DeploymentTargetLinkRoleInputV1Schema),
    deploy: projectZodProtocolSchema(DeploymentTargetDeployInputV1Schema),
    uploadDeploy: projectZodProtocolSchema(DeploymentTargetUploadDeployInputV1Schema),
    observe: projectZodProtocolSchema(DeploymentTargetObserveInputV1Schema),
    cancel: projectZodProtocolSchema(DeploymentTargetCancelInputV1Schema),
    rollback: projectZodProtocolSchema(DeploymentTargetRollbackInputV1Schema),
    promote: projectZodProtocolSchema(DeploymentTargetPromoteInputV1Schema),
    teardown: projectZodProtocolSchema(DeploymentTargetTeardownInputV1Schema),
    'logs.build': projectZodProtocolSchema(logsInput), 'logs.runtime': projectZodProtocolSchema(runtimeLogsInput),
    'domains.read': projectZodProtocolSchema(DeploymentTargetDomainInputV1Schema),
    'domains.add': projectZodProtocolSchema(DeploymentTargetDomainInputV1Schema),
    'domains.verify': projectZodProtocolSchema(DeploymentTargetDomainInputV1Schema),
    'domains.remove': projectZodProtocolSchema(DeploymentTargetDomainInputV1Schema),
    'variables.read': projectZodProtocolSchema(DeploymentTargetVariablesReadInputV1Schema),
    'variables.sync': projectZodProtocolSchema(DeploymentTargetVariablesSyncInputV1Schema),
    'projects.list': projectZodProtocolSchema(preparationInput),
    'projects.provisionOptions': projectZodProtocolSchema(preparationInput),
    'projects.provision': projectZodProtocolSchema(preparationInput),
    'projects.link': projectZodProtocolSchema(preparationInput),
    'projects.delete': DeploymentTargetDataInputV1ProtocolSchema,
    'projects.observe': DeploymentTargetDataInputV1ProtocolSchema,
    [dataProjectTeardownPreviewRole]: DeploymentTargetDataInputV1ProtocolSchema,
    'branches.list': DeploymentTargetBranchesListInputV1ProtocolSchema,
    'branches.create': DeploymentTargetDataInputV1ProtocolSchema,
    'branches.delete': DeploymentTargetDataInputV1ProtocolSchema,
    'connectionSecret.save': DeploymentTargetDataInputV1ProtocolSchema,
    'connectionSecret.reference': DeploymentTargetPreparationBaseV1ProtocolSchema,
} as const;

export const DeploymentTargetRoleResultV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), state: DeploymentEffectStateV1Schema, providerDeploymentId: z.optional(id), observedAtMs: timestamp,
    /** Why an acknowledged operation could not be observed. The native id remains available for recovery. */
    failureCause: z.optional(ActionFailureCauseV1Schema),
    /** The provider-observed commit, which may differ from the reviewed request for branch builds. */
    builtSha: z.optional(ScmCommitOidSchema),
    /** Positive native absence observation, required by the host to settle provider deletion. */
    providerResourceAbsent: z.optional(z.literal(true)),
    urls: z.optional(z.array(publicUrl)), steps: z.optional(z.array(DeploymentStepV1Schema)),
    /** Provider-observed built-in routing addresses, distinct from immutable deployment/preview URLs. */
    builtInUrls: z.optional(z.array(publicUrl)),
    /** An enabled public address returned an HTTP error after the provider confirmed activation. */
    publicAddressFailure: z.optional(z.strictObject({ url: publicUrl,
        httpStatus: z.number().check(z.int(), z.minimum(400), z.maximum(599)) })),
    /** Immutable upload evidence retained alongside later provider lifecycle observations. */
    uploadProvenance: z.optional(z.strictObject({
        sourceManifestFingerprint: id,
        build: z.discriminatedUnion('location', [
            z.strictObject({ location: z.literal('provider') }),
            z.strictObject({ location: z.literal('controller'), image: id,
                toolchain: z.strictObject({ name: id, version: id }), outputManifestFingerprint: id }),
        ]),
    })),
}));
export type DeploymentTargetRoleResultV1 = z.infer<typeof DeploymentTargetRoleResultV1Schema>;
export const DeploymentTargetRoleResultV1ProtocolSchema = projectZodProtocolSchema(DeploymentTargetRoleResultV1Schema);
/** A data Delete may report the fate of its attached provider volume. */
export const DeploymentTargetDataRemovalResultV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetRoleResultV1Schema, {
    volumeRemoval: z.optional(DeploymentVolumeRemovalOutcomeV1Schema),
}));
export const DeploymentTargetDataRemovalResultV1ProtocolSchema = projectZodProtocolSchema(DeploymentTargetDataRemovalResultV1Schema);

export { DeploymentTargetRoleFailureV1Schema, type DeploymentTargetRoleFailureV1 } from './deploymentTargetRoleFailureV1.js';
