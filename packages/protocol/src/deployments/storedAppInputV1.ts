import { ProjectSourcesCreateInputV1Schema, ProjectSourceOwnerV1Schema } from '../projects/sources/projectSourceV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { parseSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import { CanonicalHttpOriginSchema } from '../http/canonicalHttpOrigin.js';
import { RegistryContentRefV1Schema, RegistryItemPointerV1Schema } from '../registries/registryContentRefV1.js';
import { PluginUiRuntimeOccurrenceIdV1Schema } from '../plugins/ui/runtimeOccurrenceV1.js';
import { asProtocolZod, projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ScmCommitOidSchema } from '../scm/commitPublication.js';
import { ScmRepositoryContainedSubdirV1Schema } from '../scm/repositoryClone.js';
import { AutomationIdV1Schema } from '../automations/automationIdV1.js';
import { AutomationTriggerIdSchema, AutomationTriggerRevisionSchema } from '../automations/automationTriggerIdentity.js';
import { AutomationOccurrenceKeyV1Schema } from '../automations/automationOccurrenceKeyV1.js';

/** Shared serialized leaves: feature-owned Environment records compose these same definitions. */
export const DeploymentDigestV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^sha256:[0-9a-f]{64}$/u)));
export const DeploymentTextV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
export const DeploymentComposeSelectorsV1Schema = lazyZodSchema(() => z.strictObject({
    profiles: z.array(DeploymentTextV1Schema), services: z.array(DeploymentTextV1Schema), primaryService: z.optional(DeploymentTextV1Schema),
}));
export const DeploymentStoredDefinitionV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('stored'), contentRevision: revision, composeDigest: DeploymentDigestV1Schema,
    document: z.string().check(z.minLength(1)), ...DeploymentComposeSelectorsV1Schema.shape,
}));
export const DeploymentRepositoryComposeV1Schema = lazyZodSchema(() => z.strictObject({
    path: ScmRepositoryContainedSubdirV1Schema, ...DeploymentComposeSelectorsV1Schema.shape,
}));
/** Authored input is normalized once to the existing stored definition before storage. */
export const DeploymentComposeDefinitionInputV1Schema = lazyZodSchema(() => z.strictObject({
    from: z.literal('compose'), document: DeploymentStoredDefinitionV1Schema.shape.document,
    ...DeploymentComposeSelectorsV1Schema.shape,
}));
export const DeploymentImageDefinitionInputV1Schema = lazyZodSchema(() => z.strictObject({
    from: z.literal('image'), image: DeploymentTextV1Schema,
    port: z.number().check(z.int(), z.minimum(1), z.maximum(65535)),
}));
export const DeploymentStoredDefinitionInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('from', [
    DeploymentComposeDefinitionInputV1Schema, DeploymentImageDefinitionInputV1Schema,
]));
export type DeploymentStoredDefinitionInputV1 = z.infer<typeof DeploymentStoredDefinitionInputV1Schema>;
/** One exact source contract for the receipt, approval and protected pending transport. */
export const DeploymentSourceIntentV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('repository'), projectSourceId: id, sourceRevision: revision, sha: ScmCommitOidSchema,
        compose: DeploymentRepositoryComposeV1Schema, pullRequestHead: z.optional(z.strictObject({ number: revision })) }),
    DeploymentStoredDefinitionV1Schema,
]));
export type DeploymentSourceIntentV1 = z.infer<typeof DeploymentSourceIntentV1Schema>;
export const DeploymentSourceIntentV1ProtocolSchema = projectZodProtocolSchema(DeploymentSourceIntentV1Schema);
export const DeploymentSourceMethodV1Schema = lazyZodSchema(() => z.enum(['gitIntegration', 'upload']));
export type DeploymentSourceMethodV1 = z.infer<typeof DeploymentSourceMethodV1Schema>;
/** Reference only: Automation owns the evidence and authenticates this exact current occurrence. */
export const DeploymentPendingTriggerOccurrenceV1Schema = lazyZodSchema(() => z.strictObject({
    automationId: asProtocolZod(AutomationIdV1Schema), triggerId: AutomationTriggerIdSchema,
    triggerRevision: AutomationTriggerRevisionSchema, occurrenceKey: AutomationOccurrenceKeyV1Schema,
}));
export type DeploymentPendingTriggerOccurrenceV1 = z.infer<typeof DeploymentPendingTriggerOccurrenceV1Schema>;
export const DeploymentPendingDeployIntentV1Schema = lazyZodSchema(() => z.strictObject({
    sourceIntent: DeploymentSourceIntentV1Schema, requestKey: id, targetLinkId: id,
    expectedLinkRevision: revision, actionOperationId: id, sourceMethod: z.optional(DeploymentSourceMethodV1Schema),
    triggerOccurrence: z.optional(DeploymentPendingTriggerOccurrenceV1Schema),
}));
export type DeploymentPendingDeployIntentV1 = z.infer<typeof DeploymentPendingDeployIntentV1Schema>;
/** The server stores this single private field; persisted Account/Artifact mode admits the arm. */
export const DeploymentPendingDeployV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
    z.strictObject({ t: z.literal('plain'), v: DeploymentPendingDeployIntentV1Schema }),
    z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
]));
export type DeploymentPendingDeployV1 = z.infer<typeof DeploymentPendingDeployV1Schema>;
const sharedSecretRef = lazyZodSchema(() => z.string().check(z.refine(value => {
    try { return parseSavedSecretRefV1(value).kind === 'shared_resource'; } catch { return false; }
}, { message: 'An exact shared Saved Secret reference is required.' })));
export const DeploymentSecretBindingSourceV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('secret'), ref: sharedSecretRef, resourceRevision: revision,
}));
const publicValue = lazyZodSchema(() => z.strictObject({ kind: z.literal('value'), value: z.string() }));
export const DeploymentNonSecretVariableBindingSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    publicValue,
    z.strictObject({ kind: z.literal('reference'), environmentId: id, export: DeploymentTextV1Schema, via: z.enum(['auto', 'privateNetwork', 'public']) }),
    z.discriminatedUnion('fact', [
        z.strictObject({ kind: z.literal('deploymentFact'), fact: z.enum(['primaryUrl', 'commitSha', 'deploymentId', 'environmentName']) }),
        z.strictObject({ kind: z.literal('deploymentFact'), fact: z.literal('domainUrl'), domainId: id }),
    ]),
]));
export const DeploymentVariableBindingSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    DeploymentSecretBindingSourceV1Schema, ...DeploymentNonSecretVariableBindingSourceV1Schema.def.options,
]));
const variableIdentity = () => ({
    purpose: z.literal('variable'), name: z.string().check(z.regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)), phase: z.enum(['build', 'runtime']),
});
export const EnvironmentVariableBindingV1Schema = lazyZodSchema(() => z.strictObject({
    ...variableIdentity(), source: DeploymentVariableBindingSourceV1Schema,
}));
export type EnvironmentVariableBindingV1 = z.infer<typeof EnvironmentVariableBindingV1Schema>;

