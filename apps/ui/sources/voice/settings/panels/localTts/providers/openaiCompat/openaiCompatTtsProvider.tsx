import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Modal } from '@/modal';
import { t } from '@/text';
import { speakOpenAiCompatText } from '@/voice/output/TtsController';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { OpenAiCompatCredentialItem } from '@/voice/local/openaiCompat/CredentialItem';
import { OpenAiCompatEndpointItem } from '@/voice/local/openaiCompat/EndpointItem';

import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import type { LocalTtsProviderSpec } from '../_types';

const MP3_FORMAT_TITLE = 'MP3';
const WAV_FORMAT_TITLE = 'WAV';

const OpenAiCompatTtsSettings: LocalTtsProviderSpec['Settings'] = (props) => {
  const { theme } = useUnistyles();
  const [openMenu, setOpenMenu] = React.useState<null | 'ttsFormat'>(null);

  const cfg = props.cfgTts;
  const setOpenAiCompat = (patch: Partial<VoiceLocalTtsSettings['openaiCompat']>) => {
    props.setTts({ ...cfg, provider: 'openai_compat', openaiCompat: { ...cfg.openaiCompat, ...patch } });
  };

  return (
    <>
      <OpenAiCompatEndpointItem
        title={t('settingsVoice.local.ttsBaseUrl')}
        promptTitle={t('settingsVoice.local.ttsBaseUrlTitle')}
        promptDescription={t('settingsVoice.local.ttsBaseUrlDescription')}
        baseUrl={cfg.openaiCompat.baseUrl}
        insecureLocalOriginConsent={cfg.openaiCompat.insecureLocalOriginConsent}
        insecureLocalConsentMachineId={cfg.openaiCompat.insecureLocalConsentMachineId}
        onChange={setOpenAiCompat}
      />
      <Item
        title={t('settingsVoice.local.ttsModel')}
        subtitle={t('settingsVoice.local.ttsModelSubtitle')}
        detail={cfg.openaiCompat.model}
        onPress={() => {
          fireAndForget((async () => {
            const raw = await Modal.prompt(t('settingsVoice.local.ttsModelTitle'), t('settingsVoice.local.ttsModelDescription'), {
              placeholder: cfg.openaiCompat.model,
            });
            if (raw === null) return;
            const next = String(raw).trim();
            if (!next) return;
            setOpenAiCompat({ model: next });
          })(), { tag: 'OpenAiCompatTtsSettings.prompt.model' });
        }}
      />
      <Item
        title={t('settingsVoice.local.ttsVoice')}
        subtitle={t('settingsVoice.local.ttsVoiceSubtitle')}
        detail={cfg.openaiCompat.voice}
        onPress={() => {
          fireAndForget((async () => {
            const raw = await Modal.prompt(t('settingsVoice.local.ttsVoiceTitle'), t('settingsVoice.local.ttsVoiceDescription'), {
              placeholder: cfg.openaiCompat.voice,
            });
            if (raw === null) return;
            const next = String(raw).trim();
            if (!next) return;
            setOpenAiCompat({ voice: next });
          })(), { tag: 'OpenAiCompatTtsSettings.prompt.voice' });
        }}
      />

      <DropdownMenu
        open={openMenu === 'ttsFormat'}
        onOpenChange={(next) => setOpenMenu(next ? 'ttsFormat' : null)}
        variant="selectable"
        search={false}
        selectedId={cfg.openaiCompat.format}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
          title: t('settingsVoice.local.ttsFormat'),
          subtitle: t('settingsVoice.local.ttsFormatSubtitle'),
          showSelectedSubtitle: false,
        }}
        items={[
          {
            id: 'mp3',
            title: MP3_FORMAT_TITLE,
            subtitle: t('settingsVoice.local.ttsFormatOptions.mp3Subtitle'),
            icon: <Ionicons name="musical-notes-outline" size={22} color={theme.colors.text.secondary} />,
          },
          {
            id: 'wav',
            title: WAV_FORMAT_TITLE,
            subtitle: t('settingsVoice.local.ttsFormatOptions.wavSubtitle'),
            icon: <Ionicons name="pulse-outline" size={22} color={theme.colors.text.secondary} />,
          },
        ]}
        onSelect={(id) => {
          setOpenAiCompat({ format: id as any });
          setOpenMenu(null);
        }}
      />

      <OpenAiCompatCredentialItem
        title={t('settingsVoice.local.ttsApiKey')}
        promptTitle={t('settingsVoice.local.ttsApiKeyTitle')}
        promptDescription={t('settingsVoice.local.ttsApiKeyDescription')}
        credentialKind="tts_api_key"
        legacySecretValue={cfg.openaiCompat.apiKey}
      />
    </>
  );
};

export const openaiCompatTtsProviderSpec: LocalTtsProviderSpec = {
  id: 'openai_compat',
  title: t('settingsVoice.local.openaiCompatTts.provider.title'),
  subtitle: t('settingsVoice.local.openaiCompatTts.provider.subtitle'),
  iconName: 'cloud-outline',
  detail: t('settingsVoice.local.openaiCompatTts.provider.detail'),
  Settings: OpenAiCompatTtsSettings,
  test: async ({ cfgTts, sample }) => {
    const baseUrl = String(cfgTts.openaiCompat.baseUrl ?? '').trim();
    if (!baseUrl) {
      fireAndForget((async () => {
        await Modal.alert(t('common.error'), t('settingsVoice.local.testTtsMissingBaseUrl'));
      })(), {
        tag: 'openaiCompatTtsProviderSpec.alert.missingBaseUrl',
      });
      return;
    }

    await speakOpenAiCompatText({
      baseUrl,
      insecureLocalOriginConsent: cfgTts.openaiCompat.insecureLocalOriginConsent,
      insecureLocalConsentMachineId: cfgTts.openaiCompat.insecureLocalConsentMachineId,
      credentialKind: 'tts_api_key',
      model: cfgTts.openaiCompat.model,
      voice: cfgTts.openaiCompat.voice,
      format: cfgTts.openaiCompat.format,
      input: sample,
      registerPlaybackStopper: (_stopPlayback) => () => {},
    });
  },
};
