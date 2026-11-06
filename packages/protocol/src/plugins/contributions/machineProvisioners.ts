import { z } from 'zod/mini';
import { isNormalizedPluginJsonSchema } from './jsonSchema.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';
import * as mini from 'zod/mini';
import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES } from '../../actions/externalActionLimits.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema, PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginActionIconV2Schema, type PluginActionContributionV2 } from '../actions/v2.js';
import { expandDeclaredInputAlternatives, resolveDeclaredInputLeaves } from '../actions/inputSchemaTraversal.js';
import { InputPathSchema, InputPredicateSchema, evaluateInputPredicate, readInputPath, readInputPredicatePaths } from '../../inputs/inputPredicates.js';
import { writeInputPath } from '../../inputs/inputFieldRuntime.js';
import { compilePluginJsonSchema } from '../actions/jsonSchemaValidation.js';
import { PluginDeclaredExecutableRefSchema } from './agentAcpTransport.js';
import { PluginJsonSchemaV2Schema, PluginLocalizedStringV2Schema, type PluginJsonSchemaV2 } from './publicTypes.js';
import { PluginJsonValueV2Schema } from './jsonSchema.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../../connect/connectedAccountPurposeIdentity.js';
import { QualifiedConnectedAccountRefSchema } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { ManagedControllerV1Schema } from '../../machines/managed/managedMachineV1.js';
import { DevcontainerEffectReviewV1Schema } from '../../machines/managed/devcontainerV1.js';
import { BillingCapabilitiesV1Schema, RetentionCapabilitiesV1Schema, ProviderPriceV1Schema,
  ManagedPrerequisiteV1Schema, ManagedLocalResourceFactsV1Schema, ProviderNativeOptionFactsV1Schema, MachineProvisionerNativeCauseV1Schema } from '../../machines/managed/providerFactsV1.js';
import { AcquireResultV1Schema, ManagedNativeOperationReferenceV1Schema, ManagedResourceV1Schema, ManagedRecoveryHintV1Schema, ManagedBootstrapCarrierV1Schema, ProviderObservationV1Schema, SharedSavedSecretRefV1Schema, type AcquireResultV1 } from '../../machines/managed/providerFactsV1.js';
import { createProtocolComposableSchema, ProtocolValidationError, defineProtocolObject, defineProtocolString, defineProtocolNumber, defineProtocolArray, defineProtocolLiteral, defineProtocolUnion, defineProtocolJsonValue, normalizePluginJsonSchema, pluginJsonValuesEqual, type ProtocolComposableSchema, type ProtocolJsonValue } from '../actions/protocolComposableSchema.js';

export const MACHINE_PROVISIONER_EFFECT_ROLES_V1 = ['acquire', 'bootstrap', 'exec', 'putFile', 'power', 'destroy', 'rebuild', 'nativeCredentialApply'] as const;
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

const strictPortableSchema = lazyZodSchema(() => PluginJsonSchemaV2Schema.check(z.superRefine((value, context) => {
  try {
    if (!isNormalizedPluginJsonSchema(value)) normalizePluginJsonSchema(value);
    if (!isClosedSchema(value)) context.addIssue({ code: 'custom', message: 'Managed native declarations require recursively closed object schemas.' });
  } catch { context.addIssue({ code: 'custom', message: 'Invalid portable managed native schema.' }); }
})));
const local = () => asProtocolZod(PluginContributionLocalIdSchema);
function nestedProjection(schema: PluginJsonSchemaV2): PluginJsonSchemaV2 {
  if (schema.$schema === undefined) return schema;
  const { $schema: _dialect, ...projection } = schema;
  return projection;
}

// This is the public manifest/classic-schema consumer seam. Facts have their
// existing Mini owners; there is no second provider-facts validation tree.
/** Older writers may omit optional result facts, but cannot redefine a retained field. */
function machineProvisionerResultMatches(declared: PluginJsonSchemaV2, canonical: PluginJsonSchemaV2): boolean {
  if (declared === canonical) return true;
  const writer = nestedProjection(declared);
  const reader = nestedProjection(canonical);
  if (sameStrictJsonValue(writer, reader)) return true;
  function projectWriterShape(expected: PluginJsonSchemaV2, supplied: PluginJsonSchemaV2): PluginJsonSchemaV2 {
    let projected = expected;
    if (expected.properties) {
      projected = { ...projected, properties: Object.fromEntries(Object.entries(expected.properties)
        .filter(([name]) => expected.required?.includes(name) || Object.hasOwn(supplied.properties ?? {}, name))
        // Resource and native-operation `value` schemas belong to the descriptor,
        // not to host fact evolution; retain their exact declared contract.
        .map(([name, schema]) => [name, name !== 'value' && supplied.properties?.[name]
          ? projectWriterShape(schema, supplied.properties[name]) : schema])) };
    }
    if (expected.items && supplied.items) {
      projected = { ...projected, items: projectWriterShape(expected.items, supplied.items) };
    }
    // Canonical role unions keep their discriminants and complete arm set.
    // This is optional-property evolution, not general JSON Schema subtyping.
    for (const keyword of ['oneOf', 'anyOf'] as const) {
      const expectedArms = expected[keyword];
      const suppliedArms = supplied[keyword];
      if (expectedArms && suppliedArms?.length === expectedArms.length) {
        projected = { ...projected, [keyword]: expectedArms.map((arm, index) => projectWriterShape(arm, suppliedArms[index]!)) };
      }
    }
    return projected;
  }
  return sameStrictJsonValue(writer, projectWriterShape(reader, writer));
}

