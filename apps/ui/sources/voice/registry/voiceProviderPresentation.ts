import type { VoiceProviderSettingsJsonValueV1 } from '@happier-dev/protocol';

export type VoiceProviderSelectionPresentation = Readonly<{
  id: string;
  modeId: string;
  order: number;
  titleKey: string;
  subtitleKey: string;
  configPatch?: Readonly<Record<string, unknown>>;
}>;

export type VoiceProviderLegacySettingsMigration = Readonly<{
  defaultLegacyConfig: VoiceProviderSettingsJsonValueV1;
  legacyDefaultSelection?: boolean;
  readLegacySecret?(value: unknown): unknown | null;
  preserveLegacyEnvelope?(value: unknown): Readonly<{
    schemaVersion: number;
    config: unknown;
  }> | null;
  migrateLegacy?(value: unknown): Readonly<{
    config: VoiceProviderSettingsJsonValueV1;
    root?: unknown;
  }> | null;
  projectLegacy?(
    value: unknown,
    context: Readonly<{
      root: unknown;
      resolveCredential(providerId: string, credentialSlotId: string): unknown | null;
    }>,
  ): VoiceProviderSettingsJsonValueV1 | null;
  mergeLegacy?(
    currentValue: unknown,
    migratedValue: unknown,
  ): VoiceProviderSettingsJsonValueV1 | null;
}>;

export type VoiceSpeechSettingsPresentation = Readonly<{
  titleKey: string;
  subtitleKey: string;
  detailKey: string;
  iconName: string;
  credential?: Readonly<{
    titleKey: string;
    promptTitleKey: string;
    promptBodyKey: string;
  }>;
  fields: readonly Readonly<{
    fieldId: string;
    titleKey: string;
    subtitleKey: string;
    searchPlaceholderKey?: string;
    autoTitleKey?: string;
    autoSubtitleKey?: string;
    promptTitleKey?: string;
    promptBodyKey?: string;
  }>[];
  test: Readonly<{ missingValueMessageKey: string }> | null;
}>;

/**
 * Trusted first-party presentation keyed by canonical qualified Voice identity.
 * Manifest projection remains the only source for contribution semantics.
 */
export type VoiceProviderPresentation = Readonly<{
  providerId: string;
  settingsSectionId: string;
  selectionOptions?: readonly VoiceProviderSelectionPresentation[];
  legacySettingsMigration?: VoiceProviderLegacySettingsMigration;
  createSettingsSection?(): unknown;
  createSettingsSpec?(): VoiceSpeechSettingsPresentation | null;
}>;
