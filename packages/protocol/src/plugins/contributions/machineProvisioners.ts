import { z } from 'zod';
import * as mini from 'zod/mini';
import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema, PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginActionIconV2Schema, type PluginActionContributionV2 } from '../actions/v2.js';
import { expandDeclaredInputAlternatives, resolveDeclaredInputLeaves } from '../actions/inputSchemaTraversal.js';
import { InputPathSchema, InputPredicateSchema, evaluateInputPredicate, readInputPath, readInputPredicatePaths } from '../../inputs/inputPredicates.js';
import { PluginDeclaredExecutableRefSchema } from './agentAcpTransport.js';
import { PluginJsonSchemaV2Schema, PluginLocalizedStringV2Schema, type PluginJsonSchemaV2 } from './publicTypes.js';
import { PluginJsonValueV2Schema } from './jsonSchema.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../../connect/connectedAccountPurposeIdentity.js';
import { QualifiedConnectedAccountRefSchema } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { ManagedControllerV1Schema } from '../../machines/managed/managedMachineV1.js';
import { DevcontainerEffectReviewV1Schema } from '../../machines/managed/devcontainerV1.js';
import { BillingCapabilitiesV1Schema, RetentionCapabilitiesV1Schema, ProviderPriceV1Schema,
  ManagedPrerequisiteV1Schema, ManagedLocalResourceFactsV1Schema, ProviderNativeOptionFactsV1Schema } from '../../machines/managed/providerFactsV1.js';
import { AcquireResultV1Schema, ManagedResourceV1Schema, ManagedRecoveryHintV1Schema, ManagedBootstrapCarrierV1Schema, ProviderObservationV1Schema, SharedSavedSecretRefV1Schema, type AcquireResultV1 } from '../../machines/managed/providerFactsV1.js';
import { createProtocolComposableSchema, ProtocolValidationError, defineProtocolObject, defineProtocolString, defineProtocolNumber, defineProtocolArray, defineProtocolLiteral, defineProtocolUnion, defineProtocolJsonValue, normalizePluginJsonSchema, pluginJsonValuesEqual, type ProtocolComposableSchema } from '../actions/protocolComposableSchema.js';

export const MACHINE_PROVISIONER_EFFECT_ROLES_V1 = ['acquire', 'bootstrap', 'exec', 'putFile', 'power', 'destroy', 'rebuild'] as const;
export type MachineProvisionerEffectRoleV1 = typeof MACHINE_PROVISIONER_EFFECT_ROLES_V1[number];
export type MachineProvisionerRoleV1 = 'check' | 'options' | 'inspect' | 'reconcile' | 'cleanup' | MachineProvisionerEffectRoleV1;
export const MACHINE_PROVISIONER_BOOTSTRAP_CREDENTIAL_ROLES_V1 = ['acquire', 'bootstrap', 'exec', 'putFile', 'inspect', 'reconcile', 'destroy'] as const;
export type MachineProvisionerBootstrapCredentialRoleV1 = typeof MACHINE_PROVISIONER_BOOTSTRAP_CREDENTIAL_ROLES_V1[number];
export function isMachineProvisionerBootstrapCredentialRoleV1(role: MachineProvisionerRoleV1): role is MachineProvisionerBootstrapCredentialRoleV1 {
  return MACHINE_PROVISIONER_BOOTSTRAP_CREDENTIAL_ROLES_V1.some(candidate => candidate === role);
}

function isClosedSchema(schema: PluginJsonSchemaV2): boolean {
  if ((schema.type === 'object' || schema.properties) && schema.additionalProperties !== false) return false;
  return Object.values(schema.properties ?? {}).every(isClosedSchema)
    && Object.values(schema.definitions ?? {}).every(isClosedSchema)
    && Object.values(schema.$defs ?? {}).every(isClosedSchema)
    && (!schema.items || isClosedSchema(schema.items))
    && (!schema.not || isClosedSchema(schema.not))
    && [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])].every(isClosedSchema);
}

