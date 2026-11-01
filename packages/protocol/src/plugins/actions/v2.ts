import { maxCodeUnits } from '../../strings/maxCodeUnits.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { InputOptionValueSchema } from '../../inputs/inputFields.js';
import { QualifiedConnectedAccountRefSchema } from '../../connect/qualifiedConnectedAccountPersistence.js';

import {
  PluginActionDangerLevelV2Schema,
  PluginActionSurfaceV2Schema,
  type PluginActionDangerLevelV2,
  type PluginActionSurfaceV2,
} from './vocabulary.js';
import type { ActionDefinitionSlashV1 } from '../../actions/actionDefinitionV1.js';
import { ActionSafetySchema } from '../../actions/safetyVocabulary.js';
import { ActionContextualDefaultsSchema } from '../../actions/contextualDefaults.js';
import { InputPredicateSchema } from '../../inputs/inputPredicates.js';
import { ActionOperationDeclarationV1Schema } from '../../actions/operations/v1.js';
import { ActionSessionTargetDeclarationV1Schema } from '../../actions/sessionTargetV1.js';
import {
  createActionInputHintsSchemasWithStaticOptionsOnly,
  createActionInputHintsSchemasWithoutOptionsSource,
  normalizeActionInputHintsText,
  ActionInputPathSchema,
  type ActionInputWidget,
  type ActionInputHints,
} from '../../actions/actionInputHints.js';
import { PluginActionConnectedAccountPurposeBindingV2Schema, type PluginActionConnectedAccountPurposeBindingV2 } from './connectedAccountPurposeBindingV2.js';
export { PluginActionConnectedAccountPurposeBindingV2Schema, type PluginActionConnectedAccountPurposeBindingV2 } from './connectedAccountPurposeBindingV2.js';
import { PluginOptionalStringSchema } from '../_shared.js';
import {
  PluginAvailabilityDescriptorV2Schema,
  PluginJsonSchemaV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
  type PluginJsonSchemaV2,
  type PluginLocalizedStringV2,
} from '../contributions/publicTypes.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import {
  PluginClientExecutionPlatformsV1Schema,
  PluginClientExecutionReferenceV1Schema,
} from '../contributions/clientExecution.js';
import { asProtocolZod } from "./internalProtocolZodAdapter.js";
import { expandDeclaredInputAlternatives, resolveDeclaredInputLeaves } from './inputSchemaTraversal.js';
export { resolveDeclaredInputLeaves } from './inputSchemaTraversal.js';
export { PluginJsonSchemaV2Schema, type PluginJsonSchemaV2 as PluginJsonSchema } from '../contributions/publicTypes.js';
export type { PluginJsonValueV2 as PluginJsonValue } from '../contributions/publicTypes.js';
export {
  PluginActionDangerLevelV2Schema,
  PluginActionSurfaceV2Schema,
  type PluginActionDangerLevelV2,
  type PluginActionSurfaceV2,
};

export const PluginActionDefinitionExamplesV1Schema = lazyZodSchema(() => z.strictObject({
    voice: z.optional(z.strictObject({
        argsExample: z.optional(z.string().check(z.minLength(1))),
      })),
    mcp: z.optional(z.strictObject({
        argsExample: z.optional(z.string().check(z.minLength(1))),
      })),
    sdk: z.optional(z.strictObject({
        codeExample: z.optional(z.string().check(z.minLength(1))),
      })),
  }));
export type PluginActionDefinitionExamplesV1 = z.infer<typeof PluginActionDefinitionExamplesV1Schema>;

export const PluginActionScopeV2Schema = lazyZodSchema(() => z.enum([
  'global',
  'settings',
  'agent',
  'session',
  'message',
  'transcript',
  'executionRun',
  'toolResult',
  'workspace',
  'machine',
]));
export type PluginActionScopeV2 = z.infer<typeof PluginActionScopeV2Schema>;

