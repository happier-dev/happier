import { z } from 'zod';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { containsEquivalentPluginJsonValue } from './jsonSchemaValues.js';
import {
  PluginAvailabilityDescriptorV2Schema,
  PluginContributionReferenceV2Schema,
  type PluginJsonValueV2,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from './publicTypes.js';

export type PluginSettingFieldSchemaV2 = {
  type?: 'null' | 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object';
  title?: string; description?: string; enum?: PluginJsonValueV2[]; const?: PluginJsonValueV2;
  properties?: Record<string, PluginSettingFieldSchemaV2>; required?: string[];
  additionalProperties?: boolean | PluginSettingFieldSchemaV2; items?: PluginSettingFieldSchemaV2;
  minItems?: number; maxItems?: number; minimum?: number; maximum?: number;
  minLength?: number; maxLength?: number; pattern?: string;
  anyOf?: PluginSettingFieldSchemaV2[]; oneOf?: PluginSettingFieldSchemaV2[]; allOf?: PluginSettingFieldSchemaV2[];
};
export const PluginSettingFieldSchemaV2Schema: z.ZodType<PluginSettingFieldSchemaV2> = z.lazy(() => z.object({
  type: z.enum(['null', 'boolean', 'number', 'integer', 'string', 'array', 'object']).optional(),
  title: z.string().optional(), description: z.string().optional(),
  enum: z.array(PluginJsonValueV2Schema).optional(), const: PluginJsonValueV2Schema.optional(),
  properties: z.record(z.string(), PluginSettingFieldSchemaV2Schema).optional(), required: z.array(z.string()).optional(),
  additionalProperties: z.union([z.boolean(), PluginSettingFieldSchemaV2Schema]).optional(), items: PluginSettingFieldSchemaV2Schema.optional(),
  minItems: z.number().int().nonnegative().optional(), maxItems: z.number().int().nonnegative().optional(),
  minimum: z.number().finite().optional(), maximum: z.number().finite().optional(),
  minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional(), pattern: z.string().optional(),
  anyOf: z.array(PluginSettingFieldSchemaV2Schema).optional(), oneOf: z.array(PluginSettingFieldSchemaV2Schema).optional(), allOf: z.array(PluginSettingFieldSchemaV2Schema).optional(),
}).strict());

export const PluginSettingFieldIdV2Schema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z][A-Za-z0-9_./-]*$/,
    'Setting field ids must start with a letter and contain only letters, digits, underscores, dots, slashes, or hyphens.',
  );
export type PluginSettingFieldIdV2 = z.infer<typeof PluginSettingFieldIdV2Schema>;

/**
 * Secret custody is independent from the Settings model that presents a field.
 * A declaration is the only way a plugin can select its own secret owner.
 */
export const PluginSecretCustodyV1Schema = z.enum(['account', 'daemon']);
export type PluginSecretCustody = z.infer<typeof PluginSecretCustodyV1Schema>;

/**
 * A daemon-custodied secret may be bound to the canonical origin resolved from
 * one visible Account endpoint field. The relation is declarative metadata:
 * it never makes the secret an Account-record value.
 */
export const PluginSettingManagedServiceOriginV1Schema = z.object({
  endpointSettingId: PluginSettingFieldIdV2Schema,
}).strict();
export type PluginSettingManagedServiceOriginV1 = z.infer<
  typeof PluginSettingManagedServiceOriginV1Schema
>;

/** The only persistence partitions available to declarative plugin Settings. */
export const PluginSettingsScopeV1Schema = z.enum(['account', 'daemon']);
export type PluginSettingsScopeV1 = z.infer<typeof PluginSettingsScopeV1Schema>;

/** A Settings operation must name its one record; there is no merged scope. */
export const PluginSettingsScopeRefV1Schema = z.object({
  kind: PluginSettingsScopeV1Schema,
}).strict();
export type PluginSettingsScopeRefV1 = z.infer<typeof PluginSettingsScopeRefV1Schema>;

/**
 * The normalized custody interpretation for every Settings secret field.
 * `true` deliberately means Account custody; callers must not infer custody
 * from the Settings record scope or create a local fallback.
 */
export function readPluginSettingSecretCustody(
  value: unknown,
): PluginSecretCustody | null {
  if (value === true) return 'account';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const custody = (value as Readonly<Record<string, unknown>>).custody;
  return custody === 'account' || custody === 'daemon' ? custody : null;
}

/**
 * Returns the declared origin relation only after the strict declaration
 * grammar has accepted it. Callers must not infer an origin relation from a
 * field id or Settings scope.
 */
