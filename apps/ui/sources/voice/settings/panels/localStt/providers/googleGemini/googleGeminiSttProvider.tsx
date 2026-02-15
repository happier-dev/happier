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
        title="Gemini API key"
        detail={cfg.googleGemini.apiKey ? t('settingsVoice.local.apiKeySet') : t('settingsVoice.local.apiKeyNotSet')}
        onPress={() => {
          void (async () => {
            const raw = await Modal.prompt('Gemini API key', 'Create an API key in Google AI Studio (Gemini API).', {
              inputType: 'secure-text',
            });
            if (raw === null) return;
            setGoogleGemini({ apiKey: normalizeSecretStringPromptInput(raw) });
          })();
        }}
      />
      <DropdownMenu
        open={openMenu === 'model'}
        onOpenChange={(next) => setOpenMenu(next ? 'model' : null)}
        variant="selectable"
        search={true}
        searchPlaceholder="Search models"
        selectedId={String(cfg.googleGemini.model)}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        trigger={({ open, toggle }) => (
          <Item
            title="Gemini model"
            subtitle="Choose which Gemini model to use for transcription."
            detail={String(cfg.googleGemini.model)}
            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
            onPress={toggle}
            showChevron={false}
            selected={false}
          />
        )}
        items={[
          {
            id: '__custom__',
            title: 'Custom model id…',
            subtitle: 'Enter a model name manually.',
            icon: <Ionicons name="create-outline" size={22} color={theme.colors.textSecondary} />,
          },
          ...((models.length > 0
            ? models
            : [{ id: '', name: '', displayName: 'Loading models…', description: null }])
            .filter((m) => m.displayName)
            .map((m) => ({
              id: m.id,
              title: m.displayName,
              subtitle: m.id,
              disabled: !m.id,
              icon: <Ionicons name="sparkles-outline" size={22} color={theme.colors.textSecondary} />,
            }))),
        ]}
        onSelect={(id) => {
          if (id === '__custom__') {
            void (async () => {
              const raw = await Modal.prompt('Gemini model', 'Example: gemini-2.5-flash', {
                placeholder: String(cfg.googleGemini.model),
              });
              if (raw === null) return;
              const next = String(raw).trim();
              if (!next) return;
              setGoogleGemini({ model: next });
            })();
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
        searchPlaceholder="Search languages"
        selectedId={cfg.googleGemini.language ?? ''}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        trigger={({ open, toggle }) => (
          <Item
            title="Language"
            subtitle="Optional hint to improve transcription accuracy."
            detail={cfg.googleGemini.language ? String(cfg.googleGemini.language) : 'Auto'}
            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
            onPress={toggle}
            showChevron={false}
            selected={false}
          />
        )}
        items={LANGUAGES.flatMap((lang) => {
          const id = typeof lang.code === 'string' ? lang.code : '';
          if (!id) {
            return [
              {
                id: '',
                title: 'Auto',
                subtitle: 'Do not provide a language hint.',
                icon: <Ionicons name="sparkles-outline" size={22} color={theme.colors.textSecondary} />,
              },
            ];
          }
          return [
            {
              id,
              title: getLanguageDisplayName(lang),
              subtitle: id,
              icon: <Ionicons name="language-outline" size={22} color={theme.colors.textSecondary} />,
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
  title: 'Google Gemini (audio)',
  subtitle: 'Transcribe audio using Gemini multimodal models.',
  iconName: 'logo-google',
  detail: 'Google Gemini',
  Settings: GoogleGeminiSttSettings,
};