const registryBindingIdentity = lazyZodSchema(() => z.strictObject({ purpose: z.literal('registry'), targetLinkId: id,
    registryOrigin: CanonicalHttpOriginSchema }));
const backupBindingIdentity = lazyZodSchema(() => z.strictObject({ purpose: z.literal('backupDestination'),
    configKey: z.literal('destination'), role: z.enum(['accessKeyId', 'secretAccessKey', 'sessionToken', 'repositoryPassword', 'sshPrivateKey']) }));
const domainBindingIdentity = lazyZodSchema(() => z.strictObject({ purpose: z.literal('domainCredential'), domainId: id,
    role: z.enum(['basicAuth', 'certificateChain', 'privateKey']) }));
const serviceDataRoleAddress = lazyZodSchema(() => z.strictObject({ service: DeploymentTextV1Schema }));
const managedDataRoleAddress = lazyZodSchema(() => z.strictObject({ targetLinkId: id }));
/** Self-hosted services belong to the containing Environment; only managed data uses a target link. */
export const EnvironmentDataRoleAddressV1Schema = lazyZodSchema(() => z.union([serviceDataRoleAddress, managedDataRoleAddress]));
export type EnvironmentDataRoleAddressV1 = z.infer<typeof EnvironmentDataRoleAddressV1Schema>;
const serviceDataBindingIdentity = lazyZodSchema(() => z.strictObject({ purpose: z.literal('dataRole'),
    role: z.literal('readOnlyPassword'), ...serviceDataRoleAddress.shape }));
const managedDataBindingIdentity = lazyZodSchema(() => z.strictObject({ purpose: z.literal('dataRole'),
    role: z.literal('readOnlyPassword'), ...managedDataRoleAddress.shape }));
export const EnvironmentSecretBindingIdentityV1Schema = lazyZodSchema(() => z.union([
    z.strictObject(variableIdentity()), registryBindingIdentity, backupBindingIdentity, domainBindingIdentity,
    serviceDataBindingIdentity, managedDataBindingIdentity,
]));
export type EnvironmentSecretBindingIdentityV1 = z.infer<typeof EnvironmentSecretBindingIdentityV1Schema>;