/**
 * Tool invocation is intentionally a smaller, independent surface grammar.
 * Adding an Action-only surface must never silently make it available to Tools.
 */
export const PluginToolSurfaceV2Schema = lazyZodSchema(() => z.enum(['cli', 'mcp', 'agent']));
export type PluginToolSurfaceV2 = z.infer<typeof PluginToolSurfaceV2Schema>;

/**
 * One contributed Action has one explicit execution realm. The client tuple
 * identifies the exact client activation module entitled to register it.
 */
export const PluginActionExecutionV2Schema = lazyZodSchema(() => z.discriminatedUnion('target', [
  z.strictObject({
    target: z.literal('daemon'),
  }),
  z.strictObject({
    target: z.literal('account'),
    account: PluginClientExecutionReferenceV1Schema,
  }),
  z.strictObject({
    target: z.literal('client'),
    client: PluginClientExecutionReferenceV1Schema,
    platforms: PluginClientExecutionPlatformsV1Schema,
  }),
]));
export type PluginActionExecutionV2 = z.infer<typeof PluginActionExecutionV2Schema>;

export const PluginActionDeclaredExecutionV2Schema = PluginActionExecutionV2Schema;

export const PluginActionPlacementV2Schema = lazyZodSchema(() => z.enum([
  'primary',
  'secondary',
  'rowAction',
  'contextMenu',
  'commandPalette',
  'toolbar',
  'detailsPanel',
  'composer.primary',
  'composer.more',
  'composer.slash',
  'message.menu',
]));
export type PluginActionPlacementV2 = z.infer<typeof PluginActionPlacementV2Schema>;

/**
 * Ordered semantic destinations for one Action. This is intentionally distinct
 * from the legacy generic `ActionSpec.placements` taxonomy retained by the
 * CLI's normalization shell. An explicit empty collection declares
 * authenticated mounted-UI-only reachability; omitting this optional field is
 * no placement decision, and a raw UI declaration that omits it is rejected.
 */
export const PluginActionPlacementBindingsV2Schema = lazyZodSchema(() => z.array(
  PluginActionPlacementV2Schema,
).check(z.maxLength(11), z.superRefine((bindings, context) => {
  const seen = new Set<PluginActionPlacementV2>();
  bindings.forEach((binding, index) => {
    if (seen.has(binding)) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: 'Duplicate Action placement binding.',
      });
    }
    seen.add(binding);
  });
})));
export type PluginActionPlacementBindingsV2 = z.infer<
  typeof PluginActionPlacementBindingsV2Schema
>;

export const PluginActionIconV2Schema = lazyZodSchema(() => z.string().check(z.trim(), z.regex(/^[a-z][a-z0-9.-]*$/i)));

const PluginActionSlashTokenV2Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(2), z.maxLength(128), z.regex(/^\/\S+$/u, 'Composer slash tokens must begin with "/" and contain no whitespace.')));

/**
 * Bounded composer-command presentation metadata for a contributed Action.
 * The Action remains the sole execution owner; this only declares slash-picker
 * presentation for UI-mounted actions.
 */
export const PluginActionSlashV2Schema = lazyZodSchema(() => z.strictObject({
  tokens: z.array(PluginActionSlashTokenV2Schema).check(z.minLength(1), z.maxLength(8), z.superRefine((tokens, ctx) => {
    const seen = new Set<string>();
    tokens.forEach((token, index) => {
      if (seen.has(token)) {
        ctx.addIssue({ code: "custom", path: [index], message: 'Duplicate composer slash token.' });
      }
      seen.add(token);
    });
  })),
}));
export type PluginActionSlashV2 = z.infer<typeof PluginActionSlashV2Schema>;

/**
 * Identifies surfaces that participate in host placement discovery. The
 * `plugin` surface is the only trusted programmatic surface; every other
 * current surface retains its presentation contract, so this helper must not
 * be used to manufacture a placement.
 */