export function readPluginSettingManagedServiceOrigin(
  value: unknown,
): PluginSettingManagedServiceOriginV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = PluginSettingManagedServiceOriginV1Schema.safeParse(
    (value as Readonly<Record<string, unknown>>).managedServiceOrigin,
  );
  return parsed.success ? parsed.data : null;
}

export const PluginSettingSecretDeclarationSchema = z.union([
  z.literal(true),
  z.object({
    custody: PluginSecretCustodyV1Schema,
    managedServiceOrigin: PluginSettingManagedServiceOriginV1Schema.optional(),
  }).strict(),
]);
export type PluginSettingSecretDeclaration =
  z.input<typeof PluginSettingSecretDeclarationSchema>;
export type ParsedPluginSettingSecretDeclaration =
  z.output<typeof PluginSettingSecretDeclarationSchema>;

/** A non-Settings declared secret. Omitted custody normalizes to Account. */
export const PluginDirectSecretDeclarationV1Schema = z.object({
  id: PluginSettingFieldIdV2Schema,
  custody: PluginSecretCustodyV1Schema.default('account'),
}).strict();
export type PluginDirectSecretDeclarationV1 =
  z.input<typeof PluginDirectSecretDeclarationV1Schema>;
export type ParsedPluginDirectSecretDeclarationV1 =
  z.output<typeof PluginDirectSecretDeclarationV1Schema>;

export const PluginSettingOptionV2Schema = z.object({
  value: PluginJsonValueV2Schema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
}).strict();

export const PluginSettingFieldBindingV2Schema = z.union([
  z.object({
    kind: z.literal('direct'),
    settingId: PluginSettingFieldIdV2Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('perActiveServer'),
    fallbackSettingId: PluginSettingFieldIdV2Schema,
    byServerIdSettingId: PluginSettingFieldIdV2Schema,
  }).strict(),
]);

/**
 * `perActiveServer` is one Account-record binding, not an unbounded cache of
 * server state. These limits are owned with the declaration grammar so every
 * persistence adapter can apply the same bounded value contract.
 */
export const PLUGIN_PER_ACTIVE_SERVER_MAX_ENTRIES_V1 = 256;
export const PLUGIN_PER_ACTIVE_SERVER_MAX_ENCODED_BYTES_V1 = 64 * 1024;
export const PLUGIN_PER_ACTIVE_SERVER_MAX_DEPTH_V1 = 4;

const perActiveServerTextEncoder = new TextEncoder();

function readOwnDataEntries(value: object): readonly [string, unknown][] | null {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function isBoundedPerActiveServerJson(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
): boolean {
  if (depth > PLUGIN_PER_ACTIVE_SERVER_MAX_DEPTH_V1) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(descriptors).some((key) => (
        typeof key === 'symbol'
        || (key !== 'length' && (!/^\d+$/.test(key) || String(Number(key)) !== key || Number(key) >= value.length))
      ))) {
        return false;
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)
          || !isBoundedPerActiveServerJson(descriptor.value, depth + 1, ancestors)) {
          return false;
        }
      }
      return true;
    }
    const entries = readOwnDataEntries(value);
    return entries !== null && entries.every(([, entry]) => (
      isBoundedPerActiveServerJson(entry, depth + 1, ancestors)
    ));
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Validates only the binding-specific structural limits. The owning field's
 * ordinary JSON-schema validator remains responsible for each scalar value.
 */
export function isBoundedPluginPerActiveServerValueV1(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = readOwnDataEntries(value);
  if (!entries || entries.length > PLUGIN_PER_ACTIVE_SERVER_MAX_ENTRIES_V1) return false;
  if (!isBoundedPerActiveServerJson(value, 1, new WeakSet<object>())) return false;
  try {
    return perActiveServerTextEncoder.encode(JSON.stringify(value)).byteLength
      <= PLUGIN_PER_ACTIVE_SERVER_MAX_ENCODED_BYTES_V1;
  } catch {
    return false;
  }
}

