import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { normalizeSecretStringPromptInput } from '@/utils/secrets/normalizeSecretStringPromptInput';

import type { LocalSttProviderSpec } from '../_types';

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
          fireAndForget((async () => {
            const raw = await Modal.prompt(t('settingsVoice.local.sttBaseUrlTitle'), t('settingsVoice.local.sttBaseUrlDescription'), {
              placeholder: cfg.openaiCompat.baseUrl ?? '',
            });
            if (raw === null) return;
            setOpenAiCompat({ baseUrl: String(raw).trim() || null });
          })(), { tag: 'openaiCompatSttProvider.promptBaseUrl' });
        }}
      />
      <Item
        title={t('settingsVoice.local.sttModel')}
        subtitle={t('settingsVoice.local.sttModelSubtitle')}
        detail={cfg.openaiCompat.model}
        onPress={() => {
          fireAndForget((async () => {
            const raw = await Modal.prompt(t('settingsVoice.local.sttModelTitle'), t('settingsVoice.local.sttModelDescription'), {
              placeholder: cfg.openaiCompat.model,
            });
            if (raw === null) return;
            const next = String(raw).trim();
            if (!next) return;
            setOpenAiCompat({ model: next });
          })(), { tag: 'openaiCompatSttProvider.promptModel' });
        }}
      />
      <Item
        title={t('settingsVoice.local.sttApiKey')}
        detail={cfg.openaiCompat.apiKey ? t('settingsVoice.local.apiKeySet') : t('settingsVoice.local.apiKeyNotSet')}
        onPress={() => {
          fireAndForget((async () => {
            const raw = await Modal.prompt(t('settingsVoice.local.sttApiKeyTitle'), t('settingsVoice.local.sttApiKeyDescription'), {
              inputType: 'secure-text',
            });
            if (raw === null) return;
            setOpenAiCompat({ apiKey: normalizeSecretStringPromptInput(raw) });
          })(), { tag: 'openaiCompatSttProvider.promptApiKey' });
        }}
      />
    </>
  );
};

export const openaiCompatSttProviderSpec: LocalSttProviderSpec = {
  id: 'openai_compat',
  title: t('settingsVoice.local.openaiCompatStt.provider.title'),
  subtitle: t('settingsVoice.local.openaiCompatStt.provider.subtitle'),
  iconName: 'cloud-outline',
  detail: t('settingsVoice.local.openaiCompatStt.provider.detail'),
  Settings: OpenAiCompatSttSettings,
};
