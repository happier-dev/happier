import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useSettingsSelector } from '@/sync/domains/state/storage';
import { t, tLoose } from '@/text';
import { isVoiceConversationCustodySessionMetadata } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { useVoiceProviderRegistryRevision } from '@/voice/registry/useVoiceProviderRegistryRevision';
import { resolveVoiceServiceTitle } from '@/voice/registry/voiceProviderPresentation';
import { resolveVoiceProviderIdForSurface } from '@/voice/settings/resolveVoiceProviderId';

const voiceProviderRegistry = createDefaultVoiceProviderRegistry();

/**
 * Where a Voice conversation lives, for its session header: "Global Voice · OpenAI Realtime". The
 * service is the one Voice conversations use now (the setting), named by the registry's service-title
 * owner. A Voice conversation's folder is private plumbing and never its subtitle.
 */
export function useVoiceConversationHeaderSubtitle(metadata: unknown): string | undefined {
  const isVoiceCarrier = isVoiceConversationCustodySessionMetadata(metadata);
  useVoiceProviderRegistryRevision(voiceProviderRegistry, isVoiceCarrier);
  const localize = useProjectedPluginLocalizedTextResolver();
  return useSettingsSelector(settings => {
    if (!isVoiceCarrier) return undefined;
    const providerId = resolveVoiceProviderIdForSurface(
      settings.voice,
      voiceProviderRegistry,
    );
    const entry = providerId ? voiceProviderRegistry.get(providerId) : null;
    const where = t('voiceMoments.globalVoice');
    return entry
      ? `${where} · ${resolveVoiceServiceTitle(entry, tLoose, localize)}`
      : where;
  }, isVoiceCarrier ? ['voice'] : []);
}
