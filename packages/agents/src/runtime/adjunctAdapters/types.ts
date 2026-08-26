export type RuntimePreferencesAdapter = Readonly<{
  sourcePreference?: Readonly<Record<string, unknown>>;
  defaultRuntimeKind?: Readonly<Record<string, unknown>>;
  modelDefaults?: Readonly<Record<string, unknown>>;
  reasoningDefaults?: Readonly<Record<string, unknown>>;
}>;

export type ProviderConnectedServicesAdapter = Readonly<{
  cloudConnect?: Readonly<Record<string, unknown>>;
  connectedServices?: Readonly<Record<string, unknown>>;
}>;

export type ProviderMessageMetaEnricher = Readonly<{
  buildOutgoingMessageMetaExtras?: (params: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
}>;
