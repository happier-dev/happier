import type { SettingOwnerMutation } from '@/components/settings/catalog/settingDeclarations';
import type { Settings } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { readVoiceProviderSettingsConfig, writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { resolveVoiceExecutionMachinePresentationFromState } from '@/voice/credentials/useExecutionMachinePresentation';
import type { VoiceProviderRegistryEntry } from '@/voice/registry/providerRegistry';
import { Modal } from '@/modal';
import { t } from '@/text';

import { readBundledSpeechSettingsDescriptorFromEntry } from './descriptor';
import { promptSpeechEndpointChange } from './endpointConsent';

/** Confirm once, then apply the endpoint-only intent to each current Account snapshot. */
export async function prepareSpeechEndpointSettingChange(input: Readonly<{
  entry: VoiceProviderRegistryEntry;
  settings: Settings;
  value: string;
  isCurrent(): boolean;
  signal?: AbortSignal;
}>): Promise<SettingOwnerMutation | null> {
  const descriptor = readBundledSpeechSettingsDescriptorFromEntry(input.entry.providerId, input.entry);
  const consent = descriptor?.endpointConsent;
  if (!descriptor || !consent) return null;
  const current = () => !input.signal?.aborted && input.isCurrent();
  const readConfig = (settings: Settings) => {
    const envelope = settings.voice.providers[descriptor.providerId];
    if (envelope && envelope.schemaVersion !== descriptor.schemaVersion) return null;
    return descriptor.parseConfig(envelope
      ? readVoiceProviderSettingsConfig(settings.voice, descriptor.providerId)
      : descriptor.defaultConfig);
  };
  const machineFor = (settings: Settings) => resolveVoiceExecutionMachinePresentationFromState({
    ...storage.getState(), settings,
  });
  if (!current()) return null;
  const config = readConfig(input.settings);
  if (!config) return null;
  const machine = machineFor(input.settings);
  const text = (fieldId: string) => typeof config[fieldId] === 'string' ? config[fieldId] as string : '';
  const patch = await promptSpeechEndpointChange({
    currentBaseUrl: text(consent.baseUrlFieldId),
    currentConsent: text(consent.originConsentFieldId),
    currentConsentMachineId: text(consent.machineConsentFieldId),
    machineId: machine.machineId,
    machineLabel: machine.machineLabel,
    promptBaseUrl: async () => current() ? input.value : null,
    confirmInsecureOrigin: async ({ origin, machineLabel }) => current() && await Modal.confirm(
      t('settingsVoice.local.openAiCompatEndpoint.insecureTitle'),
      t('settingsVoice.local.openAiCompatEndpoint.insecureBody', { origin, machine: machineLabel }),
      { confirmText: t('settingsVoice.local.openAiCompatEndpoint.allowAction') },
    ),
    showInvalidEndpoint: async () => {
      if (current()) await Modal.alert(t('common.error'), t('settingsVoice.local.openAiCompatEndpoint.invalidBody'));
    },
  });
  if (!patch || !current()) return null;
  return (settings) => {
    if (!current()) return null;
    if (patch.insecureLocalOriginConsent && machineFor(settings).machineId !== patch.insecureLocalConsentMachineId) return null;
    const latest = readConfig(settings);
    const next = latest && descriptor.parseConfig({ ...latest,
      [consent.baseUrlFieldId]: patch.baseUrl,
      [consent.originConsentFieldId]: patch.insecureLocalOriginConsent,
      [consent.machineConsentFieldId]: patch.insecureLocalConsentMachineId,
    });
    return next ? { voice: writeVoiceProviderSettingsConfig(settings.voice, descriptor.providerId, next) } : null;
  };
}