const enrollmentRole = lazyDefinition(() => mini.enum(['server', 'personal', 'sandbox']));
export const MachineProvisionerContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: local(), title: PluginLocalizedStringV2Schema, icon: PluginActionIconV2Schema,
  resourceKind: z.string().check(z.trim(), z.minLength(1)),
  enrollmentRole: z.optional(enrollmentRole),
  kindTitle: z.optional(PluginLocalizedStringV2Schema), description: z.optional(PluginLocalizedStringV2Schema),
  launchSchema: strictPortableSchema, resourceSchema: strictPortableSchema,
  schemaVersion: z.number().check(z.int(), z.positive()),
  platforms: z.array(z.enum(['darwin', 'linux', 'win32'])).check(z.minLength(1), z.refine(values => new Set(values).size === values.length)),
  /** All required endpoints allow browser access and bootstrap needs no native SSH transport. */
  browserReachable: z.optional(z.boolean()),
  prerequisites: z.array(PluginDeclaredExecutableRefSchema),
  billing: BillingCapabilitiesV1Schema, retention: RetentionCapabilitiesV1Schema,
  actions: z.strictObject({ check: local(), options: z.optional(local()), acquire: local(), bootstrap: local(), inspect: local(), power: z.optional(local()), destroy: local(), rebuild: z.optional(local()) }),
  // References the existing options Action editor, not a second duration
  // schema or an observed resource expiry. The unit belongs to that raw input.
  nativeDurationInput: z.optional(z.strictObject({ path: InputPathSchema, unit: z.enum(['milliseconds', 'seconds']) })),
  // Where the provider's own id for a created resource lives in its resource value (the id its console
  // shows), so a host can name it without guessing native field names. Display only, never an identity.
  resourceIdPath: z.optional(InputPathSchema),
  bootstrapTransport: z.optional(z.strictObject({ kind: z.literal('native'), exec: local(), putFile: local() })),
  bootstrapCredential: z.optional(z.strictObject({ kind: z.enum(['ssh', 'native-token']) })),
  nativeCredentialDelivery: z.optional(z.strictObject({
    apply: local(), transports: z.tuple([z.literal('https_headers')]),
    preservesEndpoint: z.literal(true), perBindingMatching: z.literal(true),
  })),
  // Waive only a positively qualified native launch variant. Omission keeps
  // the Action's declared purpose required; this never grants HostAccess.
  credentialPurposeRequirements: z.optional(z.array(z.strictObject({ purpose: local(), optionalWhen: InputPredicateSchema }))),
  reconciliation: z.optional(z.strictObject({ nativeOperationSchema: strictPortableSchema, action: local(), cleanup: z.optional(local()),
    continueAcquire: z.optional(z.literal(true)) })),
}).check(z.superRefine((descriptor, context) => {
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
})));
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
    ...(descriptor.nativeCredentialDelivery ? [{ role: 'nativeCredentialApply' as const, action: descriptor.nativeCredentialDelivery.apply }] : []),
    ...(descriptor.reconciliation ? [{ role: 'reconcile' as const, action: descriptor.reconciliation.action }] : []),
    ...(descriptor.reconciliation?.cleanup ? [{ role: 'cleanup' as const, action: descriptor.reconciliation.cleanup }] : []),
  ]);
}