/** One purpose/address definition serves persisted rows and unsettled Action input. */
function environmentSecretBindingSchema<TSource extends z.core.$ZodType>(secretSource: TSource) {
    return z.union([
        z.strictObject({ ...variableIdentity(), source: z.union([secretSource, DeploymentNonSecretVariableBindingSourceV1Schema]) }),
        z.strictObject({ ...registryBindingIdentity.shape, access: z.enum(['pull', 'pushPull']), source: secretSource }),
        z.strictObject({ ...backupBindingIdentity.shape, source: secretSource }),
        z.strictObject({ ...domainBindingIdentity.shape, source: secretSource }),
        z.strictObject({ ...serviceDataBindingIdentity.shape, source: secretSource }),
        z.strictObject({ ...managedDataBindingIdentity.shape, source: secretSource }),
    ]);
}
export const EnvironmentSecretBindingV1Schema = lazyZodSchema(() => environmentSecretBindingSchema(DeploymentSecretBindingSourceV1Schema));
export type EnvironmentSecretBindingV1 = z.infer<typeof EnvironmentSecretBindingV1Schema>;
/** A pending choice exists only in Action custody, never in an Environment Artifact. */
export const EnvironmentSecretBindingInputV1Schema = lazyZodSchema(() => environmentSecretBindingSchema(z.union([
    DeploymentSecretBindingSourceV1Schema, z.strictObject({ kind: z.literal('secret'), ref: z.literal('person_selects') }),
])));
export type EnvironmentSecretBindingInputV1 = z.infer<typeof EnvironmentSecretBindingInputV1Schema>;

/** Source revisions and registry access replace, rather than create, the same row. */
export function environmentSecretBindingIdentityV1(binding: EnvironmentSecretBindingIdentityV1): string {
    switch (binding.purpose) {
        case 'variable': return JSON.stringify([binding.purpose, binding.phase, binding.name]);
        case 'registry': return JSON.stringify([binding.purpose, binding.targetLinkId, binding.registryOrigin]);
        case 'backupDestination': return JSON.stringify([binding.purpose, binding.configKey, binding.role]);
        case 'domainCredential': return JSON.stringify([binding.purpose, binding.domainId, binding.role]);
        case 'dataRole': return JSON.stringify('service' in binding
            ? [binding.purpose, 'service', binding.service, binding.role]
            : [binding.purpose, 'targetLinkId', binding.targetLinkId, binding.role]);
    }
}

/** A catalog selection pins content and version; a plugin source also binds its admitted occurrence. */
export const DeploymentTemplateRefV1Schema = lazyZodSchema(() => z.strictObject({
    ...RegistryItemPointerV1Schema.shape, ref: RegistryContentRefV1Schema,
    expectedContributorOccurrenceId: z.optional(asProtocolZod(PluginUiRuntimeOccurrenceIdV1Schema)),
}));
export const StoredAppPresetBindingV1Schema = lazyZodSchema(() => z.strictObject({
    ...variableIdentity(), source: z.discriminatedUnion('kind', [
        publicValue, DeploymentSecretBindingSourceV1Schema,
        // The pinned descriptor owns the generator profile. Saving selects a key, never a value or seed.
        z.strictObject({ kind: z.literal('generated'), key: DeploymentTextV1Schema }),
    ]),
}));
export const StoredAppPresetBindingsV1Schema = lazyZodSchema(() => z.array(StoredAppPresetBindingV1Schema).check(
    z.refine(bindings => new Set(bindings.map(binding => JSON.stringify([binding.phase, binding.name]))).size === bindings.length,
        { message: 'Variable phase/name identities must be unique.' })));
/** Inert reusable authoring intent. Normalization, defaults and all writes remain P40/P45 owned. */
export const StoredAppPresetInputV1Schema = lazyZodSchema(() => z.strictObject({
    name: DeploymentTextV1Schema,
    project: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('existing'), projectSourceId: id }),
        z.strictObject({ kind: z.literal('create') }),
    ]),
    definition: z.discriminatedUnion('from', [
        DeploymentComposeDefinitionInputV1Schema,
        z.strictObject({ from: z.literal('catalogApp'), templateRef: DeploymentTemplateRefV1Schema }),
    ]),
    bindings: StoredAppPresetBindingsV1Schema,
}));
export type StoredAppPresetInputV1 = z.infer<typeof StoredAppPresetInputV1Schema>;

export const DeploymentNewProjectV1Schema = lazyZodSchema(() => z.extend(z.pick(ProjectSourcesCreateInputV1Schema,
    { name: true, requestKey: true }), { owner: ProjectSourceOwnerV1Schema }));
export type DeploymentNewProjectV1 = z.infer<typeof DeploymentNewProjectV1Schema>;
export function hasOneDeploymentProjectV1(source: unknown, newProject: unknown): boolean {
    return (source === undefined) !== (newProject === undefined);
}
/** One catalog operand is shared by presets and ordinary Environment creation. */
export const DeploymentCatalogAppDefinitionInputV1Schema = lazyZodSchema(() => z.strictObject({
    from: z.literal('catalogApp'), templateRef: DeploymentTemplateRefV1Schema,
}));
