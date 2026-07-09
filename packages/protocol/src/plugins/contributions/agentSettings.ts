import { z } from 'zod';

const SecretLikeKeyPattern =
  /(?:^|_)(?:secret|password|api_key|client_secret|(?:api|auth|access|refresh|bearer|id|oauth|client|credential)_token|credential_(?:secret|password|key))(?:_|$)/i;

function isSecretLikeSettingKey(id: string): boolean {
  const normalized = id
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s.-]+/g, '_');
  return SecretLikeKeyPattern.test(normalized);
}

const TranslationRefSchema = z.object({
  key: z.string().trim().min(1),
}).strict();

const AgentSettingsIconSchema = z.object({
  ionName: z.string().trim().min(1),
  color: z.object({
    kind: z.literal('theme'),
    token: z.string().trim().min(1),
  }).strict(),
}).strict();

const AgentSettingsEnumOptionSchema = z.object({
  id: z.string().trim().min(1),
  title: TranslationRefSchema,
  subtitle: TranslationRefSchema.optional(),
}).strict();

const AgentSettingsFieldUiSchema = z.object({
  kind: z.enum(['boolean', 'enum', 'multiEnum', 'number', 'json', 'text']),
  title: TranslationRefSchema,
  subtitle: TranslationRefSchema.optional(),
  enumOptions: z.array(AgentSettingsEnumOptionSchema).optional(),
  numberSpec: z.object({
    min: z.number().optional(),
    step: z.number().optional(),
    placeholder: TranslationRefSchema.optional(),
  }).strict().optional(),
  binding: z.object({
    kind: z.literal('perActiveServer'),
    fallbackSettingKey: z.string().trim().min(1),
    byServerIdSettingKey: z.string().trim().min(1),
  }).strict().optional(),
}).strict();

const AgentSettingsBooleanSchema = z.object({
  kind: z.literal('boolean'),
}).strict();

const AgentSettingsStringSchema = z.object({
  kind: z.literal('string'),
  maxLength: z.number().int().positive().optional(),
}).strict();

const AgentSettingsStringRecordSchema = z.object({
  kind: z.literal('stringRecord'),
}).strict();

const AgentSettingsJsonObjectStringSchema = z.object({
  kind: z.literal('jsonObjectString'),
  maxLength: z.number().int().positive().optional(),
}).strict();

const AgentSettingsEnumSchema = z.object({
  kind: z.literal('enum'),
  values: z.array(z.string().trim().min(1)).min(1),
}).strict();

const AgentSettingsEnumArraySchema = z.object({
  kind: z.literal('enumArray'),
  values: z.array(z.string().trim().min(1)).min(1),
  max: z.number().int().positive().optional(),
}).strict();

const AgentSettingsPositiveIntegerSchema = z.object({
  kind: z.literal('positiveInteger'),
  nullable: z.boolean().optional(),
  max: z.number().int().positive().optional(),
}).strict();

export const PluginAgentSettingsFieldSchemaV1Schema = z.discriminatedUnion('kind', [
  AgentSettingsBooleanSchema,
  AgentSettingsStringSchema,
  AgentSettingsStringRecordSchema,
  AgentSettingsJsonObjectStringSchema,
  AgentSettingsEnumSchema,
  AgentSettingsEnumArraySchema,
  AgentSettingsPositiveIntegerSchema,
]);
export type PluginAgentSettingsFieldSchemaV1 = z.infer<typeof PluginAgentSettingsFieldSchemaV1Schema>;

const PluginAgentSettingsAnalyticsV1Schema = z.object({
  trackCurrentState: z.boolean().optional(),
  trackChanges: z.boolean().optional(),
  valueKind: z.enum(['boolean', 'enum', 'bucket', 'count', 'presence']),
  privacy: z.enum(['safe', 'bucketed', 'count_only', 'presence_only', 'forbidden']),
  identityScope: z.enum(['person', 'device_user']),
  serializeCurrentRule: z.enum(['orderedEnumArrayJoin', 'jsonObjectStringPresence']).optional(),
}).strict();
export type PluginAgentSettingsAnalyticsV1 = z.infer<typeof PluginAgentSettingsAnalyticsV1Schema>;