export function validateMachineProvisionerContributionsV1(value: Readonly<{ machineProvisioners: readonly MachineProvisionerContributionV1[]; actions: readonly PluginActionContributionV2[] }>, context: z.core.$RefinementCtx): void {
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
      const path = ['machineProvisioners', index, ...(binding.role === 'nativeCredentialApply' ? ['nativeCredentialDelivery', 'apply']
        : binding.role === 'reconcile' || binding.role === 'cleanup' ? ['reconciliation', binding.role === 'cleanup' ? 'cleanup' : 'action']
        : [descriptor.actions[binding.role as keyof typeof descriptor.actions] ? 'actions' : 'bootstrapTransport', binding.role])];
      if (!action || action.execution.target !== 'daemon' && action.execution.target !== 'account') {
        context.addIssue({ code: 'custom', path, message: 'Machine provisioner roles require a declared same-plugin Account or daemon Action.' });
        continue;
      }
      if (!action.inputSchema || !action.resultSchema) {
        context.addIssue({ code: 'custom', path, message: 'Machine provisioner roles require explicit input and result schemas.' });
        continue;
      }
      const input = machineProvisionerRoleInputProjection(descriptor, binding.role);
      // Structural admission has already parsed these documents. Matching the
      // canonical role shape proves their semantics without cloning file JSON
      // to manufacture an admitted identity. Native children were validated by
      // strictPortableSchema; mismatches retain strict malformed-schema errors.
      if (input && action.inputSchema !== input
        && !sameStrictJsonValue(nestedProjection(action.inputSchema), nestedProjection(input))) {
        if (!isNormalizedPluginJsonSchema(action.inputSchema)) normalizePluginJsonSchema(action.inputSchema);
        context.addIssue({ code: 'custom', path, message: 'Provisioner role input must use its canonical contract and declared launch/resource schema.' });
      }
      const result = machineProvisionerRoleResultProjection(descriptor, binding.role);
      const resultMatches = machineProvisionerResultMatches(action.resultSchema, result)
        || binding.role === 'destroy' && machineProvisionerResultMatches(
          action.resultSchema, MachineProvisionerPowerResultV1Schema.jsonSchema);
      if (!resultMatches) {
        if (!isNormalizedPluginJsonSchema(action.resultSchema)) normalizePluginJsonSchema(action.resultSchema);
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
  nativeCredentialDelivery: mini.optional(mini.strictObject({
    status: mini.enum(['supported', 'unsupported', 'unknown']), code: mini.optional(text()),
  })),
  status: mini.optional(PluginLocalizedStringV2Schema),
  prerequisites: mini.optional(mini.array(ManagedPrerequisiteV1Schema)),
  localResources: mini.optional(ManagedLocalResourceFactsV1Schema),
}));
export const MACHINE_PROVISIONER_DIMENSIONS_V1 = ['size', 'image', 'location', 'network', 'duration'] as const;
export type MachineProvisionerDimensionV1 = typeof MACHINE_PROVISIONER_DIMENSIONS_V1[number];
const optionSelector = lazyDefinition(() => mini.strictObject({
  dimension: mini.enum(MACHINE_PROVISIONER_DIMENSIONS_V1), optionIds: mini.array(text()),
}));
const optionPrice = lazyDefinition(() => mini.strictObject({
  ...ProviderPriceV1Schema.shape,
  /** Every selector must match; absent applicability means this owner's price always applies. */
  when: mini.optional(mini.array(optionSelector)),
}));
const optionFacts = () => ({
  available: mini.optional(mini.boolean()), prices: mini.optional(mini.array(optionPrice)),
  retention: mini.optional(RetentionCapabilitiesV1Schema), nativeFacts: mini.optional(ProviderNativeOptionFactsV1Schema),
});
const dimensionOption = lazyDefinition(() => mini.strictObject({
  id: text(), title: PluginLocalizedStringV2Schema,
  assignments: mini.array(mini.strictObject({ path: InputPathSchema, value: PluginJsonValueV2Schema })),
  ...optionFacts(),
}));
const machineProvisionerOptionsResult = lazyDefinition(() => mini.strictObject({
  code: mini.optional(mini.literal('provider_unavailable')),
  nativeCause: mini.optional(MachineProvisionerNativeCauseV1Schema),
  /** Missing base means an incomplete query, never a launch inferred from display facts. */
  base: mini.optional(mini.strictObject({ launch: PluginJsonValueV2Schema, ...optionFacts(),
    effectReview: mini.optional(DevcontainerEffectReviewV1Schema),
  })),
  dimensions: mini.strictObject({
    size: mini.array(dimensionOption), image: mini.array(dimensionOption), location: mini.array(dimensionOption),
    network: mini.array(dimensionOption), duration: mini.array(dimensionOption),
  }),
  /** Directed native adjacency only; no synthesized combination rows. */
  constraints: mini.optional(mini.array(mini.strictObject({ when: optionSelector, requires: optionSelector }))),
}).check(mini.superRefine((value, context) => {
  const ids = new Map(MACHINE_PROVISIONER_DIMENSIONS_V1.map(dimension => [dimension, new Set(value.dimensions[dimension].map(option => option.id))]));
  for (const dimension of MACHINE_PROVISIONER_DIMENSIONS_V1) {
    if (ids.get(dimension)!.size !== value.dimensions[dimension].length) context.addIssue({ code: 'custom',
      path: ['dimensions', dimension], message: 'Native option ids must be unique within their dimension.' });
  }
  const checkSelector = (selector: mini.infer<typeof optionSelector>, path: (string | number)[]) => {
    if (selector.optionIds.some(id => !ids.get(selector.dimension)!.has(id))) context.addIssue({ code: 'custom', path,
      message: 'Option applicability must reference returned native option ids.' });
  };
  value.constraints?.forEach((constraint, index) => {
    checkSelector(constraint.when, ['constraints', index, 'when']);
    checkSelector(constraint.requires, ['constraints', index, 'requires']);
  });
  const checkPrices = (prices: readonly mini.infer<typeof optionPrice>[] | undefined, path: (string | number)[]) =>
    prices?.forEach((price, index) => price.when?.forEach((selector, selectorIndex) => checkSelector(selector, [...path, index, 'when', selectorIndex])));
  checkPrices(value.base?.prices, ['base', 'prices']);
  for (const dimension of MACHINE_PROVISIONER_DIMENSIONS_V1) value.dimensions[dimension].forEach((option, index) =>
    checkPrices(option.prices, ['dimensions', dimension, index, 'prices']));
})));
export const MachineProvisionerCheckResultV1Schema = lazyZodSchema(() => z.lazy(() => machineProvisionerCheckResult));
export const MachineProvisionerOptionsResultV1Schema = lazyZodSchema(() => z.lazy(() => machineProvisionerOptionsResult));
export const MachineProvisionersListResultV1Schema = lazyZodSchema(() => z.strictObject({ controller: mini.optional(ManagedControllerV1Schema), provisioners: z.array(z.strictObject({
  contribution: asProtocolZod(PluginContributionIdentityV1Schema), occurrenceId: z.string().check(z.minLength(1)),
  acquireExecutionTarget: z.enum(['account', 'daemon']),
  descriptor: MachineProvisionerContributionV1Schema,
  credentialPurposes: z.optional(z.array(z.strictObject({
    purpose: QualifiedConnectedAccountPurposeV1Schema,
    options: z.array(z.strictObject({ value: asProtocolZod(QualifiedConnectedAccountRefSchema), label: z.string().check(z.minLength(1)) })),
  }))),
})) }).check(z.superRefine((result, context) => {
  result.provisioners.forEach((entry, entryIndex) => {
    if (entry.credentialPurposes === undefined) return;
    const seen = new Set<string>();
    entry.credentialPurposes.forEach(({ purpose }, purposeIndex) => {
      const path = ['provisioners', entryIndex, 'credentialPurposes', purposeIndex, 'purpose'];
      if (purpose.consumer.pluginId !== entry.contribution.pluginId || purpose.consumer.localId !== entry.contribution.localId
        || seen.has(purpose.purpose)) context.addIssue({ code: 'custom', path, message: 'Each provisioner credential purpose is qualified and declared once.' });
      seen.add(purpose.purpose);
    });
  });
})));
export type MachineProvisionerCheckResultV1 = mini.infer<typeof MachineProvisionerCheckResultV1Schema>;
export type MachineProvisionerOptionsResultV1 = mini.infer<typeof MachineProvisionerOptionsResultV1Schema>;
export type MachineProvisionerDimensionOptionV1 = MachineProvisionerOptionsResultV1['dimensions']['size'][number];
export type MachineProvisionerConditionalPriceV1 = mini.infer<typeof optionPrice>;
export type MachineProvisionerOptionConstraintV1 = NonNullable<MachineProvisionerOptionsResultV1['constraints']>[number];
export type MachineProvisionerSelectionV1 = Readonly<Partial<Record<MachineProvisionerDimensionV1, string>>>;
type SelectionFacts = Readonly<{
  prices: readonly mini.infer<typeof ProviderPriceV1Schema>[];
  nativeFacts: mini.infer<typeof ProviderNativeOptionFactsV1Schema>;
  retention?: MachineProvisionerContributionV1['retention'];
  effectReview?: mini.infer<typeof DevcontainerEffectReviewV1Schema>;
}>;
export type MachineProvisionerSelectionProjectionV1 = SelectionFacts & (
  Readonly<{ kind: 'ready'; launch: ProtocolJsonValue }>
  | Readonly<{ kind: 'incomplete' | 'unavailable' | 'invalid'; code: string }>
);

