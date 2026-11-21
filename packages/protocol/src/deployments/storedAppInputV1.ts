import { createActionExecuteFailureError } from '../actions/actionExecutionResult.js';
import { withActionFailureCauseDiagnostic } from '../actions/executor/actionFailureDiagnostic.js';
import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { SharedSavedSecretReferenceSelectionV1Schema } from '../account/settings/savedSecretReferenceV1.js';
import { CanonicalHttpOriginSchema } from '../http/canonicalHttpOrigin.js';
import { RegistryContentRefV1Schema, RegistryItemPointerV1Schema } from '../registries/registryContentRefV1.js';
import { PluginUiRuntimeOccurrenceIdV1Schema } from '../plugins/ui/runtimeOccurrenceV1.js';
import { asProtocolZod, projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ScmCommitOidSchema } from '../scm/commitPublication.js';
import { ScmRepositoryContainedSubdirV1Schema } from '../scm/repositoryClone.js';
import { AutomationIdV1Schema } from '../automations/automationIdV1.js';
import { AutomationTriggerIdSchema, AutomationTriggerRevisionSchema } from '../automations/automationTriggerIdentity.js';
import { AutomationOccurrenceKeyV1Schema } from '../automations/automationOccurrenceKeyV1.js';
import { ProjectSourcesCreateInputV1Schema, ProjectSourceOwnerV1Schema } from '../projects/sources/projectSourceV1.js';
import { WorkspaceManifestRelativePathSchema } from '../workspaces/manifestSchema.js';
import { CloudflareTunnelConnectorsPerMachineV1Schema } from './cloudflareTunnelConnectorsV1.js';

/** Source syntax only; native Compose remains the effective model and merge owner. */
export async function parseDeploymentComposeSourceV1(document: string): Promise<Record<string, unknown>> {
    const yaml = await import('yaml');
    let value: unknown;
    try { value = { ...yaml.default, ...yaml }.parse(document, { merge: true }); }
    catch (error) { throw withActionFailureCauseDiagnostic(createActionExecuteFailureError({ ok: false,
        errorCode: 'invalid_request', error: 'Invalid Compose source' }), error, 'deployment.compose.parse'); }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw createActionExecuteFailureError({ ok: false, errorCode: 'invalid_request', error: 'Invalid Compose source' });
    return value as Record<string, unknown>;
}

/** Shared serialized leaves: feature-owned Environment records compose these same definitions. */
export const DeploymentDigestV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^sha256:[0-9a-f]{64}$/u)));
export const DeploymentTextV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
/** Release preferences shared by private Environment records and reviewed update operands. */
export const OwnServerEnvironmentReleasePolicyV1Schema = z.strictObject({
    rollout: z.enum(['recreate', 'startFirst']), autoRestorePreviousRelease: z.boolean(),
});
const migrationArgv = z.array(z.string()).check(z.minLength(1),
    z.refine(argv => (argv[0]?.trim().length ?? 0) > 0, { message: 'A migration command requires an executable.' }));
/** Saved candidate commands and reviewed updates consume the same migration policy. */
export const OwnServerEnvironmentMigrationPolicyV1Schema = z.strictObject({
    migration: z.optional(z.strictObject({ service: DeploymentTextV1Schema, argv: migrationArgv,
        pendingCheck: z.optional(z.strictObject({ argv: migrationArgv })) })),
    backupBeforeMigration: z.optional(z.boolean()),
    migrationFailurePolicy: z.optional(z.enum(['ask', 'restoreBackupAndRollbackCode', 'rollbackCodeOnly'])),
});
function serviceExportNetworkMatchesExposure(value: Readonly<{
    exposure: string; privateNetwork?: string; transport?: Readonly<{ kind: 'iroh' }>;
}>): boolean {
    if (value.transport?.kind === 'iroh' && value.exposure === 'public') return false;
    return value.exposure === 'privateNetwork' ? value.privateNetwork !== undefined : value.privateNetwork === undefined;
}
function serviceExportKeysAreUnique(exports: ReadonlyArray<Readonly<{ key: string }>>): boolean {
    return new Set(exports.map(value => value.key)).size === exports.length;
}
/** Stored declarations retain public exports; Iroh destinations stay loopback even when an export also names a private network. */
export const DeploymentServiceExportV1Schema = lazyZodSchema(() => z.strictObject({
    key: DeploymentTextV1Schema, service: DeploymentTextV1Schema,
    containerPort: z.number().check(z.int(), z.minimum(1), z.maximum(65535)),
    scheme: z.string().check(z.regex(/^[a-z][a-z0-9+.-]*$/iu)),
    exposure: z.enum(['public', 'privateNetwork', 'loopback']), privateNetwork: z.optional(DeploymentTextV1Schema),
    transport: z.optional(z.strictObject({ kind: z.literal('iroh') })),
}).check(z.refine(serviceExportNetworkMatchesExposure,
    { message: 'Private network exports name their exact network; Iroh transport requires privateNetwork or loopback exposure.' })));