const strictPortableSchema = lazyZodSchema(() => PluginJsonSchemaV2Schema.superRefine((value, context) => {
  try {
    normalizePluginJsonSchema(value);
    if (!isClosedSchema(value)) context.addIssue({ code: 'custom', message: 'Managed native declarations require recursively closed object schemas.' });
  } catch { context.addIssue({ code: 'custom', message: 'Invalid portable managed native schema.' }); }
}));
const local = () => asProtocolZod(PluginContributionLocalIdSchema);
function nestedProjection(schema: PluginJsonSchemaV2): PluginJsonSchemaV2 {
  const { $schema: _dialect, ...projection } = normalizePluginJsonSchema(schema);
  return projection;
}

// This is the public manifest/classic-schema consumer seam. Facts have their
// existing Mini owners; there is no second provider-facts validation tree.
export const MachineProvisionerContributionV1Schema = lazyZodSchema(() => z.object({
  id: local(), title: PluginLocalizedStringV2Schema, icon: PluginActionIconV2Schema,
  resourceKind: z.string().trim().min(1),
  kindTitle: PluginLocalizedStringV2Schema.optional(), description: PluginLocalizedStringV2Schema.optional(),
  launchSchema: strictPortableSchema, resourceSchema: strictPortableSchema,
  schemaVersion: z.number().int().positive(),
  platforms: z.array(z.enum(['darwin', 'linux', 'win32'])).min(1).refine(values => new Set(values).size === values.length),
  prerequisites: z.array(PluginDeclaredExecutableRefSchema),
  billing: BillingCapabilitiesV1Schema, retention: RetentionCapabilitiesV1Schema,
  actions: z.object({ check: local(), options: local().optional(), acquire: local(), bootstrap: local(), inspect: local(), power: local().optional(), destroy: local(), rebuild: local().optional() }).strict(),
  // References the existing options Action editor, not a second duration
  // schema or an observed resource expiry. The unit belongs to that raw input.
  nativeDurationInput: z.object({ path: InputPathSchema, unit: z.enum(['milliseconds', 'seconds']) }).strict().optional(),
  // Where the provider's own id for a created resource lives in its resource value (the id its console
  // shows), so a host can name it without guessing native field names. Display only, never an identity.
  resourceIdPath: InputPathSchema.optional(),
  bootstrapTransport: z.object({ kind: z.literal('native'), exec: local(), putFile: local() }).strict().optional(),
  bootstrapCredential: z.object({ kind: z.enum(['ssh', 'native-token']) }).strict().optional(),
  // Waive only a positively qualified native launch variant. Omission keeps
  // the Action's declared purpose required; this never grants HostAccess.
  credentialPurposeRequirements: z.array(z.object({ purpose: local(), optionalWhen: InputPredicateSchema }).strict()).optional(),
  reconciliation: z.object({ nativeOperationSchema: strictPortableSchema, action: local(), cleanup: local().optional(),
    continueAcquire: z.literal(true).optional() }).strict().optional(),
}).strict().superRefine((descriptor, context) => {
  const purposes = new Set<string>();
  descriptor.credentialPurposeRequirements?.forEach((requirement, index) => {
    const paths = readInputPredicatePaths(requirement.optionalWhen);
    if (purposes.has(requirement.purpose) || !paths.length || paths.some(path => !resolveDeclaredInputLeaves(descriptor.launchSchema, path)?.length)) {
      context.addIssue({ code: 'custom', path: ['credentialPurposeRequirements', index], message: 'Credential requirements need a unique purpose and declared launch selector paths.' });
    }
    purposes.add(requirement.purpose);
  });
  if (descriptor.resourceIdPath !== undefined && !resolveDeclaredInputLeaves(descriptor.resourceSchema, descriptor.resourceIdPath)
    ?.every(leaf => leaf.type === 'string' || leaf.type === 'integer' || leaf.type === 'number')) {
    context.addIssue({ code: 'custom', path: ['resourceIdPath'], message: 'A native resource id path must name a text or number field of every resource arm.' });
  }
  if (descriptor.bootstrapCredential?.kind === 'native-token' && !descriptor.bootstrapTransport) {
    context.addIssue({ code: 'custom', path: ['bootstrapTransport'], message: 'Native bootstrap tokens require native exec and file transport.' });
  }
  if (!descriptor.actions.power && descriptor.retention.supportedIntents.some(intent => ['start', 'stop', 'suspend', 'resume'].includes(intent))) {
    context.addIssue({ code: 'custom', path: ['actions', 'power'], message: 'Advertised native power capabilities require a power Action.' });
  }
  if (descriptor.retention.supportedIntents.includes('rebuild') && !descriptor.actions.rebuild) {
    context.addIssue({ code: 'custom', path: ['actions', 'rebuild'], message: 'Advertised rebuild requires a replacement-resource Action.' });
  }
}));
export type MachineProvisionerContributionV1 = z.infer<typeof MachineProvisionerContributionV1Schema>;

