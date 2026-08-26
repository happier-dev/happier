import { z } from 'zod';

import {
  PluginActionDangerLevelV2Schema,
  PluginActionSurfaceV2Schema,
  type PluginActionDangerLevelV2,
  type PluginActionSurfaceV2,
} from './vocabulary.js';
import type { ActionDefinitionSlashV1 } from '../../actions/actionDefinitionV1.js';
import { ActionSafetySchema } from '../../actions/safety.js';
import { ActionContextualDefaultsSchema } from '../../actions/contextualDefaults.js';
import { ActionOperationDeclarationV1Schema } from '../../actions/operations/v1.js';
import {
  createActionInputHintsSchemasWithStaticOptionsOnly,
  createActionInputHintsSchemasWithoutOptionsSource,
  normalizeActionInputHintsText,
  ActionInputPathSchema,
  type ActionInputWidget,
  type ActionInputHints,
} from '../../actions/actionInputHints.js';
import { ConnectedAccountPurposeIdSchema } from '../../connect/connectedAccountPurposes.js';
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
export { PluginJsonSchemaV2Schema, type PluginJsonSchemaV2 as PluginJsonSchema } from '../contributions/publicTypes.js';
export type { PluginJsonValueV2 as PluginJsonValue } from '../contributions/publicTypes.js';
export {
  PluginActionDangerLevelV2Schema,
  PluginActionSurfaceV2Schema,
  type PluginActionDangerLevelV2,
  type PluginActionSurfaceV2,
};

export const PluginActionDefinitionExamplesV1Schema = z
  .object({
    voice: z
      .object({
        argsExample: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    mcp: z
      .object({
        argsExample: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    sdk: z
      .object({
        codeExample: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PluginActionDefinitionExamplesV1 = z.infer<typeof PluginActionDefinitionExamplesV1Schema>;

export const PluginActionScopeV2Schema = z.enum([
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
]);
export type PluginActionScopeV2 = z.infer<typeof PluginActionScopeV2Schema>;

/**
 * Tool invocation is intentionally a smaller, independent surface grammar.
 * Adding an Action-only surface must never silently make it available to Tools.
 */
export const PluginToolSurfaceV2Schema = z.enum(['cli', 'mcp', 'agent']);
export type PluginToolSurfaceV2 = z.infer<typeof PluginToolSurfaceV2Schema>;

/**
 * One contributed Action has one explicit execution realm. The client tuple
 * identifies the exact client activation module entitled to register it.
 */
export const PluginActionExecutionV2Schema = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('daemon'),
  }).strict(),
  z.object({
    target: z.literal('client'),
    client: PluginClientExecutionReferenceV1Schema,
    platforms: PluginClientExecutionPlatformsV1Schema,
  }).strict(),
]);
export type PluginActionExecutionV2 = z.infer<typeof PluginActionExecutionV2Schema>;

export const PluginActionDeclaredExecutionV2Schema = PluginActionExecutionV2Schema;

export const PluginActionPlacementV2Schema = z.enum([
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
]);
export type PluginActionPlacementV2 = z.infer<typeof PluginActionPlacementV2Schema>;

/**
 * Ordered semantic destinations for one Action. This is intentionally distinct
 * from the legacy generic `ActionSpec.placements` taxonomy retained by the
 * CLI's normalization shell.
 */
export const PluginActionPlacementBindingsV2Schema = z.array(
  PluginActionPlacementV2Schema,
).min(1).max(11).superRefine((bindings, context) => {
  const seen = new Set<PluginActionPlacementV2>();
  bindings.forEach((binding, index) => {
    if (seen.has(binding)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index],
        message: 'Duplicate Action placement binding.',
      });
    }
    seen.add(binding);
  });
});
export type PluginActionPlacementBindingsV2 = z.infer<
  typeof PluginActionPlacementBindingsV2Schema
>;

export const PluginActionIconV2Schema = z.string().trim().regex(/^[a-z][a-z0-9.-]*$/i);

const PluginActionSlashTokenV2Schema = z.string()
  .trim()
  .min(2)
  .max(128)
  .regex(/^\/\S+$/u, 'Composer slash tokens must begin with "/" and contain no whitespace.');

/**
 * Bounded composer-command presentation metadata for a contributed Action.
 * The Action remains the sole execution owner; this only declares slash-picker
 * presentation for UI-mounted actions.
 */
export const PluginActionSlashV2Schema = z.object({
  tokens: z.array(PluginActionSlashTokenV2Schema).min(1).max(8).superRefine((tokens, ctx) => {
    const seen = new Set<string>();
    tokens.forEach((token, index) => {
      if (seen.has(token)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: 'Duplicate composer slash token.' });
      }
      seen.add(token);
    });
  }),
}).strict();
export type PluginActionSlashV2 = z.infer<typeof PluginActionSlashV2Schema>;

