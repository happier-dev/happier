import { z } from 'zod/mini';
import { DeploymentEnvironmentCapabilitiesV1Schema, DeploymentEnvironmentHeaderV1Schema, DeploymentEnvironmentListResultV1Schema, DeploymentEnvironmentOwnerV1Schema,
    DeploymentComposeSelectorsV1Schema, DeploymentStoredDefinitionV1Schema, EnvironmentSecretBindingV1Schema, environmentSecretBindingIdentityV1,
    DeploymentRetainPreviousDeploymentsV1Schema,
    DeploymentRepositoryComposeV1Schema, DeploymentPendingDeployV1Schema, DeploymentIngressV1Schema } from '@happier-dev/protocol';
import { hasCompleteDeploymentPreviewRelationV1 } from '@happier-dev/protocol';

import { DeploymentTextV1Schema as text } from './ids.js';
import { deploymentStoredContentV1Schema } from './storedContent.js';
import { DeploymentEnvironmentTemplateProvenanceV1Schema } from './template.js';
import { DeploymentPreviewProvenanceV1Schema, DeploymentPreviewTemplateV1Schema } from './previews.js';
import { DeploymentEnvironmentBackupV1Schema } from './backup.js';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

export { DeploymentComposeSelectorsV1Schema, DeploymentStoredDefinitionV1Schema, DeploymentSecretBindingSourceV1Schema,
    DeploymentVariableBindingSourceV1Schema, DeploymentNonSecretVariableBindingSourceV1Schema, EnvironmentVariableBindingV1Schema,
    StoredAppPresetInputV1Schema, DeploymentTemplateRefV1Schema, StoredAppPresetBindingV1Schema } from '@happier-dev/protocol';
export type { EnvironmentVariableBindingV1, StoredAppPresetInputV1 } from '@happier-dev/protocol';
export { EnvironmentSecretBindingV1Schema, EnvironmentSecretBindingInputV1Schema, EnvironmentSecretBindingIdentityV1Schema,
    EnvironmentDataRoleAddressV1Schema, environmentSecretBindingIdentityV1 } from '@happier-dev/protocol';
export type { EnvironmentSecretBindingV1, EnvironmentSecretBindingInputV1, EnvironmentSecretBindingIdentityV1,
    EnvironmentDataRoleAddressV1 } from '@happier-dev/protocol';
export { DeploymentCreationDefaultsV1Schema, ProjectDeploymentDefaultsV1Schema, ProjectDeploymentDefaultsPayloadV1Schema,
    ProjectDeploymentDefaultsContentV1Schema, DEFAULT_DEPLOYMENT_RETAIN_PREVIOUS_DEPLOYMENTS_V1,
    ResolvedDeploymentCreationDefaultsV1Schema, DeploymentCreationDefaultSourceV1Schema } from '@happier-dev/protocol';
export type { DeploymentCreationDefaultsV1, ProjectDeploymentDefaultsV1, ProjectDeploymentDefaultsPayloadV1,
    ProjectDeploymentDefaultsContentV1, ResolvedDeploymentCreationDefaultsV1, DeploymentCreationDefaultSourceV1 } from '@happier-dev/protocol';
export type { ProjectSourceOwnerV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
export { DeploymentRepositoryComposeV1Schema } from '@happier-dev/protocol';
export const DeploymentEnvironmentDefinitionV1Schema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('repository'), ref: text, compose: z.optional(DeploymentRepositoryComposeV1Schema) }),
    DeploymentStoredDefinitionV1Schema,
]);
export type DeploymentEnvironmentDefinitionV1 = z.infer<typeof DeploymentEnvironmentDefinitionV1Schema>;

/** Definition revisions describe document/selectors, not unrelated Environment edits.
 * Repository definitions cannot become stored content through an ordinary update.
 * The source owner independently validates the document's digest before native use. */
export function resolveDeploymentStoredDefinitionRevisionV1(
    previous: DeploymentEnvironmentDefinitionV1 | undefined,
    candidate: Omit<Extract<DeploymentEnvironmentDefinitionV1, { kind: 'stored' }>, 'contentRevision'>,
): number | null {
    if (!previous) return 1;
    if (previous.kind !== 'stored') return null;
    const sameSource = previous.document === candidate.document
        && sameStrictJsonValue(previous.publicFiles ?? [], candidate.publicFiles ?? []);
    if (sameSource && previous.composeDigest !== candidate.composeDigest) return null;
    const sameList = (left: readonly string[], right: readonly string[]) =>
        left.length === right.length && left.every((value, index) => value === right[index]);
    const unchanged = sameSource
        && sameList(previous.profiles, candidate.profiles) && sameList(previous.services, candidate.services)
        && previous.primaryService === candidate.primaryService;
    return previous.contentRevision + (unchanged ? 0 : 1);
}

const migrationArgv = z.array(z.string()).check(z.minLength(1),
    z.refine(argv => (argv[0]?.trim().length ?? 0) > 0, { message: 'A migration command requires an executable.' }));
