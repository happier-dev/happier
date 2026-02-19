import * as React from 'react';
import { Linking, Pressable } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import type { SecretString } from '@/sync/encryption/secretSettings';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import {
  createHappierElevenLabsAgent,
  findExistingHappierElevenLabsAgents,
  updateHappierElevenLabsAgent,
} from '@/realtime/elevenlabs/autoprovision';
import { listElevenLabsVoices, type ElevenLabsVoiceSummary } from '@/realtime/elevenlabs/elevenLabsVoices';
import { showElevenLabsAgentReuseDialog } from '@/voice/settings/modals/showElevenLabsAgentReuseDialog';

function normalizeSecretStringPromptInput(value: string | null): SecretString | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? { _isSecretValue: true, value: trimmed } : null;
}

export function RealtimeElevenLabsSection(props: {
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
}) {
  const { theme } = useUnistyles();
  const cfg = props.voice.adapters.realtime_elevenlabs;
  const enabled = props.voice.providerId === 'realtime_elevenlabs';
  const isByo = enabled && cfg.billingMode === 'byo';
  const [busy, setBusy] = React.useState<null | 'autoprovCreate' | 'autoprovUpdate'>(null);
  const [openMenu, setOpenMenu] = React.useState<null | 'voiceId' | 'modelId' | 'speakerBoost' | 'welcomeMode'>(null);
  const [voiceCatalog, setVoiceCatalog] = React.useState<ReadonlyArray<ElevenLabsVoiceSummary> | null>(null);
  const [voiceCatalogStatus, setVoiceCatalogStatus] = React.useState<'idle' | 'loading' | 'error'>('idle');
  const [previewingVoiceId, setPreviewingVoiceId] = React.useState<string | null>(null);
  const previewPlayerRef = React.useRef<{ player: any; subscription: any } | null>(null);
  const loadedCatalogKeyRef = React.useRef<string | null>(null);

  const apiKey = isByo ? sync.decryptSecretValue(cfg.byo.apiKey) : null;
  const configured = isByo && Boolean(apiKey) && Boolean(cfg.byo.agentId);

  const setByo = (patch: Partial<typeof cfg.byo>) => {
    props.setVoice({
      ...props.voice,
      adapters: {
        ...props.voice.adapters,
        realtime_elevenlabs: {
          ...cfg,
          byo: { ...cfg.byo, ...patch },
        },
      },
    });
  };

  const tts = cfg.tts;
  const setTts = (patch: Partial<typeof tts>) => {
    props.setVoice({
      ...props.voice,
      adapters: {
        ...props.voice.adapters,
        realtime_elevenlabs: {
          ...cfg,
          tts: { ...tts, ...patch },
        },
      },
    });
  };

  const welcome = cfg.welcome ?? { enabled: false, mode: 'immediate' as const, templateId: null as string | null };
  const setWelcome = (patch: Partial<typeof welcome>) => {
    props.setVoice({
      ...props.voice,
      adapters: {
        ...props.voice.adapters,
        realtime_elevenlabs: {
          ...cfg,
          welcome: { ...welcome, ...patch },
        },
      },
    });
  };

  const openUrl = async (url: string) => {
    const supported = await Linking.canOpenURL(url);
    if (!supported) return;
    await Linking.openURL(url);
  };

  React.useEffect(() => {
    if (!isByo) return;
    if (!apiKey) return;
    if (openMenu !== 'voiceId') return;
    if (voiceCatalogStatus === 'loading') return;
    if (voiceCatalog && voiceCatalog.length > 0) return;

    setVoiceCatalogStatus('loading');
    void listElevenLabsVoices(apiKey)
      .then((voices) => {
        setVoiceCatalog(voices);
        setVoiceCatalogStatus('idle');
      })
      .catch(() => {
        setVoiceCatalogStatus('error');
      });
  }, [apiKey, isByo, openMenu, voiceCatalog, voiceCatalogStatus]);

  const stopPreview = React.useCallback(() => {
    try {
      previewPlayerRef.current?.subscription?.remove?.();
    } catch {
      // ignore
    }
    try {
      previewPlayerRef.current?.player?.remove?.();
    } catch {
      // ignore
    }
    previewPlayerRef.current = null;
    setPreviewingVoiceId(null);
  }, []);

  React.useEffect(() => {
    return () => {
      stopPreview();
    };
  }, [stopPreview]);

  React.useEffect(() => {
    if (!isByo) return;
    // If the API key changes, clear any cached voice catalog and stop previews.
    stopPreview();

    if (!apiKey) {
      loadedCatalogKeyRef.current = null;
      setVoiceCatalog(null);
      setVoiceCatalogStatus('idle');
      return;
    }

    if (loadedCatalogKeyRef.current === apiKey) return;
    loadedCatalogKeyRef.current = apiKey;
    setVoiceCatalog(null);
    setVoiceCatalogStatus('idle');
  }, [apiKey, isByo, stopPreview]);

  const playPreview = React.useCallback(async (voice: ElevenLabsVoiceSummary) => {
    if (!voice.previewUrl) return;
    if (previewingVoiceId === voice.voiceId) {
      stopPreview();
      return;
    }

    stopPreview();
    setPreviewingVoiceId(voice.voiceId);

    try {
      const { createAudioPlayer } = await import('expo-audio');
      const player = createAudioPlayer(voice.previewUrl);
      const subscription = player.addListener?.('playbackStatusUpdate', (status: any) => {
        if (status?.didJustFinish) {
          stopPreview();
        }
      });
      previewPlayerRef.current = { player, subscription };
      player.play();
    } catch {
      stopPreview();
    }
  }, [previewingVoiceId, stopPreview]);

  React.useEffect(() => {
    if (!isByo) return;
    // Don't keep playing audio when the dropdown isn't visible.
    if (openMenu === 'voiceId') return;
    if (!previewingVoiceId) return;
    stopPreview();
  }, [isByo, openMenu, previewingVoiceId, stopPreview]);

  const selectedVoice = React.useMemo(() => {
    if (!voiceCatalog) return null;
    return voiceCatalog.find((v) => v.voiceId === tts.voiceId) ?? null;
  }, [tts.voiceId, voiceCatalog]);

  if (!enabled) return null;

  return (
    <>
      <ItemGroup title="Call">
        <DropdownMenu
          open={openMenu === 'welcomeMode'}
          onOpenChange={(next) => setOpenMenu(next ? 'welcomeMode' : null)}
          variant="selectable"
          search={false}
          selectedId={welcome.mode ?? 'immediate'}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{
            title: 'Welcome message',
            subtitle: 'Optional greeting at the start of the call.',
            showSelectedSubtitle: false,
            detailFormatter: () => (welcome.enabled ? (welcome.mode === 'on_first_turn' ? 'On first turn' : 'Immediate') : 'Off'),
          }}
          items={[
            { id: 'off', title: 'Off', subtitle: 'No greeting.' },
            { id: 'immediate', title: 'Immediate', subtitle: 'Greet as soon as the call connects.' },
            { id: 'on_first_turn', title: 'On first turn', subtitle: 'Greet at the start of the first reply.' },
          ]}
          onSelect={(id) => {
            if (id === 'off') {
              setWelcome({ enabled: false });
            } else {
              setWelcome({ enabled: true, mode: id as any });
            }
            setOpenMenu(null);
          }}
        />
      </ItemGroup>

      {!isByo ? null : (
        <>
          <ItemGroup title={t('settingsVoice.byo.title')} footer={configured ? t('settingsVoice.byo.configured') : undefined}>
        <Item
          title={t('settingsVoice.byo.apiKeyTitle')}
          subtitle={t('settingsVoice.byo.apiKeyDescription')}
          detail={cfg.byo.apiKey ? t('settingsVoice.byo.apiKeySet') : t('settingsVoice.byo.apiKeyNotSet')}
          onPress={() => {
            fireAndForget((async () => {
              const raw = await Modal.prompt(
                t('settingsVoice.byo.apiKeyTitle'),
                t('settingsVoice.byo.apiKeyDescription'),
                { inputType: 'secure-text', placeholder: t('settingsVoice.byo.apiKeyPlaceholder') },
              );
              if (raw === null) return;
              setByo({ apiKey: normalizeSecretStringPromptInput(raw) });
            })(), { tag: 'RealtimeElevenLabsSection.prompt.apiKey' });
          }}
        />
        <Item
          title={t('settingsVoice.byo.agentIdTitle')}
          subtitle={t('settingsVoice.byo.agentIdDescription')}
          detail={cfg.byo.agentId ? String(cfg.byo.agentId) : t('settingsVoice.byo.agentIdNotSet')}
          onPress={() => {
            fireAndForget((async () => {
              const value = await Modal.prompt(
                t('settingsVoice.byo.agentIdTitle'),
                t('settingsVoice.byo.agentIdDescription'),
                { placeholder: cfg.byo.agentId ?? '' },
              );
              if (value === null) return;
              setByo({ agentId: String(value).trim() || null });
            })(), { tag: 'RealtimeElevenLabsSection.prompt.agentId' });
          }}
        />
      </ItemGroup>

      <ItemGroup title={t('settingsVoice.byo.voiceGroupTitle')} footer={t('settingsVoice.byo.voiceGroupFooter')}>
        <DropdownMenu
          open={openMenu === 'voiceId'}
          onOpenChange={(next) => setOpenMenu(next ? 'voiceId' : null)}
          variant="selectable"
          search={true}
          searchPlaceholder={t('settingsVoice.byo.voiceSearchPlaceholder')}
          selectedId={tts.voiceId}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
	          popoverBoundaryRef={props.popoverBoundaryRef}
	          itemTrigger={{
	            title: 'Voice',
	            subtitle: 'Choose the ElevenLabs voice used for replies.',
	            showSelectedSubtitle: false,
	            detailFormatter: () => (!apiKey ? t('settingsVoice.byo.apiKeyNotSet') : (selectedVoice?.name ?? String(tts.voiceId))),
	          }}
          items={
            !apiKey
              ? [{
                id: tts.voiceId,
                title: 'Add API key to load voices',
                disabled: true,
              }]
              : voiceCatalogStatus === 'loading'
                ? [{
                  id: tts.voiceId,
                  title: 'Loading voices…',
                  disabled: true,
                }]
                : voiceCatalogStatus === 'error'
                  ? [{
                    id: tts.voiceId,
                    title: 'Failed to load voices',
                    subtitle: 'Check your API key and try again.',
                    disabled: true,
                  }]
                  : (voiceCatalog ?? []).map((voice) => ({
                    id: voice.voiceId,
                    title: voice.name,
                    subtitle: voice.category ?? voice.labels?.accent ?? undefined,
                    rightElement: (
                      <Pressable
                        hitSlop={10}
                        onPress={(e: any) => {
                          e?.stopPropagation?.();
                          if (!voice.previewUrl) return;
                          void playPreview(voice);
                        }}
                        disabled={!voice.previewUrl}
                        style={{ opacity: voice.previewUrl ? 1 : 0.3, paddingHorizontal: 4, paddingVertical: 2 }}
                      >
                        <Ionicons
                          name={previewingVoiceId === voice.voiceId ? 'stop-circle-outline' : 'play-circle-outline'}
                          size={22}
                          color={theme.colors.textSecondary}
                        />
                      </Pressable>
                    ),
                  }))
          }
          onSelect={(id) => {
            setTts({ voiceId: id });
            setOpenMenu(null);
          }}
        />

        <DropdownMenu
          open={openMenu === 'modelId'}
          onOpenChange={(next) => setOpenMenu(next ? 'modelId' : null)}
          variant="selectable"
          search={false}
          selectedId={tts.modelId ?? ''}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{
            title: 'Model',
            subtitle: 'Optional: override the ElevenLabs TTS model id.',
            showSelectedSubtitle: false,
            detailFormatter: () => (tts.modelId ?? 'Auto'),
          }}
          items={[
            { id: '', title: 'Auto', subtitle: 'Use the ElevenLabs default model.' },
            { id: 'eleven_multilingual_v2', title: 'eleven_multilingual_v2', subtitle: 'Common default (multilingual).' },
            { id: 'eleven_turbo_v2', title: 'eleven_turbo_v2', subtitle: 'Lower latency (if available on your plan).' },
            { id: 'eleven_turbo_v2_5', title: 'eleven_turbo_v2_5', subtitle: 'Turbo 2.5 (if available).' },
            { id: 'custom', title: 'Custom…', subtitle: 'Enter a model id.' },
          ]}
          onSelect={(id) => {
            if (id === 'custom') {
              fireAndForget((async () => {
                const raw = await Modal.prompt(
                  'Model id',
                  'Enter an ElevenLabs model id, or leave blank to use the default.',
                  { placeholder: tts.modelId ?? 'eleven_multilingual_v2' },
                );
                if (raw === null) return;
                const trimmed = String(raw).trim();
                setTts({ modelId: trimmed.length > 0 ? trimmed : null });
              })(), { tag: 'RealtimeElevenLabsSection.prompt.modelId' });
              setOpenMenu(null);
              return;
            }
            setTts({ modelId: id.length > 0 ? id : null });
            setOpenMenu(null);
          }}
        />

        <DropdownMenu
          open={openMenu === 'speakerBoost'}
          onOpenChange={(next) => setOpenMenu(next ? 'speakerBoost' : null)}
          variant="selectable"
          search={false}
          selectedId={tts.voiceSettings.useSpeakerBoost === null ? '' : String(tts.voiceSettings.useSpeakerBoost)}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{
            title: t('settingsVoice.byo.speakerBoostTitle'),
            subtitle: t('settingsVoice.byo.speakerBoostSubtitle'),
            showSelectedSubtitle: false,
          }}
          items={[
            {
              id: '',
              title: t('settingsVoice.byo.speakerBoostAuto'),
              subtitle: t('settingsVoice.byo.speakerBoostAutoSubtitle'),
            },
            {
              id: 'true',
              title: t('settingsVoice.byo.speakerBoostOn'),
              subtitle: t('settingsVoice.byo.speakerBoostOnSubtitle'),
            },
            {
              id: 'false',
              title: t('settingsVoice.byo.speakerBoostOff'),
              subtitle: t('settingsVoice.byo.speakerBoostOffSubtitle'),
            },
          ]}
          onSelect={(id) => {
            const next = id === '' ? null : id === 'true';
            setTts({
              voiceSettings: {
                ...tts.voiceSettings,
                useSpeakerBoost: next,
              },
            });
            setOpenMenu(null);
          }}
        />

        <Item
          title="Stability"
          subtitle="0–1. Leave blank for default."
          detail={tts.voiceSettings.stability === null ? 'Default' : String(tts.voiceSettings.stability)}
          onPress={() => {
            fireAndForget((async () => {
              const raw = await Modal.prompt(
                'Stability (0–1)',
                'Enter a number between 0 and 1. Leave blank to use the default.',
                { inputType: 'numeric', placeholder: tts.voiceSettings.stability === null ? '' : String(tts.voiceSettings.stability) },
              );
              if (raw === null) return;
              const trimmed = String(raw).trim();
              if (trimmed.length === 0) {
                setTts({ voiceSettings: { ...tts.voiceSettings, stability: null } });
                return;
              }
              const n = Number(trimmed);
              if (!Number.isFinite(n) || n < 0 || n > 1) {
                Modal.alert(t('common.error'), 'Please enter a number between 0 and 1.');
                return;
              }
              setTts({ voiceSettings: { ...tts.voiceSettings, stability: n } });
            })(), { tag: 'RealtimeElevenLabsSection.prompt.stability' });
          }}
        />

        <Item
          title="Similarity boost"
          subtitle="0–1. Leave blank for default."
          detail={tts.voiceSettings.similarityBoost === null ? 'Default' : String(tts.voiceSettings.similarityBoost)}
          onPress={() => {
            fireAndForget((async () => {
              const raw = await Modal.prompt(
                'Similarity boost (0–1)',
                'Enter a number between 0 and 1. Leave blank to use the default.',
                { inputType: 'numeric', placeholder: tts.voiceSettings.similarityBoost === null ? '' : String(tts.voiceSettings.similarityBoost) },
              );
              if (raw === null) return;
              const trimmed = String(raw).trim();
              if (trimmed.length === 0) {
                setTts({ voiceSettings: { ...tts.voiceSettings, similarityBoost: null } });
                return;
              }
              const n = Number(trimmed);
              if (!Number.isFinite(n) || n < 0 || n > 1) {
                Modal.alert(t('common.error'), 'Please enter a number between 0 and 1.');
                return;
              }
              setTts({ voiceSettings: { ...tts.voiceSettings, similarityBoost: n } });
            })(), { tag: 'RealtimeElevenLabsSection.prompt.similarityBoost' });
          }}
        />

        <Item
          title="Style"
          subtitle="0–1. Leave blank for default."
          detail={tts.voiceSettings.style === null ? 'Default' : String(tts.voiceSettings.style)}
          onPress={() => {
            fireAndForget((async () => {
              const raw = await Modal.prompt(
                'Style (0–1)',
                'Enter a number between 0 and 1. Leave blank to use the default.',
                { inputType: 'numeric', placeholder: tts.voiceSettings.style === null ? '' : String(tts.voiceSettings.style) },
              );
              if (raw === null) return;
              const trimmed = String(raw).trim();
              if (trimmed.length === 0) {
                setTts({ voiceSettings: { ...tts.voiceSettings, style: null } });
                return;
              }
              const n = Number(trimmed);
              if (!Number.isFinite(n) || n < 0 || n > 1) {
                Modal.alert(t('common.error'), 'Please enter a number between 0 and 1.');
                return;
              }
              setTts({ voiceSettings: { ...tts.voiceSettings, style: n } });
            })(), { tag: 'RealtimeElevenLabsSection.prompt.style' });
          }}
        />

        <Item
          title="Speed"
          subtitle="0.5–2. Leave blank for default."
          detail={tts.voiceSettings.speed === null ? 'Default' : String(tts.voiceSettings.speed)}
          onPress={() => {
            fireAndForget((async () => {
              const raw = await Modal.prompt(
                'Speed (0.5–2)',
                'Enter a number between 0.5 and 2. Leave blank to use the default.',
                { inputType: 'numeric', placeholder: tts.voiceSettings.speed === null ? '' : String(tts.voiceSettings.speed) },
              );
              if (raw === null) return;
              const trimmed = String(raw).trim();
              if (trimmed.length === 0) {
                setTts({ voiceSettings: { ...tts.voiceSettings, speed: null } });
                return;
              }
              const n = Number(trimmed);
              if (!Number.isFinite(n) || n < 0.5 || n > 2) {
                Modal.alert(t('common.error'), 'Please enter a number between 0.5 and 2.');
                return;
              }
              setTts({ voiceSettings: { ...tts.voiceSettings, speed: n } });
            })(), { tag: 'RealtimeElevenLabsSection.prompt.speed' });
          }}
        />
      </ItemGroup>

      <ItemGroup title={t('settingsVoice.byo.provisioningGroupTitle')} footer={t('settingsVoice.byo.provisioningGroupFooter')}>
        <Item
          title={t('settingsVoice.byo.autoprovCreate')}
          subtitle={t('settingsVoice.byo.autoprovCreateSubtitle')}
          detail={busy === 'autoprovCreate' ? t('common.loading') : undefined}
	          disabled={busy !== null || !apiKey}
	          onPress={() => {
	            fireAndForget((async () => {
	              if (!apiKey) {
	                Modal.alert(t('common.error'), t('settingsVoice.byo.notConfigured'));
	                return;
	              }
	              setBusy('autoprovCreate');
	              try {
	                const existing = await findExistingHappierElevenLabsAgents({ apiKey });
	                if (existing.length > 0) {
	                  const reuse = existing[0]!;
	                  const decision = await showElevenLabsAgentReuseDialog({
	                    existingAgentId: reuse.agentId,
	                    existingAgentName: reuse.name,
	                  });
	                  if (decision === 'cancel') return;
	                  if (decision === 'update_existing') {
	                    await updateHappierElevenLabsAgent({
	                      apiKey,
	                      agentId: reuse.agentId,
	                      tts: {
	                        voiceId: cfg.tts.voiceId,
	                        modelId: cfg.tts.modelId,
	                        voiceSettings: cfg.tts.voiceSettings,
	                      },
	                    });
	                    setByo({ agentId: reuse.agentId });
	                    Modal.alert(t('common.success'), t('settingsVoice.byo.autoprovUpdated'));
	                    return;
	                  }
	                }

	                const res = await createHappierElevenLabsAgent({
	                  apiKey,
	                  tts: {
	                    voiceId: cfg.tts.voiceId,
	                    modelId: cfg.tts.modelId,
	                    voiceSettings: cfg.tts.voiceSettings,
	                  },
	                });
	                setByo({ agentId: res.agentId });
	                Modal.alert(t('common.success'), t('settingsVoice.byo.autoprovCreated', { agentId: res.agentId }));
	              } catch {
	                Modal.alert(t('common.error'), t('settingsVoice.byo.autoprovFailed'));
	              } finally {
	                setBusy(null);
	              }
            })(), { tag: 'RealtimeElevenLabsSection.autoprov.create' });
          }}
        />

        <Item
          title={t('settingsVoice.byo.autoprovUpdate')}
          subtitle={t('settingsVoice.byo.autoprovUpdateSubtitle')}
          detail={busy === 'autoprovUpdate' ? t('common.loading') : undefined}
          disabled={busy !== null || !apiKey || !cfg.byo.agentId}
          onPress={() => {
            fireAndForget((async () => {
              if (!apiKey || !cfg.byo.agentId) return;
              setBusy('autoprovUpdate');
              try {
                await updateHappierElevenLabsAgent({
                  apiKey,
                  agentId: cfg.byo.agentId,
                  tts: {
                    voiceId: cfg.tts.voiceId,
                    modelId: cfg.tts.modelId,
                    voiceSettings: cfg.tts.voiceSettings,
                  },
                });
                Modal.alert(t('common.success'), t('settingsVoice.byo.autoprovUpdated'));
              } catch {
                Modal.alert(t('common.error'), t('settingsVoice.byo.autoprovFailed'));
              } finally {
                setBusy(null);
              }
            })(), { tag: 'RealtimeElevenLabsSection.autoprov.update' });
          }}
        />
      </ItemGroup>

      <ItemGroup title="Get started" footer={configured ? undefined : t('settingsVoice.byo.notConfigured')}>
        <Item
          title={t('settingsVoice.byo.createAccount')}
          subtitle={t('settingsVoice.byo.createAccountSubtitle')}
          onPress={() => {
            fireAndForget(openUrl('https://elevenlabs.io'), { tag: 'RealtimeElevenLabsSection.openUrl.createAccount' });
          }}
        />
        <Item
          title={t('settingsVoice.byo.openApiKeys')}
          subtitle={t('settingsVoice.byo.openApiKeysSubtitle')}
          onPress={() => {
            fireAndForget(openUrl('https://elevenlabs.io/app/settings/api-keys'), { tag: 'RealtimeElevenLabsSection.openUrl.apiKeys' });
          }}
        />
        <Item
          title={t('settingsVoice.byo.apiKeyHelp')}
          subtitle={t('settingsVoice.byo.apiKeyHelpSubtitle')}
          onPress={() => {
            Modal.alert(t('settingsVoice.byo.apiKeyHelpDialogTitle'), t('settingsVoice.byo.apiKeyHelpDialogBody'));
          }}
        />
      </ItemGroup>

      <ItemGroup>
        <Item
          title={t('settingsVoice.byo.disconnect')}
          subtitle={t('settingsVoice.byo.disconnectSubtitle')}
          onPress={() => {
            fireAndForget((async () => {
              const confirmed = await Modal.confirm(
                t('settingsVoice.byo.disconnectTitle'),
                t('settingsVoice.byo.disconnectDescription'),
                { confirmText: t('settingsVoice.byo.disconnectConfirm') },
              );
              if (!confirmed) return;
              setByo({ apiKey: null, agentId: null });
            })(), { tag: 'RealtimeElevenLabsSection.confirm.disconnect' });
          }}
        />
      </ItemGroup>
        </>
      )}
    </>
  );
}
