import type { input as ZodInput, output as ZodOutput, ZodTypeAny } from 'zod';

export type SettingStorageScope = 'account' | 'local';
export type SettingValueKind = 'boolean' | 'enum' | 'bucket' | 'count' | 'presence';
export type SettingAnalyticsPrivacy = 'safe' | 'bucketed' | 'count_only' | 'presence_only' | 'forbidden';
export type SettingAnalyticsIdentityScope = 'person' | 'device_user';
export type SettingAnalyticsScalar = boolean | string | number | null;
export type SettingAnalyticsStructuredScalars = Readonly<Record<string, SettingAnalyticsScalar>>;

export type SettingAnalyticsMetadata<TValue = unknown> = Readonly<{
  trackCurrentState?: boolean;
  trackChanges?: boolean;
  valueKind: SettingValueKind;
  privacy: SettingAnalyticsPrivacy;
  identityScope: SettingAnalyticsIdentityScope;
  currentPropertyValueKinds?: Readonly<Record<string, SettingValueKind>>;
  derivedPropertyValueKinds?: Readonly<Record<string, SettingValueKind>>;
  serializeCurrent?(value: TValue): SettingAnalyticsScalar;
  serializeCurrentWithContext?(value: TValue, record: Readonly<Record<string, unknown>>): SettingAnalyticsScalar;
  serializeCurrentProperties?(value: TValue): SettingAnalyticsStructuredScalars;
  serializeCurrentPropertiesWithContext?(
    value: TValue,
    record: Readonly<Record<string, unknown>>,
  ): SettingAnalyticsStructuredScalars;
  serializeDerivedProperties?(value: TValue): SettingAnalyticsStructuredScalars;
  serializeDerivedPropertiesWithContext?(
    value: TValue,
    record: Readonly<Record<string, unknown>>,
  ): SettingAnalyticsStructuredScalars;
}>;

export type SettingDefinition<TSchema extends ZodTypeAny = ZodTypeAny> = Readonly<{
  schema: TSchema;
  default: ZodInput<TSchema>;
  description: string;
  storageScope: SettingStorageScope;
  analytics?: SettingAnalyticsMetadata<ZodOutput<TSchema>>;
}>;

export type SettingDefinitionMap = Readonly<Record<string, SettingDefinition<ZodTypeAny>>>;

type SettingDefinitionInput<TSchema extends ZodTypeAny = ZodTypeAny> = Readonly<{
  schema: TSchema;
  default: ZodInput<TSchema>;
  description: string;
  storageScope: SettingStorageScope | string;
  analytics?: Readonly<Record<string, unknown>>;
}>;

type NormalizedSettingDefinition<TValue extends SettingDefinitionInput<ZodTypeAny>> =
  SettingDefinition<Extract<TValue['schema'], ZodTypeAny>>;

export function defineSettingDefinitions<
  const TDefinitions extends Readonly<Record<string, SettingDefinitionInput<ZodTypeAny>>>
>(
  definitions: TDefinitions,
): { readonly [TKey in keyof TDefinitions]: NormalizedSettingDefinition<TDefinitions[TKey]> } {
  return definitions as unknown as { readonly [TKey in keyof TDefinitions]: NormalizedSettingDefinition<TDefinitions[TKey]> };
}