export const PluginAgentSettingsFieldV1Schema = z.object({
  id: z.string().trim().min(1),
  schema: PluginAgentSettingsFieldSchemaV1Schema,
  default: z.unknown(),
  description: z.string().trim().min(1),
  storageScope: z.enum(['account', 'local']).default('account'),
  analytics: PluginAgentSettingsAnalyticsV1Schema.optional(),
  ui: AgentSettingsFieldUiSchema.optional(),
}).strict().superRefine((field, ctx) => {
  if (isSecretLikeSettingKey(field.id)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['id'],
      message: 'Agent settings descriptors may not declare secret-like setting keys.',
    });
  }

  if (!agentSettingsDefaultMatchesSchema(field.default, field.schema)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['default'],
      message: 'Agent settings default does not match its schema.',
    });
  }
});
export type PluginAgentSettingsFieldV1 = z.infer<typeof PluginAgentSettingsFieldV1Schema>;

const AgentSettingsSubagentSectionSchema = z.object({
  id: z.string().trim().min(1),
  title: TranslationRefSchema,
  footer: TranslationRefSchema.optional(),
  items: z.array(z.object({
    id: z.string().trim().min(1),
    title: TranslationRefSchema,
    subtitle: TranslationRefSchema.optional(),
    route: z.string().trim().min(1),
    iconIonName: z.string().trim().min(1).optional(),
  }).strict()).default([]),
}).strict();

const AgentSettingsUiSectionSchema = z.object({
  id: z.string().trim().min(1),
  title: TranslationRefSchema,
  footer: TranslationRefSchema.optional(),
  fields: z.array(z.string().trim().min(1)).min(1),
}).strict();

const AgentSettingsUiSchema = z.object({
  title: TranslationRefSchema.optional(),
  icon: AgentSettingsIconSchema.optional(),
  sections: z.array(AgentSettingsUiSectionSchema).default([]),
  subagentSettingsSections: z.array(AgentSettingsSubagentSectionSchema).default([]),
}).strict().default({ sections: [], subagentSettingsSections: [] });

export const PluginAgentSettingsContributionV1Schema = z.object({
  id: z.string().trim().min(1),
  kind: z.literal('agentSettings.v1').default('agentSettings.v1'),
  agentId: z.string().trim().min(1),
  version: z.literal(1).default(1),
  storageScope: z.literal('agentAccount').default('agentAccount'),
  fields: z.array(PluginAgentSettingsFieldV1Schema),
  ui: AgentSettingsUiSchema,
}).strict().superRefine((contribution, ctx) => {
  const seenFields = new Set<string>();
  for (const [index, field] of contribution.fields.entries()) {
    if (seenFields.has(field.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fields', index, 'id'],
        message: `Duplicate agent setting field id "${field.id}".`,
      });
    }
    seenFields.add(field.id);
  }

  for (const [sectionIndex, section] of contribution.ui.sections.entries()) {
    for (const [fieldIndex, fieldId] of section.fields.entries()) {
      if (!seenFields.has(fieldId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ui', 'sections', sectionIndex, 'fields', fieldIndex],
          message: `Unknown agent setting field id "${fieldId}".`,
        });
      }
    }
  }
});
export type PluginAgentSettingsContributionV1 = z.infer<typeof PluginAgentSettingsContributionV1Schema>;

export type PluginAgentSettingsUiDescriptorV1 = Readonly<{
  kind: 'agentSettings.v1';
  descriptorId: string;
  agentId: string;
  title?: Readonly<{ key: string }>;
  icon?: Readonly<{ ionName: string; color: Readonly<{ kind: 'theme'; token: string }> }>;
  settings: Readonly<Record<string, Readonly<{
    schema: Readonly<Record<string, unknown>>;
    default: unknown;
    description: string;
    storageScope: 'account' | 'local';
  }>>>;
  subagentSettingsSections: readonly unknown[];
  uiSections: readonly Readonly<{
    id: string;
    title: Readonly<{ key: string }>;
    footer?: Readonly<{ key: string }>;
    fields: readonly Readonly<Record<string, unknown>>[];
  }>[];
}>;

