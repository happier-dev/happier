import { z, type ZodRawShape, type ZodType, type ZodTypeAny } from 'zod';

import {
  GENERATED_EXTERNAL_SESSIONS_SOURCE_DECLARATIONS,
} from '../../agents/generated/externalSession/sources.js';
import { assertBackendExternalSessionSourceReferences } from '../../plugins/backendExternalSessionSourceReferences.js';
import type { PluginBackendExternalSessionSourceDeclarationV1 } from '../../plugins/backendDefinitionV1.js';
import {
  PluginAgentExternalSessionLinkDataSchema,
  type PluginAgentExternalSessionLinkData,
} from '../../plugins/contributions/agentExternalSessions.js';

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
type ExternalSessionInstanceDeclaration =
  | Readonly<{ kind: 'default'; constants: Readonly<Record<string, string | number | boolean | null>> }>
  | Readonly<{
    kind: 'connectedServiceProfiles';
    serviceId: string;
    constants: Readonly<Record<string, string | number | boolean | null>>;
    fields: Readonly<{ serviceId: string; profileId: string }>;
  }>;
type ExternalSessionSourceDeclaration = Readonly<{
  sourceKind: string;
  schema: Readonly<{
    passthrough?: boolean;
    fields: readonly ExternalSessionSchemaFieldDeclaration[];
    refinements?: readonly ExternalSessionSchemaRefinementDeclaration[];
  }>;
  key: Readonly<{
    segments: readonly ExternalSessionKeySegmentDeclaration[];
  }>;
  instances?: readonly ExternalSessionInstanceDeclaration[];
}>;
type GeneratedExternalSessionSourceDeclaration =
  ExternalSessionSourceDeclaration & Readonly<{ agentId: string }>;

const EXTERNAL_SESSIONS_SOURCE_DECLARATIONS =
  GENERATED_EXTERNAL_SESSIONS_SOURCE_DECLARATIONS satisfies readonly GeneratedExternalSessionSourceDeclaration[];

type GeneratedExternalSessionsSourceDeclaration = typeof EXTERNAL_SESSIONS_SOURCE_DECLARATIONS[number];
type GeneratedExternalSessionsAgentId = GeneratedExternalSessionsSourceDeclaration['agentId'];
type GeneratedExternalSessionsSourceKind = GeneratedExternalSessionsSourceDeclaration['sourceKind'];
type ExternalSessionSourceSchemaOption = ZodTypeAny;
type ExternalSessionsAgentDefinition = Readonly<{
  agentId: GeneratedExternalSessionsAgentId;
  sourceKind: GeneratedExternalSessionsSourceKind;
  sourceSchema: ExternalSessionSourceSchemaOption;
  resolveSourceKey: (source: Record<string, unknown>) => string;
  resolveLegacySourceKey: (source: Record<string, unknown>) => string;
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
  return declaration.key.segments
    .map((segment) => resolveExternalSessionKeySegment(segment, source))
    .map((segment) => segment.replaceAll('%', '%25').replaceAll(':', '%3A'))
    .join(':');
}

function resolveLegacyExternalSessionDeclarationSourceKey(
  declaration: ExternalSessionSourceDeclaration,
  source: Record<string, unknown>,
): string {
  return declaration.key.segments.map((segment) => resolveExternalSessionKeySegment(segment, source)).join(':');
}

const EXTERNAL_SESSIONS_AGENT_DEFINITIONS = EXTERNAL_SESSIONS_SOURCE_DECLARATIONS.map((declaration) => {
  assertBackendExternalSessionSourceReferences(declaration);
  return {
    agentId: declaration.agentId,
    sourceKind: declaration.sourceKind,
    sourceSchema: buildExternalSessionSourceSchema(declaration),
    resolveSourceKey: (source: Record<string, unknown>) => resolveExternalSessionDeclarationSourceKey(declaration, source),
    resolveLegacySourceKey: (source: Record<string, unknown>) =>
      resolveLegacyExternalSessionDeclarationSourceKey(declaration, source),
  };
}) as readonly ExternalSessionsAgentDefinition[];

const EXTERNAL_SESSIONS_AGENT_DEFINITION_BY_SOURCE_KIND = Object.freeze(
  Object.fromEntries(
    EXTERNAL_SESSIONS_AGENT_DEFINITIONS.map((definition) => [definition.sourceKind, definition] as const),
  ) as Record<ExternalSessionsAgentDefinition['sourceKind'], ExternalSessionsAgentDefinition>,
);

export const EXTERNAL_SESSIONS_AGENT_IDS_BY_SOURCE_KIND_V1 = Object.freeze(
  Object.fromEntries(
    EXTERNAL_SESSIONS_AGENT_DEFINITIONS.map((definition) => [definition.sourceKind, [definition.agentId]] as const),
  ) as Record<GeneratedExternalSessionsSourceKind, readonly [GeneratedExternalSessionsAgentId]>,
);

