export type VoiceProviderSelectionPresentation = Readonly<{
  id: string;
  modeId: string;
  order: number;
  titleKey: string;
  subtitleKey: string;
  configPatch?: Readonly<Record<string, unknown>>;
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
  createSettingsSpec?(): VoiceSpeechSettingsPresentation | null;
}>;