/** One purpose requirement owner shared by acquisition, retained roles and configuration. */
export function isMachineProvisionerCredentialPurposeRequiredV1(
  descriptor: Pick<MachineProvisionerContributionV1, 'credentialPurposeRequirements'>, purpose: string, launch: unknown,
): boolean {
  const requirement = descriptor.credentialPurposeRequirements?.find(entry => entry.purpose === purpose);
  if (!requirement) return true;
  const paths = readInputPredicatePaths(requirement.optionalWhen);
  return !paths.length || paths.some(path => readInputPath(launch, path) === undefined)
    || !evaluateInputPredicate(requirement.optionalWhen, launch);
}

export function readMachineProvisionerActionRolesV1(descriptor: MachineProvisionerContributionV1): readonly Readonly<{ role: MachineProvisionerRoleV1; action: string }>[] {
  return Object.freeze([
    ...Object.entries(descriptor.actions).map(([role, action]) => Object.freeze({ role: role as MachineProvisionerRoleV1, action })),
    ...(descriptor.bootstrapTransport ? [
      { role: 'exec' as const, action: descriptor.bootstrapTransport.exec },
      { role: 'putFile' as const, action: descriptor.bootstrapTransport.putFile },
    ] : []),
    ...(descriptor.reconciliation ? [{ role: 'reconcile' as const, action: descriptor.reconciliation.action }] : []),
    ...(descriptor.reconciliation?.cleanup ? [{ role: 'cleanup' as const, action: descriptor.reconciliation.cleanup }] : []),
  ]);
}

export function validateMachineProvisionerContributionsV1(value: Readonly<{ machineProvisioners: readonly MachineProvisionerContributionV1[]; actions: readonly PluginActionContributionV2[] }>, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  value.machineProvisioners.forEach((descriptor, index) => {
    if (seen.has(descriptor.id)) context.addIssue({ code: 'custom', path: ['machineProvisioners', index, 'id'], message: 'Duplicate machine provisioner id.' });
    seen.add(descriptor.id);
    const acquire = value.actions.find(action => action.id === descriptor.actions.acquire);
    descriptor.credentialPurposeRequirements?.forEach((requirement, requirementIndex) => {
      if (!acquire?.hostAccess?.includes(requirement.purpose)) context.addIssue({ code: 'custom',
        path: ['machineProvisioners', index, 'credentialPurposeRequirements', requirementIndex, 'purpose'],
        message: 'A conditional credential purpose must be declared by its acquisition Action.' });
    });
    for (const binding of readMachineProvisionerActionRolesV1(descriptor)) {
      const action = value.actions.find(candidate => candidate.id === binding.action);
      const path = ['machineProvisioners', index, ...(binding.role === 'reconcile' || binding.role === 'cleanup' ? ['reconciliation', binding.role === 'cleanup' ? 'cleanup' : 'action']
        : [descriptor.actions[binding.role as keyof typeof descriptor.actions] ? 'actions' : 'bootstrapTransport', binding.role])];
      if (!action || action.execution.target !== 'daemon') {
        context.addIssue({ code: 'custom', path, message: 'Machine provisioner roles require a declared same-plugin daemon Action.' });
        continue;
      }
      if (!action.inputSchema || !action.resultSchema) {
        context.addIssue({ code: 'custom', path, message: 'Machine provisioner roles require explicit input and result schemas.' });
        continue;
      }
      const input = machineProvisionerRoleInputProjection(descriptor, binding.role);
      if (input && !pluginJsonValuesEqual(nestedProjection(action.inputSchema), nestedProjection(input))) {
        context.addIssue({ code: 'custom', path, message: 'Provisioner role input must use its canonical contract and declared launch/resource schema.' });
      }
      const result = machineProvisionerRoleResultProjection(descriptor, binding.role);
      if (!pluginJsonValuesEqual(nestedProjection(action.resultSchema), nestedProjection(result))) {
        context.addIssue({ code: 'custom', path, message: 'Provisioner role results must use their canonical declared contract.' });
      }
      if (!isClosedSchema(action.inputSchema)) context.addIssue({ code: 'custom', path, message: 'Provisioner role input schemas must be closed.' });
      if (['check', 'options', 'inspect', 'reconcile', 'cleanup'].includes(binding.role) && action.dangerLevel !== 'safe') context.addIssue({ code: 'custom', path, message: 'Read-only provisioner roles must be safe.' });
    }
    if (descriptor.nativeDurationInput) {
      const binding = descriptor.nativeDurationInput;
      const options = value.actions.find(action => action.id === descriptor.actions.options);
      const fields = options?.inputHints?.fields.filter(field => field.path === binding.path) ?? [];
      const field = fields.length === 1 ? fields[0] : undefined;
      const leaves = options?.inputSchema ? resolveDeclaredInputLeaves(options.inputSchema, binding.path) : null;
      const alternatives = leaves?.flatMap(expandDeclaredInputAlternatives) ?? [];
      const first = alternatives[0];
      const valid = field !== undefined && field.connectedAccountOptions !== true && field.inputType === undefined
        && (field.widget === 'number' || field.widget === 'integer')
        && first !== undefined && alternatives.every(leaf => (
          (leaf.type === 'integer' || field.widget === 'number' && leaf.type === 'number')
          && pluginJsonValuesEqual(first, leaf)
        ));
      if (!valid) context.addIssue({ code: 'custom', path: ['machineProvisioners', index, 'nativeDurationInput'],
        message: 'Native duration input requires one ordinary numeric options field with an identical declared schema in every input arm.' });
    }
  });
}