const serviceExport = z.strictObject({
    key: text, service: text, containerPort: z.number().check(z.int(), z.minimum(1), z.maximum(65535)),
    scheme: z.string().check(z.regex(/^[a-z][a-z0-9+.-]*$/iu)),
    exposure: z.enum(['public', 'privateNetwork', 'loopback']), privateNetwork: z.optional(text),
}).check(z.refine(value => value.exposure === 'privateNetwork'
    ? value.privateNetwork !== undefined : value.privateNetwork === undefined,
{ message: 'Only a private export names its exact observed private network.' }));
export const OwnServerEnvironmentConfigurationV1Schema = z.strictObject({
    rollout: z.enum(['recreate', 'startFirst']), autoRestorePreviousRelease: z.boolean(),
    migration: z.optional(z.strictObject({ service: text, argv: migrationArgv,
        pendingCheck: z.optional(z.strictObject({ argv: migrationArgv })) })),
    backupBeforeMigration: z.optional(z.boolean()),
    migrationFailurePolicy: z.optional(z.enum(['ask', 'restoreBackupAndRollbackCode', 'rollbackCodeOnly'])),
    serviceExports: z.optional(z.array(serviceExport).check(z.refine(exports =>
        new Set(exports.map(value => value.key)).size === exports.length,
    { message: 'Service export keys must be unique.' }))),
});
export type OwnServerEnvironmentConfigurationV1 = z.infer<typeof OwnServerEnvironmentConfigurationV1Schema>;

/** Author defaults once for a newly selected own-server configuration; stored readers and edits preserve omissions. */
export function createOwnServerEnvironmentConfigurationV1(
    input: Partial<OwnServerEnvironmentConfigurationV1> = {},
): OwnServerEnvironmentConfigurationV1 {
    return OwnServerEnvironmentConfigurationV1Schema.parse({
        ...input,
        rollout: input.rollout === undefined ? 'recreate' : input.rollout,
        autoRestorePreviousRelease: input.autoRestorePreviousRelease === undefined ? true : input.autoRestorePreviousRelease,
        backupBeforeMigration: input.backupBeforeMigration === undefined ? true : input.backupBeforeMigration,
        migrationFailurePolicy: input.migrationFailurePolicy === undefined ? 'ask' : input.migrationFailurePolicy,
        serviceExports: input.serviceExports === undefined ? [] : input.serviceExports,
    });
}

export const DeploymentEnvironmentContentV1Schema = z.strictObject({
    name: text, retainPreviousDeployments: DeploymentRetainPreviousDeploymentsV1Schema,
    definition: DeploymentEnvironmentDefinitionV1Schema, bindings: z.array(EnvironmentSecretBindingV1Schema),
    ownServer: z.optional(OwnServerEnvironmentConfigurationV1Schema),
    ingress: z.optional(DeploymentIngressV1Schema),
    backup: z.optional(DeploymentEnvironmentBackupV1Schema),
    template: z.optional(DeploymentEnvironmentTemplateProvenanceV1Schema),
    previewTemplate: z.optional(DeploymentPreviewTemplateV1Schema),
    previewProvenance: z.optional(DeploymentPreviewProvenanceV1Schema),
}).check(z.refine(content => new Set(content.bindings.map(environmentSecretBindingIdentityV1)).size === content.bindings.length,
{ message: 'Binding purpose identities must be unique.' }));
export type DeploymentEnvironmentContentV1 = z.infer<typeof DeploymentEnvironmentContentV1Schema>;
/** A binding writer may replace only bindings, never another owner's content leaves. */
export function isDeploymentEnvironmentBindingsOnlyUpdateV1(
    previous: DeploymentEnvironmentContentV1, candidate: DeploymentEnvironmentContentV1,
): boolean {
    return sameStrictJsonValue({ ...previous, bindings: [] }, { ...candidate, bindings: [] });
}
export const DeploymentEnvironmentStoredContentV1Schema = deploymentStoredContentV1Schema(DeploymentEnvironmentContentV1Schema);
export type DeploymentEnvironmentStoredContentV1 = z.infer<typeof DeploymentEnvironmentStoredContentV1Schema>;

export { DeploymentEnvironmentCapabilitiesV1Schema, DeploymentEnvironmentHeaderV1Schema, DeploymentEnvironmentOwnerV1Schema };
export type { DeploymentEnvironmentHeaderV1 } from '@happier-dev/protocol';
const { contentArtifactId: _contentArtifactId, contentHeaderVersion: _contentHeaderVersion,
    contentBodyVersion: _contentBodyVersion, ...deploymentEnvironmentMetadataShape } = DeploymentEnvironmentHeaderV1Schema.shape;
export const DeploymentEnvironmentV1Schema = z.strictObject({
    ...deploymentEnvironmentMetadataShape,
    content: DeploymentEnvironmentStoredContentV1Schema,
    pendingDeploy: z.optional(DeploymentPendingDeployV1Schema),
}).check(z.refine(hasCompleteDeploymentPreviewRelationV1,
{ message: 'Preview relationships are complete and absent on standard Environments.' }));
export type DeploymentEnvironmentV1 = z.infer<typeof DeploymentEnvironmentV1Schema>;
export { DeploymentEnvironmentListResultV1Schema };
export type DeploymentEnvironmentListResultV1 = z.infer<typeof DeploymentEnvironmentListResultV1Schema>;