export const DeploymentServiceExportsV1Schema = lazyZodSchema(() => z.array(DeploymentServiceExportV1Schema)
    .check(z.refine(serviceExportKeysAreUnique, { message: 'Service export keys must be unique.' })));
export type DeploymentServiceExportV1 = z.infer<typeof DeploymentServiceExportV1Schema>;
export const DeploymentPrivateServiceExportsV1Schema = lazyZodSchema(() => z.array(DeploymentServiceExportV1Schema.check(
    z.refine(value => value.exposure === 'privateNetwork' || value.transport?.kind === 'iroh',
        { message: 'Private authoring requires an exact private network or Iroh transport.' })))
    .check(z.refine(serviceExportKeysAreUnique, { message: 'Service export keys must be unique.' })));
export const OwnServerEnvironmentConfigurationV1Schema = z.strictObject({
    ...OwnServerEnvironmentReleasePolicyV1Schema.shape,
    ...OwnServerEnvironmentMigrationPolicyV1Schema.shape,
    serviceExports: z.optional(DeploymentServiceExportsV1Schema),
});
export type OwnServerEnvironmentConfigurationV1 = z.infer<typeof OwnServerEnvironmentConfigurationV1Schema>;

/** Environment ingress intent. Source/placement admission validates the referenced edge and serving topology. */
export const DeploymentIngressV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('cloudflareTunnel'), connectorsPerMachine: z.optional(CloudflareTunnelConnectorsPerMachineV1Schema) }),
    z.strictObject({ kind: z.literal('edgeCaddy'), edgeMachineId: id }),
]));
export type DeploymentIngressV1 = z.infer<typeof DeploymentIngressV1Schema>;
/** Target enablement may offer retention without changing the allocation silently. */
export const DeploymentTargetManagedRetentionV1Schema = lazyZodSchema(() => z.enum(['keep', 'until-delete']));
export const DeploymentComposeSelectorsV1Schema = lazyZodSchema(() => z.strictObject({
    profiles: z.array(DeploymentTextV1Schema), services: z.array(DeploymentTextV1Schema), primaryService: z.optional(DeploymentTextV1Schema),
}));
/** An operation restriction, distinct from the complete stored source selectors. */
export const DeploymentServiceSubsetV1Schema = lazyZodSchema(() => DeploymentComposeSelectorsV1Schema.shape.services.check(
    z.minLength(1), z.refine(values => new Set(values).size === values.length, { message: 'Select each service once.' })));