/**
 * The manifest grammar owns this boundary so projected readers do not each
 * reinterpret whether a declaration needs a human presentation. `plugin` is
 * the only trusted programmatic Action surface; every other existing Action
 * surface retains its incumbent presentation contract.
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
    z.string().trim().min(1).max(maxUtf16Units),
    z.object({
      key: z.string().trim().min(1).max(maxUtf16Units),
      fallback: z.string().trim().min(1).max(maxUtf16Units),
    }).strict(),
  ]);
}

const PluginActionConfirmationTitleV2Schema = createPluginActionConfirmationPresentationTextSchema(
  PLUGIN_ACTION_CONFIRMATION_PRESENTATION_LIMITS_V2.titleUtf16Units,
);
const PluginActionConfirmationBodyV2Schema = createPluginActionConfirmationPresentationTextSchema(
  PLUGIN_ACTION_CONFIRMATION_PRESENTATION_LIMITS_V2.bodyUtf16Units,
);

export const PluginActionConfirmationV2Schema = z.object({
  title: PluginActionConfirmationTitleV2Schema,
  body: PluginActionConfirmationBodyV2Schema.optional(),
  confirmLabel: PluginActionConfirmationTitleV2Schema.optional(),
}).strict();
export type PluginActionConfirmationV2 = z.infer<typeof PluginActionConfirmationV2Schema>;

const PluginActionInputHintsSchemasV2 = createActionInputHintsSchemasWithoutOptionsSource(
  PluginLocalizedStringV2Schema,
  z.string().trim().min(1),
);

const PluginToolInputHintsSchemasV2 = createActionInputHintsSchemasWithStaticOptionsOnly(
  PluginLocalizedStringV2Schema,
  z.string().trim().min(1),
);

/** Plugin authors have no arbitrary option-source selector. */
export const PluginActionInputHintsV2Schema = PluginActionInputHintsSchemasV2.hintsSchema;
export type PluginActionInputHintsV2 = z.infer<typeof PluginActionInputHintsV2Schema>;

/**
 * One explicit credential-ref input path to one declared Connected Account
 * purpose. Host adapters consume this mapping; field names and request order
 * are never authorization inputs.
 */
export const PluginActionConnectedAccountPurposeBindingV2Schema = z.object({
  path: ActionInputPathSchema,
  purpose: ConnectedAccountPurposeIdSchema,
}).strict();
export type PluginActionConnectedAccountPurposeBindingV2 = z.infer<
  typeof PluginActionConnectedAccountPurposeBindingV2Schema
>;

/** Tools cannot request host-resolved Action-form options. */
export const PluginToolInputHintsV2Schema = PluginToolInputHintsSchemasV2.hintsSchema;
export type PluginToolInputHintsV2 = z.infer<typeof PluginToolInputHintsV2Schema>;

/**
 * Expands one declared schema position into the exact alternatives an input
 * value can take there. A union contributes every arm, so a path proven across
 * the expansion is proven for every representable input. A schema that already
 * declares its own `type` or `properties` is its own single alternative, which
 * keeps a nullable credential-ref leaf intact rather than splitting it.
 */
function expandDeclaredInputAlternatives(
  schema: PluginJsonSchemaV2,
): readonly PluginJsonSchemaV2[] {
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (
    !alternatives
    || alternatives.length === 0
    || schema.type !== undefined
    || schema.properties !== undefined
  ) return [schema];
  return alternatives.flatMap(expandDeclaredInputAlternatives);
}

/** One declaration is traversable when every representable input arm is an object. */
function declaresTraversableObjectInput(
  inputSchema: PluginJsonSchemaV2 | undefined,
): boolean {
  if (!inputSchema) return false;
  const arms = expandDeclaredInputAlternatives(inputSchema);
  return arms.length > 0 && arms.every((arm) => arm.type === 'object');
}

/**
 * Resolves one declared input path to the leaf each representable input arm
 * would carry there. Returning `null` means at least one arm cannot reach the
 * path, so the declaration proves nothing about it.
 */