function projectSettingSchemaValueSemantics(schema: PluginSettingFieldSchemaV2): unknown {
  const {
    title: _title,
    description: _description,
    properties,
    additionalProperties,
    items,
    anyOf,
    oneOf,
    allOf,
    ...rest
  } = schema;
  const output: Record<string, unknown> = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined),
  );
  if (properties) {
    output.properties = Object.fromEntries(Object.entries(properties).map(([key, value]) => (
      [key, projectSettingSchemaValueSemantics(value)]
    )));
  }
  if (additionalProperties !== undefined) {
    output.additionalProperties = typeof additionalProperties === 'boolean'
      ? additionalProperties
      : projectSettingSchemaValueSemantics(additionalProperties);
  }
  if (items) output.items = projectSettingSchemaValueSemantics(items);
  if (anyOf) output.anyOf = anyOf.map(projectSettingSchemaValueSemantics);
  if (oneOf) output.oneOf = oneOf.map(projectSettingSchemaValueSemantics);
  if (allOf) output.allOf = allOf.map(projectSettingSchemaValueSemantics);
  return output;
}

function haveEquivalentSettingValueSchemas(
  left: PluginSettingFieldSchemaV2,
  right: PluginSettingFieldSchemaV2,
): boolean {
  return containsEquivalentPluginJsonValue(
    [projectSettingSchemaValueSemantics(left)],
    projectSettingSchemaValueSemantics(right),
  );
}

export const PluginSettingFieldPresentationV2Schema = z.object({
  control: z.enum(['auto', 'text', 'textarea', 'switch', 'select', 'multiSelect', 'number', 'json']).optional(),
  placeholder: PluginLocalizedStringV2Schema.optional(),
  options: z.array(PluginSettingOptionV2Schema).optional(),
  step: z.number().positive().optional(),
  binding: PluginSettingFieldBindingV2Schema.optional(),
  hidden: z.boolean().optional(),
  order: z.number().int().optional(),
}).strict();

export const PluginSettingAnalyticsV2Schema = z.object({
  trackCurrentState: z.boolean().optional(),
  trackChanges: z.boolean().optional(),
  valueKind: z.enum(['boolean', 'enum', 'bucket', 'count', 'presence']),
  privacy: z.enum(['safe', 'bucketed', 'count_only', 'presence_only', 'forbidden']),
  identityScope: z.enum(['person', 'device_user']),
  serializeCurrentRule: z.enum(['orderedEnumArrayJoin', 'jsonObjectStringPresence']).optional(),
}).strict();

const PluginSettingFieldBaseV2Schema = z.object({
  id: PluginSettingFieldIdV2Schema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  schema: PluginSettingFieldSchemaV2Schema,
  availability: PluginAvailabilityDescriptorV2Schema.optional(),
  presentation: PluginSettingFieldPresentationV2Schema.optional(),
  analytics: PluginSettingAnalyticsV2Schema.optional(),
});
export const PluginSettingFieldV2Schema = z.union([
  PluginSettingFieldBaseV2Schema.extend({
    secret: PluginSettingSecretDeclarationSchema,
    default: z.never().optional(),
  }).strict(),
  PluginSettingFieldBaseV2Schema.extend({ secret: z.literal(false).optional(), default: PluginJsonValueV2Schema.optional() }).strict(),
]);
export type PluginSettingFieldV2 = z.infer<typeof PluginSettingFieldV2Schema>;
export const PluginConfigurationSettingFieldV2Schema = z.union([
  PluginSettingFieldBaseV2Schema.extend({ secret: z.literal(true), default: z.never().optional(), required: z.boolean().optional() }).strict(),
  PluginSettingFieldBaseV2Schema.extend({ secret: z.literal(false).optional(), default: PluginJsonValueV2Schema.optional(), required: z.boolean().optional() }).strict(),
]);
export type PluginConfigurationSettingFieldV2 =
  z.infer<typeof PluginConfigurationSettingFieldV2Schema>;

export const PluginSettingsIconV2Schema = z.object({
  ionName: z.string().trim().min(1),
  color: z.object({
    kind: z.literal('theme'),
    token: z.string().trim().min(1),
  }).strict(),
}).strict();

export const PluginSettingsSectionV2Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  fields: z.array(PluginSettingFieldIdV2Schema).min(1),
}).strict();

/**
 * A labelled cross-link from the host Sub-agents screen into the agent settings
 * screen of the contribution that declares it.
 *
 * It carries NO route. A public plugin declaration must not depend on private
 * host route topology: the destination is the settings contribution's own
 * `target: { kind: 'agent' }`, and the host owns how that agent's settings
 * screen is reached. An item declared by a `target: { kind: 'plugin' }`
 * contribution therefore has no destination and is not presented.
 */
export const PluginSettingsSubagentItemV2Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  iconIonName: z.string().trim().min(1).optional(),
}).strict();

export const PluginSettingsSubagentSectionV2Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  items: z.array(PluginSettingsSubagentItemV2Schema),
}).strict();

