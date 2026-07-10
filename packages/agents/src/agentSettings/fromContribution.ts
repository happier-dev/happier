import { z, type ZodTypeAny } from 'zod';

import {
  PluginAgentSettingsContributionV1Schema,
  type PluginAgentSettingsContributionV1,
  type PluginAgentSettingsFieldSchemaV1,
  type SettingAnalyticsMetadata,
  type SettingDefinitionMap,
} from '@happier-dev/protocol';

import type { AgentSettingsDefinition } from './types.js';

function asNonEmptyStringTuple(values: readonly string[]): [string, ...string[]] {
  if (values.length === 0) {
    throw new Error('Agent settings enum schemas require at least one value');
  }
  return [...values] as [string, ...string[]];
}

function isValidJsonObjectString(raw: string, maxLength: number | undefined): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (maxLength !== undefined && trimmed.length > maxLength) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

function schemaFromContributionField(schema: PluginAgentSettingsFieldSchemaV1): ZodTypeAny {
  if (schema.kind === 'boolean') return z.boolean();
  if (schema.kind === 'string') {
    return schema.maxLength === undefined ? z.string() : z.string().max(schema.maxLength);
  }
  if (schema.kind === 'stringRecord') {
    return z.record(z.string(), z.string());
  }
  if (schema.kind === 'jsonObjectString') {
    return z.string().refine((value) => isValidJsonObjectString(value, schema.maxLength), {
      message: 'Must be empty or a valid JSON object string',
    });
  }
  if (schema.kind === 'enum') {
    return z.enum(asNonEmptyStringTuple(schema.values));
  }
  if (schema.kind === 'enumArray') {
    const arraySchema = z.array(z.enum(asNonEmptyStringTuple(schema.values)));
    return schema.max === undefined ? arraySchema : arraySchema.max(schema.max);
  }
  if (schema.kind === 'positiveInteger') {
    const numberSchema = z.number().int().positive();
    const bounded = schema.max === undefined ? numberSchema : numberSchema.max(schema.max);
    return schema.nullable ? bounded.nullable() : bounded;
  }
  throw new Error(`Unsupported agent settings schema kind: ${(schema as Readonly<{ kind?: unknown }>).kind}`);
}

function analyticsFromContributionField(
  field: PluginAgentSettingsContributionV1['fields'][number],
): SettingAnalyticsMetadata | undefined {
  if (!field.analytics) return undefined;

  const analytics = field.analytics;
  const base = {
    trackCurrentState: analytics.trackCurrentState,
    trackChanges: analytics.trackChanges,
    valueKind: analytics.valueKind,
    privacy: analytics.privacy,
    identityScope: analytics.identityScope,
  } satisfies SettingAnalyticsMetadata;

  if (analytics.serializeCurrentRule === 'orderedEnumArrayJoin' && field.schema.kind === 'enumArray') {
    const values = field.schema.values;
    return {
      ...base,
      serializeCurrent: (value: unknown) => {
        if (!Array.isArray(value)) return 'none';
        const input = new Set(value.filter((entry): entry is string => typeof entry === 'string' && values.includes(entry)));
        const ordered = values.filter((entry) => input.has(entry));
        return ordered.length === 0 ? 'none' : ordered.join('+');
      },
    };
  }

  if (analytics.serializeCurrentRule === 'jsonObjectStringPresence' && field.schema.kind === 'jsonObjectString') {
    const maxLength = field.schema.maxLength;
    return {
      ...base,
      serializeCurrent: (value: unknown) =>
        typeof value === 'string' && isValidJsonObjectString(value, maxLength) && value.trim().length > 0,
    };
  }

  return base;
}

export function buildAgentSettingsDefinitionFromContribution(
  input: PluginAgentSettingsContributionV1,
): AgentSettingsDefinition {
  const contribution = PluginAgentSettingsContributionV1Schema.parse(input);
  const fields: SettingDefinitionMap = Object.fromEntries(contribution.fields.map((field) => [
    field.id,
    {
      schema: schemaFromContributionField(field.schema),
      default: field.default,
      description: field.description,
      storageScope: field.storageScope,
      ...(field.analytics ? { analytics: analyticsFromContributionField(field) } : {}),
    },
  ]));

  return Object.freeze({
    agentId: contribution.agentId,
    fields,
  });
}