/** Exact public source files travel with the stored Compose source and its digest. */
export const DeploymentComposePublicFilesV1Schema = lazyZodSchema(() => z.array(z.strictObject({
    path: WorkspaceManifestRelativePathSchema.check(z.refine(value => !/[\\\0:]/u.test(value)
        && value.split('/').every(segment => !/[. ]$/u.test(segment)), 'Public file paths must be portable')),
    content: z.string(),
})).check(z.superRefine((files, context) => {
    const paths = new Set(files.map(file => file.path.toLowerCase()));
    const seen = new Set<string>();
    for (const [index, file] of files.entries()) {
        const path = file.path.toLowerCase();
        const ancestors = path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));
        if (path === 'compose.yaml' || path.startsWith('compose.yaml/') || seen.has(path)
            || ancestors.some(ancestor => paths.has(ancestor))) {
            context.addIssue({ code: 'custom', path: [index, 'path'], message: 'Public files must not collide with the Compose source or each other.' });
        }
        seen.add(path);
    }
})));
export const DeploymentStoredDefinitionV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('stored'), contentRevision: revision, composeDigest: DeploymentDigestV1Schema,
    document: z.string().check(z.minLength(1)), publicFiles: z.optional(DeploymentComposePublicFilesV1Schema), ...DeploymentComposeSelectorsV1Schema.shape,
}));
export const DeploymentRepositoryComposeV1Schema = lazyZodSchema(() => z.strictObject({
    path: ScmRepositoryContainedSubdirV1Schema, ...DeploymentComposeSelectorsV1Schema.shape,
}));
/** Repository selection provenance shares one persisted owner. */
export const DeploymentRepositoryDefinitionV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('repository'), ref: DeploymentTextV1Schema, compose: z.optional(DeploymentRepositoryComposeV1Schema),
}));
export type DeploymentRepositoryDefinitionV1 = z.infer<typeof DeploymentRepositoryDefinitionV1Schema>;
/** Authored input is normalized once to the existing stored definition before storage. */
export const DeploymentComposeDefinitionInputV1Schema = lazyZodSchema(() => z.strictObject({
    from: z.literal('compose'), ...z.pick(DeploymentStoredDefinitionV1Schema, { document: true, publicFiles: true }).shape,
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
        compose: z.optional(DeploymentRepositoryComposeV1Schema), pullRequestHead: z.optional(z.strictObject({ number: revision })) }),
    DeploymentStoredDefinitionV1Schema,
]));
export type DeploymentSourceIntentV1 = z.infer<typeof DeploymentSourceIntentV1Schema>;
export const DeploymentSourceIntentV1ProtocolSchema = projectZodProtocolSchema(DeploymentSourceIntentV1Schema);
/**
 * A deployed revision's short name, the one every surface says (the receipt page, History, an investigation's
 * evidence): a commit's short id, or a stored definition's Compose digest.
 */
export function deploymentRevisionShortLabelV1(
    revision: Readonly<{ kind: 'repository'; sha: string }> | Readonly<{ kind: 'stored'; composeDigest: string }>,
): string {
    return revision.kind === 'repository' ? revision.sha.slice(0, 7) : revision.composeDigest.replace(/^sha256:/, '').slice(0, 7);
}
export const DeploymentSourceMethodV1Schema = lazyZodSchema(() => z.enum(['gitIntegration', 'upload']));
export type DeploymentSourceMethodV1 = z.infer<typeof DeploymentSourceMethodV1Schema>;
export const DeploymentOnFailureV1Schema = lazyZodSchema(() => z.enum(['rollbackAll', 'keepPartial']));
export type DeploymentOnFailureV1 = z.infer<typeof DeploymentOnFailureV1Schema>;
export const DEFAULT_DEPLOYMENT_ON_FAILURE_V1: DeploymentOnFailureV1 = 'rollbackAll';
/** Reference only: Automation owns the evidence and authenticates this exact current occurrence. */
export const DeploymentPendingTriggerOccurrenceV1Schema = lazyZodSchema(() => z.strictObject({
    automationId: asProtocolZod(AutomationIdV1Schema), triggerId: AutomationTriggerIdSchema,
    triggerRevision: AutomationTriggerRevisionSchema, occurrenceKey: AutomationOccurrenceKeyV1Schema,
}));
export type DeploymentPendingTriggerOccurrenceV1 = z.infer<typeof DeploymentPendingTriggerOccurrenceV1Schema>;
export const DeploymentPendingDeployIntentV1Schema = lazyZodSchema(() => z.strictObject({
    sourceIntent: DeploymentSourceIntentV1Schema, requestKey: id, targetLinkId: id,
    actionOperationId: id, sourceMethod: z.optional(DeploymentSourceMethodV1Schema),
    onFailure: z.optional(DeploymentOnFailureV1Schema),
    services: z.optional(DeploymentServiceSubsetV1Schema),
    triggerOccurrence: z.optional(DeploymentPendingTriggerOccurrenceV1Schema),
}));
export type DeploymentPendingDeployIntentV1 = z.infer<typeof DeploymentPendingDeployIntentV1Schema>;
/** The server stores this single private field; persisted Account/Artifact mode admits the arm. */
export const DeploymentPendingDeployV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
    z.strictObject({ t: z.literal('plain'), v: DeploymentPendingDeployIntentV1Schema }),
    z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
]));
export type DeploymentPendingDeployV1 = z.infer<typeof DeploymentPendingDeployV1Schema>;
/** Retained pending intent drops retired fields only at the existing storage/open boundary.
 * Mutation input remains strict; encrypted TAKE retains its exact ciphertext. */
