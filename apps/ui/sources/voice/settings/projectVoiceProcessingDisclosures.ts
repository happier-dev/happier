import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { createVoiceDictationRuntimeSettingsSnapshot } from '@/voice/dictation/voiceDictationRuntimeSettings';
import {
  isLocalVoiceProviderSelected,
  parseLocalVoiceSttSettings,
  parseLocalVoiceTtsSettings,
  resolveLocalVoiceAdapterSettings,
} from '@/voice/local/localVoiceSettings';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { readBundledSpeechSettingsDescriptorFromEntry } from '@/voice/settings/panels/bundledSpeech/descriptor';
import { resolveVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';
import { resolveSelectedVoiceProviderTitleKey } from '@/voice/registry/providerSelection';
import type { VoiceProviderSettings } from '@happier-dev/protocol';

type LocalizedDisclosure = string | Readonly<{ key: string; fallback: string }>;

export type VoiceProcessingDisclosureProjection = Readonly<{
  id: string;
  providerIds: readonly string[];
  roles: readonly ('conversation' | 'stt' | 'tts')[];
  titleKey: string;
  disclosure: LocalizedDisclosure | null;
  facts: VoiceProviderSettings['privacyFacts'] | null;
}>;

const defaultRegistry = createDefaultVoiceProviderRegistry();

function disclosureIdentity(disclosure: LocalizedDisclosure | null): string {
  if (disclosure === null) return 'facts-only';
  return typeof disclosure === 'string'
    ? `text:${disclosure}`
    : `key:${disclosure.key}`;
}

/**
 * Projects only the providers selected by the canonical conversation, Dictation,
 * and Local Voice settings owners. Registry declarations remain the disclosure
 * authority; this projection adds no provider catalog or vendor-specific policy.
 */
export function projectVoiceProcessingDisclosures(
  input: VoiceSettings,
  registry: VoiceProviderRegistry = defaultRegistry,
): readonly VoiceProcessingDisclosureProjection[] {
  const voice = voiceSettingsParse(input);
  const byDisclosure = new Map<string, VoiceProcessingDisclosureProjection>();

  const add = (
    providerId: string,
    role: 'conversation' | 'stt' | 'tts',
    disclosure: LocalizedDisclosure | null,
    titleKey: string,
    facts: VoiceProviderSettings['privacyFacts'] | null = null,
  ): void => {
    const identity = `${disclosureIdentity(disclosure)}:${JSON.stringify(facts)}`;
    const existing = byDisclosure.get(identity);
    if (existing) {
      if (!existing.providerIds.includes(providerId) || !existing.roles.includes(role)) {
        byDisclosure.set(identity, Object.freeze({
          ...existing,
          providerIds: Object.freeze(existing.providerIds.includes(providerId)
            ? existing.providerIds
            : [...existing.providerIds, providerId]),
          roles: Object.freeze(existing.roles.includes(role) ? existing.roles : [...existing.roles, role]),
        }));
      }
      return;
    }
    byDisclosure.set(identity, Object.freeze({
      id: identity,
      providerIds: Object.freeze([providerId]),
      roles: Object.freeze([role]),
      titleKey,
      disclosure,
      facts,
    }));
  };

  const conversationProviderId = resolveVoiceProviderId(voice.providerId, registry);
  if (conversationProviderId) {
    const entry = registry.get(conversationProviderId);
    const disclosure = entry?.providerSettings?.privacyDisclosure;
    if (entry && (disclosure || entry.providerSettings?.privacyFacts)) {
      add(
        conversationProviderId,
        'conversation',
        disclosure ?? null,
        resolveSelectedVoiceProviderTitleKey(voice, registry) ?? conversationProviderId,
        entry.providerSettings?.privacyFacts ?? null,
      );
    }
  }

  const addSpeechProvider = (providerId: string, role: 'stt' | 'tts'): void => {
    const entry = registry.get(providerId);
    const hostDisclosure = entry?.processingDisclosures?.[role];
    if (entry && hostDisclosure) {
      add(providerId, role, {
        key: hostDisclosure.disclosureKey,
        fallback: hostDisclosure.disclosureKey,
      }, hostDisclosure.titleKey, hostDisclosure.facts ?? null);
      return;
    }
    const descriptor = readBundledSpeechSettingsDescriptorFromEntry(providerId, entry);
    if (!entry || !descriptor || entry.kind !== 'voice.speech-engine.v1') return;
    const facts = entry.declaration?.settings?.privacyFacts ?? null;
    if (!descriptor.privacyDisclosure && !facts) return;
    add(providerId, role, descriptor.privacyDisclosure ?? null, descriptor.titleKey, facts);
  };

  const dictationRuntime = createVoiceDictationRuntimeSettingsSnapshot({ voice });
  const dictationStt = parseLocalVoiceSttSettings(
    resolveLocalVoiceAdapterSettings(dictationRuntime).config.stt,
  );
  addSpeechProvider(dictationStt.provider, 'stt');

  if (isLocalVoiceProviderSelected({ voice })) {
    const local = resolveLocalVoiceAdapterSettings({ voice }).config;
    addSpeechProvider(parseLocalVoiceSttSettings(local.stt).provider, 'stt');
    addSpeechProvider(parseLocalVoiceTtsSettings(local.tts).provider, 'tts');
  }

  return Object.freeze([...byDisclosure.values()]);
}
