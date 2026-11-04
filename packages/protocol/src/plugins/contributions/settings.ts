import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
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
export const PluginSettingFieldSchemaV2Schema: z.ZodMiniType<PluginSettingFieldSchemaV2> = z.lazy(() => z.strictObject({
  type: z.optional(z.enum(['null', 'boolean', 'number', 'integer', 'string', 'array', 'object'])),
  title: z.optional(z.string()), description: z.optional(z.string()),
  enum: z.optional(z.array(PluginJsonValueV2Schema)), const: z.optional(PluginJsonValueV2Schema),
  properties: z.optional(z.record(z.string(), PluginSettingFieldSchemaV2Schema)), required: z.optional(z.array(z.string())),
  additionalProperties: z.optional(z.union([z.boolean(), PluginSettingFieldSchemaV2Schema])), items: z.optional(PluginSettingFieldSchemaV2Schema),
  minItems: z.optional(z.number().check(z.int(), z.nonnegative())), maxItems: z.optional(z.number().check(z.int(), z.nonnegative())),
  minimum: z.optional(z.number()), maximum: z.optional(z.number()),
  minLength: z.optional(z.number().check(z.int(), z.nonnegative())), maxLength: z.optional(z.number().check(z.int(), z.nonnegative())), pattern: z.optional(z.string()),
  anyOf: z.optional(z.array(PluginSettingFieldSchemaV2Schema)), oneOf: z.optional(z.array(PluginSettingFieldSchemaV2Schema)), allOf: z.optional(z.array(PluginSettingFieldSchemaV2Schema)),
}));

export const PluginSettingFieldIdV2Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(128), z.regex(/^[A-Za-z][A-Za-z0-9_./-]*$/, 'Setting field ids must start with a letter and contain only letters, digits, underscores, dots, slashes, or hyphens.')));
export type PluginSettingFieldIdV2 = z.infer<typeof PluginSettingFieldIdV2Schema>;

/**
 * Secret custody is independent from the Settings model that presents a field.
 * A declaration is the only way a plugin can select its own secret owner.
 */
export const PluginSecretCustodyV1Schema = lazyZodSchema(() => z.enum(['account', 'daemon']));
export type PluginSecretCustody = z.infer<typeof PluginSecretCustodyV1Schema>;

/**
 * A daemon-custodied secret may be bound to the canonical origin resolved from
 * one visible Account endpoint field. The relation is declarative metadata:
 * it never makes the secret an Account-record value.
 */
export const PluginSettingManagedServiceOriginV1Schema = lazyZodSchema(() => z.strictObject({
  endpointSettingId: PluginSettingFieldIdV2Schema,
}));
export type PluginSettingManagedServiceOriginV1 = z.infer<
  typeof PluginSettingManagedServiceOriginV1Schema
>;

/** The only persistence partitions available to declarative plugin Settings. */
export const PluginSettingsScopeV1Schema = lazyZodSchema(() => z.enum(['account', 'daemon']));
export type PluginSettingsScopeV1 = z.infer<typeof PluginSettingsScopeV1Schema>;

/** A Settings operation must name its one record; there is no merged scope. */
export const PluginSettingsScopeRefV1Schema = lazyZodSchema(() => z.strictObject({
  kind: PluginSettingsScopeV1Schema,
}));
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

export const PluginSettingSecretDeclarationSchema = lazyZodSchema(() => z.union([
  z.literal(true),
  z.strictObject({
    custody: PluginSecretCustodyV1Schema,
    managedServiceOrigin: z.optional(PluginSettingManagedServiceOriginV1Schema),
  }),
]));
export type PluginSettingSecretDeclaration =
  z.input<typeof PluginSettingSecretDeclarationSchema>;
export type ParsedPluginSettingSecretDeclaration =
  z.output<typeof PluginSettingSecretDeclarationSchema>;

/** A non-Settings declared secret. Omitted custody normalizes to Account. */
export const PluginDirectSecretDeclarationV1Schema = lazyZodSchema(() => z.strictObject({
  id: PluginSettingFieldIdV2Schema,
  custody: z._default(PluginSecretCustodyV1Schema, 'account'),
}));
export type PluginDirectSecretDeclarationV1 =
  z.input<typeof PluginDirectSecretDeclarationV1Schema>;
export type ParsedPluginDirectSecretDeclarationV1 =
  z.output<typeof PluginDirectSecretDeclarationV1Schema>;

export const PluginSettingOptionV2Schema = lazyZodSchema(() => z.strictObject({
  value: PluginJsonValueV2Schema,
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
}));

