import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { LANGUAGES, findLanguageByCode, getLanguageDisplayName } from '@/constants/Languages';
import { formatVoiceTestFailureMessage } from '@/voice/local/formatVoiceTestFailureMessage';
import { speakGoogleCloudText } from '@/voice/output/GoogleCloudTtsController';
import { fetchGoogleCloudTtsVoiceCatalog, type GoogleCloudTtsVoice } from '@/voice/output/googleCloudTtsApi';
import { createVoicePlaybackController } from '@/voice/runtime/VoicePlaybackController';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import type { LocalTtsProviderSpec } from '../_types';

function normalizeSecretStringPromptInput(value: string | null): VoiceLocalTtsSettings['googleCloud']['apiKey'] {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? { _isSecretValue: true, value: trimmed } : null;
}

const GoogleCloudTtsSettings: LocalTtsProviderSpec['Settings'] = (props) => {
  const { theme } = useUnistyles();
  const [openMenu, setOpenMenu] = React.useState<null | 'googleVoiceName' | 'googleLanguage' | 'googleFormat'>(null);

  const cfg = props.cfgTts;
  const googleCloud = cfg.googleCloud ?? {
    apiKey: null,
    androidCertSha1: null,
    voiceName: null,
    languageCode: null,
    format: 'mp3',
    speakingRate: null,
    pitch: null,
  };

  const setGoogleCloud = (patch: Partial<VoiceLocalTtsSettings['googleCloud']>) => {
    props.setTts({ ...cfg, provider: 'google_cloud', googleCloud: { ...googleCloud, ...patch } as any });
  };

  const googleApiKey = React.useMemo(() => {
    return googleCloud.apiKey ? (sync.decryptSecretValue(googleCloud.apiKey) ?? null) : null;
  }, [googleCloud.apiKey]);

  const [googleVoices, setGoogleVoices] = React.useState<GoogleCloudTtsVoice[]>([]);
  React.useEffect(() => {
    let canceled = false;
    if (!googleApiKey) {
      setGoogleVoices([]);
      return;
    }

    void fetchGoogleCloudTtsVoiceCatalog({
      apiKey: googleApiKey,
      androidCertSha1: googleCloud.androidCertSha1,
      timeoutMs: Math.max(10_000, props.networkTimeoutMs),
    })
      .then((voices) => {
        if (canceled) return;
        setGoogleVoices(voices);
      })
      .catch(() => {
        if (canceled) return;
        setGoogleVoices([]);
      });

    return () => {
      canceled = true;
    };
  }, [googleApiKey, googleCloud.androidCertSha1, props.networkTimeoutMs]);

  const availableLanguageCodes = React.useMemo(() => {
    const codes = new Set<string>();
    for (const v of googleVoices) {
      if (!Array.isArray(v.languageCodes)) continue;
      for (const c of v.languageCodes) {
        const code = typeof c === 'string' ? c.trim() : '';
        if (code) codes.add(code);
      }
    }
    return Array.from(codes).sort((a, b) => a.localeCompare(b));
  }, [googleVoices]);

  const filteredVoices = React.useMemo(() => {
    const lang = typeof googleCloud.languageCode === 'string' && googleCloud.languageCode.trim() ? googleCloud.languageCode.trim() : null;
    if (!lang) return googleVoices;
    return googleVoices.filter((v) => Array.isArray(v.languageCodes) && v.languageCodes.includes(lang));
  }, [googleCloud.languageCode, googleVoices]);

  const previewController = React.useMemo(() => createVoicePlaybackController(), []);
  const [previewingGoogleVoiceName, setPreviewingGoogleVoiceName] = React.useState<string | null>(null);
  const stopGooglePreview = React.useCallback(() => {
    previewController.interrupt();
    setPreviewingGoogleVoiceName(null);
  }, [previewController]);

  React.useEffect(() => {
    if (openMenu === 'googleVoiceName') return;
    if (!previewingGoogleVoiceName) return;
    stopGooglePreview();
  }, [openMenu, previewingGoogleVoiceName, stopGooglePreview]);

  const playGooglePreview = React.useCallback(
    async (voiceName: string) => {
      if (!googleApiKey) return;
      if (previewingGoogleVoiceName === voiceName) {
        stopGooglePreview();
        return;
      }

      stopGooglePreview();
      setPreviewingGoogleVoiceName(voiceName);

      try {
        await speakGoogleCloudText({
          apiKey: googleApiKey,
          androidCertSha1: googleCloud.androidCertSha1,
          input: t('settingsVoice.local.testTtsSample'),
          voiceName,
          languageCode: googleCloud.languageCode,
          format: googleCloud.format === 'wav' ? 'wav' : 'mp3',
          speakingRate: googleCloud.speakingRate ?? null,
          pitch: googleCloud.pitch ?? null,
          timeoutMs: Math.max(60_000, props.networkTimeoutMs),
          registerPlaybackStopper: previewController.registerStopper,
        });
      } catch {
        // ignore
      } finally {
        setPreviewingGoogleVoiceName(null);
      }
    },
    [
      googleApiKey,
      googleCloud.androidCertSha1,
      googleCloud.format,
      googleCloud.languageCode,
      googleCloud.pitch,
      googleCloud.speakingRate,
      previewController.registerStopper,
      previewingGoogleVoiceName,
      props.networkTimeoutMs,
      stopGooglePreview,
    ],
  );

  return (
    <>
      <Item
        title="Google Cloud API key"
        detail={googleCloud.apiKey ? t('settingsVoice.local.apiKeySet') : t('settingsVoice.local.apiKeyNotSet')}
        onPress={() => {
          fireAndForget((async () => {
            const raw = await Modal.prompt(
              'Google Cloud API key',
              'Create an API key with Text-to-Speech API enabled. Optional: restrict the key to this app (iOS bundle id / Android package+SHA1).',
              { inputType: 'secure-text' },
            );
            if (raw === null) return;
            setGoogleCloud({ apiKey: normalizeSecretStringPromptInput(raw) });
          })(), { tag: 'GoogleCloudTtsSettings.prompt.apiKey' });
        }}
      />
      <Item
        title="Android cert SHA-1 (optional)"
        subtitle="Only needed if you restrict the API key to your Android app."
        detail={googleCloud.androidCertSha1 ? String(googleCloud.androidCertSha1) : t('settingsVoice.local.notSet')}
        onPress={() => {
          fireAndForget((async () => {
            const raw = await Modal.prompt('Android cert SHA-1', 'Example: AA:BB:CC:... (from your signing certificate).', {
              placeholder: googleCloud.androidCertSha1 ?? '',
            });
            if (raw === null) return;
            setGoogleCloud({ androidCertSha1: String(raw).trim() || null });
          })(), { tag: 'GoogleCloudTtsSettings.prompt.androidCertSha1' });
        }}
      />
      <DropdownMenu
        open={openMenu === 'googleLanguage'}
        onOpenChange={(next) => setOpenMenu(next ? 'googleLanguage' : null)}
        variant="selectable"
        search={true}
        searchPlaceholder="Search languages"
        selectedId={googleCloud.languageCode ?? ''}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
          title: 'Language',
          subtitle: 'Optional filter for the voice list.',
          showSelectedSubtitle: false,
          detailFormatter: () => (googleCloud.languageCode ? String(googleCloud.languageCode) : 'All'),
        }}
        items={[
          {
            id: '',
            title: 'All',
            subtitle: 'Show voices for all languages.',
            icon: <Ionicons name="sparkles-outline" size={22} color={theme.colors.textSecondary} />,
          },
          ...availableLanguageCodes.map((code) => {
            const lang = findLanguageByCode(code);
            return {
              id: code,
              title: lang ? getLanguageDisplayName(lang) : code,
              subtitle: code,
              icon: <Ionicons name="language-outline" size={22} color={theme.colors.textSecondary} />,
            };
          }),
          ...LANGUAGES.flatMap((lang) => {
            const code = typeof lang.code === 'string' ? lang.code : null;
            if (!code) return [];
            if (availableLanguageCodes.includes(code)) return [];
            return [
              {
                id: code,
                title: getLanguageDisplayName(lang),
                subtitle: code,
                icon: <Ionicons name="language-outline" size={22} color={theme.colors.textSecondary} />,
              },
            ];
          }),
        ]}
        onSelect={(id) => {
          setGoogleCloud({ languageCode: id ? String(id) : null });
          setOpenMenu(null);
        }}
      />

      <Item
        title="Speaking rate"
        subtitle="0.25–4.0 (default uses voice default)."
        detail={googleCloud.speakingRate == null ? 'Default' : String(googleCloud.speakingRate)}
        onPress={() => {
          fireAndForget((async () => {
            const raw = await Modal.prompt('Speaking rate', 'Set the speaking rate (0.25–4.0). Leave empty to use default.', {
              inputType: 'numeric',
              placeholder: googleCloud.speakingRate == null ? '' : String(googleCloud.speakingRate),
            });
            if (raw === null) return;
            const trimmed = String(raw).trim();
            if (!trimmed) {
              setGoogleCloud({ speakingRate: null });
              return;
            }
            const next = Number(trimmed);
            if (!Number.isFinite(next)) return;
            setGoogleCloud({ speakingRate: Math.max(0.25, Math.min(4, next)) });
          })(), { tag: 'GoogleCloudTtsSettings.prompt.speakingRate' });
        }}
      />

      <Item
        title="Pitch"
        subtitle="-20–20 (default uses voice default)."
        detail={googleCloud.pitch == null ? 'Default' : String(googleCloud.pitch)}
        onPress={() => {
          fireAndForget((async () => {
            const raw = await Modal.prompt('Pitch', 'Set the pitch (-20–20). Leave empty to use default.', {
              inputType: 'numeric',
              placeholder: googleCloud.pitch == null ? '' : String(googleCloud.pitch),
            });
            if (raw === null) return;
            const trimmed = String(raw).trim();
            if (!trimmed) {
              setGoogleCloud({ pitch: null });
              return;
            }
            const next = Number(trimmed);
            if (!Number.isFinite(next)) return;
            setGoogleCloud({ pitch: Math.max(-20, Math.min(20, next)) });
          })(), { tag: 'GoogleCloudTtsSettings.prompt.pitch' });
        }}
      />

      <DropdownMenu
        open={openMenu === 'googleVoiceName'}
        onOpenChange={(next) => setOpenMenu(next ? 'googleVoiceName' : null)}
        variant="selectable"
        search={true}
        searchPlaceholder="Search voices"
        selectedId={googleCloud.voiceName ?? ''}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
          title: 'Voice',
          subtitle: 'Select a Google Cloud voice.',
          showSelectedSubtitle: false,
          detailFormatter: () => (googleCloud.voiceName ?? (googleApiKey ? 'Select…' : 'Set API key')),
        }}
        items={(
          filteredVoices.length > 0
            ? filteredVoices
            : [{ name: null, languageCodes: [], ssmlGender: null, disabled: true } as any]
        ).map((v: GoogleCloudTtsVoice) => ({
          id: v.name ? String(v.name) : '',
          title: v.name ? String(v.name) : 'Loading voices…',
          subtitle:
            Array.isArray(v.languageCodes) && v.languageCodes.length > 0
              ? `${v.languageCodes.join(', ')}${v.ssmlGender ? ` • ${v.ssmlGender}` : ''}`
              : undefined,
          disabled: (v as any).disabled === true || !v.name,
          rightElement: v.name ? (
            <Pressable
              hitSlop={10}
              onPress={(e: any) => {
                e?.stopPropagation?.();
                void playGooglePreview(String(v.name));
              }}
              style={{ paddingHorizontal: 4, paddingVertical: 2 }}
            >
              <Ionicons
                name={previewingGoogleVoiceName === v.name ? 'stop-circle-outline' : 'play-circle-outline'}
                size={22}
                color={theme.colors.textSecondary}
              />
            </Pressable>
          ) : null,
        }))}
        onSelect={(id) => {
          setGoogleCloud({ voiceName: id || null });
          setOpenMenu(null);
        }}
      />

      <DropdownMenu
        open={openMenu === 'googleFormat'}
        onOpenChange={(next) => setOpenMenu(next ? 'googleFormat' : null)}
        variant="selectable"
        search={false}
        selectedId={googleCloud.format}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
          title: 'Format',
          subtitle: 'MP3 is smaller; WAV is uncompressed.',
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
          setGoogleCloud({ format: id === 'wav' ? 'wav' : 'mp3' });
          setOpenMenu(null);
        }}
      />
    </>
  );
};

