export type LegacyVoiceSettingsMigrationSource = Readonly<{
  adapters: Record<string, unknown> | null;
  hasCompleteBuiltInAdapterBlock: boolean;
}>;

export const LEGACY_BUILT_IN_VOICE_ADAPTER_IDS = Object.freeze([
  'realtime_elevenlabs',
  'local_direct',
  'local_conversation',
] as const);

/**
 * The sole boundary reader for the retired `voice.adapters` persistence shape.
 * It deliberately performs only structural inspection; the canonical settings
 * owner validates each provider config with its owning schema before migration.
 */
export function readLegacyVoiceSettingsMigrationSource(raw: Record<string, unknown>): LegacyVoiceSettingsMigrationSource {
  const hasPersistedAdapters = Object.prototype.propertyIsEnumerable.call(raw, 'adapters');
  const adapters = hasPersistedAdapters && raw.adapters && typeof raw.adapters === 'object' && !Array.isArray(raw.adapters)
    ? raw.adapters as Record<string, unknown>
    : null;
  return {
    adapters,
    hasCompleteBuiltInAdapterBlock: Boolean(
      adapters
      && LEGACY_BUILT_IN_VOICE_ADAPTER_IDS.every(
        (providerId) => Object.prototype.hasOwnProperty.call(adapters, providerId),
      ),
    ),
  };
}
