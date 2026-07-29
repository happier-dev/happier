import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import type { VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Item } from '@/components/ui/lists/Item';
import { OpenAiCompatCredentialItem } from '@/voice/local/openaiCompat/CredentialItem';
import { OpenAiCompatEndpointItem } from '@/voice/local/openaiCompat/EndpointItem';

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
      <OpenAiCompatEndpointItem
        title={t('settingsVoice.local.sttBaseUrl')}
        promptTitle={t('settingsVoice.local.sttBaseUrlTitle')}
        promptDescription={t('settingsVoice.local.sttBaseUrlDescription')}
        baseUrl={cfg.openaiCompat.baseUrl}
        insecureLocalOriginConsent={cfg.openaiCompat.insecureLocalOriginConsent}
        insecureLocalConsentMachineId={cfg.openaiCompat.insecureLocalConsentMachineId}
        onChange={setOpenAiCompat}
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
      <OpenAiCompatCredentialItem
        title={t('settingsVoice.local.sttApiKey')}
        promptTitle={t('settingsVoice.local.sttApiKeyTitle')}
        promptDescription={t('settingsVoice.local.sttApiKeyDescription')}
        credentialKind="stt_api_key"
        legacySecretValue={cfg.openaiCompat.apiKey}
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