export const googleCloudTtsProviderSpec: LocalTtsProviderSpec = {
  id: 'google_cloud',
  title: 'Google Cloud Text-to-Speech',
  subtitle: 'Use your own Google Cloud API key to synthesize audio.',
  iconName: 'logo-google',
  detail: 'Google Cloud',
  Settings: GoogleCloudTtsSettings,
  test: async ({ cfgTts, networkTimeoutMs, sample }) => {
    const apiKey = cfgTts.googleCloud.apiKey ? (sync.decryptSecretValue(cfgTts.googleCloud.apiKey) ?? null) : null;
    if (!apiKey) {
      fireAndForget((async () => {
        await Modal.alert(t('common.error'), 'Missing Google Cloud API key.');
      })(), {
        tag: 'googleCloudTtsProviderSpec.alert.missingApiKey',
      });
      return;
    }
    if (!cfgTts.googleCloud.voiceName) {
      fireAndForget((async () => {
        await Modal.alert(t('common.error'), 'Select a Google Cloud voice first.');
      })(), {
        tag: 'googleCloudTtsProviderSpec.alert.missingVoice',
      });
      return;
    }

    try {
      await speakGoogleCloudText({
        apiKey,
        androidCertSha1: cfgTts.googleCloud.androidCertSha1,
        input: sample,
        voiceName: cfgTts.googleCloud.voiceName,
        languageCode: cfgTts.googleCloud.languageCode,
        format: cfgTts.googleCloud.format === 'wav' ? 'wav' : 'mp3',
        speakingRate: cfgTts.googleCloud.speakingRate ?? null,
        pitch: cfgTts.googleCloud.pitch ?? null,
        timeoutMs: Math.max(60_000, networkTimeoutMs),
        registerPlaybackStopper: (_stopper) => () => {},
      });
    } catch (err) {
      fireAndForget((async () => {
        await Modal.alert(t('common.error'), formatVoiceTestFailureMessage(t('settingsVoice.local.testTtsFailed'), err));
      })(), {
        tag: 'googleCloudTtsProviderSpec.alert.testFailed',
      });
    }
  },
};