export function pluginActionRequiresPlacement(
  surfaces: readonly PluginActionSurfaceV2[],
): boolean {
  return surfaces.includes('ui');
}

export function pluginActionRequiresConfirmationPresentation(
  surfaces: readonly PluginActionSurfaceV2[],
  dangerLevel: PluginActionDangerLevelV2,
): boolean {
  return dangerLevel !== 'safe' && surfaces.some((surface) => surface !== 'plugin');
}

export const PluginActionAvailabilityV2Schema = PluginAvailabilityDescriptorV2Schema;
export type PluginActionAvailabilityV2 = z.infer<typeof PluginActionAvailabilityV2Schema>;

export const PLUGIN_ACTION_CONFIRMATION_PRESENTATION_LIMITS_V2 = Object.freeze({
  titleUtf16Units: 1_024,
  bodyUtf16Units: 4_096,
});

function createPluginActionConfirmationPresentationTextSchema(maxUtf16Units: number) {
  return z.union([
    z.string().check(z.trim(), z.minLength(1), maxCodeUnits(maxUtf16Units)),
    z.strictObject({
      key: z.string().check(z.trim(), z.minLength(1), maxCodeUnits(maxUtf16Units)),
      fallback: z.string().check(z.trim(), z.minLength(1), maxCodeUnits(maxUtf16Units)),
    }),
  ]);
}

const PluginActionConfirmationTitleV2Schema = createPluginActionConfirmationPresentationTextSchema(
  PLUGIN_ACTION_CONFIRMATION_PRESENTATION_LIMITS_V2.titleUtf16Units,
);
const PluginActionConfirmationBodyV2Schema = createPluginActionConfirmationPresentationTextSchema(
  PLUGIN_ACTION_CONFIRMATION_PRESENTATION_LIMITS_V2.bodyUtf16Units,
);

/** Statically reviewed operands; values come only from the admitted Action input. */
export const PluginActionConfirmationInputFieldV2Schema = lazyZodSchema(() => z.strictObject({
  path: ActionInputPathSchema,
  title: PluginActionConfirmationTitleV2Schema,
}));
export type PluginActionConfirmationInputFieldV2 = z.infer<typeof PluginActionConfirmationInputFieldV2Schema>;

export const PluginActionConfirmationV2Schema = lazyZodSchema(() => z.strictObject({
  title: PluginActionConfirmationTitleV2Schema,
  body: z.optional(PluginActionConfirmationBodyV2Schema),
  confirmLabel: z.optional(PluginActionConfirmationTitleV2Schema),
  inputFields: z.optional(z.array(PluginActionConfirmationInputFieldV2Schema)),
}));
export type PluginActionConfirmationV2 = z.infer<typeof PluginActionConfirmationV2Schema>;

/** Flat predicates apply everywhere; the scoped form preserves automation defaults. */
export const PluginActionConfirmationWhenV2Schema = lazyZodSchema(() => z.union([
  InputPredicateSchema,
  z.strictObject({ presentUserUi: z.union([z.boolean(), InputPredicateSchema]) }),
]));
export type PluginActionConfirmationWhenV2 = z.infer<typeof PluginActionConfirmationWhenV2Schema>;

// Only the purpose-derived field capability may offer Connected Account choices.
// Other typed choices still carry strict JSON through the neutral value owner.
const PluginActionStaticOptionValueV2Schema = lazyZodSchema(() => InputOptionValueSchema.check(z.refine(value => !QualifiedConnectedAccountRefSchema.safeParse(value).success, { message: 'Static Connected Account choices require the purpose-derived field capability.' })));

const PluginActionInputHintsSchemasV2 = createActionInputHintsSchemasWithoutOptionsSource(
  PluginLocalizedStringV2Schema,
  PluginActionStaticOptionValueV2Schema,
);

const PluginToolInputHintsSchemasV2 = createActionInputHintsSchemasWithStaticOptionsOnly(
  PluginLocalizedStringV2Schema,
  z.string().check(z.trim(), z.minLength(1)),
);

