import { z, type core, type ZodRawShape, type ZodType, type ZodTypeAny } from 'zod';

import {
  GENERATED_EXTERNAL_SESSIONS_SOURCE_DECLARATIONS,
} from '../../providers/generated/externalSession/sources.js';

type ExternalSessionWhenDeclaration = Readonly<{ field: string; equals: string }>;
type ExternalSessionSchemaFieldDeclaration = Readonly<{
  name: string;
  kind: 'literal' | 'string' | 'enum' | 'unknown';
  value?: string;
  values?: readonly string[];
  min?: number;
  max?: number;
  optional?: boolean;
  nullish?: boolean;
}>;
type ExternalSessionSchemaRefinementDeclaration =
  | Readonly<{
    kind: 'requiresWhenEquals';
    field: string;
    when: ExternalSessionWhenDeclaration;
  }>
  | Readonly<{
    kind: 'forbidsWhenEquals';
    fields: readonly string[];
    when: ExternalSessionWhenDeclaration;
  }>;
type ExternalSessionKeySegmentDeclaration =
  | Readonly<{ kind: 'literal'; value: string }>
  | Readonly<{ kind: 'field'; field: string }>
  | Readonly<{ kind: 'homeMode'; field: string }>
  | Readonly<{ kind: 'conditionalField'; field: string; when: ExternalSessionWhenDeclaration }>
  | Readonly<{
    kind: 'connectedServiceScope';
    groupField: string;
    profileField: string;
    when: ExternalSessionWhenDeclaration;
  }>;
type ExternalSessionSourceDeclaration = Readonly<{
  providerId: string;
  sourceKind: string;
  schema: Readonly<{
    passthrough?: boolean;
    fields: readonly ExternalSessionSchemaFieldDeclaration[];
    refinements?: readonly ExternalSessionSchemaRefinementDeclaration[];
  }>;
  key: Readonly<{
    segments: readonly ExternalSessionKeySegmentDeclaration[];
  }>;
}>;

const EXTERNAL_SESSIONS_SOURCE_DECLARATIONS = GENERATED_EXTERNAL_SESSIONS_SOURCE_DECLARATIONS satisfies readonly ExternalSessionSourceDeclaration[];

type GeneratedExternalSessionsSourceDeclaration = typeof EXTERNAL_SESSIONS_SOURCE_DECLARATIONS[number];
type GeneratedExternalSessionsProviderId = GeneratedExternalSessionsSourceDeclaration['providerId'];
type GeneratedExternalSessionsSourceKind = GeneratedExternalSessionsSourceDeclaration['sourceKind'];
type ExternalSessionSourceSchemaOption = core.$ZodTypeDiscriminable;
type ExternalSessionsProviderDefinition = Readonly<{
  providerId: GeneratedExternalSessionsProviderId;
  sourceKind: GeneratedExternalSessionsSourceKind;
  sourceSchema: ExternalSessionSourceSchemaOption;
  resolveSourceKey: (source: Record<string, unknown>) => string;
}>;

function normalizeNullableString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function buildExternalSessionFieldSchema(field: ExternalSessionSchemaFieldDeclaration): ZodTypeAny {
  let schema: ZodTypeAny;
  if (field.kind === 'literal') {
    schema = z.literal(field.value ?? '');
  } else if (field.kind === 'enum') {
    const values = [...(field.values ?? [])];
    if (values.length === 0) {
      throw new Error(`Invalid external-session source declaration for ${field.name}: enum requires at least one value`);
    }
    schema = z.enum(values as [string, ...string[]]);
  } else if (field.kind === 'unknown') {
    schema = z.unknown();
  } else {
    let stringSchema = z.string();
    if (typeof field.min === 'number') {
      stringSchema = stringSchema.min(field.min);
    }
    if (typeof field.max === 'number') {
      stringSchema = stringSchema.max(field.max);
    }
    schema = stringSchema;
  }
  if (field.nullish) return schema.nullish();
  if (field.optional) return schema.optional();
  return schema;
}

function externalSessionConditionMatches(value: Record<string, unknown>, when: ExternalSessionWhenDeclaration): boolean {
  return value[when.field] === when.equals;
}

function applyExternalSessionRefinements(
  value: Record<string, unknown>,
  ctx: z.RefinementCtx,
  refinements: readonly ExternalSessionSchemaRefinementDeclaration[],
): void {
  for (const refinement of refinements) {
    if (refinement.kind === 'requiresWhenEquals') {
      if (!externalSessionConditionMatches(value, refinement.when)) continue;
      if (!value[refinement.field]) {
        ctx.addIssue({
          code: 'custom',
          message: `${refinement.field} is required when ${refinement.when.field}=${refinement.when.equals}`,
          path: [refinement.field],
        });
      }
      continue;
    }
    if (!externalSessionConditionMatches(value, refinement.when)) continue;
    for (const field of refinement.fields) {
      if (!value[field]) continue;
      ctx.addIssue({
        code: 'custom',
        message: `${field} is not allowed when ${refinement.when.field}=${refinement.when.equals}`,
        path: [field],
      });
    }
  }
}

