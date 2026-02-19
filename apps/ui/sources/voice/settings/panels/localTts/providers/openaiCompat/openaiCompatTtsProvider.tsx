import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { speakOpenAiCompatText } from '@/voice/output/TtsController';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import type { LocalTtsProviderSpec } from '../_types';

function normalizeSecretStringPromptInput(value: string | null): VoiceLocalTtsSettings['openaiCompat']['apiKey'] {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? { _isSecretValue: true, value: trimmed } : null;
}

const OpenAiCompatTtsSettings: LocalTtsProviderSpec['Settings'] = (props) => {
  const { theme } = useUnistyles();
  const [openMenu, setOpenMenu] = React.useState<null | 'ttsFormat'>(null);

  const cfg = props.cfgTts;
  const setOpenAiCompat = (patch: Partial<VoiceLocalTtsSettings['openaiCompat']>) => {
    props.setTts({ ...cfg, provider: 'openai_compat', openaiCompat: { ...cfg.openaiCompat, ...patch } });
  };

  return (
    <>
      <Item
        title={t('settingsVoice.local.ttsBaseUrl')}
        detail={cfg.openaiCompat.baseUrl ? String(cfg.openaiCompat.baseUrl) : t('settingsVoice.local.notSet')}
        onPress={() => {
          fireAndForget((async () => {
            const raw = await Modal.prompt(t('settingsVoice.local.ttsBaseUrlTitle'), t('settingsVoice.local.ttsBaseUrlDescription'), {
              placeholder: cfg.openaiCompat.baseUrl ?? '',
            });
            if (raw === null) return;
            setOpenAiCompat({ baseUrl: String(raw).trim() || null });
          })(), { tag: 'OpenAiCompatTtsSettings.prompt.baseUrl' });
        }}
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
            title: 'MP3',
            subtitle: 'Smaller output, broadly compatible.',
            icon: <Ionicons name="musical-notes-outline" size={22} color={theme.colors.textSecondary} />,
          },
          {
            id: 'wav',
            title: 'WAV',
            subtitle: 'Larger output, uncompressed.',
            icon: <Ionicons name="pulse-outline" size={22} color={theme.colors.textSecondary} />,
          },
        ]}
        onSelect={(id) => {
          setOpenAiCompat({ format: id as any });
          setOpenMenu(null);
        }}
      />

      <Item
        title={t('settingsVoice.local.ttsApiKey')}
        detail={cfg.openaiCompat.apiKey ? t('settingsVoice.local.apiKeySet') : t('settingsVoice.local.apiKeyNotSet')}
        onPress={() => {
          fireAndForget((async () => {
            const raw = await Modal.prompt(t('settingsVoice.local.ttsApiKeyTitle'), t('settingsVoice.local.ttsApiKeyDescription'), {
              inputType: 'secure-text',
            });
            if (raw === null) return;
            setOpenAiCompat({ apiKey: normalizeSecretStringPromptInput(raw) });
          })(), { tag: 'OpenAiCompatTtsSettings.prompt.apiKey' });
        }}
      />
    </>
  );
};

export const openaiCompatTtsProviderSpec: LocalTtsProviderSpec = {
  id: 'openai_compat',
  title: 'OpenAI-compatible endpoint',
  subtitle: 'Use your own local/remote OpenAI-compatible TTS server.',
  iconName: 'cloud-outline',
  detail: 'Endpoint',
  Settings: OpenAiCompatTtsSettings,
  test: async ({ cfgTts, networkTimeoutMs, sample }) => {
    const baseUrl = String(cfgTts.openaiCompat.baseUrl ?? '').trim();
    if (!baseUrl) {
      fireAndForget((async () => {
        await Modal.alert(t('common.error'), t('settingsVoice.local.testTtsMissingBaseUrl'));
      })(), {
        tag: 'openaiCompatTtsProviderSpec.alert.missingBaseUrl',
      });
      return;
    }

    const apiKey = cfgTts.openaiCompat.apiKey ? (sync.decryptSecretValue(cfgTts.openaiCompat.apiKey) ?? null) : null;
    await speakOpenAiCompatText({
      baseUrl,
      apiKey,
      model: cfgTts.openaiCompat.model,
      voice: cfgTts.openaiCompat.voice,
      format: cfgTts.openaiCompat.format,
      input: sample,
      timeoutMs: networkTimeoutMs,
      registerPlaybackStopper: (_stopPlayback) => () => {},
    });
  },
};