/** Plugin authors have no arbitrary option-source selector. */
export const PluginActionInputHintsV2Schema = PluginActionInputHintsSchemasV2.hintsSchema;
export type PluginActionInputHintsV2 = z.infer<typeof PluginActionInputHintsV2Schema>;

/**
 * One explicit credential-ref input path to one declared Connected Account
 * purpose. Host adapters consume this mapping; field names and request order
 * are never authorization inputs.
 */
/** Tools cannot request host-resolved Action-form options. */
export const PluginToolInputHintsV2Schema = PluginToolInputHintsSchemasV2.hintsSchema;
export type PluginToolInputHintsV2 = z.infer<typeof PluginToolInputHintsV2Schema>;

/** One declaration is traversable when every representable input arm is an object. */
function declaresTraversableObjectInput(
  inputSchema: PluginJsonSchemaV2 | undefined,
): boolean {
  if (!inputSchema) return false;
  const arms = expandDeclaredInputAlternatives(inputSchema);
  return arms.length > 0 && arms.every((arm) => arm.type === 'object');
}

function canonicalDeclaredSchemaJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalDeclaredSchemaJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entryValue]) => (
      `${JSON.stringify(key)}:${canonicalDeclaredSchemaJson(entryValue)}`
    )).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A bound credential-ref path carries one declaration, not per-arm variants: an
 * arm that narrows the service, the account, or the leaf's nullability differently
 * would let one representable input request a credential the binding never proved.
 */
function declaredInputLeavesAgree(leaves: readonly PluginJsonSchemaV2[]): boolean {
  const [first, ...rest] = leaves;
  if (!first) return false;
  const canonicalFirst = canonicalDeclaredSchemaJson(first);
  return rest.every((leaf) => canonicalDeclaredSchemaJson(leaf) === canonicalFirst);
}

function isExactQualifiedConnectedAccountRefInputLeaf(
  inputLeaf: PluginJsonSchemaV2,
): boolean {
  if (
    inputLeaf.type !== 'object'
    || inputLeaf.additionalProperties !== false
    || !inputLeaf.properties
    || Object.keys(inputLeaf.properties).length !== 2
    || !inputLeaf.required
    || inputLeaf.required.length !== 2
    || !inputLeaf.required.includes('service')
    || !inputLeaf.required.includes('accountId')
  ) return false;
  const service = inputLeaf.properties.service;
  const accountId = inputLeaf.properties.accountId;
  if (!service || !isExactQualifiedServiceInputLeaf(service)) return false;
  return accountId?.type === 'string';
}

function isExactQualifiedServiceInputLeaf(service: PluginJsonSchemaV2): boolean {
  const alternatives = expandDeclaredInputAlternatives(service);
  if (alternatives.length !== 1 || alternatives[0] !== service) {
    return alternatives.every(isExactQualifiedServiceInputLeaf);
  }
  if (
    service.type !== 'object'
    || service.additionalProperties !== false
    || !service.properties
    || Object.keys(service.properties).length !== 2
    || !service.required
    || service.required.length !== 2
    || !service.required.includes('pluginId')
    || !service.required.includes('localId')
  ) return false;
  return [service.properties.pluginId, service.properties.localId].every((identity) => (
    identity?.type === 'string'
    || identity?.type === undefined && typeof identity?.const === 'string'
  ));
}

function isExactOrNullableQualifiedConnectedAccountRefInputLeaf(
  inputLeaf: PluginJsonSchemaV2,
): boolean {
  if (isExactQualifiedConnectedAccountRefInputLeaf(inputLeaf)) return true;
  const alternatives = inputLeaf.oneOf ?? inputLeaf.anyOf;
  return alternatives?.length === 2
    && alternatives.some((alternative) => (
      alternative.type === 'null'
    ))
    && alternatives.some(isExactQualifiedConnectedAccountRefInputLeaf) === true;
}