export const DeploymentPendingDeployStoredIntentV1Schema = lazyZodSchema(() => z.object(DeploymentPendingDeployIntentV1Schema.shape));
export const DeploymentPendingDeployStoredV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
    z.strictObject({ ...DeploymentPendingDeployV1Schema.def.options[0].shape, v: DeploymentPendingDeployStoredIntentV1Schema }),
    DeploymentPendingDeployV1Schema.def.options[1],
]));
export const DeploymentSecretBindingSourceV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('secret'), ...SharedSavedSecretReferenceSelectionV1Schema.shape,
}));
export type DeploymentSecretBindingSourceV1 = z.infer<typeof DeploymentSecretBindingSourceV1Schema>;
const publicValue = lazyZodSchema(() => z.strictObject({ kind: z.literal('value'), value: z.string() }));
export const DeploymentReferenceSourceV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('reference'), environmentId: id, export: DeploymentTextV1Schema, via: z.enum(['auto', 'privateNetwork', 'public']),
    component: z.optional(z.enum(['host', 'port'])),
}));
const deploymentVariableFact = z.enum(['primaryUrl', 'commitSha', 'deploymentId', 'environmentName', 'telemetryEndpoint']);
const deploymentVariableDomainFact = z.enum(['domainUrl']);
/** Authoring choices come from the same fact schemas that admit saved bindings. */
export const DeploymentVariableFactOptionsV1 = [...deploymentVariableFact.options, ...deploymentVariableDomainFact.options] as const;
export type DeploymentVariableFactV1 = typeof DeploymentVariableFactOptionsV1[number];
export const DeploymentNonSecretVariableBindingSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    publicValue,
    DeploymentReferenceSourceV1Schema,
    z.discriminatedUnion('fact', [
        z.strictObject({ kind: z.literal('deploymentFact'), fact: deploymentVariableFact }),
        z.strictObject({ kind: z.literal('deploymentFact'), fact: deploymentVariableDomainFact, domainId: id }),
    ]),
]));
export const DeploymentVariableBindingSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    DeploymentSecretBindingSourceV1Schema, ...DeploymentNonSecretVariableBindingSourceV1Schema.def.options,
]));
const variableIdentity = () => ({
    purpose: z.literal('variable'), name: z.string().check(z.regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)), phase: z.enum(['build', 'runtime']),
});
/** Opaque per-binding address used outside Account-encrypted Environment content. */
export const EnvironmentVariableBindingGrantReferenceV1Schema = lazyZodSchema(() => z.string().check(z.uuid()));
export type EnvironmentVariableBindingGrantReferenceV1 = z.infer<typeof EnvironmentVariableBindingGrantReferenceV1Schema>;
const variableDelivery = () => ({ managedBy: z.optional(z.literal('telemetry')),
    valueFormat: z.optional(z.literal('otelAuthorizationHeader')) });
const persistedVariableIdentity = () => ({ ...variableIdentity(), ...variableDelivery(), grantRef: EnvironmentVariableBindingGrantReferenceV1Schema });
const authoredVariableIdentity = () => ({ ...variableIdentity(), ...variableDelivery(), grantRef: z.optional(EnvironmentVariableBindingGrantReferenceV1Schema) });
export const EnvironmentVariableBindingV1Schema = lazyZodSchema(() => z.strictObject({
    ...persistedVariableIdentity(), source: DeploymentVariableBindingSourceV1Schema,
}));
export type EnvironmentVariableBindingV1 = z.infer<typeof EnvironmentVariableBindingV1Schema>;
/** Authored intent may carry a writer-minted reference; persisted bindings always require one. */
export const EnvironmentVariableBindingInputV1Schema = lazyZodSchema(() => z.strictObject({
    ...authoredVariableIdentity(), source: DeploymentVariableBindingSourceV1Schema,
}));
export type EnvironmentVariableBindingInputV1 = z.infer<typeof EnvironmentVariableBindingInputV1Schema>;

const registryBindingIdentity = lazyZodSchema(() => z.strictObject({ purpose: z.literal('registry'), targetLinkId: id,
    registryOrigin: CanonicalHttpOriginSchema }));
const backupBindingIdentity = lazyZodSchema(() => z.strictObject({ purpose: z.literal('backupDestination'),
    configKey: z.literal('destination'), role: z.enum(['accessKeyId', 'secretAccessKey', 'sessionToken', 'repositoryPassword', 'sshPrivateKey']) }));