export const PluginSettingFieldBindingV2Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    kind: z.literal('direct'),
    settingId: z.optional(PluginSettingFieldIdV2Schema),
  }),
  z.strictObject({
    kind: z.literal('perActiveServer'),
    fallbackSettingId: PluginSettingFieldIdV2Schema,
    byServerIdSettingId: PluginSettingFieldIdV2Schema,
  }),
]));

export type PluginSettingStorageBindingV1 = z.infer<typeof PluginSettingFieldBindingV2Schema>;
type PluginSettingBoundFieldV1 = Readonly<{ key: string; binding?: PluginSettingStorageBindingV1 }>;
type PluginSettingBoundInputV1 = Readonly<{
  values: Readonly<Record<string, unknown>>;
  field: PluginSettingBoundFieldV1;
  serverIdentityId: string | null;
}>;

function readPluginSettingBindingRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

/** The declared binding is the sole mapping from a display field to its storage field. */
export function readPluginSettingBoundValueV1(params: PluginSettingBoundInputV1): unknown {
  const binding = params.field.binding;
  if (binding?.kind === 'direct') return params.values[binding.settingId ?? params.field.key];
  if (binding?.kind === 'perActiveServer') {
    const byServer = readPluginSettingBindingRecord(params.values[binding.byServerIdSettingId]);
    if (params.serverIdentityId && byServer && Object.hasOwn(byServer, params.serverIdentityId)) return byServer[params.serverIdentityId];
    return params.values[binding.fallbackSettingId];
  }
  return params.values[params.field.key];
}

export function resolvePluginSettingBoundSetV1(params: PluginSettingBoundInputV1 & Readonly<{ value: unknown }>):
  Readonly<{ fieldId: string; value: unknown }> {
  const binding = params.field.binding;
  if (binding?.kind === 'direct') return { fieldId: binding.settingId ?? params.field.key, value: params.value };
  if (binding?.kind !== 'perActiveServer' || !params.serverIdentityId) return {
    fieldId: binding?.kind === 'perActiveServer' ? binding.fallbackSettingId : params.field.key, value: params.value,
  };
  const current = readPluginSettingBindingRecord(params.values[binding.byServerIdSettingId]);
  const byServer: Record<string, unknown> = current ? { ...current } : {};
  byServer[params.serverIdentityId] = params.value;
  return { fieldId: binding.byServerIdSettingId, value: byServer };
}

export function resolvePluginSettingBoundResetV1(params: PluginSettingBoundInputV1): Readonly<{
  fieldId: string;
  mutation: Readonly<{ kind: 'delete' }> | Readonly<{ kind: 'set'; value: Readonly<Record<string, unknown>> }>;
}> {
  const binding = params.field.binding;
  if (binding?.kind !== 'perActiveServer' || !params.serverIdentityId) return {
    fieldId: binding?.kind === 'perActiveServer' ? binding.fallbackSettingId
      : binding?.kind === 'direct' ? binding.settingId ?? params.field.key : params.field.key,
    mutation: { kind: 'delete' },
  };
  const current = readPluginSettingBindingRecord(params.values[binding.byServerIdSettingId]);
  const byServer = { ...current };
  delete byServer[params.serverIdentityId];
  return { fieldId: binding.byServerIdSettingId,
    mutation: Object.keys(byServer).length === 0 ? { kind: 'delete' } : { kind: 'set', value: byServer } };
}

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

export const PluginSettingFieldPresentationV2Schema = lazyZodSchema(() => z.strictObject({
  control: z.optional(z.enum(['auto', 'text', 'textarea', 'switch', 'select', 'multiSelect', 'number', 'json'])),
  placeholder: z.optional(PluginLocalizedStringV2Schema),
  options: z.optional(z.array(PluginSettingOptionV2Schema)),
  step: z.optional(z.number().check(z.positive())),
  binding: z.optional(PluginSettingFieldBindingV2Schema),
  hidden: z.optional(z.boolean()),
  /** Folded under the form's Advanced row until opened; meant for optional fields most people skip. */
  advanced: z.optional(z.literal(true)),
  order: z.optional(z.number().check(z.int())),
}));

export const PluginSettingAnalyticsV2Schema = lazyZodSchema(() => z.strictObject({
  trackCurrentState: z.optional(z.boolean()),
  trackChanges: z.optional(z.boolean()),
  valueKind: z.enum(['boolean', 'enum', 'bucket', 'count', 'presence']),
  privacy: z.enum(['safe', 'bucketed', 'count_only', 'presence_only', 'forbidden']),
  identityScope: z.enum(['person', 'device_user']),
  serializeCurrentRule: z.optional(z.enum(['orderedEnumArrayJoin', 'jsonObjectStringPresence'])),
}));

