import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import type { VoiceProviderSettingsJsonValueV1 } from '@happier-dev/protocol';

import {
  isVoiceProviderSettingsProjectionCurrent,
  projectVoiceProviderSettings,
  type VoiceProviderRegistry,
  type VoiceProviderRegistryEntry,
  type VoiceProviderSettingsProjection,
} from './providerRegistry';

export type VoiceProviderSelectionRow = Readonly<{
  providerId: string;
  optionId: string;
  modeId: string | null;
  order: number;
  titleKey: string;
  subtitleKey: string;
  selected: boolean;
  envelope: Readonly<{ schemaVersion: number; config: unknown }>;
  entry: VoiceProviderRegistryEntry;
}>;

export type SelectedUnavailableVoiceProvider = Readonly<{
  providerId: string;
  titleKey: string;
  subtitleKey: string | null;
  modeId: string | null;
  entry: VoiceProviderRegistryEntry | null;
  settingsProjection: VoiceProviderSettingsProjection | null;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isVoiceProviderSettingsJsonObject(
  value: VoiceProviderSettingsJsonValueV1 | null | undefined,
): value is Readonly<{ [key: string]: VoiceProviderSettingsJsonValueV1 }> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function projectVoiceProviderSelectionRows(
  settings: Pick<VoiceSettings, 'providerId' | 'providers'>,
  registry: VoiceProviderRegistry,
): readonly VoiceProviderSelectionRow[] {
  const rows = registry.list().flatMap((entry) => {
    if (entry.kind !== 'voice.conversation-provider.v1' || !entry.selectionOptions?.length) return [];
    const currentEnvelope = settings.providers[entry.providerId] ?? null;
    const projection = projectVoiceProviderSettings(entry, currentEnvelope);
    return entry.selectionOptions.map((option): VoiceProviderSelectionRow => {
      const currentConfig = currentEnvelope && isRecord(currentEnvelope.config)
        ? currentEnvelope.config
        : entry.providerSettings?.defaultConfig ?? {};
      const envelope = Object.freeze({
        schemaVersion:
          currentEnvelope?.schemaVersion
          ?? entry.providerSettings?.schemaVersion
          ?? 1,
        config: Object.freeze({
          ...currentConfig,
          ...(option.configPatch ?? {}),
        }),
      });
      return Object.freeze({
        providerId: entry.providerId,
        optionId: option.id,
        modeId: option.modeId,
        order: option.order,
        titleKey: option.titleKey,
        subtitleKey: option.subtitleKey,
        selected: settings.providerId === entry.providerId
          && isVoiceProviderSettingsProjectionCurrent(projection)
          && projection.modeId === option.modeId,
        envelope,
        entry,
      });
    });
  });
  return Object.freeze(rows.sort((left, right) =>
    left.order - right.order
    || left.providerId.localeCompare(right.providerId)
    || left.optionId.localeCompare(right.optionId)));
}

/**
 * Projects only persisted selections that cannot be represented by a normal
 * selectable row. The saved provider envelope remains opaque and untouched.
 */
export function projectSelectedUnavailableVoiceProvider(
  settings: Pick<VoiceSettings, 'providerId' | 'providers'>,
  registry: VoiceProviderRegistry,
): SelectedUnavailableVoiceProvider | null {
  const providerId = settings.providerId;
  if (!providerId) return null;
  const envelope = settings.providers[providerId] ?? null;
  const entry = registry.get(providerId);
  if (!entry) {
    return Object.freeze({
      providerId,
      titleKey: providerId,
      subtitleKey: null,
      modeId: null,
      entry: null,
      settingsProjection: null,
    });
  }
  if (entry.kind !== 'voice.conversation-provider.v1') return null;
  const settingsProjection = projectVoiceProviderSettings(entry, envelope);
  if (settingsProjection?.status !== 'unsupported_version') return null;
  const displayOption = entry.selectionOptions?.find(
    (option) => option.modeId === settingsProjection.modeId,
  ) ?? (entry.selectionOptions?.length === 1 ? entry.selectionOptions[0] : null);
  return Object.freeze({
    providerId,
    titleKey: displayOption?.titleKey ?? providerId,
    subtitleKey: displayOption?.subtitleKey ?? null,
    modeId: settingsProjection.modeId,
    entry,
    settingsProjection,
  });
}

/** Returns the selected ready provider's descriptor-owned display key. */
export function resolveSelectedVoiceProviderTitleKey(
  settings: Pick<VoiceSettings, 'providerId' | 'providers'>,
  registry: VoiceProviderRegistry,
): string | null {
  if (!settings.providerId) return null;
  return projectVoiceProviderSelectionRows(settings, registry)
    .find((row) => row.selected)?.titleKey ?? null;
}

export function selectVoiceProviderOption(
  settings: VoiceSettings,
  registry: VoiceProviderRegistry,
  providerId: string,
  optionId: string,
): VoiceSettings | null {
  const entry = registry.get(providerId);
  if (!entry || entry.kind !== 'voice.conversation-provider.v1' || !entry.projectSettings) return null;
  const option = entry.selectionOptions?.find((candidate) => candidate.id === optionId);
  if (!option) return null;
  const previousEnvelope = settings.providers[providerId] ?? null;
  let schemaVersion = previousEnvelope?.schemaVersion ?? entry.providerSettings?.schemaVersion ?? 1;
  let previousConfig: Readonly<{ [key: string]: VoiceProviderSettingsJsonValueV1 }>;
  if (entry.providerSettings) {
    if (previousEnvelope && previousEnvelope.schemaVersion !== entry.providerSettings.schemaVersion) {
      return null;
    }
    let parsedPreviousConfig: VoiceProviderSettingsJsonValueV1 | null = null;
    try {
      parsedPreviousConfig = previousEnvelope
        ? entry.providerSettings.parseConfig(previousEnvelope.config)
        : null;
    } catch {
      parsedPreviousConfig = null;
    }
    schemaVersion = entry.providerSettings.schemaVersion;
    previousConfig = isVoiceProviderSettingsJsonObject(parsedPreviousConfig)
      ? parsedPreviousConfig
      : entry.providerSettings.defaultConfig;
  } else {
    previousConfig = previousEnvelope && isVoiceProviderSettingsJsonObject(previousEnvelope.config)
      ? previousEnvelope.config
      : {};
  }
  const nextEnvelope = {
    schemaVersion,
    config: {
      ...previousConfig,
      ...(option.configPatch ?? {}),
    },
  };
  const projection = projectVoiceProviderSettings(entry, nextEnvelope);
  if (!isVoiceProviderSettingsProjectionCurrent(projection)
    || projection.modeId !== option.modeId) return null;
  return {
    ...settings,
    providerId,
    providers: {
      ...settings.providers,
      [providerId]: nextEnvelope,
    },
  };
}