function resolveOptionalDeclaredInputLeaves(
  inputSchema: PluginJsonSchemaV2,
  segments: readonly string[],
): readonly (PluginJsonSchemaV2 | undefined)[] {
  if (segments.length === 0) return [inputSchema];
  const [segment, ...remaining] = segments;
  return expandDeclaredInputAlternatives(inputSchema).flatMap((arm) => {
    const property = arm.type === 'object' && segment !== undefined ? arm.properties?.[segment] : undefined;
    return property ? resolveOptionalDeclaredInputLeaves(property, remaining) : [undefined];
  });
}

/** Preserve correlation while both paths traverse the same union-shaped selection. */
function resolveDeclaredSelectionPairs(
  inputSchema: PluginJsonSchemaV2,
  accountPath: readonly string[],
  nativePath: readonly string[],
): readonly Readonly<{ account?: PluginJsonSchemaV2; native?: PluginJsonSchemaV2 }>[] {
  return expandDeclaredInputAlternatives(inputSchema).flatMap((arm) => {
    if (accountPath.length > 0 && accountPath[0] === nativePath[0]) {
      const segment = accountPath[0]!;
      const property = arm.type === 'object' ? arm.properties?.[segment] : undefined;
      return property ? resolveDeclaredSelectionPairs(property, accountPath.slice(1), nativePath.slice(1)) : [{}];
    }
    return resolveOptionalDeclaredInputLeaves(arm, accountPath).flatMap((account) => (
      resolveOptionalDeclaredInputLeaves(arm, nativePath).map((native) => ({ account, native }))
    ));
  });
}

function hasValidPurposeBindingInputLeaves(
  inputSchema: PluginJsonSchemaV2,
  binding: PluginActionConnectedAccountPurposeBindingV2,
): boolean {
  if (!binding.nativeServicePath) {
    const leaves = resolveDeclaredInputLeaves(inputSchema, binding.path);
    return leaves !== null && leaves.every(isExactOrNullableQualifiedConnectedAccountRefInputLeaf)
      && declaredInputLeavesAgree(leaves);
  }
  const pairs = resolveDeclaredSelectionPairs(inputSchema, binding.path.split('.'), binding.nativeServicePath.split('.'));
  if (pairs.length === 0 || !pairs.every(({ account, native }) => (
    account !== undefined && native === undefined && isExactQualifiedConnectedAccountRefInputLeaf(account)
    || account === undefined && native !== undefined && isExactQualifiedServiceInputLeaf(native)
  ))) return false;
  const accounts = pairs.flatMap(({ account }) => account ? [account] : []);
  const services = pairs.flatMap(({ native }) => native ? [native] : []);
  return (accounts.length === 0 || declaredInputLeavesAgree(accounts))
    && (services.length === 0 || declaredInputLeavesAgree(services));
}

/**
 * Verifies the bounded, exact declaration shared by Action inputs and
 * Automation Event source configs. Every representable arm proves an account
 * ref or an explicitly declared native service. Consumers never infer
 * credential authority from field names or value shapes.
 */
export function hasValidPluginConnectedAccountPurposeBindingsV2(
  inputSchema: PluginJsonSchemaV2 | undefined,
  purposeBindings: readonly PluginActionConnectedAccountPurposeBindingV2[],
): boolean {
  if (purposeBindings.length === 0) return true;

  const bindingPaths = new Set<string>();
  const bindingPurposes = new Set<string>();
  for (const binding of purposeBindings) {
    if (bindingPaths.has(binding.path) || bindingPurposes.has(binding.purpose)
      || binding.nativeServicePath === binding.path
      || (binding.nativeServicePath !== undefined && bindingPaths.has(binding.nativeServicePath))) return false;
    bindingPaths.add(binding.path);
    if (binding.nativeServicePath) bindingPaths.add(binding.nativeServicePath);
    bindingPurposes.add(binding.purpose);
  }

  const traversableInputSchema = declaresTraversableObjectInput(inputSchema)
    ? inputSchema
    : undefined;
  if (!traversableInputSchema) return false;
  return purposeBindings.every((binding) => {
    return hasValidPurposeBindingInputLeaves(traversableInputSchema, binding);
  });
}