/** Recover only unambiguous native selections from an already authored launch. */
export function readMachineProvisionerSelectionForLaunchV1(options: MachineProvisionerOptionsResultV1,
  launch: unknown): MachineProvisionerSelectionV1 {
  const selection: Partial<Record<MachineProvisionerDimensionV1, string>> = {};
  for (const dimension of MACHINE_PROVISIONER_DIMENSIONS_V1) {
    const matching = options.dimensions[dimension].filter(option => option.assignments.every(assignment =>
      pluginJsonValuesEqual(readInputPath(launch, assignment.path), assignment.value)));
    if (matching.length === 1) selection[dimension] = matching[0]!.id;
  }
  return selection;
}

/** One selection owner for UI, headless callers and external authors. Native acquire still revalidates current facts. */
export function projectMachineProvisionerSelectionV1(input: Readonly<{
  options: MachineProvisionerOptionsResultV1;
  selection: MachineProvisionerSelectionV1;
  launchSchema: PluginJsonSchemaV2;
}>): MachineProvisionerSelectionProjectionV1 {
  const { options, selection } = input;
  const prices: mini.infer<typeof ProviderPriceV1Schema>[] = [];
  const nativeFacts: mini.infer<typeof ProviderNativeOptionFactsV1Schema> = {};
  let retention = options.base?.retention;
  let selectedRetention: MachineProvisionerContributionV1['retention'] | undefined;
  let invalid: string | undefined;
  let unavailable = options.code !== undefined || options.base?.available === false;
  let incomplete = options.base === undefined;
  const selected: MachineProvisionerDimensionOptionV1[] = [];
  const facts = () => ({ prices, nativeFacts, ...(retention ? { retention } : {}),
    ...(options.base?.effectReview ? { effectReview: options.base.effectReview } : {}) });
  for (const dimension of Object.keys(selection)) {
    if (!MACHINE_PROVISIONER_DIMENSIONS_V1.some(candidate => candidate === dimension)) invalid = 'unknown_dimension';
  }
  for (const dimension of MACHINE_PROVISIONER_DIMENSIONS_V1) {
    const id = selection[dimension];
    const entries = options.dimensions[dimension];
    if (id === undefined) { if (entries.length) incomplete = true; continue; }
    const option = entries.find(entry => entry.id === id);
    if (!option) { invalid = 'unknown_option'; continue; }
    selected.push(option);
    if (option.available === false) unavailable = true;
    if (option.retention) {
      if (selectedRetention && !pluginJsonValuesEqual(selectedRetention, option.retention)) invalid = 'conflicting_retention';
      selectedRetention = option.retention;
      retention = option.retention;
    }
  }
  for (const owner of [options.base, ...selected]) {
    for (const price of owner?.prices ?? []) {
      if (price.when && !price.when.every(condition => selection[condition.dimension] !== undefined
        && condition.optionIds.includes(selection[condition.dimension]!))) continue;
      const { when: _when, ...fact } = price;
      prices.push(fact);
    }
    for (const key of Object.keys(owner?.nativeFacts ?? {}) as (keyof typeof nativeFacts)[]) {
      const incoming = owner!.nativeFacts![key];
      const existing = nativeFacts[key];
      if (incoming === undefined) continue;
      if (key === 'monthlyCapStatus') {
        if (existing !== undefined && existing !== incoming) invalid = 'conflicting_native_facts';
        nativeFacts.monthlyCapStatus = incoming as typeof nativeFacts.monthlyCapStatus;
      } else {
        const fields = incoming as Record<string, unknown>;
        const previous = existing as Record<string, unknown> | undefined;
        if (previous && Object.entries(fields).some(([field, value]) => previous[field] !== undefined
          && !pluginJsonValuesEqual(previous[field], value))) invalid = 'conflicting_native_facts';
        Object.assign(nativeFacts, { [key]: { ...previous, ...fields } });
      }
    }
  }
  for (const dimension of MACHINE_PROVISIONER_DIMENSIONS_V1) {
    const option = options.dimensions[dimension].find(entry => entry.id === selection[dimension]);
    if (option && nativeFacts[dimension] === undefined && dimension !== 'duration') Object.assign(nativeFacts, { [dimension]: { id: option.id, title: option.title } });
  }
  for (const constraint of options.constraints ?? []) {
    const when = selection[constraint.when.dimension];
    if (when === undefined || !constraint.when.optionIds.includes(when)) continue;
    const required = selection[constraint.requires.dimension];
    if (required === undefined) incomplete = true;
    else if (!constraint.requires.optionIds.includes(required)) unavailable = true;
  }
  let launch: ProtocolJsonValue | undefined = options.base?.launch;
  const assignments = selected.flatMap(option => option.assignments);
  for (let index = 0; index < assignments.length; index++) {
    const assignment = assignments[index]!;
    if (!resolveDeclaredInputLeaves(input.launchSchema, assignment.path, 'conditional-field')) invalid = 'undeclared_selector';
    if (assignments.slice(0, index).some(previous => previous.path === assignment.path
      || previous.path.startsWith(`${assignment.path}.`) || assignment.path.startsWith(`${previous.path}.`))) invalid = 'conflicting_selectors';
    if (launch === undefined) continue;
    if (launch === null || typeof launch !== 'object' || Array.isArray(launch)) { invalid = 'invalid_launch'; continue; }
    launch = writeInputPath(launch as Readonly<Record<string, ProtocolJsonValue>>, assignment.path, assignment.value) as ProtocolJsonValue;
  }
  if (options.base?.effectReview && !pluginJsonValuesEqual(launch, options.base.launch)) invalid = 'effect_review_mismatch';
  if (invalid) return { ...facts(), kind: 'invalid', code: invalid };
  if (unavailable) return { ...facts(), kind: 'unavailable', code: options.code ?? 'option_unavailable' };
  if (incomplete || launch === undefined) return { ...facts(), kind: 'incomplete', code: 'selection_incomplete' };
  try {
    const schema = normalizePluginJsonSchema(input.launchSchema);
    if (!isClosedSchema(schema) || !compilePluginJsonSchema(schema)(launch)) return { ...facts(), kind: 'invalid', code: 'invalid_launch' };
  } catch { return { ...facts(), kind: 'invalid', code: 'invalid_launch' }; }
  return { ...facts(), kind: 'ready', launch };
}
export type MachineProvisionersListResultV1 = z.infer<typeof MachineProvisionersListResultV1Schema>;

