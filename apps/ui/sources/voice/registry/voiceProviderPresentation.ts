import type { VoiceProviderRegistryEntry } from './providerRegistry';

/** Billing choices name accounts, not services. Share the service name across setup and live copy. */
export function resolveVoiceServiceTitle(
  entry: VoiceProviderRegistryEntry,
  translate: (key: string) => string,
  localize: (pluginId: string, value: unknown) => string,
): string {
  if ((entry.selectionOptions?.length ?? 0) > 1 && entry.kind === 'voice.conversation-provider.v1' && entry.declaration?.title) {
    return localize(entry.pluginId, entry.declaration.title);
  }
  const titleKey = entry.selectionOptions?.[0]?.titleKey;
  return titleKey ? translate(titleKey) : entry.kind === 'voice.conversation-provider.v1' && entry.declaration?.title
    ? localize(entry.pluginId, entry.declaration.title) : translate('voicePresence.title');
}

export type VoiceProviderSelectionPresentation = Readonly<{
  id: string;
  modeId: string;
  order: number;
  titleKey: string;
  subtitleKey: string;
  badgeKey?: string;
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
  resources?: Readonly<{ titleKey: string; accountTitleKey: string; apiKeysTitleKey: string }>;
  agentAction?: Readonly<{
    settingId: string;
    createActionId: string;
    updateActionId: string;
    titleKey: string;
    missingStateKey: string;
    configuredStateKey: string;
  }>;
  selectionOptions?: readonly VoiceProviderSelectionPresentation[];
  createSettingsSpec?(): VoiceSpeechSettingsPresentation | null;
}>;