function widgetMatchesInputLeaf(
  field: Readonly<{ widget: ActionInputWidget; connectedAccountOptions?: true; inputType?: unknown }>,
  inputLeaf: PluginJsonSchemaV2,
): boolean {
  if (field.connectedAccountOptions === true) {
    return field.widget === 'select' && isExactQualifiedConnectedAccountRefInputLeaf(inputLeaf);
  }
  // Typed choices carry schema-admitted JSON, not only the incumbent string dialect.
  // The target's pre-dispatch input admission also enforces the resolved type schema.
  if (field.inputType && field.widget === 'select') return true;
  if (field.inputType && field.widget === 'multiselect') return inputLeaf.type === 'array';
  // Public DSL unions and literals need not emit an explicit type. Each union
  // arm must support the widget; this refinement does not change credential
  // leaf traversal or the exact Connected Account checks above.
  const alternatives = expandDeclaredInputAlternatives(inputLeaf);
  if (alternatives.length !== 1 || alternatives[0] !== inputLeaf) {
    return alternatives.every((alternative) => widgetMatchesInputLeaf(field, alternative));
  }
  let type = inputLeaf.type;
  if (type === undefined) {
    const literal = inputLeaf.const;
    if (typeof literal === 'string') type = 'string';
    else if (typeof literal === 'boolean') type = 'boolean';
    else if (typeof literal === 'number') type = Number.isInteger(literal) ? 'integer' : 'number';
  }
  switch (field.widget) {
    case 'text':
    case 'url':
    case 'secret':
    case 'textarea':
    case 'select':
      return type === 'string';
    case 'number':
      return type === 'number' || type === 'integer';
    case 'integer':
      return type === 'integer';
    case 'text_list':
    case 'multiselect':
      return inputLeaf.type === 'array' && inputLeaf.items?.type === 'string';
    case 'boolean':
      return type === 'boolean';
    case 'json':
      return true;
  }
}

function resolvePluginLocalizedActionInputText(value: PluginLocalizedStringV2): string {
  return typeof value === 'string' ? value : value.fallback;
}

/**
 * Plugins author localized presentation facts; the Action catalog projects one
 * resolved descriptor used by every host presentation surface.
 */
export function normalizePluginActionInputHintsV2(
  inputHints: PluginActionInputHintsV2 | undefined,
): ActionInputHints | undefined {
  if (inputHints === undefined) return undefined;
  return normalizeActionInputHintsText(inputHints, resolvePluginLocalizedActionInputText);
}

/** Normalizes the bounded author declaration into the incumbent Action slash field. */
export function normalizePluginActionSlashV2(
  slash: PluginActionSlashV2 | undefined,
): ActionDefinitionSlashV1 {
  return slash ? { tokens: [...slash.tokens] } : null;
}