export const PluginSettingsPresentationV2Schema = z.object({
  icon: PluginSettingsIconV2Schema.optional(),
  sections: z.array(PluginSettingsSectionV2Schema).default([]),
  subagentSections: z.array(PluginSettingsSubagentSectionV2Schema).default([]),
}).strict();

export const PluginSettingsActionDeclarationV2Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  placement: z.union([
    z.object({ kind: z.literal('contributionFooter') }).strict(),
    z.object({
      kind: z.literal('afterField'),
      fieldId: PluginSettingFieldIdV2Schema,
    }).strict(),
  ]),
  confirmation: z.union([
    z.object({ kind: z.literal('none') }).strict(),
    z.object({
      kind: z.literal('required'),
      title: PluginLocalizedStringV2Schema,
      description: PluginLocalizedStringV2Schema,
      confirmLabel: PluginLocalizedStringV2Schema,
    }).strict(),
  ]),
  patchFieldIds: z.array(PluginSettingFieldIdV2Schema).min(1).max(16)
    .refine((ids) => new Set(ids).size === ids.length, 'Settings action patch field ids must be unique.'),
}).strict();
export type PluginSettingsActionDeclarationV2 = z.infer<typeof PluginSettingsActionDeclarationV2Schema>;

export const PluginSettingsContributionV2Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  version: z.literal(1).default(1),
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  target: z.union([
    z.object({ kind: z.literal('plugin') }).strict(),
    z.object({ kind: z.literal('agent'), agent: asProtocolZod(PluginContributionReferenceV2Schema) }).strict(),
  ]),
  scope: PluginSettingsScopeV1Schema,
  fields: z.array(PluginSettingFieldV2Schema),
  actions: z.array(PluginSettingsActionDeclarationV2Schema).max(8).default([]),
  presentation: PluginSettingsPresentationV2Schema.default({
    sections: [],
    subagentSections: [],
  }),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.fields.forEach((field, fieldIndex) => {
    if (seen.has(field.id)) ctx.addIssue({ code: 'custom', path: ['fields', fieldIndex, 'id'], message: `Duplicate settings field id '${field.id}'.` });
    seen.add(field.id);
    const options = field.presentation?.options;
    if (options) {
      const schemaOptions = field.schema.type === 'array'
        ? field.schema.items?.enum
        : field.schema.enum;
      options.forEach((option, optionIndex) => {
        if (!schemaOptions || !containsEquivalentPluginJsonValue(schemaOptions, option.value)) {
          ctx.addIssue({
            code: 'custom',
            path: ['fields', fieldIndex, 'presentation', 'options', optionIndex, 'value'],
            message: `Setting option is not accepted by field '${field.id}'.`,
          });
        }
      });
    }
    const binding = field.presentation?.binding;
    if (binding?.kind === 'perActiveServer' && value.scope !== 'account') {
      ctx.addIssue({
        code: 'custom',
        path: ['fields', fieldIndex, 'presentation', 'binding'],
        message: 'plugin_settings_binding_scope_invalid: perActiveServer is available only to Account-scoped Settings.',
      });
    }
    if (binding?.kind === 'direct' && binding.settingId && !seen.has(binding.settingId)) {
      // Direct forward references are checked after the complete field inventory below.
    }
  });
  const fieldsById = new Map(value.fields.map((field) => [field.id, field] as const));
  const actionIds = new Set<string>();
  value.actions.forEach((action, actionIndex) => {
    if (actionIds.has(action.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['actions', actionIndex, 'id'],
        message: `Duplicate settings action id '${action.id}'.`,
      });
    }
    actionIds.add(action.id);
    if (action.placement.kind === 'afterField' && !fieldsById.has(action.placement.fieldId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['actions', actionIndex, 'placement', 'fieldId'],
        message: `Unknown settings action placement field '${action.placement.fieldId}'.`,
      });
    }
    action.patchFieldIds.forEach((fieldId, fieldIndex) => {
      const field = fieldsById.get(fieldId);
      if (!field) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', actionIndex, 'patchFieldIds', fieldIndex],
          message: `Unknown settings action patch field '${fieldId}'.`,
        });
      } else if (field.secret !== undefined && field.secret !== false) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', actionIndex, 'patchFieldIds', fieldIndex],
          message: `Settings action patch field '${fieldId}' must not be secret.`,
        });
      }
    });
  });
  value.presentation.sections.forEach((section, sectionIndex) => {
    const sectionFields = new Set<string>();
    section.fields.forEach((fieldId, fieldIndex) => {
      if (!seen.has(fieldId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['presentation', 'sections', sectionIndex, 'fields', fieldIndex],
          message: `Unknown settings field id '${fieldId}'.`,
        });
      } else if (sectionFields.has(fieldId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['presentation', 'sections', sectionIndex, 'fields', fieldIndex],
          message: `Duplicate settings field id '${fieldId}' in section '${section.id}'.`,
        });
      }
      sectionFields.add(fieldId);
    });
  });
  value.fields.forEach((field, fieldIndex) => {
    const binding = field.presentation?.binding;
    const referencedIds = binding?.kind === 'direct'
      ? (binding.settingId ? [binding.settingId] : [])
      : binding?.kind === 'perActiveServer'
        ? [binding.fallbackSettingId, binding.byServerIdSettingId]
        : [];
    referencedIds.forEach((fieldId) => {
      if (!seen.has(fieldId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', fieldIndex, 'presentation', 'binding'],
          message: `Unknown bound settings field id '${fieldId}'.`,
        });
      }
    });
    if (binding?.kind === 'perActiveServer') {
      const fallback = fieldsById.get(binding.fallbackSettingId);
      const byServer = fieldsById.get(binding.byServerIdSettingId);
      const fallbackIsSecret = fallback?.secret !== undefined && fallback.secret !== false;
      const byServerIsSecret = byServer?.secret !== undefined && byServer.secret !== false;
      const fallbackIsScalar = fallback?.schema.type === 'null'
        || fallback?.schema.type === 'boolean'
        || fallback?.schema.type === 'number'
        || fallback?.schema.type === 'integer'
        || fallback?.schema.type === 'string';
      if (binding.fallbackSettingId !== field.id || !fallback || fallbackIsSecret || !fallbackIsScalar) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', fieldIndex, 'presentation', 'binding', 'fallbackSettingId'],
          message: 'perActiveServer requires its visible non-secret scalar fallback field in the same contribution.',
        });
      }
      if (!byServer || byServerIsSecret || byServer.presentation?.hidden !== true
        || byServer.schema.type !== 'object' || byServer.schema.additionalProperties === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', fieldIndex, 'presentation', 'binding', 'byServerIdSettingId'],
          message: 'perActiveServer requires a hidden non-secret object map field in the same contribution.',
        });
      } else {
        const mapValueSchema = byServer.schema.additionalProperties;
        if (
          !fallback
          || typeof mapValueSchema !== 'object'
          || !haveEquivalentSettingValueSchemas(fallback.schema, mapValueSchema)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['fields', fieldIndex, 'presentation', 'binding', 'byServerIdSettingId'],
            message: 'perActiveServer requires its map values to match the visible fallback field schema.',
          });
        }
        if (byServer.default !== undefined && !isBoundedPluginPerActiveServerValueV1(byServer.default)) {
          ctx.addIssue({
            code: 'custom',
            path: ['fields', fieldIndex, 'default'],
            message: 'perActiveServer map defaults must have at most 256 entries, 64 KiB encoded data, and depth 4.',
          });
        }
      }
    }
    const managedServiceOrigin = readPluginSettingManagedServiceOrigin(field.secret);
    if (managedServiceOrigin) {
      const endpoint = fieldsById.get(managedServiceOrigin.endpointSettingId);
      const endpointIsSecret = endpoint?.secret !== undefined && endpoint.secret !== false;
      if (value.scope !== 'account') {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', fieldIndex, 'secret', 'managedServiceOrigin'],
          message: 'managedServiceOrigin is available only to Account-scoped Settings.',
        });
      }
      if (readPluginSettingSecretCustody(field.secret) !== 'daemon') {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', fieldIndex, 'secret', 'managedServiceOrigin'],
          message: 'managedServiceOrigin requires daemon secret custody.',
        });
      }
      if (!endpoint || endpointIsSecret || endpoint.schema.type !== 'string') {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', fieldIndex, 'secret', 'managedServiceOrigin', 'endpointSettingId'],
          message: 'managedServiceOrigin requires a non-secret string endpoint field in the same contribution.',
        });
      }
    }
  });
});
export type ParsedPluginSettingsContributionV2 = z.infer<typeof PluginSettingsContributionV2Schema>;
/** Author declarations may omit actions; canonical parsing materializes the empty list. */
export type PluginSettingsContributionV2 = Omit<ParsedPluginSettingsContributionV2, 'actions'> & Readonly<{
  actions?: ParsedPluginSettingsContributionV2['actions'];
}>;
export type PluginSettingsContribution = z.input<typeof PluginSettingsContributionV2Schema>;
