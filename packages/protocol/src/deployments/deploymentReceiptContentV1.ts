import { z } from '../zodRuntimePolicy.js';
import { ActionActorV1Schema } from '../actions/actionRequestAttributionV1.js';
import { SharedSavedSecretReferenceSelectionV1Schema } from '../account/settings/savedSecretReferenceV1.js';
import { DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } from '../artifacts/deploymentArtifactKindsV1.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { DeploymentTemplateV1Schema } from '../plugins/contributions/deploymentTemplates.js';
import { DeploymentTargetRoleResultV1Schema, DeploymentTargetLinkProviderContentV1Schema } from '../plugins/contributions/deploymentTargetRolesV1.js';
import { PluginContributionIdentityV1Schema, type PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
import { WorkspaceManifestEntrySchema } from '../workspaces/manifestSchema.js';
import { readDeploymentArtifactContentV1, type DeploymentArtifactContentReferenceV1,
    type DeploymentArtifactDocumentV1, type DeploymentArtifactReadResultV1 } from './deploymentArtifactContentReferenceV1.js';
import { DeploymentPreMigrationBackupV1Schema } from './deploymentBackupActionsV1.js';
import { DeploymentOwnServerTargetMachinesV1Schema } from './deploymentEnvironmentCreateV1.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentPreviewDomainFactV1Schema } from './deploymentPreviewTemplateV1.js';
import { DeploymentReferenceAddressV1Schema } from './deploymentReadsV1.js';
import { DeploymentReceiptFailureV1Schema } from './deploymentReceiptEventsV1.js';
import { DeploymentReviewRevisionV1Schema, DeploymentMachineReviewV1Schema } from './deploymentReviewV1.js';
import { DeploymentStepV1Schema } from './deploymentStateV1.js';
import { DeploymentTelemetryTokenHashV1Schema } from './deploymentTelemetryV1.js';
import { DeploymentTeardownContentV1Schema } from './deploymentTeardownContentV1.js';
import { DeploymentDataCreationReferenceV1Schema } from './deploymentTeardownRequestV1.js';
import { DeploymentPreviewCleanupV1Schema } from './deploymentTeardownVolumesV1.js';
import { DeploymentDigestV1Schema, DeploymentTextV1Schema as text, DeploymentIngressV1Schema,
    DeploymentOnFailureV1Schema, DeploymentPlatformSourceIntentV1Schema, DeploymentSourceMethodV1Schema,
    DeploymentFolderSourceIntentV1Schema, DeploymentRepositorySourceIntentV1Schema, DeploymentStoredDefinitionV1Schema,
    DeploymentServiceSubsetV1Schema, EnvironmentSecretBindingStoredReadV1Schema,
    OwnServerEnvironmentConfigurationV1Schema } from './storedAppInputV1.js';

const displayUrl = z.url({ protocol: /^https?$/u });

/** External display/deep-link facts only; never an approval or lifecycle gate. */
export const DeploymentCorrelationV1Schema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('forgeRun'), url: displayUrl }),
    z.strictObject({ kind: z.literal('forgeCheck'), url: displayUrl }),
    z.strictObject({ kind: z.literal('githubReview'), url: displayUrl }),
]);
export type DeploymentCorrelationV1 = z.infer<typeof DeploymentCorrelationV1Schema>;

export const DeploymentImageV1Schema = z.strictObject({
    service: text, platform: text, configDigest: DeploymentDigestV1Schema, manifestDigest: DeploymentDigestV1Schema,
    indexDigest: z.optional(DeploymentDigestV1Schema), registryReference: z.optional(text),
});
export type DeploymentImageV1 = z.infer<typeof DeploymentImageV1Schema>;
/** Private receipt provenance. Archive SHA-256 identifies transport bytes, not CONFIG. */
export const OwnServerDeploymentImageArchiveV1Schema = z.strictObject({
    image: DeploymentImageV1Schema,
    holder: z.strictObject({ serverId: id, machineId: id, installationId: id, rootPath: text, path: text }),
    sizeBytes: z.number().check(z.int(), z.nonnegative()),
    sha256: z.string().check(z.regex(/^[a-f0-9]{64}$/u)),
});
export type OwnServerDeploymentImageArchiveV1 = z.infer<typeof OwnServerDeploymentImageArchiveV1Schema>;
/** Original transfer custody and direct shared-bind mapping. Native roots are
 * derived on the owning host; no app bytes or removal root is caller-selected. */
