import { z } from 'zod';

import {
  buildAcpConfigOptionOverridesV1,
  type AcpConfigOptionOverridesV1,
} from '../sessions/metadata/metadataOverridesV1.js';

export const SpawnConfigOptionValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type SpawnConfigOptionValue = z.infer<typeof SpawnConfigOptionValueSchema>;

export type SpawnConfigOptionsAliasConflict = Readonly<{
  id: string;
  canonicalValue: SpawnConfigOptionValue;
  aliasValue: SpawnConfigOptionValue;
}>;

export function buildAcpConfigOptionOverridesV1FromConfigOptions(params: Readonly<{
  configOptions: Readonly<Record<string, SpawnConfigOptionValue>>;
  updatedAt?: number;
}>): AcpConfigOptionOverridesV1 | undefined {
  const entries = Object.entries(params.configOptions);
  if (entries.length === 0) return undefined;
  const updatedAt = Number.isFinite(params.updatedAt) ? params.updatedAt as number : Date.now();
  return buildAcpConfigOptionOverridesV1({
    updatedAt,
    overrides: Object.fromEntries(entries.map(([id, value]) => [id, { updatedAt, value }])),
  });
}

export function findSpawnConfigOptionAliasConflicts(params: Readonly<{
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  configOptions?: Readonly<Record<string, SpawnConfigOptionValue>>;
}>): readonly SpawnConfigOptionsAliasConflict[] {
  const canonicalOverrides = params.sessionConfigOptionOverrides?.overrides;
  const configOptions = params.configOptions;
  if (!canonicalOverrides || !configOptions) return [];
  return Object.entries(configOptions).flatMap(([id, aliasValue]) => {
    const canonicalValue = canonicalOverrides[id]?.value;
    if (canonicalValue === undefined || Object.is(canonicalValue, aliasValue)) return [];
    return [{ id, canonicalValue, aliasValue }];
  });
}

export function mergeSpawnConfigOptionAliases(params: Readonly<{
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  configOptions?: Readonly<Record<string, SpawnConfigOptionValue>>;
  updatedAt?: number;
}>): AcpConfigOptionOverridesV1 | undefined {
  const canonical = params.sessionConfigOptionOverrides;
  const shorthand = buildAcpConfigOptionOverridesV1FromConfigOptions({
    configOptions: params.configOptions ?? {},
    updatedAt: params.updatedAt,
  });
  if (!canonical) return shorthand;
  if (!shorthand) return canonical;
  const updatedAt = Number.isFinite(params.updatedAt) ? params.updatedAt as number : Date.now();
  return buildAcpConfigOptionOverridesV1({
    updatedAt,
    overrides: {
      ...shorthand.overrides,
      ...canonical.overrides,
    },
  });
}