/** A declaration-neutral projection of the existing validator, not a second parser. */
function projectRoleSchema<T>(schema: z.core.$ZodType<T>): ProtocolComposableSchema<T, T> {
  return createProtocolComposableSchema<T, T>(
    () => zodSchemaToJsonSchemaObject(schema, { target: 'draft-7' }),
    value => {
      const result = z.safeParse(schema, value);
      return result.success ? { success: true, data: result.data } : { success: false,
        error: new ProtocolValidationError(result.error.issues.map(issue => ({ code: issue.code, message: issue.message, path: issue.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number') }))),
      };
    },
  );
}
export const MachineProvisionerCheckInputV1Schema = defineProtocolObject({}, { policy: 'closed' });
export const MachineProvisionerNativeCauseProtocolV1Schema = projectRoleSchema(MachineProvisionerNativeCauseV1Schema);
export const MachineProvisionerCheckResultProtocolV1Schema = projectRoleSchema(MachineProvisionerCheckResultV1Schema);
export const MachineProvisionerOptionsResultProtocolV1Schema = projectRoleSchema(MachineProvisionerOptionsResultV1Schema);
export const MachineProvisionerAcquireResultV1Schema = projectRoleSchema(AcquireResultV1Schema);
export const MachineProvisionerBootstrapCarrierV1Schema = projectRoleSchema(ManagedBootstrapCarrierV1Schema);
export const MachineProvisionerObservationV1Schema = projectRoleSchema(ProviderObservationV1Schema);
export const MachineProvisionerPowerResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('confirmed') }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('unknown'), code: defineProtocolString({ minLength: 1 }).optional(), nativeCause: MachineProvisionerNativeCauseProtocolV1Schema.optional() }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('refused'), code: defineProtocolString({ minLength: 1 }), nativeCause: MachineProvisionerNativeCauseProtocolV1Schema.optional() }, { policy: 'closed' }),
]);
export const MachineProvisionerDestroyResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('confirmed') }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('unknown'), code: defineProtocolString({ minLength: 1 }).optional() }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('refused'), code: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' }),
  projectRoleSchema(lazyDefinition(() => mini.strictObject({
    kind: mini.literal('accepted'),
    nativeOperationRef: ManagedNativeOperationReferenceV1Schema,
  }))),
]);
export const MachineProvisionerPutFileResultV1Schema = MachineProvisionerPowerResultV1Schema;
/** Complete desired policy descriptors. Secret headers stay invocation-private. */
export const MachineProvisionerNativeCredentialBindingV1Schema = lazyZodSchema(() => z.strictObject({
  bindingKey: z.string().check(z.minLength(1)), destination: z.string().check(z.minLength(1)),
  requests: z.array(z.strictObject({ path: z.string().check(z.minLength(1)),
    methods: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
  })).check(z.minLength(1)),
  placeholder: z.strictObject({ header: z.string().check(z.minLength(1)), value: z.string().check(z.minLength(1)) }),
  attributionHeaders: z.optional(z.array(z.strictObject({
    name: z.string().check(z.minLength(1)), value: z.string(),
  }))),
}));
export type MachineProvisionerNativeCredentialBindingV1 = z.infer<typeof MachineProvisionerNativeCredentialBindingV1Schema>;
export const MachineProvisionerNativeCredentialApplyInputV1Schema = lazyZodSchema(() => z.strictObject({
  resource: ManagedResourceV1Schema,
  baseline: z.strictObject({ kind: z.literal('allow-all') }),
  bindings: z.array(MachineProvisionerNativeCredentialBindingV1Schema),
  /** Current and retiring admitted bindings prove ownership of redacted rules. */
  ownedBindings: z.optional(z.array(MachineProvisionerNativeCredentialBindingV1Schema)),
}));
export type MachineProvisionerNativeCredentialApplyInputV1<TResource = ProtocolJsonValue> =
  Omit<z.infer<typeof MachineProvisionerNativeCredentialApplyInputV1Schema>, 'resource'> & {
    resource: Omit<z.infer<typeof ManagedResourceV1Schema>, 'value'> & { value: TResource };
  };