export const OwnServerDeploymentSourceV1Schema = z.strictObject({
    machineId: id, installationId: id, deploymentId: id, role: z.enum(['build', 'runtime']),
    restorationForDeploymentId: z.optional(id), manifestFingerprint: text,
    manifestEntries: z.array(WorkspaceManifestEntrySchema), rootFingerprint: text,
    sharedBinds: z.array(z.strictObject({ relativePath: text, services: z.array(text) })),
    namedVolumes: z.optional(z.array(z.strictObject({ volume: text, physicalName: text }))),
});
export type OwnServerDeploymentSourceV1 = z.infer<typeof OwnServerDeploymentSourceV1Schema>;
const images = z.array(DeploymentImageV1Schema).check(z.refine(values =>
    new Set(values.map(image => JSON.stringify([image.service, image.platform]))).size === values.length,
{ message: 'Each service/platform has one immutable image identity.' }));
const runtimeProjection = {
    manifestFingerprint: text,
    configInputDigests: z.array(z.strictObject({ path: text, digest: DeploymentDigestV1Schema })),
    physicalProjectName: text, toolVersion: text,
    /** Imported projects review the current native generation, never rendered values. */
    nativeGeneration: z.optional(z.array(z.strictObject({
        id: z.string().check(z.regex(/^[a-f0-9]{64}$/u)),
        restartCount: z.number().check(z.int(), z.minimum(0)),
    }))),
    services: z.array(text).check(z.minLength(1)), profiles: z.array(text),
    servicePlatforms: z.optional(z.array(z.strictObject({ service: text, platform: text }))),
};
function hasExactServicePlatforms(projection: Readonly<{
    services: readonly string[]; servicePlatforms?: readonly Readonly<{ service: string; platform: string }>[] | undefined;
}>): boolean {
    return projection.servicePlatforms === undefined || projection.servicePlatforms.length === projection.services.length
        && new Set(projection.servicePlatforms.map(value => value.service)).size === projection.servicePlatforms.length
        && projection.servicePlatforms.every((value, index) => value.service === projection.services[index]);
}
export const OwnServerDeploymentRuntimeProjectionV1Schema = z.strictObject({
    machineId: id, installationId: id, platform: text, ...runtimeProjection,
    /** Observed by this member’s admitted native review; old generations remain unknown. */
    engineKind: z.optional(DeploymentMachineReviewV1Schema.shape.target.shape.engine),
}).check(z.refine(hasExactServicePlatforms, { message: 'Service platforms must cover the exact ordered selected services.' }));
export type OwnServerDeploymentRuntimeProjectionV1 = z.infer<typeof OwnServerDeploymentRuntimeProjectionV1Schema>;
/** Native receipts keep their required Compose selectors; platform source uses the same repository identity without them. */
const ownServerSourceIntentV1Schema = z.discriminatedUnion('kind', [
    z.required(DeploymentRepositorySourceIntentV1Schema, { compose: true }),
    DeploymentStoredDefinitionV1Schema,
    z.required(DeploymentFolderSourceIntentV1Schema, { compose: true }),
]);
/** Comparison inputs only. Never hash or retain a secret-interpolated native model. */
export const OwnServerDeploymentInputBasisV1Schema = z.strictObject({
    v: z.literal(1), environmentId: id, environmentRevision: revision,
    targetLinkId: id, targetLinkRevision: revision,
    sourceIntent: ownServerSourceIntentV1Schema, ...runtimeProjection,
    members: DeploymentOwnServerTargetMachinesV1Schema,
    bindings: z.array(EnvironmentSecretBindingStoredReadV1Schema), images,
    /** Capture the reviewed readiness policy; absence in old receipts means all services participate. */
    health: DeploymentTemplateV1Schema.shape.health,
    ownServer: z.optional(OwnServerEnvironmentConfigurationV1Schema),
    buildServices: z.optional(z.array(text).check(z.refine(values => new Set(values).size === values.length))),
    runtimeProjections: z.optional(z.array(OwnServerDeploymentRuntimeProjectionV1Schema)),
}).check(z.refine(hasExactServicePlatforms, { message: 'Service platforms must cover the exact ordered selected services.' }),
z.refine(basis => basis.runtimeProjections === undefined
    || basis.runtimeProjections.length === basis.members.length
        && basis.runtimeProjections.every((projection, index) => projection.machineId === basis.members[index].machineId
            && projection.installationId === basis.members[index].installationId),
{ message: 'Runtime projections must cover the exact ordered admitted installations.' }));
export type OwnServerDeploymentInputBasisV1 = z.infer<typeof OwnServerDeploymentInputBasisV1Schema>;
/** Exact already-masked deployment output retained by its producing installation. */
export const DeploymentStageLogsV1Schema = z.array(z.strictObject({
        machineId: id, installationId: id, relativePath: z.literal('.happier/deploy.log'),
        /** Captured only from the masked stage-output sink, never subprocess errors. */
        excerpt: z.optional(z.strictObject({ text: z.string(), truncated: z.boolean() })),
        /** Sink-owned offsets into this same masked file. Null end is the current phase. */
        steps: z.optional(z.array(z.strictObject({ ref: id, range: z.strictObject({
            start: z.number().check(z.int(), z.nonnegative()),
            end: z.nullable(z.number().check(z.int(), z.nonnegative())),
        }) }))),
    })).check(z.refine(values => new Set(values.map(value =>
        JSON.stringify([value.machineId, value.installationId]))).size === values.length));