const PluginSettingFieldBaseV2Schema = lazyZodSchema(() => z.object({
  id: PluginSettingFieldIdV2Schema,
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  schema: PluginSettingFieldSchemaV2Schema,
  availability: z.optional(PluginAvailabilityDescriptorV2Schema),
  presentation: z.optional(PluginSettingFieldPresentationV2Schema),
  analytics: z.optional(PluginSettingAnalyticsV2Schema),
}));
export const PluginSettingFieldV2Schema = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginSettingFieldBaseV2Schema, {
    secret: PluginSettingSecretDeclarationSchema,
    default: z.optional(z.never()),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginSettingFieldBaseV2Schema, { secret: z.optional(z.literal(false)), default: z.optional(PluginJsonValueV2Schema) })),
]));
export type PluginSettingFieldV2 = z.infer<typeof PluginSettingFieldV2Schema>;
export const PluginConfigurationSettingFieldV2Schema = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginSettingFieldBaseV2Schema, { secret: z.literal(true), default: z.optional(z.never()), required: z.optional(z.boolean()) })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginSettingFieldBaseV2Schema, { secret: z.optional(z.literal(false)), default: z.optional(PluginJsonValueV2Schema), required: z.optional(z.boolean()) })),
]));
export type PluginConfigurationSettingFieldV2 =
  z.infer<typeof PluginConfigurationSettingFieldV2Schema>;

export const PluginSettingsIconV2Schema = lazyZodSchema(() => z.strictObject({
  ionName: z.string().check(z.trim(), z.minLength(1)),
  color: z.strictObject({
    kind: z.literal('theme'),
    token: z.string().check(z.trim(), z.minLength(1)),
  }),
}));

export const PluginSettingsSectionV2Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  fields: z.array(PluginSettingFieldIdV2Schema).check(z.minLength(1)),
}));

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
export const PluginSettingsSubagentItemV2Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  iconIonName: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

export const PluginSettingsSubagentSectionV2Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  items: z.array(PluginSettingsSubagentItemV2Schema),
}));

export const PluginSettingsPresentationV2Schema = lazyZodSchema(() => z.strictObject({
  icon: z.optional(PluginSettingsIconV2Schema),
  sections: z._default(z.array(PluginSettingsSectionV2Schema), []),
  subagentSections: z._default(z.array(PluginSettingsSubagentSectionV2Schema), []),
}));

export const PluginSettingsActionDeclarationV2Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  placement: z.union([
    z.strictObject({ kind: z.literal('contributionFooter') }),
    z.strictObject({
      kind: z.literal('afterField'),
      fieldId: PluginSettingFieldIdV2Schema,
    }),
  ]),
  confirmation: z.union([
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({
      kind: z.literal('required'),
      title: PluginLocalizedStringV2Schema,
      description: PluginLocalizedStringV2Schema,
      confirmLabel: PluginLocalizedStringV2Schema,
    }),
  ]),
  patchFieldIds: z.array(PluginSettingFieldIdV2Schema).check(z.minLength(1), z.maxLength(16), z.refine((ids) => new Set(ids).size === ids.length, 'Settings action patch field ids must be unique.')),
}));
export type PluginSettingsActionDeclarationV2 = z.infer<typeof PluginSettingsActionDeclarationV2Schema>;

export const PluginSettingsContributionV2Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  version: z._default(z.literal(1), 1),
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  target: z.union([
    z.strictObject({ kind: z.literal('plugin') }),
    z.strictObject({ kind: z.literal('agent'), agent: asProtocolZod(PluginContributionReferenceV2Schema) }),
  ]),
  scope: PluginSettingsScopeV1Schema,
  fields: z.array(PluginSettingFieldV2Schema),
  actions: z._default(z.array(PluginSettingsActionDeclarationV2Schema).check(z.maxLength(8)), []),
  presentation: z._default(PluginSettingsPresentationV2Schema, {
    sections: [],
    subagentSections: [],
  }),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
}).check(z.superRefine((value, ctx) => {
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
})));
export type ParsedPluginSettingsContributionV2 = z.infer<typeof PluginSettingsContributionV2Schema>;
/** Author declarations may omit actions; canonical parsing materializes the empty list. */
export type PluginSettingsContributionV2 = Omit<ParsedPluginSettingsContributionV2, 'actions'> & Readonly<{
  actions?: ParsedPluginSettingsContributionV2['actions'];
}>;
export type PluginSettingsContribution = z.input<typeof PluginSettingsContributionV2Schema>;