export const EXTERNAL_SESSIONS_AGENT_IDS = Object.freeze(
  Object.values(EXTERNAL_SESSIONS_AGENT_IDS_BY_SOURCE_KIND_V1).flat(),
) as [
  GeneratedExternalSessionsAgentId,
  ...GeneratedExternalSessionsAgentId[],
];

export const ExternalSessionsAgentIdSchema = z.string().trim().min(1).max(128);
export type ExternalSessionsAgentId = z.infer<typeof ExternalSessionsAgentIdSchema>;
export type ExternalSessionsSourceKindV1 = keyof typeof EXTERNAL_SESSIONS_AGENT_IDS_BY_SOURCE_KIND_V1;

export type ExternalSessionsSource = PluginAgentExternalSessionLinkData & Readonly<{ kind: string }>;

export const ExternalSessionsSourceSchema = z.unknown().transform((value, ctx) => {
  const parsed = PluginAgentExternalSessionLinkDataSchema.safeParse(value);
  if (!parsed.success) {
    ctx.addIssue({ code: 'custom', message: 'External-session source must be a bounded JSON object.' });
    return z.NEVER;
  }
  const kind = z.string().trim().min(1).max(128).safeParse(parsed.data.kind);
  if (!kind.success) {
    ctx.addIssue({ code: 'custom', path: ['kind'], message: 'External-session source kind is invalid.' });
    return z.NEVER;
  }
  return parsed.data as ExternalSessionsSource;
}) as ZodType<ExternalSessionsSource>;

export function parseExternalSessionsSourceForDeclaration(
  declaration: Pick<PluginBackendExternalSessionSourceDeclarationV1, 'sourceKind' | 'schema' | 'key'>,
  source: unknown,
): ExternalSessionsSource | null {
  assertBackendExternalSessionSourceReferences(declaration);
  const envelope = ExternalSessionsSourceSchema.safeParse(source);
  if (!envelope.success) return null;
  const parsed = buildExternalSessionSourceSchema(declaration as ExternalSessionSourceDeclaration).safeParse(envelope.data);
  return parsed.success ? parsed.data as ExternalSessionsSource : null;
}

export function resolveExternalSessionsSourceKeyForDeclaration(
  declaration: Pick<PluginBackendExternalSessionSourceDeclarationV1, 'sourceKind' | 'schema' | 'key'>,
  source: unknown,
): string {
  const parsed = parseExternalSessionsSourceForDeclaration(declaration, source);
  if (!parsed) {
    throw new Error(`Invalid external-session source for declaration '${declaration.sourceKind}'`);
  }
  return resolveExternalSessionDeclarationSourceKey(declaration as ExternalSessionSourceDeclaration, parsed);
}

export function resolveExternalSessionsSourceKey(source: ExternalSessionsSource): string {
  const definition = EXTERNAL_SESSIONS_AGENT_DEFINITION_BY_SOURCE_KIND[
    source.kind as GeneratedExternalSessionsSourceKind
  ];
  if (!definition) {
    throw new Error(`No built-in external-session source definition for '${source.kind}'`);
  }
  return definition.resolveSourceKey(source);
}

/** Reproduces the pre-escaping source-key join exactly. */
export function resolveLegacyExternalSessionsSourceKey(source: ExternalSessionsSource): string {
  const definition = EXTERNAL_SESSIONS_AGENT_DEFINITION_BY_SOURCE_KIND[
    source.kind as GeneratedExternalSessionsSourceKind
  ];
  if (!definition) {
    throw new Error(`No built-in external-session source definition for '${source.kind}'`);
  }
  return definition.resolveLegacySourceKey(source);
}

const LEGACY_PERSISTED_TAG_SOURCE_KINDS = new Set<string>([
  'claudeConfig',
  'codexHome',
  'opencodeServer',
]);

/**
 * Returns source keys used to look up persisted `direct:v1` tags.
 *
 * The legacy direction is limited to the Claude, Codex, and OpenCode tag
 * writers observed in CLI stable `cli-v0.2.1`, preview
 * `cli-v0.2.2-preview.1775586717.26498`, and dirty `remote-dev` predecessor
 * `e67f3751f1ab5dc13e40a583a28f3962111154aa`. Those writers joined segments
 * without escaping. They did not emit an Oh My Pi source-key tag.
 *
 * Remove the legacy result only when no supported stable/preview or inspected
 * predecessor writer can emit it and persisted tags from those writers have
 * been migrated or proven absent.
 */
export function resolveExternalSessionsSourceKeysForPersistedTagLookup(
  source: ExternalSessionsSource,
): readonly [string, ...string[]] {
  const sourceKey = resolveExternalSessionsSourceKey(source);
  if (!LEGACY_PERSISTED_TAG_SOURCE_KINDS.has(source.kind)) return [sourceKey];
  const legacySourceKey = resolveLegacyExternalSessionsSourceKey(source);
  return sourceKey === legacySourceKey ? [sourceKey] : [sourceKey, legacySourceKey];
}