export const PluginActionContributionV2Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  confirmVerb: z.optional(PluginLocalizedStringV2Schema),
  irreversible: z.optional(z.literal(true)),
  description: z.optional(PluginLocalizedStringV2Schema),
  icon: z.optional(PluginActionIconV2Schema),
  scopes: z.array(PluginActionScopeV2Schema).check(z.minLength(1)),
  surfaces: z.array(PluginActionSurfaceV2Schema).check(z.minLength(1)),
  execution: PluginActionDeclaredExecutionV2Schema,
  operation: z.optional(ActionOperationDeclarationV1Schema),
  sessionTarget: z.optional(ActionSessionTargetDeclarationV1Schema),
  placementBindings: z.optional(PluginActionPlacementBindingsV2Schema),
  slash: z.optional(PluginActionSlashV2Schema),
  inputSchema: z.optional(PluginJsonSchemaV2Schema),
  contextualDefaults: z.optional(ActionContextualDefaultsSchema),
  inputHints: z.optional(PluginActionInputHintsV2Schema),
  connectedAccountPurposeBindings: z.optional(z.array(
    PluginActionConnectedAccountPurposeBindingV2Schema,
  ).check(z.maxLength(8))),
  resultSchema: z.optional(PluginJsonSchemaV2Schema),
  availability: z.optional(PluginActionAvailabilityV2Schema),
  hostAccess: z.optional(z.array(z.string().check(z.regex(/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/))).check(z.minLength(1), z.superRefine((values, ctx) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) ctx.addIssue({ code: 'custom', path: [index], message: 'Duplicate hostAccess request id.' });
      seen.add(value);
    });
  }))),
  priority: z.optional(z.number().check(z.int())),
  dangerLevel: PluginActionDangerLevelV2Schema,
  confirmation: z.optional(PluginActionConfirmationV2Schema),
  confirmationWhen: z.optional(PluginActionConfirmationWhenV2Schema),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
}).check(z.superRefine((value, ctx) => {
  if (value.operation && value.execution.target !== 'daemon') {
    ctx.addIssue({
      code: "custom",
      path: ['operation'],
      message: 'Tracked operations require daemon Action execution.',
    });
  }
  if (value.slash && !value.surfaces.includes('ui')) {
    ctx.addIssue({
      code: "custom",
      path: ['slash'],
      message: 'Composer slash metadata requires the UI Action surface.',
    });
  }
  if (pluginActionRequiresPlacement(value.surfaces) && !value.placementBindings) {
    ctx.addIssue({
      code: "custom",
      path: ['placementBindings'],
      message: 'UI plugin actions must declare an explicit placement decision.',
    });
  }
  // Confirmation also protects sensitive reads; dangerLevel describes effects,
  // not whether disclosure needs a present-user decision.
  if (pluginActionRequiresConfirmationPresentation(value.surfaces, value.dangerLevel) && !value.confirmation) {
    ctx.addIssue({
      code: "custom",
      path: ['confirmation'],
      message: 'Non-safe plugin actions must declare host confirmation metadata.',
    });
  }

  const inputSchema = value.inputSchema;
  if (value.sessionTarget && (!declaresTraversableObjectInput(inputSchema)
    || !resolveDeclaredInputLeaves(inputSchema!, value.sessionTarget.field)?.length)) {
    ctx.addIssue({
      code: 'custom', path: ['sessionTarget', 'field'],
      message: 'Session target must identify a declared object input operand.',
    });
  }
  if (value.contextualDefaults) {
    if (!declaresTraversableObjectInput(inputSchema)) {
      ctx.addIssue({
        code: "custom",
        path: ['inputSchema'],
        message: 'Contextual defaults require an object inputSchema.',
      });
    } else {
      for (const [field] of Object.entries(value.contextualDefaults)) {
        const leaves = resolveDeclaredInputLeaves(inputSchema!, field);
        if (!leaves || !leaves.every((leaf) => leaf.type === 'string')) {
          ctx.addIssue({
            code: "custom",
            path: ['contextualDefaults', field],
            message: 'Contextual defaults must target a declared root string input field.',
          });
        }
      }
    }
  }
  const purposeBindings = value.connectedAccountPurposeBindings ?? [];
  const bindingPaths = new Set<string>();
  const bindingPurposes = new Set<string>();
  purposeBindings.forEach((binding, index) => {
    if (bindingPaths.has(binding.path) || binding.nativeServicePath === binding.path
      || (binding.nativeServicePath !== undefined && bindingPaths.has(binding.nativeServicePath))) {
      ctx.addIssue({
        code: "custom",
        path: ['connectedAccountPurposeBindings', index, 'path'],
        message: 'Connected Account credential-ref paths must map to exactly one purpose.',
      });
    }
    bindingPaths.add(binding.path);
    if (binding.nativeServicePath) bindingPaths.add(binding.nativeServicePath);
    if (bindingPurposes.has(binding.purpose)) {
      ctx.addIssue({
        code: "custom",
        path: ['connectedAccountPurposeBindings', index, 'purpose'],
        message: 'Connected Account purposes must map to exactly one credential-ref path.',
      });
    }
    bindingPurposes.add(binding.purpose);
  });
  const traversableInputSchema = declaresTraversableObjectInput(inputSchema) ? inputSchema : undefined;
  if (purposeBindings.length > 0 && !traversableInputSchema) {
    ctx.addIssue({
      code: "custom",
      path: ['inputSchema'],
      message: 'Connected Account purpose bindings require an object inputSchema.',
    });
  }
  if (traversableInputSchema) {
    purposeBindings.forEach((binding, index) => {
      if (!hasValidPurposeBindingInputLeaves(traversableInputSchema, binding)) {
        ctx.addIssue({
          code: "custom",
          path: ['connectedAccountPurposeBindings', index, 'path'],
          message: 'Connected Account purpose bindings must target one exact qualified account ref or declared native service in every input arm.',
        });
      }
    });
  }

  const inputHints = value.inputHints;
  if (!inputHints || inputHints.fields.length === 0) return;
  if (!traversableInputSchema) {
    ctx.addIssue({
      code: "custom",
      path: ['inputSchema'],
      message: 'Plugin Actions with input fields must declare an object inputSchema.',
    });
    return;
  }
  inputHints.fields.forEach((field, index) => {
    const inputLeaves = resolveDeclaredInputLeaves(traversableInputSchema, field.path,
      field.visibleWhen !== undefined && field.connectedAccountOptions !== true ? 'conditional-field' : 'every-arm');
    if (!inputLeaves) {
      ctx.addIssue({
        code: "custom",
        path: ['inputHints', 'fields', index, 'path'],
        message: 'Plugin Action input fields must resolve to a declared inputSchema leaf.',
      });
      return;
    }
    if (inputLeaves.every((inputLeaf) => widgetMatchesInputLeaf(field, inputLeaf))) return;
    ctx.addIssue({
      code: "custom",
      path: ['inputHints', 'fields', index, 'widget'],
      message: 'Plugin Action input widget does not match its declared inputSchema leaf.',
    });
  });
})));
export type PluginActionContributionV2 = z.infer<typeof PluginActionContributionV2Schema>;