function hasDuplicateStrings(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function isJsonObjectString(value: string, maxLength: number | undefined): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (maxLength !== undefined && trimmed.length > maxLength) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

function agentSettingsDefaultMatchesSchema(
  value: unknown,
  schema: PluginAgentSettingsFieldSchemaV1,
): boolean {
  if (schema.kind === 'boolean') return typeof value === 'boolean';
  if (schema.kind === 'string') {
    return typeof value === 'string'
      && (schema.maxLength === undefined || value.length <= schema.maxLength);
  }
  if (schema.kind === 'stringRecord') {
    return value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.values(value).every((entry) => typeof entry === 'string');
  }
  if (schema.kind === 'jsonObjectString') {
    return typeof value === 'string' && isJsonObjectString(value, schema.maxLength);
  }
  if (schema.kind === 'enum') {
    return !hasDuplicateStrings(schema.values)
      && typeof value === 'string'
      && schema.values.includes(value);
  }
  if (schema.kind === 'enumArray') {
    return !hasDuplicateStrings(schema.values)
      && Array.isArray(value)
      && (schema.max === undefined || value.length <= schema.max)
      && value.every((entry) => typeof entry === 'string' && schema.values.includes(entry));
  }
  if (schema.kind === 'positiveInteger') {
    if (value === null) return schema.nullable === true;
    return typeof value === 'number'
      && Number.isInteger(value)
      && value > 0
      && (schema.max === undefined || value <= schema.max);
  }
  return false;
}

export function defineAgentSettingsContribution<const TContribution extends Readonly<{
  id: string;
  agentId: string;
  fields: readonly PluginAgentSettingsFieldV1[];
  ui?: PluginAgentSettingsContributionV1['ui'];
}>>(contribution: TContribution): PluginAgentSettingsContributionV1 & TContribution {
  return {
    kind: 'agentSettings.v1',
    version: 1,
    storageScope: 'agentAccount',
    ...contribution,
    ui: contribution.ui ?? { sections: [], subagentSettingsSections: [] },
  } as PluginAgentSettingsContributionV1 & TContribution;
}

type FieldBaseInput = Readonly<{
  id: string;
  description: string;
  storageScope?: 'account' | 'local';
  analytics?: PluginAgentSettingsAnalyticsV1;
  ui?: PluginAgentSettingsFieldV1['ui'];
}>;

function settingField(input: FieldBaseInput & Readonly<{
  schema: PluginAgentSettingsFieldSchemaV1;
  default: unknown;
}>): PluginAgentSettingsFieldV1 {
  return {
    id: input.id,
    schema: input.schema,
    default: input.default,
    description: input.description,
    storageScope: input.storageScope ?? 'account',
    ...(input.analytics ? { analytics: input.analytics } : {}),
    ...(input.ui ? { ui: input.ui } : {}),
  };
}

export function booleanAgentSetting(input: FieldBaseInput & Readonly<{ default: boolean }>): PluginAgentSettingsFieldV1 {
  return settingField({ ...input, schema: { kind: 'boolean' } });
}

export function stringAgentSetting(input: FieldBaseInput & Readonly<{
  default: string;
  maxLength?: number;
}>): PluginAgentSettingsFieldV1 {
  return settingField({
    ...input,
    schema: {
      kind: 'string',
      ...(input.maxLength !== undefined ? { maxLength: input.maxLength } : {}),
    },
  });
}

export function stringRecordAgentSetting(input: FieldBaseInput & Readonly<{
  default: Readonly<Record<string, string>>;
}>): PluginAgentSettingsFieldV1 {
  return settingField({
    ...input,
    schema: {
      kind: 'stringRecord',
    },
  });
}

export function enumAgentSetting<const TValues extends readonly [string, ...string[]]>(input: FieldBaseInput & Readonly<{
  values: TValues;
  default: TValues[number];
}>): PluginAgentSettingsFieldV1 {
  return settingField({ ...input, schema: { kind: 'enum', values: [...input.values] } });
}

export function enumArrayAgentSetting<const TValues extends readonly [string, ...string[]]>(input: FieldBaseInput & Readonly<{
  values: TValues;
  default: readonly TValues[number][];
  max?: number;
}>): PluginAgentSettingsFieldV1 {
  return settingField({
    ...input,
    schema: {
      kind: 'enumArray',
      values: [...input.values],
      ...(input.max !== undefined ? { max: input.max } : {}),
    },
  });
}

export function positiveIntegerAgentSetting(input: FieldBaseInput & Readonly<{
  default: number | null;
  nullable?: boolean;
  max?: number;
}>): PluginAgentSettingsFieldV1 {
  return settingField({
    ...input,
    schema: {
      kind: 'positiveInteger',
      ...(input.nullable ? { nullable: true } : {}),
      ...(input.max !== undefined ? { max: input.max } : {}),
    },
  });
}

export function jsonObjectStringAgentSetting(input: FieldBaseInput & Readonly<{
  default: string;
  maxLength?: number;
}>): PluginAgentSettingsFieldV1 {
  return settingField({
    ...input,
    schema: {
      kind: 'jsonObjectString',
      ...(input.maxLength !== undefined ? { maxLength: input.maxLength } : {}),
    },
  });
}

export function buildAgentSettingsDefaults(
  contribution: PluginAgentSettingsContributionV1,
): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(contribution.fields.map((field) => [field.id, field.default])));
}