export type DeploymentStageLogV1 = z.infer<typeof DeploymentStageLogsV1Schema>[number];
export const OwnServerDeploymentDetailsV1Schema = z.strictObject({
    approvedInputBasis: OwnServerDeploymentInputBasisV1Schema,
    previewCleanup: z.optional(DeploymentPreviewCleanupV1Schema),
    referenceAddresses: z.optional(z.array(DeploymentReferenceAddressV1Schema)),
    preMigrationBackup: z.optional(DeploymentPreMigrationBackupV1Schema),
    sources: z.optional(z.array(OwnServerDeploymentSourceV1Schema)),
    imageArchives: z.optional(z.array(OwnServerDeploymentImageArchiveV1Schema)),
    stageLogs: z.optional(DeploymentStageLogsV1Schema),
    /** Display snapshot of the incumbent already admitted by the rollout owner; not rollback authorization. */
    rollbackTarget: z.optional(z.nullable(z.strictObject({ deploymentId: id, revision: DeploymentReviewRevisionV1Schema }))),
    /** Presence records a completed build even when later rollout fails. Empty
     * sets remain explicit so removing a secret invalidates that service cache. */
    buildSecretRevisions: z.optional(z.array(z.strictObject({ service: text, machineId: id, installationId: id,
        bindings: z.array(SharedSavedSecretReferenceSelectionV1Schema).check(z.refine(values =>
            new Set(values.map(value => value.ref)).size === values.length)),
    })).check(z.refine(values => new Set(values.map(value => value.service)).size === values.length))),
});
export type OwnServerDeploymentDetailsV1 = z.infer<typeof OwnServerDeploymentDetailsV1Schema>;
export const DeploymentMachineResultV1Schema = z.strictObject({
    machineId: id, installationId: id, steps: z.array(DeploymentStepV1Schema),
    telemetryMachineId: z.optional(id), telemetryTokenHash: z.optional(DeploymentTelemetryTokenHashV1Schema),
    actionOperationId: z.optional(id), previousDeploymentId: z.optional(id), currentDeploymentId: z.optional(id),
    activation: z.enum(['pending', 'succeeded', 'failed', 'cancelled', 'outcome_unknown']),
    health: z.enum(['unknown', 'healthy', 'unhealthy', 'unverified']),
    /** Native stop/start observations for the serving generation, retained across cancellation. */
    incumbentStopped: z.optional(z.boolean()),
    restoration: z.optional(z.enum(['succeeded', 'failed', 'unreachable', 'outcome_unknown'])),
});
export type DeploymentMachineResultV1 = z.infer<typeof DeploymentMachineResultV1Schema>;
/** The existing native serialized arm retains its exact builder/member/image proofs. */
export const DeploymentOwnServerContentV1Schema = z.strictObject({
    actor: z.optional(ActionActorV1Schema),
    sourceIntent: ownServerSourceIntentV1Schema,
    previewDomain: z.optional(DeploymentPreviewDomainFactV1Schema),
    services: z.optional(DeploymentServiceSubsetV1Schema),
    commitSubject: z.optional(z.string()), failure: z.optional(DeploymentReceiptFailureV1Schema),
    sourceMethod: z.optional(DeploymentSourceMethodV1Schema),
    correlations: z.optional(z.array(DeploymentCorrelationV1Schema)),
    machines: z.array(id).check(z.minLength(1)), buildMachineId: id,
    ingress: z.optional(DeploymentIngressV1Schema),
    onFailure: DeploymentOnFailureV1Schema, images,
    machineResults: z.array(DeploymentMachineResultV1Schema), steps: z.array(DeploymentStepV1Schema),
    ownServer: z.optional(OwnServerDeploymentDetailsV1Schema),
    teardown: z.optional(DeploymentTeardownContentV1Schema),
    platform: z.optional(z.never()),
}).check(z.refine(content => new Set(content.machines).size === content.machines.length
    && (content.ingress?.kind !== 'edgeCaddy' || content.machines.length > 1)
    && new Set(content.machineResults.map(result => result.machineId)).size === content.machineResults.length
    && content.machineResults.every(result => content.machines.includes(result.machineId))
    && (content.ownServer?.imageArchives ?? []).every(archive => content.images.some(image =>
        image.service === archive.image.service && image.platform === archive.image.platform
        && image.configDigest === archive.image.configDigest && image.manifestDigest === archive.image.manifestDigest)),
{ message: 'Receipt Machines and service/platform images must have one exact identity.' }));
export type DeploymentOwnServerContentV1 = z.infer<typeof DeploymentOwnServerContentV1Schema>;