export const MachineProvisionerNativeCredentialApplyInputProtocolV1Schema = projectRoleSchema(MachineProvisionerNativeCredentialApplyInputV1Schema);
export const MachineProvisionerNativeCredentialApplyResultV1Schema = MachineProvisionerPowerResultV1Schema;
export const MachineProvisionerRebuildResultV1Schema = projectRoleSchema(lazyDefinition(() => mini.discriminatedUnion('kind', [
  mini.strictObject({ kind: mini.literal('bound'), resource: ManagedResourceV1Schema }),
  mini.strictObject({ kind: mini.literal('unknown'), recovery: ManagedRecoveryHintV1Schema }),
  mini.strictObject({ kind: mini.literal('refused'), code: text() }),
])));
function nativeCredentialApplyInputProjection(resource: PluginJsonSchemaV2): PluginJsonSchemaV2 {
  // The structural JSON definition belongs only to the generic resource.value.
  // Replacing that value also removes its now-unreferenced open definition.
  const { definitions: _genericDefinitions, $defs: _genericDefs, ...canonical } =
    MachineProvisionerNativeCredentialApplyInputProtocolV1Schema.jsonSchema;
  const envelope = canonical.properties!.resource!;
  return { ...canonical, properties: { ...canonical.properties,
    resource: { ...envelope, properties: { ...envelope.properties, value: nestedProjection(resource) } },
  } };
}
function defineNativeCredentialApplyInput<RI, RO>(resource: ProtocolComposableSchema<RI, RO>) {
  return createProtocolComposableSchema<MachineProvisionerNativeCredentialApplyInputV1<RI>, MachineProvisionerNativeCredentialApplyInputV1<RO>>(
    () => nativeCredentialApplyInputProjection(resource.jsonSchema), value => {
      const canonical = MachineProvisionerNativeCredentialApplyInputProtocolV1Schema.safeParse(value);
      if (!canonical.success) return canonical;
      const native = resource.safeParse(canonical.data.resource.value);
      return native.success ? { success: true, data: { ...canonical.data,
        resource: { ...canonical.data.resource, value: native.data },
      } } : { success: false, error: native.error };
    });
}
function acquireResultProjection(resource: PluginJsonSchemaV2, nativeOperation?: PluginJsonSchemaV2): PluginJsonSchemaV2 {
  const canonical = MachineProvisionerAcquireResultV1Schema.jsonSchema;
  return { ...canonical, oneOf: canonical.oneOf?.filter(variant => nativeOperation !== undefined || variant.properties?.kind?.const !== 'pending').map(variant => {
    const kind = variant.properties?.kind?.const;
    if (kind !== 'bound' && kind !== 'pending') return variant;
    const key = kind === 'bound' ? 'resource' : 'nativeOperationRef';
    const declared = kind === 'bound' ? resource : nativeOperation;
    const envelope = variant.properties?.[key];
    if (!envelope || !declared) return variant;
    return { ...variant, properties: { ...variant.properties, [key]: { ...envelope, properties: { ...envelope.properties, value: nestedProjection(declared) } } } };
  }) };
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
    case 'nativeCredentialApply': return MachineProvisionerNativeCredentialApplyResultV1Schema.jsonSchema;
    case 'putFile': return MachineProvisionerPutFileResultV1Schema.jsonSchema;
    case 'power': return MachineProvisionerPowerResultV1Schema.jsonSchema;
    case 'destroy': return descriptor.reconciliation
      ? destroyResultProjection(descriptor.reconciliation.nativeOperationSchema)
      : MachineProvisionerPowerResultV1Schema.jsonSchema;
    case 'rebuild': return rebuildResultProjection(descriptor.resourceSchema);
  }
}
// The role envelopes around a descriptor's launch/resource schema do not depend
// on the descriptor: only the declared native schemas are substituted afterwards.
// Building them once keeps manifest validation from rebuilding and re-normalizing
// the same generic contracts for every role of every provisioner.
let genericRoles: Readonly<Record<'plain' | 'continueAcquire', ReturnType<typeof defineMachineProvisionerSchemas>>> | undefined;
function genericRoleSchemas(continueAcquire: boolean) {
  genericRoles ??= Object.freeze({
    plain: defineMachineProvisionerSchemas({ launch: MachineProvisionerCheckInputV1Schema, resource: MachineProvisionerCheckInputV1Schema }),
    continueAcquire: defineMachineProvisionerSchemas({ launch: MachineProvisionerCheckInputV1Schema, resource: MachineProvisionerCheckInputV1Schema, continueAcquire: true }),
  });
  return continueAcquire ? genericRoles.continueAcquire : genericRoles.plain;
}
let genericReconciliation: ReturnType<typeof defineMachineProvisionerReconciliationSchemas> | undefined;
function genericReconciliationRoleSchemas() {
  return genericReconciliation ??= defineMachineProvisionerReconciliationSchemas({ launch: MachineProvisionerCheckInputV1Schema,
    resource: MachineProvisionerCheckInputV1Schema, nativeOperation: MachineProvisionerCheckInputV1Schema });
}
function machineProvisionerRoleInputProjection(descriptor: MachineProvisionerContributionV1, role: MachineProvisionerRoleV1): PluginJsonSchemaV2 | undefined {
  // Options deliberately owns its provider-declared query, not a universal wrapper.
  if (role === 'options') return undefined;
  if (role === 'nativeCredentialApply') return nativeCredentialApplyInputProjection(descriptor.resourceSchema);
  if (role === 'cleanup') {
    if (!descriptor.reconciliation) return undefined;
    const { cleanupInput } = genericReconciliationRoleSchemas();
    return { ...cleanupInput.jsonSchema,
      properties: { nativeOperation: nestedProjection(descriptor.reconciliation.nativeOperationSchema) } };
  }
  if (role === 'reconcile' || role === 'destroy' && descriptor.reconciliation) {
    if (!descriptor.reconciliation) return undefined;
    const schemas = genericReconciliationRoleSchemas();
    const projection = (role === 'reconcile' ? schemas.input : schemas.destroyInput).jsonSchema;
    return { ...projection, anyOf: projection.anyOf!.map(variant => {
      if (variant.properties?.nativeOperation) return { ...variant,
        properties: { nativeOperation: nestedProjection(descriptor.reconciliation!.nativeOperationSchema) } };
      if (variant.properties?.resource) return { ...variant, properties: { resource: nestedProjection(descriptor.resourceSchema) } };
      const correlation = variant.properties?.correlation;
      return correlation ? { ...variant, properties: { correlation: { ...correlation,
        properties: { ...correlation.properties, launch: nestedProjection(descriptor.launchSchema) } } } } : variant;
    }) };
  }
  const roles = genericRoleSchemas(descriptor.reconciliation?.continueAcquire === true);
  const schema = role === 'check' ? roles.checkInput : role === 'acquire' ? roles.acquireInput
    : role === 'bootstrap' ? roles.bootstrapInput : role === 'power' ? roles.powerInput : role === 'rebuild' ? roles.rebuildInput
      : role === 'exec' ? roles.execInput : role === 'putFile' ? roles.putFileInput : roles.resourceInput;
  if (role === 'check') return schema.jsonSchema;
  const key = role === 'acquire' ? 'launch' : 'resource';
  const native = role === 'acquire' ? descriptor.launchSchema : descriptor.resourceSchema;
  return { ...schema.jsonSchema, properties: {
    ...schema.jsonSchema.properties, [key]: nestedProjection(native),
    ...(role === 'acquire' && descriptor.reconciliation?.continueAcquire ? { resource: nestedProjection(descriptor.resourceSchema) } : {}),
  } };
}
function defineAcquireResult<TInput, TOutput, NInput, NOutput>(resource: ProtocolComposableSchema<TInput, TOutput>, nativeOperation?: ProtocolComposableSchema<NInput, NOutput>) {
  return createProtocolComposableSchema<AcquireResultV1, AcquireResultV1>(() => acquireResultProjection(resource.jsonSchema, nativeOperation?.jsonSchema), value => {
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
function destroyResultProjection(nativeOperation: PluginJsonSchemaV2): PluginJsonSchemaV2 {
  const power = MachineProvisionerPowerResultV1Schema.jsonSchema;
  const pending = acquireResultProjection(nativeOperation, nativeOperation).oneOf
    ?.find(variant => variant.properties?.kind?.const === 'pending');
  if (!pending) throw new Error('Destroy custody requires the canonical pending native-operation envelope.');
  return { anyOf: [
    ...(power.anyOf ?? []),
    { ...pending, properties: { ...pending.properties,
      kind: { ...pending.properties!.kind, const: 'accepted' },
    } },
  ] };
}
function defineDestroyResult<NI, NO>(nativeOperation: ProtocolComposableSchema<NI, NO>) {
  return createProtocolComposableSchema(() => destroyResultProjection(nativeOperation.jsonSchema), value => {
    const canonical = MachineProvisionerDestroyResultV1Schema.safeParse(value);
    if (!canonical.success || canonical.data.kind !== 'accepted') return canonical;
    const native = nativeOperation.safeParse(canonical.data.nativeOperationRef.value);
    return native.success ? MachineProvisionerDestroyResultV1Schema.safeParse({ ...canonical.data,
      nativeOperationRef: { ...canonical.data.nativeOperationRef, value: native.data },
    }) : { success: false, error: native.error };
  });
}
function rebuildResultProjection(resource: PluginJsonSchemaV2): PluginJsonSchemaV2 {
  const replacement = acquireResultProjection(resource).oneOf?.filter(variant => ['bound', 'unknown'].includes(String(variant.properties?.kind?.const))) ?? [];
  const refused = MachineProvisionerRebuildResultV1Schema.jsonSchema.oneOf?.find(variant => variant.properties?.kind?.const === 'refused');
  return { oneOf: [...replacement, ...(refused ? [refused] : [])] };
}
function defineRebuildResult<I, O>(resource: ProtocolComposableSchema<I, O>) {
  return createProtocolComposableSchema(() => rebuildResultProjection(resource.jsonSchema), value => {
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
    destroyResult: defineDestroyResult(schemas.nativeOperation),
    cleanupInput: pending,
    cleanupResult: MachineProvisionerCleanupObservationV1Schema,
    result: defineAcquireResult(schemas.resource, schemas.nativeOperation),
  });
}
const closedRole = { policy: 'closed' } as const;
const roleString = defineProtocolString({ minLength: 1 });
const roleBoolean = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const roleBase64Character = '[A-Za-z0-9+/]';
/** A native file Action carries one fragment within the incumbent Action body
 * budget. The host reserves its actual JSON metadata before encoding bytes;
 * this is a per-call memory boundary, never a maximum installer/archive size. */
export const MACHINE_PROVISIONER_PUT_FILE_BASE64_MAX_LENGTH_V1 = EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES;
// Unroll each fixed-width group: a nested {4} repetition exhausts V8's regexp
// stack on release archives. The final assertion also rejects a trailing newline.
const roleBase64Pattern = `^(?:${roleBase64Character.repeat(4)})*(?:${roleBase64Character.repeat(2)}==|${roleBase64Character.repeat(3)}=)?$(?![\\s\\S])`;
const roleBase64 = defineProtocolString({ pattern: roleBase64Pattern });
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
export type MachineProvisionerProcessConfigV1 = Readonly<{
  environment: Readonly<{ HOME: string; HAPPIER_HOME_DIR: string }>;
  /** The top-level argv is the supervised foreground alternative. Providers
   * with a finite native process model select this host-built alternative. */
  detachedDaemonStartArgv: readonly string[];
}>;
export function defineMachineProvisionerSchemas<TLaunchInput, TLaunch, TResourceInput, TResource>(schemas: Readonly<{
  launch: ProtocolComposableSchema<TLaunchInput, TLaunch>; resource: ProtocolComposableSchema<TResourceInput, TResource>;
  continueAcquire?: true;
}>) {
  const closed = { policy: 'closed' } as const;
  return Object.freeze({
    checkInput: MachineProvisionerCheckInputV1Schema,
    nativeCredentialApplyInput: defineNativeCredentialApplyInput(schemas.resource),
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
      processConfig: defineProtocolObject({
        environment: defineProtocolObject({ HOME: roleString, HAPPIER_HOME_DIR: roleString }, closed),
        detachedDaemonStartArgv: defineProtocolArray(defineProtocolString(), { minItems: 1 }),
      }, closed).optional() }, closed),
    putFileInput: defineProtocolObject({ resource: schemas.resource, guestPath: defineProtocolString({ minLength: 1 }),
      bytesBase64: defineProtocolString({ pattern: roleBase64Pattern, maxLength: MACHINE_PROVISIONER_PUT_FILE_BASE64_MAX_LENGTH_V1 }),
      mode: defineProtocolNumber({ integer: true, minimum: 0 }).optional() }, closed),
  });
}

export type { MachineProvisionerNativeCauseV1 } from '../../machines/managed/providerFactsV1.js';