const PluginToolJsonObjectSchemaV2Schema = lazyZodSchema(() => PluginJsonSchemaV2Schema.check(z.refine((schema) => schema.type === 'object', 'Tool schemas must declare type "object" at the root')));

export const PluginToolContributionV2Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  name: z.string().check(z.trim(), z.minLength(1)),
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  safety: z._default(ActionSafetySchema, 'safe'),
  surfaces: z._default(z.array(PluginToolSurfaceV2Schema), []),
  inputSchema: z.optional(PluginToolJsonObjectSchemaV2Schema),
  outputSchema: z.optional(PluginToolJsonObjectSchemaV2Schema),
  inputHints: z.optional(PluginToolInputHintsV2Schema),
  compatibility: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
  examples: z.optional(PluginActionDefinitionExamplesV1Schema),
  promptSnippet: PluginOptionalStringSchema,
  promptGuidelines: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  action: z.union([
    z.string().check(z.trim(), z.minLength(1)),
    z.strictObject({ pluginId: z.string().check(z.trim(), z.minLength(1)), localId: z.string().check(z.trim(), z.minLength(1)) }),
  ]),
  availability: z.optional(PluginActionAvailabilityV2Schema),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
}));
export type PluginToolContributionV2 = z.infer<typeof PluginToolContributionV2Schema>;
