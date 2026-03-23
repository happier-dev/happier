import type { output as ZodOutput, ZodTypeAny } from 'zod';

import type { SettingDefinition, SettingDefinitionMap } from './settingDefinition.js';

const AllowedSettingValueKinds = new Set(['boolean', 'enum', 'bucket', 'count', 'presence']);
const AllowedSettingAnalyticsPrivacy = new Set(['safe', 'bucketed', 'count_only', 'presence_only', 'forbidden']);
const AllowedSettingAnalyticsIdentityScopes = new Set(['person', 'device_user']);

type SettingShape<TDefinitions extends SettingDefinitionMap> = {
  [TKey in keyof TDefinitions]: TDefinitions[TKey]['schema'];
};

type SettingDefaults<TDefinitions extends SettingDefinitionMap> = {
  [TKey in keyof TDefinitions]: ZodOutput<TDefinitions[TKey]['schema']>;
};

type TrackedSettingDefinitions<TDefinitions extends SettingDefinitionMap> = Partial<TDefinitions>;

export type SettingArtifacts<TDefinitions extends SettingDefinitionMap> = Readonly<{
  definitions: TDefinitions;
  shape: SettingShape<TDefinitions>;
  defaults: SettingDefaults<TDefinitions>;
  trackedCurrentStateDefinitions: TrackedSettingDefinitions<TDefinitions>;
  trackedChangeDefinitions: TrackedSettingDefinitions<TDefinitions>;
  trackedDerivedDefinitions: TrackedSettingDefinitions<TDefinitions>;
}>;

function parseSettingDefault<TDefinition extends SettingDefinition<ZodTypeAny>>(
  key: string,
  definition: TDefinition,
): ZodOutput<TDefinition['schema']> {
  if (!definition?.schema || typeof (definition.schema as any).safeParse !== 'function') {
    throw new Error(`Invalid schema for setting "${key}"`);
  }
  const parsedDefault = definition.schema.safeParse(definition.default);
  if (!parsedDefault.success) {
    throw new Error(`Invalid default for setting "${key}"`);
  }

  return parsedDefault.data as ZodOutput<TDefinition['schema']>;
}

function assertAnalyticsDefinitionIsSafe<TDefinition extends SettingDefinition<ZodTypeAny>>(
  key: string,
  definition: TDefinition,
): void {
  const analytics = definition.analytics;
  if (!analytics) return;

  // `defineSettingDefinitions(...)` intentionally accepts loose analytics metadata for inference.
  // Enforce required analytics fields at build time so privacy/value-kind are never silently missing.
  if (typeof analytics !== 'object' || analytics === null || Array.isArray(analytics)) {
    throw new Error(`Invalid analytics metadata for setting "${key}"`);
  }

  const analyticsRecord = analytics as Record<string, unknown>;

  const valueKind = analyticsRecord.valueKind;
  if (typeof valueKind !== 'string' || !AllowedSettingValueKinds.has(valueKind)) {
    throw new Error(`Invalid analytics valueKind for setting "${key}"`);
  }

  const privacy = analyticsRecord.privacy;
  if (typeof privacy !== 'string' || !AllowedSettingAnalyticsPrivacy.has(privacy)) {
    throw new Error(`Invalid analytics privacy for setting "${key}"`);
  }

  const identityScope = analyticsRecord.identityScope;
  if (typeof identityScope !== 'string' || !AllowedSettingAnalyticsIdentityScopes.has(identityScope)) {
    throw new Error(`Invalid analytics identityScope for setting "${key}"`);
  }

  const trackCurrentState = analyticsRecord.trackCurrentState === true;
  const trackChanges = analyticsRecord.trackChanges === true;
  const hasDerivedSerializer =
    typeof analyticsRecord.serializeDerivedProperties === 'function'
    || typeof analyticsRecord.serializeDerivedPropertiesWithContext === 'function';

  const isTracked = trackCurrentState || trackChanges || hasDerivedSerializer;

  if (isTracked && privacy === 'forbidden') {
    throw new Error(`Invalid analytics privacy for setting "${key}": forbidden settings cannot be tracked`);
  }

  // For non-safe privacy modes, a serializer is required so we never fall back to emitting raw values.
  if ((trackCurrentState || trackChanges) && privacy !== 'safe') {
    const hasCurrentSerializer =
      typeof analyticsRecord.serializeCurrent === 'function'
      || typeof analyticsRecord.serializeCurrentWithContext === 'function'
      || typeof analyticsRecord.serializeCurrentProperties === 'function'
      || typeof analyticsRecord.serializeCurrentPropertiesWithContext === 'function';
    if (!hasCurrentSerializer) {
      throw new Error(`Invalid analytics metadata for setting "${key}": non-safe privacy requires a serializer`);
    }
  }
}

export function buildSettingArtifacts<TDefinitions extends SettingDefinitionMap>(
  definitions: TDefinitions,
): SettingArtifacts<TDefinitions> {
  const shape = {} as SettingShape<TDefinitions>;
  const defaults = {} as SettingDefaults<TDefinitions>;
  const trackedCurrentStateDefinitions = {} as TrackedSettingDefinitions<TDefinitions>;
  const trackedChangeDefinitions = {} as TrackedSettingDefinitions<TDefinitions>;
  const trackedDerivedDefinitions = {} as TrackedSettingDefinitions<TDefinitions>;

  const assignDefinition = <TKey extends keyof TDefinitions>(key: TKey) => {
    const definition = definitions[key];

    assertAnalyticsDefinitionIsSafe(String(key), definition);
    shape[key] = definition.schema;
    defaults[key] = parseSettingDefault(String(key), definition);

    if (definition.analytics?.trackCurrentState) {
      trackedCurrentStateDefinitions[key] = definition;
    }
    if (definition.analytics?.trackChanges) {
      trackedChangeDefinitions[key] = definition;
    }
    if (definition.analytics?.serializeDerivedProperties || definition.analytics?.serializeDerivedPropertiesWithContext) {
      trackedDerivedDefinitions[key] = definition;
    }
  };

  for (const key of Object.keys(definitions) as Array<keyof TDefinitions>) {
    assignDefinition(key);
  }

  return {
    definitions,
    shape,
    defaults,
    trackedCurrentStateDefinitions,
    trackedChangeDefinitions,
    trackedDerivedDefinitions,
  };
}