function agentFieldSchemaToUiSchema(schema: PluginAgentSettingsFieldSchemaV1): Readonly<Record<string, unknown>> {
  if (schema.kind === 'enumArray') {
    return {
      kind: 'array',
      element: { kind: 'enum', values: schema.values },
      ...(schema.max ? { max: schema.max } : {}),
    };
  }
  if (schema.kind === 'positiveInteger') {
    return {
      kind: 'number',
      int: true,
      min: 1,
      ...(schema.max ? { max: schema.max } : {}),
      ...(schema.nullable ? { nullable: true } : {}),
    };
  }
  return schema;
}

function agentFieldUiKind(field: PluginAgentSettingsFieldV1): string {
  if (field.ui?.kind) return field.ui.kind;
  if (field.schema.kind === 'boolean') return 'boolean';
  if (field.schema.kind === 'enum') return 'enum';
  if (field.schema.kind === 'enumArray') return 'multiEnum';
  if (field.schema.kind === 'positiveInteger') return 'number';
  if (field.schema.kind === 'jsonObjectString') return 'json';
  return 'text';
}

function agentFieldToUiField(field: PluginAgentSettingsFieldV1): Readonly<Record<string, unknown>> {
  return {
    key: field.id,
    kind: agentFieldUiKind(field),
    ...(field.ui?.title ? { title: field.ui.title } : {}),
    ...(field.ui?.subtitle ? { subtitle: field.ui.subtitle } : {}),
    ...(field.ui?.enumOptions ? { enumOptions: field.ui.enumOptions } : {}),
    ...(field.ui?.numberSpec ? { numberSpec: field.ui.numberSpec } : {}),
    ...(field.ui?.binding ? { binding: field.ui.binding } : {}),
  };
}

export function agentSettingsContributionToUiDescriptor(
  contribution: PluginAgentSettingsContributionV1,
): PluginAgentSettingsUiDescriptorV1 {
  const fieldsById = new Map(contribution.fields.map((field) => [field.id, field]));
  const settings = Object.fromEntries(contribution.fields.map((field) => [
    field.id,
    {
      schema: agentFieldSchemaToUiSchema(field.schema),
      default: field.default,
      description: field.description,
      storageScope: field.storageScope,
    },
  ]));

  return Object.freeze({
    kind: 'agentSettings.v1',
    descriptorId: contribution.id,
    agentId: contribution.agentId,
    ...(contribution.ui.title ? { title: contribution.ui.title } : {}),
    ...(contribution.ui.icon ? { icon: contribution.ui.icon } : {}),
    settings,
    subagentSettingsSections: contribution.ui.subagentSettingsSections,
    uiSections: contribution.ui.sections.map((section) => ({
      id: section.id,
      title: section.title,
      ...(section.footer ? { footer: section.footer } : {}),
      fields: section.fields.flatMap((fieldId) => {
        const field = fieldsById.get(fieldId);
        return field ? [agentFieldToUiField(field)] : [];
      }),
    })),
  });
}
