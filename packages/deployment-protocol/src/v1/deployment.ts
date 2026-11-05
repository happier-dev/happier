import { z } from 'zod/mini';
import { DeploymentDataCreationReferenceV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { PluginContributionIdentityV1Schema, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { DeploymentIngressV1Schema, DeploymentReceiptHeaderV1Schema, DeploymentReceiptMetadataV1Schema, DeploymentReceiptListResultV1Schema, DeploymentOwnServerTargetMachinesV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTemplateV1Schema } from '@happier-dev/protocol/plugins/contributions/deploymentTemplates';
import { DeploymentStateV1Schema, deploymentInProgressStates } from '@happier-dev/protocol/deployments/deploymentStateV1';
import { DeploymentSourceIntentV1Schema, DeploymentSourceMethodV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';

import { DeploymentDigestV1Schema, DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision, DeploymentTextV1Schema as text } from './ids.js';
import { EnvironmentSecretBindingV1Schema, OwnServerEnvironmentConfigurationV1Schema } from './environment.js';
import { deploymentStoredContentV1Schema } from './storedContent.js';
import { DeploymentTeardownContentV1Schema } from './teardown.js';
import { DeploymentCorrelationV1Schema } from './correlations.js';
import { DeploymentReviewRevisionV1Schema } from './review.js';
import { SharedSavedSecretReferenceSelectionV1Schema } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { DeploymentPreMigrationBackupV1Schema } from './backup.js';
import { WorkspaceManifestEntrySchema } from '@happier-dev/protocol/workspaces/manifestSchema';
import { DeploymentStepV1Schema,
    DeploymentTargetRoleResultV1Schema, DeploymentTargetRoleFailureV1Schema, DeploymentTargetLinkProviderContentV1Schema } from '@happier-dev/protocol/plugins/contributions/v2';

export { DeploymentStateV1Schema };
export { deploymentInProgressStates };
export type DeploymentStateV1 = z.infer<typeof DeploymentStateV1Schema>;
/** Receipt-derived presentation facts shared by server publication and client reads. */
export function projectDeploymentReceiptActivityV1(state: DeploymentStateV1): Readonly<{ running: boolean; failed: boolean }> {
    return { running: deploymentInProgressStates().includes(state), failed: state === 'failed' };
}
export { DeploymentSourceIntentV1Schema, DeploymentSourceMethodV1Schema, DeploymentPendingTriggerOccurrenceV1Schema, DeploymentPendingDeployIntentV1Schema, DeploymentPendingDeployV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';
export type { DeploymentSourceIntentV1, DeploymentSourceMethodV1, DeploymentPendingTriggerOccurrenceV1,
    DeploymentPendingDeployIntentV1, DeploymentPendingDeployV1 } from '@happier-dev/protocol';
export { DeploymentStepV1Schema };
export type DeploymentStepV1 = z.infer<typeof DeploymentStepV1Schema>;
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
}).check(z.refine(hasExactServicePlatforms, { message: 'Service platforms must cover the exact ordered selected services.' }));
export type OwnServerDeploymentRuntimeProjectionV1 = z.infer<typeof OwnServerDeploymentRuntimeProjectionV1Schema>;
/** Native receipts keep their required Compose selectors; platform source uses the same repository identity without them. */
const ownServerSourceIntentV1Schema = z.discriminatedUnion('kind', [
    z.required(DeploymentSourceIntentV1Schema._zod.def.options[0], { compose: true }),
    DeploymentSourceIntentV1Schema._zod.def.options[1],
]);
/** Comparison inputs only. Never hash or retain a secret-interpolated native model. */
export const OwnServerDeploymentInputBasisV1Schema = z.strictObject({
    v: z.literal(1), environmentId: id, environmentRevision: revision,
    targetLinkId: id, targetLinkRevision: revision,
    sourceIntent: ownServerSourceIntentV1Schema, ...runtimeProjection,
    members: DeploymentOwnServerTargetMachinesV1Schema,
    bindings: z.array(EnvironmentSecretBindingV1Schema), images,
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
export const OwnServerDeploymentDetailsV1Schema = z.strictObject({
    approvedInputBasis: OwnServerDeploymentInputBasisV1Schema,
    preMigrationBackup: z.optional(DeploymentPreMigrationBackupV1Schema),
    sources: z.optional(z.array(OwnServerDeploymentSourceV1Schema)),
    imageArchives: z.optional(z.array(OwnServerDeploymentImageArchiveV1Schema)),
    /** Exact sanitized operation file, never arbitrary manifest-external app data. */
    stageLogs: z.optional(z.array(z.strictObject({
        machineId: id, installationId: id, relativePath: z.literal('.happier/deploy.log'),
        /** Captured only from the masked stage-output sink, never subprocess errors. */
        excerpt: z.optional(z.strictObject({ text: z.string(), truncated: z.boolean() })),
        /** Sink-owned offsets into this same masked file. Null end is the current phase. */
        steps: z.optional(z.array(z.strictObject({ ref: id, range: z.strictObject({
            start: z.number().check(z.int(), z.nonnegative()),
            end: z.nullable(z.number().check(z.int(), z.nonnegative())),
        }) }))),
    })).check(z.refine(values => new Set(values.map(value =>
        JSON.stringify([value.machineId, value.installationId]))).size === values.length))),
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
    actionOperationId: z.optional(id), previousDeploymentId: z.optional(id), currentDeploymentId: z.optional(id),
    activation: z.enum(['pending', 'succeeded', 'failed', 'cancelled', 'outcome_unknown']),
    health: z.enum(['unknown', 'healthy', 'unhealthy', 'unverified']),
    restoration: z.optional(z.enum(['succeeded', 'failed', 'unreachable', 'outcome_unknown'])),
});
export type DeploymentMachineResultV1 = z.infer<typeof DeploymentMachineResultV1Schema>;
export const DeploymentReceiptFailureV1Schema = z.strictObject({
    code: id, phase: z.union([DeploymentTargetRoleFailureV1Schema.shape.phase,
        z.enum(['source', 'build', 'activate', 'restore', 'cleanup', 'observe', 'admission'])]),
});
export type DeploymentReceiptFailureV1 = z.infer<typeof DeploymentReceiptFailureV1Schema>;
/** The existing native serialized arm retains its exact builder/member/image proofs. */
export const DeploymentOwnServerContentV1Schema = z.strictObject({
    sourceIntent: ownServerSourceIntentV1Schema,
    commitSubject: z.optional(z.string()), failure: z.optional(DeploymentReceiptFailureV1Schema),
    sourceMethod: z.optional(DeploymentSourceMethodV1Schema),
    correlations: z.optional(z.array(DeploymentCorrelationV1Schema)),
    machines: z.array(id).check(z.minLength(1)), buildMachineId: id,
    ingress: z.optional(DeploymentIngressV1Schema),
    onFailure: z.enum(['rollbackAll', 'keepPartial']), images,
    machineResults: z.array(DeploymentMachineResultV1Schema), steps: z.array(DeploymentStepV1Schema),
    ownServer: z.optional(OwnServerDeploymentDetailsV1Schema),
    teardown: z.optional(DeploymentTeardownContentV1Schema),
    platform: z.optional(z.never()),
}).check(z.refine(content => new Set(content.machines).size === content.machines.length
    && (content.ingress === undefined || content.machines.length > 1)
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
});
export type DeploymentPlatformProvenanceV1 = z.infer<typeof DeploymentPlatformProvenanceV1Schema>;
export const DeploymentPlatformContentV1Schema = z.strictObject({
    sourceIntent: DeploymentSourceIntentV1Schema, sourceMethod: DeploymentSourceMethodV1Schema,
    commitSubject: z.optional(z.string()), failure: z.optional(DeploymentReceiptFailureV1Schema),
    correlations: z.optional(z.array(DeploymentCorrelationV1Schema)),
    machines: z.array(id).check(z.maxLength(0)), images: z.array(DeploymentImageV1Schema).check(z.maxLength(0)),
    machineResults: z.array(DeploymentMachineResultV1Schema).check(z.maxLength(0)), steps: z.array(DeploymentStepV1Schema),
    platform: DeploymentPlatformProvenanceV1Schema,
    buildMachineId: z.optional(z.never()), ingress: z.optional(z.never()), onFailure: z.optional(z.never()),
    ownServer: z.optional(z.never()), teardown: z.optional(z.never()),
});
export type DeploymentPlatformContentV1 = z.infer<typeof DeploymentPlatformContentV1Schema>;
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
    DeploymentDataTeardownContentV1Schema]);
export type DeploymentContentV1 = z.infer<typeof DeploymentContentV1Schema>;
export const DeploymentStoredContentV1Schema = deploymentStoredContentV1Schema(DeploymentContentV1Schema);
export type DeploymentStoredContentV1 = z.infer<typeof DeploymentStoredContentV1Schema>;
export const DeploymentV1Schema = z.extend(DeploymentReceiptMetadataV1Schema, {
    content: DeploymentStoredContentV1Schema,
});
export type DeploymentV1 = z.infer<typeof DeploymentV1Schema>;
export { DeploymentReceiptHeaderV1Schema };
export type { DeploymentReceiptHeaderV1 } from '@happier-dev/protocol';
export { DeploymentReceiptListResultV1Schema };
export type DeploymentReceiptListResultV1 = z.infer<typeof DeploymentReceiptListResultV1Schema>;

export function isDeploymentSettledV1(state: DeploymentStateV1): boolean {
    return state === 'succeeded' || state === 'running_unverified' || state === 'failed' || state === 'cancelled';
}

/** Successful settled releases remain rollback sources even without verified health. */
export function isDeploymentRollbackSourceEligibleV1(state: DeploymentStateV1): boolean {
    return state === 'succeeded' || state === 'running_unverified';
}

/** Reconciliation observes unknown effects; settled receipts cannot launch another effect. */
export function canTransitionDeploymentV1(from: DeploymentStateV1, to: DeploymentStateV1): boolean {
    if (from === to) return true;
    if (isDeploymentSettledV1(from)) return false;
    if (from === 'outcome_unknown') return to === 'failed' || to === 'cancelled';
    if (from === 'queued') return to === 'running' || to === 'failed' || to === 'cancelled' || to === 'outcome_unknown';
    return to !== 'queued';
}
