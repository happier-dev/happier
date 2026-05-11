import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import type { SecretString } from '@/sync/encryption/secretSettings';
import { t } from '@/text';
import type { VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';
import { LANGUAGES, getLanguageDisplayName } from '@/constants/Languages';
import { fetchGoogleGeminiModelCatalog, type GoogleGeminiModelSummary } from '@/voice/input/googleGeminiModelsApi';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { LocalSttProviderSpec } from '../_types';

function normalizeSecretStringPromptInput(value: string | null): SecretString | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? { _isSecretValue: true, value: trimmed } : null;
}

const GoogleGeminiSttSettings: LocalSttProviderSpec['Settings'] = (props) => {
  const { theme } = useUnistyles();
  const [openMenu, setOpenMenu] = React.useState<null | 'model' | 'language'>(null);
  const cfg = props.cfgStt as VoiceLocalSttSettings;
  const setGoogleGemini = (patch: Partial<VoiceLocalSttSettings['googleGemini']>) =>
    props.setStt({
      ...cfg,
      provider: 'google_gemini',
      googleGemini: { ...cfg.googleGemini, ...patch },
    });

  const apiKey = React.useMemo(() => {
    return cfg.googleGemini.apiKey ? (sync.decryptSecretValue(cfg.googleGemini.apiKey) ?? null) : null;
  }, [cfg.googleGemini.apiKey]);

  const [models, setModels] = React.useState<GoogleGeminiModelSummary[]>([]);
  React.useEffect(() => {
    let canceled = false;
    if (!apiKey) {
      setModels([]);
      return;
    }

    void fetchGoogleGeminiModelCatalog({ apiKey, timeoutMs: 10_000 })
      .then((next) => {
        if (canceled) return;
        setModels(next);
      })
      .catch(() => {
        if (canceled) return;
        setModels([]);
      });

    return () => {
      canceled = true;
    };
  }, [apiKey]);

  return (
    <>
      <Item
        title={t('settingsVoice.local.googleGeminiStt.apiKey.title')}
        detail={cfg.googleGemini.apiKey ? t('settingsVoice.local.apiKeySet') : t('settingsVoice.local.apiKeyNotSet')}
        onPress={() => {
          fireAndForget((async () => {
            const raw = await Modal.prompt(t('settingsVoice.local.googleGeminiStt.apiKey.promptTitle'), t('settingsVoice.local.googleGeminiStt.apiKey.promptBody'), {
              inputType: 'secure-text',
            });
            if (raw === null) return;
            setGoogleGemini({ apiKey: normalizeSecretStringPromptInput(raw) });
          })(), { tag: 'googleGeminiSttProvider.promptApiKey' });
        }}
      />
      <DropdownMenu
        open={openMenu === 'model'}
        onOpenChange={(next) => setOpenMenu(next ? 'model' : null)}
        variant="selectable"
        search={true}
        searchPlaceholder={t('settingsVoice.local.googleGeminiStt.model.searchPlaceholder')}
        selectedId={String(cfg.googleGemini.model)}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
          title: t('settingsVoice.local.googleGeminiStt.model.title'),
          subtitle: t('settingsVoice.local.googleGeminiStt.model.subtitle'),
          showSelectedSubtitle: false,
          detailFormatter: () => String(cfg.googleGemini.model),
        }}
        items={[
          {
            id: '__custom__',
            title: t('settingsVoice.local.googleGeminiStt.model.customTitle'),
            subtitle: t('settingsVoice.local.googleGeminiStt.model.customSubtitle'),
            icon: <Ionicons name="create-outline" size={22} color={theme.colors.text.secondary} />,
          },
          ...((models.length > 0
            ? models
            : [{ id: '', name: '', displayName: t('settingsVoice.local.googleGeminiStt.model.loadingModelsTitle'), description: null }])
            .filter((m) => m.displayName)
            .map((m) => ({
              id: m.id,
              title: m.displayName,
              subtitle: m.id,
              disabled: !m.id,
              icon: <Ionicons name="sparkles-outline" size={22} color={theme.colors.text.secondary} />,
            }))),
        ]}
        onSelect={(id) => {
          if (id === '__custom__') {
            fireAndForget((async () => {
              const raw = await Modal.prompt(t('settingsVoice.local.googleGeminiStt.model.promptTitle'), t('settingsVoice.local.googleGeminiStt.model.promptBody'), {
                placeholder: String(cfg.googleGemini.model),
              });
              if (raw === null) return;
              const next = String(raw).trim();
              if (!next) return;
              setGoogleGemini({ model: next });
            })(), { tag: 'googleGeminiSttProvider.promptModel' });
            setOpenMenu(null);
            return;
          }
          if (id) setGoogleGemini({ model: String(id) });
          setOpenMenu(null);
        }}
      />

      <DropdownMenu
        open={openMenu === 'language'}
        onOpenChange={(next) => setOpenMenu(next ? 'language' : null)}
        variant="selectable"
        search={true}
        searchPlaceholder={t('settingsVoice.local.googleGeminiStt.language.searchPlaceholder')}
        selectedId={cfg.googleGemini.language ?? ''}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
          title: t('settingsVoice.local.googleGeminiStt.language.title'),
          subtitle: t('settingsVoice.local.googleGeminiStt.language.subtitle'),
          showSelectedSubtitle: false,
          detailFormatter: () => (cfg.googleGemini.language ? String(cfg.googleGemini.language) : t('settingsVoice.local.googleGeminiStt.language.autoTitle')),
        }}
        items={LANGUAGES.flatMap((lang) => {
          const id = typeof lang.code === 'string' ? lang.code : '';
          if (!id) {
            return [
              {
                id: '',
                title: t('settingsVoice.local.googleGeminiStt.language.autoTitle'),
                subtitle: t('settingsVoice.local.googleGeminiStt.language.autoSubtitle'),
                icon: <Ionicons name="sparkles-outline" size={22} color={theme.colors.text.secondary} />,
              },
            ];
          }
          return [
            {
              id,
              title: getLanguageDisplayName(lang),
              subtitle: id,
              icon: <Ionicons name="language-outline" size={22} color={theme.colors.text.secondary} />,
            },
          ];
        })}
        onSelect={(id) => {
          setGoogleGemini({ language: id ? String(id) : null });
          setOpenMenu(null);
        }}
      />
    </>
  );
};

export const googleGeminiSttProviderSpec: LocalSttProviderSpec = {
  id: 'google_gemini',
  title: t('settingsVoice.local.googleGeminiStt.provider.title'),
  subtitle: t('settingsVoice.local.googleGeminiStt.provider.subtitle'),
  iconName: 'logo-google',
  detail: t('settingsVoice.local.googleGeminiStt.provider.detail'),
  Settings: GoogleGeminiSttSettings,
};