/** Protected invocation coordinates and the exact provider observation, never server columns. */
export const DeploymentPlatformProvenanceV1Schema = z.extend(DeploymentTargetLinkProviderContentV1Schema, {
    targetLinkRevision: revision,
    observation: DeploymentTargetRoleResultV1Schema,
    /** Controller output survives failed uploads without a provider deployment id. */
    stageLogs: z.optional(DeploymentStageLogsV1Schema),
});
export type DeploymentPlatformProvenanceV1 = z.infer<typeof DeploymentPlatformProvenanceV1Schema>;
export const DeploymentPlatformContentV1Schema = z.strictObject({
    actor: z.optional(ActionActorV1Schema),
    sourceIntent: DeploymentPlatformSourceIntentV1Schema, sourceMethod: DeploymentSourceMethodV1Schema,
    commitSubject: z.optional(z.string()), failure: z.optional(DeploymentReceiptFailureV1Schema),
    correlations: z.optional(z.array(DeploymentCorrelationV1Schema)),
    machines: z.array(id).check(z.maxLength(0)), images: z.array(DeploymentImageV1Schema).check(z.maxLength(0)),
    machineResults: z.array(DeploymentMachineResultV1Schema).check(z.maxLength(0)), steps: z.array(DeploymentStepV1Schema),
    platform: DeploymentPlatformProvenanceV1Schema,
    buildMachineId: z.optional(z.never()), ingress: z.optional(z.never()), onFailure: z.optional(z.never()),
    ownServer: z.optional(z.never()), teardown: z.optional(z.never()),
    services: z.optional(z.never()),
});
export type DeploymentPlatformContentV1 = z.infer<typeof DeploymentPlatformContentV1Schema>;
/** Resource deletion uses exact provider custody without requiring a prior deployment source. */
export const DeploymentProviderTeardownContentV1Schema = z.extend(z.omit(DeploymentPlatformContentV1Schema, {
    sourceIntent: true, sourceMethod: true, teardown: true,
}), { sourceIntent: z.optional(z.never()), sourceMethod: z.optional(z.never()),
    teardown: z.strictObject({ ...DeploymentTeardownContentV1Schema.shape,
        // Provider effects have no native installation/resource proof inventory.
        machines: z.array(DeploymentTeardownContentV1Schema.shape.machines._zod.def.element).check(z.maxLength(0)),
        resources: z.array(DeploymentTeardownContentV1Schema.shape.resources._zod.def.element).check(z.maxLength(0)),
        proofs: z.array(DeploymentTeardownContentV1Schema.shape.proofs._zod.def.element).check(z.maxLength(0)),
    }),
});
export type DeploymentProviderTeardownContentV1 = z.infer<typeof DeploymentProviderTeardownContentV1Schema>;
/** Data cleanup spends its retained provider custody; it has no runtime source/build provenance. */
export const DeploymentDataTeardownContentV1Schema = z.extend(z.omit(DeploymentPlatformContentV1Schema, {
    sourceIntent: true, sourceMethod: true, platform: true,
}), { sourceIntent: z.optional(z.never()), sourceMethod: z.optional(z.never()),
    platform: z.extend(DeploymentPlatformProvenanceV1Schema, {
        /** Exact authenticated Workflow output retained for ordinary data teardown. */
        dataCreation: z.strictObject({ reference: DeploymentDataCreationReferenceV1Schema, retainedProviderResource: z.boolean(),
            deleteAction: z.custom<PluginContributionIdentityV1>(value => PluginContributionIdentityV1Schema.safeParse(value).success),
            operands: z.record(z.string(), StrictJsonValueSchema) }),
    }),
});
export type DeploymentDataTeardownContentV1 = z.infer<typeof DeploymentDataTeardownContentV1Schema>;
export const DeploymentContentV1Schema = z.union([DeploymentOwnServerContentV1Schema, DeploymentPlatformContentV1Schema,
    DeploymentDataTeardownContentV1Schema, DeploymentProviderTeardownContentV1Schema]);
export type DeploymentContentV1 = z.infer<typeof DeploymentContentV1Schema>;

export function readDeploymentReceiptArtifactV1(reference: DeploymentArtifactContentReferenceV1, artifact: DeploymentArtifactDocumentV1 | null): DeploymentArtifactReadResultV1<z.infer<typeof DeploymentContentV1Schema>> {
    return readDeploymentArtifactContentV1(reference, artifact, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, DeploymentContentV1Schema);
}