export { backupBindingIdentity as DeploymentBackupDestinationBindingIdentityV1Schema };
export const DeploymentBackupDestinationBindingIdentityV1ProtocolSchema = projectZodProtocolSchema(backupBindingIdentity);
export const DeploymentBackupDestinationCredentialRoleV1ProtocolSchema = projectZodProtocolSchema(backupBindingIdentity.shape.role);
const domainBindingIdentity = lazyZodSchema(() => z.strictObject({ purpose: z.literal('domainCredential'), domainId: id,
    role: z.enum(['basicAuth', 'certificateChain', 'privateKey']) }));
export const EnvironmentDomainCredentialBindingV1Schema = lazyZodSchema(() => z.strictObject({
    ...domainBindingIdentity.shape, source: DeploymentSecretBindingSourceV1Schema,
}));
const serviceDataRoleAddress = lazyZodSchema(() => z.strictObject({ service: DeploymentTextV1Schema }));
const managedDataRoleAddress = lazyZodSchema(() => z.strictObject({ targetLinkId: id }));
/** Self-hosted services belong to the containing Environment; only managed data uses a target link. */
export const EnvironmentDataRoleAddressV1Schema = lazyZodSchema(() => z.union([serviceDataRoleAddress, managedDataRoleAddress]));
export type EnvironmentDataRoleAddressV1 = z.infer<typeof EnvironmentDataRoleAddressV1Schema>;
const serviceDataBindingIdentity = lazyZodSchema(() => z.strictObject({ purpose: z.literal('dataRole'),
    role: z.enum(['readOnlyPassword', 'write']), ...serviceDataRoleAddress.shape }));
const managedDataBindingIdentity = lazyZodSchema(() => z.strictObject({ purpose: z.literal('dataRole'),
    role: z.enum(['readOnlyPassword', 'write']), ...managedDataRoleAddress.shape }));
export const EnvironmentSecretBindingIdentityV1Schema = lazyZodSchema(() => z.union([
    z.strictObject(variableIdentity()), registryBindingIdentity, backupBindingIdentity, domainBindingIdentity,
    serviceDataBindingIdentity, managedDataBindingIdentity,
]));
export type EnvironmentSecretBindingIdentityV1 = z.infer<typeof EnvironmentSecretBindingIdentityV1Schema>;

/** One purpose/address definition serves persisted rows and unsettled Action input. */
function backupDestinationBindingSchema<TSource extends z.core.$ZodType>(source: TSource) {
    return z.strictObject({ ...backupBindingIdentity.shape, source });
}
function environmentSecretBindingSchema<TSource extends z.core.$ZodType>(secretSource: TSource) {
    return z.union([
        z.strictObject({ ...persistedVariableIdentity(), source: z.union([secretSource, DeploymentNonSecretVariableBindingSourceV1Schema]) }),
        z.strictObject({ ...registryBindingIdentity.shape, access: z.enum(['pull', 'pushPull']), source: secretSource }),
        backupDestinationBindingSchema(secretSource),
        z.strictObject({ ...domainBindingIdentity.shape, source: secretSource }),
        z.strictObject({ ...serviceDataBindingIdentity.shape, source: secretSource }),
        z.strictObject({ ...managedDataBindingIdentity.shape, source: secretSource }),
    ]);
}
function environmentSecretBindingInputSchema<TSource extends z.core.$ZodType>(secretSource: TSource) {
    return z.union([
        z.strictObject({ ...authoredVariableIdentity(), source: z.union([secretSource, DeploymentNonSecretVariableBindingSourceV1Schema]) }),
        z.strictObject({ ...registryBindingIdentity.shape, access: z.enum(['pull', 'pushPull']), source: secretSource }),
        backupDestinationBindingSchema(secretSource),
        z.strictObject({ ...domainBindingIdentity.shape, source: secretSource }),
        z.strictObject({ ...serviceDataBindingIdentity.shape, source: secretSource }),
        z.strictObject({ ...managedDataBindingIdentity.shape, source: secretSource }),
    ]);
}
export const EnvironmentSecretBindingV1Schema = lazyZodSchema(() => environmentSecretBindingSchema(DeploymentSecretBindingSourceV1Schema));
/** The pre-reference stored producer has no grantRef; reads preserve that absence until a normal save. */
export const EnvironmentSecretBindingStoredReadV1Schema = lazyZodSchema(() => environmentSecretBindingInputSchema(DeploymentSecretBindingSourceV1Schema));
export type EnvironmentSecretBindingV1 = z.infer<typeof EnvironmentSecretBindingStoredReadV1Schema>;
const bindingIdentityProjectionSchema = lazyZodSchema(() => z.union(
    EnvironmentSecretBindingIdentityV1Schema._zod.def.options.map(identity => z.object(identity.shape)),
));
/** Keep only the canonical address when removing a persisted binding. */
export function projectEnvironmentSecretBindingIdentityV1(binding: EnvironmentSecretBindingV1): EnvironmentSecretBindingIdentityV1 {
    return bindingIdentityProjectionSchema.parse(binding);
}
/** A pending choice exists only in Action custody, never in an Environment Artifact. */
const secretBindingInputSource = lazyZodSchema(() => z.union([
    DeploymentSecretBindingSourceV1Schema, z.strictObject({ kind: z.literal('secret'), ref: z.literal('person_selects') }),
]));
export const EnvironmentBackupDestinationBindingInputV1Schema = lazyZodSchema(() => backupDestinationBindingSchema(secretBindingInputSource));
export const EnvironmentSecretBindingInputV1Schema = lazyZodSchema(() => environmentSecretBindingInputSchema(secretBindingInputSource));
export type EnvironmentSecretBindingInputV1 = z.infer<typeof EnvironmentSecretBindingInputV1Schema>;
/** Effects consume settled rows only; a pending person choice is resolved by approval first. */
export function isSettledEnvironmentSecretBindingV1(binding: EnvironmentSecretBindingInputV1): binding is EnvironmentSecretBindingV1 {
    return !(binding.source.kind === 'secret' && binding.source.ref === 'person_selects');
}

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