function resolveDeclaredInputLeaves(
  inputSchema: PluginJsonSchemaV2,
  path: string,
): readonly PluginJsonSchemaV2[] | null {
  let frontier: readonly PluginJsonSchemaV2[] = [inputSchema];
  for (const segment of path.split('.')) {
    const next: PluginJsonSchemaV2[] = [];
    for (const position of frontier) {
      for (const arm of expandDeclaredInputAlternatives(position)) {
        if (arm.type !== 'object') return null;
        const property = arm.properties?.[segment];
        if (!property) return null;
        next.push(property);
      }
    }
    if (next.length === 0) return null;
    frontier = next;
  }
  return frontier.length > 0 ? frontier : null;
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
  if (
    !service
    || service.type !== 'object'
    || service.additionalProperties !== false
    || !service.properties
    || Object.keys(service.properties).length !== 2
    || !service.required
    || service.required.length !== 2
    || !service.required.includes('pluginId')
    || !service.required.includes('localId')
  ) return false;
  return service.properties.pluginId?.type === 'string'
    && service.properties.localId?.type === 'string'
    && accountId?.type === 'string';
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

/**
 * Verifies the bounded, exact declaration shared by Action inputs and
 * Automation Event source configs. The host can only mint an Account binding
 * when the declaration proves one account ref at every representable schema
 * arm; consumers must not infer an Account from a field name or value shape.
 */
export function hasValidPluginConnectedAccountPurposeBindingsV2(
  inputSchema: PluginJsonSchemaV2 | undefined,
  purposeBindings: readonly PluginActionConnectedAccountPurposeBindingV2[],
): boolean {
  if (purposeBindings.length === 0) return true;

  const bindingPaths = new Set<string>();
  const bindingPurposes = new Set<string>();
  for (const binding of purposeBindings) {
    if (bindingPaths.has(binding.path) || bindingPurposes.has(binding.purpose)) return false;
    bindingPaths.add(binding.path);
    bindingPurposes.add(binding.purpose);
  }

  const traversableInputSchema = declaresTraversableObjectInput(inputSchema)
    ? inputSchema
    : undefined;
  if (!traversableInputSchema) return false;
  return purposeBindings.every((binding) => {
    const inputLeaves = resolveDeclaredInputLeaves(traversableInputSchema, binding.path);
    return inputLeaves !== null
      && inputLeaves.every(isExactOrNullableQualifiedConnectedAccountRefInputLeaf)
      && declaredInputLeavesAgree(inputLeaves);
  });
}

function widgetMatchesInputLeaf(
  field: Readonly<{ widget: ActionInputWidget; connectedAccountOptions?: true }>,
  inputLeaf: PluginJsonSchemaV2,
): boolean {
  if (field.connectedAccountOptions === true) {
    return field.widget === 'select' && isExactQualifiedConnectedAccountRefInputLeaf(inputLeaf);
  }
  switch (field.widget) {
    case 'text':
    case 'url':
    case 'secret':
    case 'textarea':
    case 'select':
      return inputLeaf.type === 'string';
    case 'number':
      return inputLeaf.type === 'number' || inputLeaf.type === 'integer';
    case 'integer':
      return inputLeaf.type === 'integer';
    case 'text_list':
    case 'multiselect':
      return inputLeaf.type === 'array' && inputLeaf.items?.type === 'string';
    case 'boolean':
      return inputLeaf.type === 'boolean';
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

export const PluginActionContributionV2Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  icon: PluginActionIconV2Schema.optional(),
  scopes: z.array(PluginActionScopeV2Schema).min(1),
  surfaces: z.array(PluginActionSurfaceV2Schema).min(1),
  execution: PluginActionDeclaredExecutionV2Schema,
  operation: ActionOperationDeclarationV1Schema.optional(),
  placementBindings: PluginActionPlacementBindingsV2Schema.optional(),
  slash: PluginActionSlashV2Schema.optional(),
  inputSchema: PluginJsonSchemaV2Schema.optional(),
  contextualDefaults: ActionContextualDefaultsSchema.optional(),
  inputHints: PluginActionInputHintsV2Schema.optional(),
  connectedAccountPurposeBindings: z.array(
    PluginActionConnectedAccountPurposeBindingV2Schema,
  ).max(8).optional(),
  resultSchema: PluginJsonSchemaV2Schema.optional(),
  availability: PluginActionAvailabilityV2Schema.optional(),
  hostAccess: z.array(z.string().regex(/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/)).min(1).superRefine((values, ctx) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) ctx.addIssue({ code: 'custom', path: [index], message: 'Duplicate hostAccess request id.' });
      seen.add(value);
    });
  }).optional(),
  priority: z.number().int().optional(),
  dangerLevel: PluginActionDangerLevelV2Schema,
  confirmation: PluginActionConfirmationV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.operation && value.execution.target !== 'daemon') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['operation'],
      message: 'Tracked operations require daemon Action execution.',
    });
  }
  if (pluginActionRequiresPlacement(value.surfaces) && !value.placementBindings) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['placementBindings'],
      message: 'UI plugin actions must declare at least one placement binding.',
    });
  }
  if (value.slash && !value.surfaces.includes('ui')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['slash'],
      message: 'Composer slash metadata requires the UI Action surface.',
    });
  }
  if (value.dangerLevel === 'safe' && value.confirmation) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmation'], message: 'Safe actions cannot request confirmation.' });
  } else if (pluginActionRequiresConfirmationPresentation(value.surfaces, value.dangerLevel) && !value.confirmation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['confirmation'],
      message: 'Non-safe plugin actions must declare host confirmation metadata.',
    });
  }

  const inputSchema = value.inputSchema;
  if (value.contextualDefaults) {
    if (!declaresTraversableObjectInput(inputSchema)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['inputSchema'],
        message: 'Contextual defaults require an object inputSchema.',
      });
    } else {
      for (const [field] of Object.entries(value.contextualDefaults)) {
        const leaves = resolveDeclaredInputLeaves(inputSchema!, field);
        if (!leaves || !leaves.every((leaf) => leaf.type === 'string')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
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
    if (bindingPaths.has(binding.path)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['connectedAccountPurposeBindings', index, 'path'],
        message: 'Connected Account credential-ref paths must map to exactly one purpose.',
      });
    }
    bindingPaths.add(binding.path);
    if (bindingPurposes.has(binding.purpose)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['connectedAccountPurposeBindings', index, 'purpose'],
        message: 'Connected Account purposes must map to exactly one credential-ref path.',
      });
    }
    bindingPurposes.add(binding.purpose);
  });
  const traversableInputSchema = declaresTraversableObjectInput(inputSchema) ? inputSchema : undefined;
  if (purposeBindings.length > 0 && !traversableInputSchema) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['inputSchema'],
      message: 'Connected Account purpose bindings require an object inputSchema.',
    });
  }
  if (traversableInputSchema) {
    purposeBindings.forEach((binding, index) => {
      const inputLeaves = resolveDeclaredInputLeaves(traversableInputSchema, binding.path);
      if (
        !inputLeaves
        || !inputLeaves.every(isExactOrNullableQualifiedConnectedAccountRefInputLeaf)
        || !declaredInputLeavesAgree(inputLeaves)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['connectedAccountPurposeBindings', index, 'path'],
          message: 'Connected Account purpose bindings must target one exact qualified credential-ref input leaf in every declared input arm.',
        });
      }
    });
  }

  const inputHints = value.inputHints;
  if (!inputHints || inputHints.fields.length === 0) return;
  if (!traversableInputSchema) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['inputSchema'],
      message: 'Plugin Actions with input fields must declare an object inputSchema.',
    });
    return;
  }
  inputHints.fields.forEach((field, index) => {
    const inputLeaves = resolveDeclaredInputLeaves(traversableInputSchema, field.path);
    if (!inputLeaves) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['inputHints', 'fields', index, 'path'],
        message: 'Plugin Action input fields must resolve to a declared inputSchema leaf.',
      });
      return;
    }
    if (inputLeaves.every((inputLeaf) => widgetMatchesInputLeaf(field, inputLeaf))) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['inputHints', 'fields', index, 'widget'],
      message: 'Plugin Action input widget does not match its declared inputSchema leaf.',
    });
  });
});
export type PluginActionContributionV2 = z.infer<typeof PluginActionContributionV2Schema>;

const PluginToolJsonObjectSchemaV2Schema = PluginJsonSchemaV2Schema.refine(
  (schema) => schema.type === 'object',
  'Tool schemas must declare type "object" at the root',
);

export const PluginToolContributionV2Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  name: z.string().trim().min(1),
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  safety: ActionSafetySchema.default('safe'),
  surfaces: z.array(PluginToolSurfaceV2Schema).default([]),
  inputSchema: PluginToolJsonObjectSchemaV2Schema.optional(),
  outputSchema: PluginToolJsonObjectSchemaV2Schema.optional(),
  inputHints: PluginToolInputHintsV2Schema.optional(),
  compatibility: z.record(z.string(), PluginJsonValueV2Schema).optional(),
  examples: PluginActionDefinitionExamplesV1Schema.optional(),
  promptSnippet: PluginOptionalStringSchema,
  promptGuidelines: z.array(z.string().trim().min(1)).optional(),
  action: z.union([
    z.string().trim().min(1),
    z.object({ pluginId: z.string().trim().min(1), localId: z.string().trim().min(1) }).strict(),
  ]),
  availability: PluginActionAvailabilityV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type PluginToolContributionV2 = z.infer<typeof PluginToolContributionV2Schema>;
