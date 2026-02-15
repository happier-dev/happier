import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import type { SecretString } from '@/sync/encryption/secretSettings';
import { t } from '@/text';
import type { VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';

import type { LocalSttProviderSpec } from '../_types';

function normalizeSecretStringPromptInput(value: string | null): SecretString | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? { _isSecretValue: true, value: trimmed } : null;
}

const OpenAiCompatSttSettings: LocalSttProviderSpec['Settings'] = (props) => {
  const cfg = props.cfgStt as VoiceLocalSttSettings;
  const setOpenAiCompat = (patch: Partial<VoiceLocalSttSettings['openaiCompat']>) =>
    props.setStt({
      ...cfg,
      provider: 'openai_compat',
      openaiCompat: { ...cfg.openaiCompat, ...patch },
    });

  return (
    <>
      <Item
        title={t('settingsVoice.local.sttBaseUrl')}
        detail={cfg.openaiCompat.baseUrl ? String(cfg.openaiCompat.baseUrl) : t('settingsVoice.local.notSet')}
        onPress={() => {
          void (async () => {
            const raw = await Modal.prompt(t('settingsVoice.local.sttBaseUrlTitle'), t('settingsVoice.local.sttBaseUrlDescription'), {
              placeholder: cfg.openaiCompat.baseUrl ?? '',
            });
            if (raw === null) return;
            setOpenAiCompat({ baseUrl: String(raw).trim() || null });
          })();
        }}
      />
      <Item
        title={t('settingsVoice.local.sttModel')}
        subtitle={t('settingsVoice.local.sttModelSubtitle')}
        detail={cfg.openaiCompat.model}
        onPress={() => {
          void (async () => {
            const raw = await Modal.prompt(t('settingsVoice.local.sttModelTitle'), t('settingsVoice.local.sttModelDescription'), {
              placeholder: cfg.openaiCompat.model,
            });
            if (raw === null) return;
            const next = String(raw).trim();
            if (!next) return;
            setOpenAiCompat({ model: next });
          })();
        }}
      />
      <Item
        title={t('settingsVoice.local.sttApiKey')}
        detail={cfg.openaiCompat.apiKey ? t('settingsVoice.local.apiKeySet') : t('settingsVoice.local.apiKeyNotSet')}
        onPress={() => {
          void (async () => {
            const raw = await Modal.prompt(t('settingsVoice.local.sttApiKeyTitle'), t('settingsVoice.local.sttApiKeyDescription'), {
              inputType: 'secure-text',
            });
            if (raw === null) return;
            setOpenAiCompat({ apiKey: normalizeSecretStringPromptInput(raw) });
          })();
        }}
      />
    </>
  );
};

export const openaiCompatSttProviderSpec: LocalSttProviderSpec = {
  id: 'openai_compat',
  title: 'OpenAI-compatible endpoint',
  subtitle: 'Use your own Whisper-compatible transcription server.',
  iconName: 'cloud-outline',
  detail: 'Endpoint',
  Settings: OpenAiCompatSttSettings,
};