/** A catalog selection pins content and version; a plugin occurrence records supplier provenance. */
export const DeploymentTemplateRefV1Schema = lazyZodSchema(() => z.strictObject({
    ...RegistryItemPointerV1Schema.shape, ref: RegistryContentRefV1Schema,
    expectedContributorOccurrenceId: z.optional(asProtocolZod(PluginUiRuntimeOccurrenceIdV1Schema)),
}));
export type DeploymentTemplateRefV1 = z.infer<typeof DeploymentTemplateRefV1Schema>;
export const StoredAppPresetBindingV1Schema = lazyZodSchema(() => z.strictObject({
    ...authoredVariableIdentity(), source: z.discriminatedUnion('kind', [
        publicValue, DeploymentSecretBindingSourceV1Schema,
        // The pinned descriptor owns the generator profile. Saving selects a key, never a value or seed.
        z.strictObject({ kind: z.literal('generated'), key: DeploymentTextV1Schema }),
    ]),
}));
export const StoredAppPresetBindingsV1Schema = lazyZodSchema(() => z.array(StoredAppPresetBindingV1Schema).check(
    z.refine(bindings => new Set(bindings.map(binding => JSON.stringify([binding.phase, binding.name]))).size === bindings.length,
        { message: 'Variable phase/name identities must be unique.' })));
/** The ordinary Source creator owns this reviewed, repository-free create intent. */
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
/** Inert template Domain selections shared by reusable App intent and template preparation. */
export const DeploymentTemplateDomainBindingsV1Schema = lazyZodSchema(() => z.array(z.strictObject({
    templateDomainId: id, hostname: id,
})));
/** Inert reusable authoring intent. Normalization, defaults and all writes remain P40/P45 owned. */
export const StoredAppPresetInputV1Schema = lazyZodSchema(() => z.strictObject({
    name: DeploymentTextV1Schema,
    project: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('existing'), projectSourceId: id }),
        z.strictObject({ kind: z.literal('create') }),
    ]),
    definition: z.discriminatedUnion('from', [
        DeploymentComposeDefinitionInputV1Schema,
        DeploymentCatalogAppDefinitionInputV1Schema,
    ]),
    bindings: StoredAppPresetBindingsV1Schema,
    domainBindings: z.optional(DeploymentTemplateDomainBindingsV1Schema),
}).check(z.refine(input => input.definition.from === 'catalogApp' || input.domainBindings === undefined,
    { message: 'Template Domain selections require a catalog App.' })));
export type StoredAppPresetInputV1 = z.infer<typeof StoredAppPresetInputV1Schema>;