const text = () => mini.string().check(mini.trim(), mini.minLength(1));
const machineProvisionerCheckResult = lazyDefinition(() => mini.strictObject({
  available: mini.boolean(), code: mini.optional(text()),
  status: mini.optional(PluginLocalizedStringV2Schema),
  prerequisites: mini.optional(mini.array(ManagedPrerequisiteV1Schema)),
  localResources: mini.optional(ManagedLocalResourceFactsV1Schema),
}));
const machineProvisionerOptionsResult = lazyDefinition(() => mini.strictObject({
  choices: mini.array(mini.strictObject({ id: text(), title: PluginLocalizedStringV2Schema,
    launch: mini.optional(PluginJsonValueV2Schema), available: mini.optional(mini.boolean()), prices: mini.optional(mini.array(ProviderPriceV1Schema)),
    /** Selected native variant capabilities replace the descriptor fallback. */
    retention: mini.optional(RetentionCapabilitiesV1Schema),
    nativeFacts: mini.optional(ProviderNativeOptionFactsV1Schema),
    effectReview: mini.optional(DevcontainerEffectReviewV1Schema),
  })),
}));
export const MachineProvisionerCheckResultV1Schema = lazyZodSchema(() => z.lazy(() => machineProvisionerCheckResult));
export const MachineProvisionerOptionsResultV1Schema = lazyZodSchema(() => z.lazy(() => machineProvisionerOptionsResult));
export const MachineProvisionersListResultV1Schema = lazyZodSchema(() => z.object({ controller: mini.optional(ManagedControllerV1Schema), provisioners: z.array(z.object({
  contribution: asProtocolZod(PluginContributionIdentityV1Schema), occurrenceId: z.string().min(1),
  descriptor: MachineProvisionerContributionV1Schema,
  credentialPurposes: z.array(z.object({
    purpose: QualifiedConnectedAccountPurposeV1Schema,
    options: z.array(z.object({ value: asProtocolZod(QualifiedConnectedAccountRefSchema), label: z.string().min(1) }).strict()),
  }).strict()).optional(),
}).strict()) }).strict().superRefine((result, context) => {
  result.provisioners.forEach((entry, entryIndex) => {
    if (entry.credentialPurposes === undefined) return;
    if (!result.controller) context.addIssue({ code: 'custom', path: ['controller'], message: 'Credential choices require their exact controller.' });
    const seen = new Set<string>();
    entry.credentialPurposes.forEach(({ purpose }, purposeIndex) => {
      const path = ['provisioners', entryIndex, 'credentialPurposes', purposeIndex, 'purpose'];
      if (purpose.consumer.pluginId !== entry.contribution.pluginId || purpose.consumer.localId !== entry.contribution.localId
        || seen.has(purpose.purpose)) context.addIssue({ code: 'custom', path, message: 'Each provisioner credential purpose is qualified and declared once.' });
      seen.add(purpose.purpose);
    });
  });
}));
export type MachineProvisionerCheckResultV1 = mini.infer<typeof MachineProvisionerCheckResultV1Schema>;
export type MachineProvisionerOptionsResultV1 = mini.infer<typeof MachineProvisionerOptionsResultV1Schema>;
export type MachineProvisionersListResultV1 = z.infer<typeof MachineProvisionersListResultV1Schema>;