function buildExternalSessionSourceSchema(
  declaration: ExternalSessionSourceDeclaration,
): ExternalSessionSourceSchemaOption {
  const shape = Object.fromEntries(
    declaration.schema.fields.map((field) => [field.name, buildExternalSessionFieldSchema(field)]),
  ) as ZodRawShape;
  let schema = z.object(shape);
  if (declaration.schema.passthrough !== false) {
    schema = schema.passthrough();
  }
  const refinements = declaration.schema.refinements ?? [];
  if (refinements.length === 0) {
    return schema as ExternalSessionSourceSchemaOption;
  }
  return schema.superRefine((value, ctx) => {
    applyExternalSessionRefinements(value, ctx, refinements);
  }) as ExternalSessionSourceSchemaOption;
}

function resolveExternalSessionKeySegment(
  segment: ExternalSessionKeySegmentDeclaration,
  source: Record<string, unknown>,
): string {
  if (segment.kind === 'literal') return segment.value;
  if (segment.kind === 'field') return normalizeNullableString(source[segment.field]);
  if (segment.kind === 'homeMode') {
    return source[segment.field] === 'connectedService' ? 'connectedService' : 'user';
  }
  if (segment.kind === 'conditionalField') {
    return externalSessionConditionMatches(source, segment.when)
      ? normalizeNullableString(source[segment.field])
      : '';
  }
  if (!externalSessionConditionMatches(source, segment.when)) return '';
  const group = normalizeNullableString(source[segment.groupField]);
  return group ? `group:${group}` : normalizeNullableString(source[segment.profileField]);
}

function resolveExternalSessionDeclarationSourceKey(
  declaration: ExternalSessionSourceDeclaration,
  source: Record<string, unknown>,
): string {
  return declaration.key.segments.map((segment) => resolveExternalSessionKeySegment(segment, source)).join(':');
}

const EXTERNAL_SESSIONS_PROVIDER_DEFINITIONS = EXTERNAL_SESSIONS_SOURCE_DECLARATIONS.map((declaration) => ({
  providerId: declaration.providerId,
  sourceKind: declaration.sourceKind,
  sourceSchema: buildExternalSessionSourceSchema(declaration),
  resolveSourceKey: (source: Record<string, unknown>) => resolveExternalSessionDeclarationSourceKey(declaration, source),
})) as readonly ExternalSessionsProviderDefinition[];

const EXTERNAL_SESSIONS_SOURCE_SCHEMAS = EXTERNAL_SESSIONS_PROVIDER_DEFINITIONS.map((definition) => definition.sourceSchema) as [
  ExternalSessionSourceSchemaOption,
  ...ExternalSessionSourceSchemaOption[],
];

const EXTERNAL_SESSIONS_PROVIDER_DEFINITION_BY_SOURCE_KIND = Object.freeze(
  Object.fromEntries(
    EXTERNAL_SESSIONS_PROVIDER_DEFINITIONS.map((definition) => [definition.sourceKind, definition] as const),
  ) as Record<ExternalSessionsProviderDefinition['sourceKind'], ExternalSessionsProviderDefinition>,
);

export const EXTERNAL_SESSIONS_PROVIDER_IDS_BY_SOURCE_KIND_V1 = Object.freeze(
  Object.fromEntries(
    EXTERNAL_SESSIONS_PROVIDER_DEFINITIONS.map((definition) => [definition.sourceKind, [definition.providerId]] as const),
  ) as Record<GeneratedExternalSessionsSourceKind, readonly [GeneratedExternalSessionsProviderId]>,
);

export const EXTERNAL_SESSIONS_PROVIDER_IDS = Object.freeze(
  Object.values(EXTERNAL_SESSIONS_PROVIDER_IDS_BY_SOURCE_KIND_V1).flat(),
) as [
  GeneratedExternalSessionsProviderId,
  ...GeneratedExternalSessionsProviderId[],
];

export const ExternalSessionsProviderIdSchema = z.enum(EXTERNAL_SESSIONS_PROVIDER_IDS);
export type ExternalSessionsProviderId = z.infer<typeof ExternalSessionsProviderIdSchema>;
export type ExternalSessionsSourceKindV1 = keyof typeof EXTERNAL_SESSIONS_PROVIDER_IDS_BY_SOURCE_KIND_V1;

export type ExternalSessionsSource = {
  [Declaration in GeneratedExternalSessionsSourceDeclaration as Declaration['sourceKind']]:
    Record<string, unknown> & { kind: Declaration['sourceKind'] }
}[GeneratedExternalSessionsSourceKind];

export const ExternalSessionsSourceSchema = z.discriminatedUnion('kind', EXTERNAL_SESSIONS_SOURCE_SCHEMAS) as ZodType<ExternalSessionsSource>;

export function resolveExternalSessionsSourceKey(source: ExternalSessionsSource): string {
  const definition = EXTERNAL_SESSIONS_PROVIDER_DEFINITION_BY_SOURCE_KIND[source.kind];
  return definition.resolveSourceKey(source);
}