/** A declaration-neutral projection of the existing validator, not a second parser. */
function projectRoleSchema<T>(schema: z.core.$ZodType<T>): ProtocolComposableSchema<T, T> {
  return lazyDefinition(() => createProtocolComposableSchema<T, T>(
    { ...z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) },
    value => {
      const result = z.safeParse(schema, value);
      return result.success ? { success: true, data: result.data } : { success: false,
        error: new ProtocolValidationError(result.error.issues.map(issue => ({ code: issue.code, message: issue.message, path: issue.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number') }))),
      };
    },
  ));
}
export const MachineProvisionerCheckInputV1Schema = defineProtocolObject({}, { policy: 'closed' });
export const MachineProvisionerCheckResultProtocolV1Schema = projectRoleSchema(MachineProvisionerCheckResultV1Schema);
export const MachineProvisionerOptionsResultProtocolV1Schema = projectRoleSchema(MachineProvisionerOptionsResultV1Schema);
export const MachineProvisionerAcquireResultV1Schema = projectRoleSchema(AcquireResultV1Schema);
export const MachineProvisionerBootstrapCarrierV1Schema = projectRoleSchema(ManagedBootstrapCarrierV1Schema);
export const MachineProvisionerObservationV1Schema = projectRoleSchema(ProviderObservationV1Schema);
export const MachineProvisionerPowerResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('confirmed') }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('unknown'), code: defineProtocolString({ minLength: 1 }).optional() }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('refused'), code: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' }),
]);
export const MachineProvisionerPutFileResultV1Schema = MachineProvisionerPowerResultV1Schema;
export const MachineProvisionerRebuildResultV1Schema = projectRoleSchema(lazyDefinition(() => mini.discriminatedUnion('kind', [
  mini.strictObject({ kind: mini.literal('bound'), resource: ManagedResourceV1Schema }),
  mini.strictObject({ kind: mini.literal('unknown'), recovery: ManagedRecoveryHintV1Schema }),
  mini.strictObject({ kind: mini.literal('refused'), code: text() }),
])));
function acquireResultProjection(resource: PluginJsonSchemaV2, nativeOperation?: PluginJsonSchemaV2): PluginJsonSchemaV2 {
  const canonical = MachineProvisionerAcquireResultV1Schema.jsonSchema;
  return normalizePluginJsonSchema({ ...canonical, oneOf: canonical.oneOf?.filter(variant => nativeOperation !== undefined || variant.properties?.kind?.const !== 'pending').map(variant => {
    const kind = variant.properties?.kind?.const;
    if (kind !== 'bound' && kind !== 'pending') return variant;
    const key = kind === 'bound' ? 'resource' : 'nativeOperationRef';
    const declared = kind === 'bound' ? resource : nativeOperation;
    const envelope = variant.properties?.[key];
    if (!envelope || !declared) return variant;
    return { ...variant, properties: { ...variant.properties, [key]: { ...envelope, properties: { ...envelope.properties, value: nestedProjection(declared) } } } };
  }) });
}
function machineProvisionerRoleResultProjection(descriptor: MachineProvisionerContributionV1, role: MachineProvisionerRoleV1): PluginJsonSchemaV2 {
  switch (role) {
    case 'check': return MachineProvisionerCheckResultProtocolV1Schema.jsonSchema;
    case 'options': return MachineProvisionerOptionsResultProtocolV1Schema.jsonSchema;
    case 'acquire': case 'reconcile': return acquireResultProjection(descriptor.resourceSchema, descriptor.reconciliation?.nativeOperationSchema);
    case 'bootstrap': return MachineProvisionerBootstrapCarrierV1Schema.jsonSchema;
    case 'inspect': return MachineProvisionerObservationV1Schema.jsonSchema;
    case 'cleanup': return MachineProvisionerCleanupObservationV1Schema.jsonSchema;
    case 'exec': return MachineProvisionerNativeExecResultV1Schema.jsonSchema;
    case 'putFile': return MachineProvisionerPutFileResultV1Schema.jsonSchema;
    case 'power': case 'destroy': return MachineProvisionerPowerResultV1Schema.jsonSchema;
    case 'rebuild': return rebuildResultProjection(descriptor.resourceSchema);
  }
}
function machineProvisionerRoleInputProjection(descriptor: MachineProvisionerContributionV1, role: MachineProvisionerRoleV1): PluginJsonSchemaV2 | undefined {
  // Options deliberately owns its provider-declared query, not a universal wrapper.
  if (role === 'options') return undefined;
  if (role === 'cleanup') {
    if (!descriptor.reconciliation) return undefined;
    const { cleanupInput } = defineMachineProvisionerReconciliationSchemas({ launch: MachineProvisionerCheckInputV1Schema,
      resource: MachineProvisionerCheckInputV1Schema, nativeOperation: MachineProvisionerCheckInputV1Schema });
    return normalizePluginJsonSchema({ ...cleanupInput.jsonSchema,
      properties: { nativeOperation: nestedProjection(descriptor.reconciliation.nativeOperationSchema) } });
  }
  if (role === 'reconcile' || role === 'destroy' && descriptor.reconciliation) {
    if (!descriptor.reconciliation) return undefined;
    const schemas = defineMachineProvisionerReconciliationSchemas({ launch: MachineProvisionerCheckInputV1Schema,
      resource: MachineProvisionerCheckInputV1Schema, nativeOperation: MachineProvisionerCheckInputV1Schema });
    const projection = (role === 'reconcile' ? schemas.input : schemas.destroyInput).jsonSchema;
    return normalizePluginJsonSchema({ ...projection, anyOf: projection.anyOf!.map(variant => {
      if (variant.properties?.nativeOperation) return { ...variant,
        properties: { nativeOperation: nestedProjection(descriptor.reconciliation!.nativeOperationSchema) } };
      if (variant.properties?.resource) return { ...variant, properties: { resource: nestedProjection(descriptor.resourceSchema) } };
      const correlation = variant.properties?.correlation;
      return correlation ? { ...variant, properties: { correlation: { ...correlation,
        properties: { ...correlation.properties, launch: nestedProjection(descriptor.launchSchema) } } } } : variant;
    }) });
  }
  const roles = defineMachineProvisionerSchemas({ launch: MachineProvisionerCheckInputV1Schema, resource: MachineProvisionerCheckInputV1Schema,
    ...(descriptor.reconciliation?.continueAcquire ? { continueAcquire: true } : {}) });
  const schema = role === 'check' ? roles.checkInput : role === 'acquire' ? roles.acquireInput
    : role === 'bootstrap' ? roles.bootstrapInput : role === 'power' ? roles.powerInput : role === 'rebuild' ? roles.rebuildInput
      : role === 'exec' ? roles.execInput : role === 'putFile' ? roles.putFileInput : roles.resourceInput;
  if (role === 'check') return schema.jsonSchema;
  const key = role === 'acquire' ? 'launch' : 'resource';
  const native = role === 'acquire' ? descriptor.launchSchema : descriptor.resourceSchema;
  return normalizePluginJsonSchema({ ...schema.jsonSchema, properties: {
    ...schema.jsonSchema.properties, [key]: nestedProjection(native),
    ...(role === 'acquire' && descriptor.reconciliation?.continueAcquire ? { resource: nestedProjection(descriptor.resourceSchema) } : {}),
  } });
}
function defineAcquireResult<TInput, TOutput, NInput, NOutput>(resource: ProtocolComposableSchema<TInput, TOutput>, nativeOperation?: ProtocolComposableSchema<NInput, NOutput>) {
  return createProtocolComposableSchema<AcquireResultV1, AcquireResultV1>(acquireResultProjection(resource.jsonSchema, nativeOperation?.jsonSchema), value => {
    const canonical = MachineProvisionerAcquireResultV1Schema.safeParse(value);
    if (!canonical.success || (canonical.data.kind !== 'bound' && canonical.data.kind !== 'pending')) return canonical;
    if (canonical.data.kind === 'pending') {
      if (!nativeOperation) return { success: false, error: new ProtocolValidationError([{ code: 'custom', path: ['nativeOperationRef'], message: 'Pending acquisition requires a declared native reconciliation contract.' }]) };
      const native = nativeOperation.safeParse(canonical.data.nativeOperationRef.value);
      return native.success ? MachineProvisionerAcquireResultV1Schema.safeParse({ ...canonical.data,
        nativeOperationRef: { ...canonical.data.nativeOperationRef, value: native.data },
      }) : { success: false, error: native.error };
    }
    const native = resource.safeParse(canonical.data.resource.value);
    return native.success ? MachineProvisionerAcquireResultV1Schema.safeParse({ ...canonical.data,
      resource: { ...canonical.data.resource, value: native.data },
    }) : { success: false, error: native.error };
  });
}
function rebuildResultProjection(resource: PluginJsonSchemaV2): PluginJsonSchemaV2 {
  const replacement = acquireResultProjection(resource).oneOf?.filter(variant => ['bound', 'unknown'].includes(String(variant.properties?.kind?.const))) ?? [];
  const refused = MachineProvisionerRebuildResultV1Schema.jsonSchema.oneOf?.find(variant => variant.properties?.kind?.const === 'refused');
  return normalizePluginJsonSchema({ oneOf: [...replacement, ...(refused ? [refused] : [])] });
}
function defineRebuildResult<I, O>(resource: ProtocolComposableSchema<I, O>) {
  return createProtocolComposableSchema(rebuildResultProjection(resource.jsonSchema), value => {
    const result = MachineProvisionerRebuildResultV1Schema.safeParse(value);
    if (!result.success || result.data.kind !== 'bound') return result;
    const native = resource.safeParse(result.data.resource.value);
    return native.success ? MachineProvisionerRebuildResultV1Schema.safeParse({ ...result.data,
      resource: { ...result.data.resource, value: native.data },
    }) : { success: false, error: native.error };
  });
}
/** The same declared result is used by acquire and read-only pending reconciliation. */
export function defineMachineProvisionerReconciliationSchemas<LI, LO, RI, RO, NI, NO>(schemas: Readonly<{
  launch: ProtocolComposableSchema<LI, LO>; resource: ProtocolComposableSchema<RI, RO>; nativeOperation: ProtocolComposableSchema<NI, NO>;
}>) {
  const closed = { policy: 'closed' } as const;
  const pending = defineProtocolObject({ nativeOperation: schemas.nativeOperation }, closed);
  return Object.freeze({
    input: defineProtocolUnion([pending, defineProtocolObject({ correlation: defineProtocolObject({
      managedId: defineProtocolString({ minLength: 1 }), requestId: defineProtocolString({ minLength: 1 }), launch: schemas.launch,
    }, closed) }, closed)]),
    destroyInput: defineProtocolUnion([defineProtocolObject({ resource: schemas.resource }, closed), pending]),
    cleanupInput: pending,
    cleanupResult: MachineProvisionerCleanupObservationV1Schema,
    result: defineAcquireResult(schemas.resource, schemas.nativeOperation),
  });
}
const closedRole = { policy: 'closed' } as const;
const roleString = defineProtocolString({ minLength: 1 });
const roleBoolean = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const roleBase64 = defineProtocolString({ pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' });
const roleRef = PluginContributionIdentityV1Schema;
/** Read-only exact cleanup evidence; retryable is native idempotency evidence,
 * never independent admission to replay an effect. */
export const MachineProvisionerCleanupObservationV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('confirmed') }, closedRole),
  defineProtocolObject({ kind: defineProtocolLiteral('retryable') }, closedRole),
  defineProtocolObject({ kind: defineProtocolLiteral('unknown'), code: roleString.optional() }, closedRole),
]);
const nativeDiagnostic = defineProtocolObject({
  code: roleString,
  severity: defineProtocolUnion([defineProtocolLiteral('info'), defineProtocolLiteral('warning'), defineProtocolLiteral('error')]),
  message: defineProtocolString().optional(), details: defineProtocolJsonValue().optional(),
  remediation: defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('retry') }, closedRole),
    defineProtocolObject({ kind: defineProtocolLiteral('openSettings'), path: roleString }, closedRole),
    defineProtocolObject({ kind: defineProtocolLiteral('selectAccount'), service: roleRef }, closedRole),
    defineProtocolObject({ kind: defineProtocolLiteral('installDependency'), dependencyId: roleString }, closedRole),
    defineProtocolObject({ kind: defineProtocolLiteral('openUrl'), url: roleString }, closedRole),
  ]).optional(),
}, closedRole);
export const MachineProvisionerNativeExecResultV1Schema = defineProtocolUnion([defineProtocolObject({
  termination: defineProtocolObject({
    observed: defineProtocolUnion([
      defineProtocolObject({ kind: defineProtocolLiteral('exit'), exitCode: defineProtocolNumber({ integer: true }) }, closedRole),
      defineProtocolObject({ kind: defineProtocolLiteral('signal'), signal: roleString }, closedRole),
      defineProtocolObject({ kind: defineProtocolLiteral('failed'), diagnostic: nativeDiagnostic }, closedRole),
    ]),
    requestedBy: defineProtocolUnion([
      defineProtocolObject({ kind: defineProtocolLiteral('none') }, closedRole),
      defineProtocolObject({ kind: defineProtocolLiteral('timeout') }, closedRole),
      defineProtocolObject({ kind: defineProtocolLiteral('abort') }, closedRole),
      defineProtocolObject({ kind: defineProtocolLiteral('dispose'), reason: defineProtocolUnion([
        defineProtocolLiteral('caller'), defineProtocolLiteral('generationRetired'),
        defineProtocolLiteral('hostShutdown'), defineProtocolLiteral('runtimeRecovery'),
      ]).optional() }, closedRole),
    ]),
  }, closedRole),
  stdoutBase64: roleBase64, stderrBase64: roleBase64, stdoutTruncated: roleBoolean, stderrTruncated: roleBoolean,
}, closedRole), defineProtocolObject({ kind: defineProtocolLiteral('process-configured') }, closedRole)]);
export function defineMachineProvisionerSchemas<TLaunchInput, TLaunch, TResourceInput, TResource>(schemas: Readonly<{
  launch: ProtocolComposableSchema<TLaunchInput, TLaunch>; resource: ProtocolComposableSchema<TResourceInput, TResource>;
  continueAcquire?: true;
}>) {
  const closed = { policy: 'closed' } as const;
  return Object.freeze({
    checkInput: MachineProvisionerCheckInputV1Schema,
    acquireInput: defineProtocolObject({ launch: schemas.launch, managedId: defineProtocolString({ minLength: 1 }).optional(), bootstrapPublicKey: defineProtocolString({ minLength: 1 }).optional(),
      ...(schemas.continueAcquire ? { resource: schemas.resource.optional() } : {}) }, closed),
    acquireResult: defineAcquireResult(schemas.resource),
    rebuildInput: defineProtocolObject({ resource: schemas.resource, reviewedEffectDigest: defineProtocolString({ minLength: 1 }) }, closed),
    rebuildResult: defineRebuildResult(schemas.resource),
    bootstrapInput: defineProtocolObject({ resource: schemas.resource, credentialRef: projectRoleSchema(SharedSavedSecretRefV1Schema).optional(), bootstrapPublicKey: defineProtocolString({ minLength: 1 }).optional() }, closed),
    resourceInput: defineProtocolObject({ resource: schemas.resource }, closed),
    powerInput: defineProtocolObject({ resource: schemas.resource, intent: defineProtocolUnion([
      defineProtocolLiteral('start'), defineProtocolLiteral('stop'), defineProtocolLiteral('suspend'),
      defineProtocolLiteral('resume'), defineProtocolLiteral('delete'), defineProtocolLiteral('rebuild'),
    ]) }, closed),
    execInput: defineProtocolObject({ resource: schemas.resource, argv: defineProtocolArray(defineProtocolString(), { minItems: 1 }),
      inputBase64: roleBase64.optional(), timeoutMs: defineProtocolNumber({ integer: true, minimum: 0 }).nullable().optional(),
      processConfig: defineProtocolObject({ environment: defineProtocolObject({ HOME: roleString, HAPPIER_HOME_DIR: roleString }, closed) }, closed).optional() }, closed),
    putFileInput: defineProtocolObject({ resource: schemas.resource, guestPath: defineProtocolString({ minLength: 1 }), bytesBase64: roleBase64, mode: defineProtocolNumber({ integer: true, minimum: 0 }).optional() }, closed),
  });
}
