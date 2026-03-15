import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { DEFAULT_AGENT_ID, getAgentCore, isAgentId } from '@/agents/catalog/catalog';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { getAgentDropdownMenuItems } from '@/components/settings/pickers/agentDropdownItems';
import { getModelDropdownMenuItems, REFRESH_MODELS_DROPDOWN_ITEM_ID } from '@/components/settings/pickers/modelDropdownItems';
import { getMachineDropdownMenuItems } from '@/components/settings/pickers/machineDropdownItems';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Modal } from '@/modal';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import type { SecretString } from '@/sync/encryption/secretSettings';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { LocalVoiceSttGroup } from '@/voice/settings/panels/localStt/LocalVoiceSttGroup';
import { LocalVoiceTtsGroup } from '@/voice/settings/panels/localTts/LocalVoiceTtsGroup';
import { resetGlobalVoiceAgentPersistence } from '@/voice/agent/resetGlobalVoiceAgentPersistence';
import { canAgentResume } from '@/agents/runtime/resumeCapabilities';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useAllMachines } from '@/sync/store/hooks';
import { useSetting } from '@/sync/domains/state/storage';
import { resolvePreferredMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';

function normalizeSecretStringPromptInput(value: string | null): SecretString | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? { _isSecretValue: true, value: trimmed } : null;
}

export function LocalConversationSection(props: {
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
}) {
  const { theme } = useUnistyles();
  const voiceAgentEnabled = useFeatureEnabled('voice.agent');
  const enabledAgentIds = useEnabledAgentIds();
  const [openMenu, setOpenMenu] = React.useState<
    | null
    | 'conversationMode'
    | 'mediatorBackend'
    | 'mediatorMachineTarget'
    | 'mediatorRootSessionPolicy'
    | 'mediatorAgentSource'
    | 'mediatorAgentId'
    | 'mediatorPermissionPolicy'
    | 'mediatorTranscriptPersistence'
    | 'mediatorResumabilityMode'
    | 'mediatorReplayStrategy'
    | 'mediatorWelcomeMode'
    | 'mediatorChatModelSource'
    | 'mediatorChatModelId'
    | 'mediatorCommitModelSource'
    | 'mediatorCommitModelId'
    | 'mediatorVerbosity'
  >(null);

  const cfg = props.voice.adapters.local_conversation;
  const enabled = props.voice.providerId === 'local_conversation';
  const machines = useAllMachines();
  const recentMachinePaths = useSetting('recentMachinePaths') as any[] | undefined;

  const selectedAgentIdForDropdown = React.useMemo(() => {
    const raw = String(cfg.agent.agentId ?? '').trim();
    return raw.length > 0 ? raw : null;
  }, [cfg.agent.agentId]);

  const selectedAgentIdLabel = React.useMemo(() => {
    const raw = String(cfg.agent.agentId ?? '').trim();
    if (!raw) return t('settingsVoice.local.notSet');
    if (isAgentId(raw as any)) return t(getAgentCore(raw as any).displayNameKey);
    return raw;
  }, [cfg.agent.agentId]);

  const agentIdMenuItems = React.useMemo(() => {
    return [
      ...getAgentDropdownMenuItems({
        agentIds: enabledAgentIds as any,
        iconColor: theme.colors.textSecondary,
      }),
      {
        id: '__custom__',
        title: t('settingsVoice.local.modelCustomTitle'),
        subtitle: t('settingsVoice.local.conversation.customBackendIdSubtitle'),
        icon: <Ionicons name="create-outline" size={22} color={theme.colors.textSecondary} />,
      },
    ];
  }, [enabledAgentIds, theme.colors.textSecondary]);

  const selectedAgentIdForModelOptions = React.useMemo(() => {
    if (cfg.agent.agentSource !== 'agent') return null;
    const raw = String(cfg.agent.agentId ?? '').trim();
    if (!raw) return null;
    return isAgentId(raw as any) ? (raw as any) : null;
  }, [cfg.agent.agentId, cfg.agent.agentSource]);

  const preflightMachineId = React.useMemo(() => {
    if (cfg.agent.machineTargetMode === 'fixed') {
      const machineId = String(cfg.agent.machineTargetId ?? '').trim();
      return machineId.length > 0 ? machineId : null;
    }

    return resolvePreferredMachineId({
      machines,
      recentMachinePaths: Array.isArray(recentMachinePaths) ? recentMachinePaths : [],
    });
  }, [cfg.agent.machineTargetId, cfg.agent.machineTargetMode, machines, recentMachinePaths]);

  const preflightModels = useNewSessionPreflightModelsState({
    agentType: (selectedAgentIdForModelOptions ?? DEFAULT_AGENT_ID) as any,
    selectedMachineId: preflightMachineId,
    capabilityServerId: String(getActiveServerSnapshot().serverId ?? '').trim(),
  });

  const selectableModelMenuItems = React.useMemo(() => {
    if (!selectedAgentIdForModelOptions) return [];
    return getModelDropdownMenuItems({
      modelOptions: preflightModels.modelOptions,
      iconColor: theme.colors.textSecondary,
      probe: {
        phase: preflightModels.probe.phase,
        onRefresh: preflightModels.probe.refresh,
      },
    });
  }, [preflightModels.modelOptions, preflightModels.probe.phase, preflightModels.probe.refresh, selectedAgentIdForModelOptions, theme.colors.textSecondary]);

  const modelIdMenuItems = React.useMemo(() => {
    return [
      ...selectableModelMenuItems,
      {
        id: '__custom__',
        title: t('settingsVoice.local.modelCustomTitle'),
        subtitle: t('settingsVoice.local.modelCustomSubtitle'),
        icon: <Ionicons name="create-outline" size={22} color={theme.colors.textSecondary} />,
      },
    ];
  }, [selectableModelMenuItems, theme.colors.textSecondary]);

  const machineTargetDropdownItems = React.useMemo(() => {
    return getMachineDropdownMenuItems({
      machines,
      iconColor: theme.colors.textSecondary,
      includeAuto: true,
      autoSubtitle: t('settingsVoice.local.conversation.machineAutoSubtitle'),
    });
  }, [machines, theme.colors.textSecondary]);

  const machineTargetSelectedId = React.useMemo(() => {
    if (cfg.agent.machineTargetMode === 'fixed') {
      const machineId = String(cfg.agent.machineTargetId ?? '').trim();
      if (machineId) return machineId;
    }
    return 'auto';
  }, [cfg.agent.machineTargetId, cfg.agent.machineTargetMode]);

  const machineTargetSelectedItem = React.useMemo(() => {
    return machineTargetDropdownItems.find((it) => it.id === machineTargetSelectedId) ?? machineTargetDropdownItems[0] ?? null;
  }, [machineTargetDropdownItems, machineTargetSelectedId]);

  const rootSessionPolicyItems = React.useMemo(() => {
    return [
      {
        id: 'single',
        title: t('settingsVoice.local.conversation.rootSessionPolicy.singleTitle'),
        subtitle: t('settingsVoice.local.conversation.rootSessionPolicy.singleSubtitle'),
        icon: <Ionicons name="radio-button-on-outline" size={22} color={theme.colors.textSecondary} />,
      },
      {
        id: 'keep_warm',
        title: t('settingsVoice.local.conversation.rootSessionPolicy.keepWarmTitle'),
        subtitle: t('settingsVoice.local.conversation.rootSessionPolicy.keepWarmSubtitle'),
        icon: <Ionicons name="flame-outline" size={22} color={theme.colors.textSecondary} />,
      },
    ] as const;
  }, [theme.colors.textSecondary]);

  const rootSessionPolicySelectedItem = React.useMemo(() => {
    const selectedId = cfg.agent.rootSessionPolicy === 'keep_warm' ? 'keep_warm' : 'single';
    return rootSessionPolicyItems.find((it) => it.id === selectedId) ?? rootSessionPolicyItems[0];
  }, [cfg.agent.rootSessionPolicy, rootSessionPolicyItems]);

  const providerResumeSupportedByAgent = React.useMemo(() => {
    if (!enabled) return true;
    if (cfg.agent.agentSource !== 'agent') return true;
    const agentId = String(cfg.agent.agentId ?? '').trim();
    if (!agentId) return false;
    return canAgentResume(agentId);
  }, [cfg.agent.agentId, cfg.agent.agentSource, enabled]);

  if (!enabled) return null;

  const setCfg = (patch: Partial<typeof cfg>) => {
    props.setVoice({
      ...props.voice,
      adapters: {
        ...props.voice.adapters,
        local_conversation: { ...cfg, ...patch },
      },
    });
  };

  const setAgent = (patch: Partial<typeof cfg.agent>) => setCfg({ agent: { ...cfg.agent, ...patch } });
  const setStreaming = (patch: Partial<typeof cfg.streaming>) => setCfg({ streaming: { ...cfg.streaming, ...patch } });

  const sttProvider =
    typeof (cfg.stt as any)?.provider === 'string'
      ? ((cfg.stt as any).provider as any)
      : (cfg.stt as any)?.useDeviceStt === true
        ? 'device'
        : 'openai_compat';

  return (
    <>
      <ItemGroup title={t('settingsVoice.local.title')} footer={t('settingsVoice.local.footer')}>
        <DropdownMenu
          open={openMenu === 'conversationMode'}
          onOpenChange={(next) => setOpenMenu(next ? 'conversationMode' : null)}
          variant="selectable"
          search={false}
          selectedId={cfg.conversationMode}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{
            title: t('settingsVoice.local.conversationMode'),
          }}
          items={[
            {
              id: 'agent',
              title: t('settingsFeatures.expVoiceAgent'),
              subtitle: t('settingsVoice.local.conversation.mode.voiceAgentSubtitle'),
              icon: <Ionicons name="chatbubble-ellipses-outline" size={22} color={theme.colors.textSecondary} />,
            },
            {
              id: 'direct_session',
              title: t('settingsVoice.local.conversation.mode.directTitle'),
              subtitle: t('settingsVoice.local.conversation.mode.directSubtitle'),
              icon: <Ionicons name="paper-plane-outline" size={22} color={theme.colors.textSecondary} />,
            },
          ]}
          onSelect={(id) => {
            setCfg({ conversationMode: id as any });
            setOpenMenu(null);
          }}
        />
      </ItemGroup>

      <LocalVoiceSttGroup
        cfgStt={cfg.stt}
        setStt={(next) => setCfg({ stt: next })}
        popoverBoundaryRef={props.popoverBoundaryRef}
      />

      {sttProvider === 'device' ? (
        <ItemGroup title={t('settingsVoice.local.conversation.handsFree.title')}>
          <Item
            title={t('settingsVoice.local.conversation.handsFree.enableTitle')}
            rightElement={
              <Switch
                value={cfg.handsFree.enabled}
                onValueChange={(v) => setCfg({ handsFree: { ...cfg.handsFree, enabled: v } })}
              />
            }
          />
          <Item
            title={t('settingsVoice.local.conversation.handsFree.silenceTitle')}
            detail={String(cfg.handsFree.endpointing.silenceMs)}
            onPress={() => {
              fireAndForget((async () => {
                const raw = await Modal.prompt(t('settingsVoice.local.conversation.handsFree.silenceTitle'), undefined, {
                  inputType: 'numeric',
                  placeholder: String(cfg.handsFree.endpointing.silenceMs),
                });
                if (raw === null) return;
                const next = Number(String(raw).trim());
                if (!Number.isFinite(next)) return;
                setCfg({
                  handsFree: {
                    ...cfg.handsFree,
                    endpointing: {
                      ...cfg.handsFree.endpointing,
                      silenceMs: Math.max(0, Math.min(5000, Math.floor(next))),
                    },
                  },
                });
              })(), { tag: 'LocalConversationSection.prompt.handsFree.silenceMs' });
            }}
          />
          <Item
            title={t('settingsVoice.local.conversation.handsFree.minSpeechTitle')}
            detail={String(cfg.handsFree.endpointing.minSpeechMs)}
            onPress={() => {
              fireAndForget((async () => {
                const raw = await Modal.prompt(t('settingsVoice.local.conversation.handsFree.minSpeechTitle'), undefined, {
                  inputType: 'numeric',
                  placeholder: String(cfg.handsFree.endpointing.minSpeechMs),
                });
                if (raw === null) return;
                const next = Number(String(raw).trim());
                if (!Number.isFinite(next)) return;
                setCfg({
                  handsFree: {
                    ...cfg.handsFree,
                    endpointing: {
                      ...cfg.handsFree.endpointing,
                      minSpeechMs: Math.max(0, Math.min(5000, Math.floor(next))),
                    },
                  },
                });
              })(), { tag: 'LocalConversationSection.prompt.handsFree.minSpeechMs' });
            }}
          />
        </ItemGroup>
      ) : null}

      <LocalVoiceTtsGroup
        cfgTts={cfg.tts}
        setTts={(next) => setCfg({ tts: next })}
        networkTimeoutMs={cfg.networkTimeoutMs}
        popoverBoundaryRef={props.popoverBoundaryRef}
      />

      {cfg.conversationMode === 'agent' ? (
        <>
          <ItemGroup title={t('settingsFeatures.expVoiceAgent')}>
            <DropdownMenu
              open={openMenu === 'mediatorTranscriptPersistence'}
              onOpenChange={(next) => setOpenMenu(next ? 'mediatorTranscriptPersistence' : null)}
              variant="selectable"
              search={false}
              selectedId={cfg.agent.transcript?.persistenceMode ?? 'ephemeral'}
              showCategoryTitles={false}
              matchTriggerWidth={true}
              connectToTrigger={true}
              rowKind="item"
              popoverBoundaryRef={props.popoverBoundaryRef}
              itemTrigger={{
                title: t('settingsVoice.local.conversation.persistence.title'),
              }}
              items={[
                {
                  id: 'ephemeral',
                  title: t('settingsVoice.local.conversation.persistence.ephemeralTitle'),
                  subtitle: t('settingsVoice.local.conversation.persistence.ephemeralSubtitle'),
                  icon: <Ionicons name="flash-outline" size={22} color={theme.colors.textSecondary} />,
                },
                {
                  id: 'persistent',
                  title: t('settingsVoice.local.conversation.persistence.persistentTitle'),
                  subtitle: t('settingsVoice.local.conversation.persistence.persistentSubtitle'),
                  icon: <Ionicons name="infinite-outline" size={22} color={theme.colors.textSecondary} />,
                },
              ]}
              onSelect={(id) => {
                setAgent({ transcript: { ...(cfg.agent.transcript ?? {}), persistenceMode: id as any } });
                setOpenMenu(null);
              }}
            />

            {(cfg.agent.transcript?.persistenceMode ?? 'ephemeral') === 'persistent' ? (
              <>
                <DropdownMenu
                  open={openMenu === 'mediatorResumabilityMode'}
                  onOpenChange={(next) => setOpenMenu(next ? 'mediatorResumabilityMode' : null)}
                  variant="selectable"
                  search={false}
                  selectedId={cfg.agent.resumabilityMode ?? 'replay'}
                  showCategoryTitles={false}
                  matchTriggerWidth={true}
                  connectToTrigger={true}
                  rowKind="item"
                  popoverBoundaryRef={props.popoverBoundaryRef}
                  itemTrigger={{
                    title: t('settingsVoice.local.conversation.resumability.modeTitle'),
                    subtitleFormatter: () => {
                      const mode = cfg.agent.resumabilityMode ?? 'replay';
                      if (mode !== 'provider_resume') return t('settingsVoice.local.conversation.resumability.replaySubtitle');
                      if (!voiceAgentEnabled) return t('settingsVoice.local.conversation.resumability.disabledVoiceAgent');
                      if (cfg.agent.backend !== 'daemon') return t('settingsVoice.local.conversation.resumability.disabledDaemonBackend');
                      if (cfg.agent.agentSource === 'agent' && !providerResumeSupportedByAgent) return t('settingsVoice.local.conversation.resumability.disabledAgentNoProviderResume');
                      return t('settingsVoice.local.conversation.resumability.providerResumeSubtitle');
                    },
                    detailFormatter: () => ((cfg.agent.resumabilityMode ?? 'replay') === 'provider_resume'
                      ? t('settingsVoice.local.conversation.resumability.providerResumeTitle')
                      : t('settingsVoice.local.conversation.resumability.replayTitle')),
                  }}
                  items={[
                    {
                      id: 'replay',
                      title: t('settingsVoice.local.conversation.resumability.replayTitle'),
                      subtitle: t('settingsVoice.local.conversation.resumability.replaySubtitle'),
                      icon: <Ionicons name="time-outline" size={22} color={theme.colors.textSecondary} />,
                    },
                    {
                      id: 'provider_resume',
                      title: t('settingsVoice.local.conversation.resumability.providerResumeTitle'),
                      subtitle: !voiceAgentEnabled
                        ? t('settingsVoice.local.conversation.resumability.disabledVoiceAgent')
                        : cfg.agent.backend !== 'daemon'
                          ? t('settingsVoice.local.conversation.resumability.disabledDaemonBackend')
                          : cfg.agent.agentSource === 'agent' && !providerResumeSupportedByAgent
                            ? t('settingsVoice.local.conversation.resumability.disabledAgentNoProviderResume')
                            : t('settingsVoice.local.conversation.resumability.providerResumeSubtitle'),
                      disabled: !voiceAgentEnabled || cfg.agent.backend !== 'daemon' || (cfg.agent.agentSource === 'agent' && !providerResumeSupportedByAgent),
                      icon: <Ionicons name="refresh-outline" size={22} color={theme.colors.textSecondary} />,
                    },
                  ]}
                  onSelect={(id) => {
                    setAgent({ resumabilityMode: id as any });
                    setOpenMenu(null);
                  }}
                />

                {(cfg.agent.resumabilityMode ?? 'replay') === 'provider_resume' ? (
                  <Item
                    title={t('settingsVoice.local.conversation.providerResumeFallback.title')}
                    subtitle={t('settingsVoice.local.conversation.providerResumeFallback.subtitle')}
                    rightElement={
                      <Switch
                        value={cfg.agent.providerResume?.fallbackToReplay !== false}
                        onValueChange={(v) => setAgent({ providerResume: { ...(cfg.agent.providerResume ?? {}), fallbackToReplay: v } })}
                      />
                    }
                  />
                ) : null}

                <DropdownMenu
                  open={openMenu === 'mediatorReplayStrategy'}
                  onOpenChange={(next) => setOpenMenu(next ? 'mediatorReplayStrategy' : null)}
                  variant="selectable"
                  search={false}
                  selectedId={cfg.agent.replay?.strategy ?? 'recent_messages'}
                  showCategoryTitles={false}
                  matchTriggerWidth={true}
                  connectToTrigger={true}
                  rowKind="item"
                  popoverBoundaryRef={props.popoverBoundaryRef}
                  itemTrigger={{
                    title: t('settingsSession.replayResume.strategyTitle'),
                  }}
                  items={[
                    {
                      id: 'recent_messages',
                      title: t('settingsSession.replayResume.strategy.recentTitle'),
                      subtitle: t('settingsSession.replayResume.strategy.recentSubtitle'),
                      icon: <Ionicons name="chatbubbles-outline" size={22} color={theme.colors.textSecondary} />,
                    },
                    {
                      id: 'summary_plus_recent',
                      title: t('settingsSession.replayResume.strategy.summaryRecentTitle'),
                      subtitle: t('settingsSession.replayResume.strategy.summaryRecentSubtitle'),
                      icon: <Ionicons name="document-text-outline" size={22} color={theme.colors.textSecondary} />,
                    },
                  ]}
                  onSelect={(id) => {
                    setAgent({ replay: { ...(cfg.agent.replay ?? {}), strategy: id as any } });
                    setOpenMenu(null);
                  }}
                />

                <Item
                  title={t('settingsSession.replayResume.recentMessagesTitle')}
                  detail={String(cfg.agent.replay?.recentMessagesCount ?? 16)}
                  onPress={() => {
                    fireAndForget((async () => {
                      const raw = await Modal.prompt(
                        t('settingsSession.replayResume.recentMessagesTitle'),
                        t('settingsVoice.local.conversation.replayRecentMessagesPromptBody'),
                        {
                        inputType: 'numeric',
                        placeholder: String(cfg.agent.replay?.recentMessagesCount ?? 16),
                        }
                      );
                      if (raw === null) return;
                      const next = Number(String(raw).trim());
                      if (!Number.isFinite(next)) return;
                      setAgent({ replay: { ...(cfg.agent.replay ?? {}), recentMessagesCount: Math.max(1, Math.min(100, Math.floor(next))) } });
                    })(), { tag: 'LocalConversationSection.prompt.replay.recentMessagesCount' });
                  }}
                />
              </>
            ) : null}

            <Item
              title={t('settingsVoice.local.conversation.prewarm.title')}
              subtitle={t('settingsVoice.local.conversation.prewarm.subtitle')}
              rightElement={
                <Switch
                  value={cfg.agent.prewarmOnConnect === true}
                  onValueChange={(v) => setAgent({ prewarmOnConnect: v })}
                />
              }
            />

            <DropdownMenu
              open={openMenu === 'mediatorWelcomeMode'}
              onOpenChange={(next) => setOpenMenu(next ? 'mediatorWelcomeMode' : null)}
              variant="selectable"
              search={false}
              selectedId={cfg.agent.welcome?.enabled ? (cfg.agent.welcome?.mode ?? 'immediate') : 'off'}
              showCategoryTitles={false}
              matchTriggerWidth={true}
              connectToTrigger={true}
              rowKind="item"
              popoverBoundaryRef={props.popoverBoundaryRef}
              itemTrigger={{
                title: t('settingsVoice.local.conversation.welcome.title'),
              }}
              items={[
                {
                  id: 'off',
                  title: t('settingsVoice.local.conversation.welcome.offTitle'),
                  subtitle: t('settingsVoice.local.conversation.welcome.offSubtitle'),
                  icon: <Ionicons name="close-outline" size={22} color={theme.colors.textSecondary} />,
                },
                {
                  id: 'immediate',
                  title: t('settingsVoice.local.conversation.welcome.immediateTitle'),
                  subtitle: t('settingsVoice.local.conversation.welcome.immediateSubtitle'),
                  icon: <Ionicons name="happy-outline" size={22} color={theme.colors.textSecondary} />,
                },
                {
                  id: 'on_first_turn',
                  title: t('settingsVoice.local.conversation.welcome.onFirstTurnTitle'),
                  subtitle: t('settingsVoice.local.conversation.welcome.onFirstTurnSubtitle'),
                  icon: <Ionicons name="chatbox-outline" size={22} color={theme.colors.textSecondary} />,
                },
              ]}
              onSelect={(id) => {
                if (id === 'off') {
                  setAgent({ welcome: { ...(cfg.agent.welcome ?? {}), enabled: false } });
                } else {
                  setAgent({ welcome: { ...(cfg.agent.welcome ?? {}), enabled: true, mode: id as any } });
                }
                setOpenMenu(null);
              }}
            />

              {(cfg.agent.transcript?.persistenceMode ?? 'ephemeral') === 'persistent' ? (
                <Item
                  title={t('settingsVoice.local.conversation.resetVoiceAgent.title')}
                  subtitle={t('settingsVoice.local.conversation.resetVoiceAgent.subtitle')}
                  destructive
                onPress={() => {
                  fireAndForget((async () => {
                    const confirmed = await Modal.confirm(
                      t('settingsVoice.local.conversation.resetVoiceAgent.title'),
                      t('settingsVoice.local.conversation.resetVoiceAgent.confirmBody'),
                      { confirmText: t('common.reset') },
                    );
                    if (!confirmed) return;
                    await resetGlobalVoiceAgentPersistence();
                    const epochRaw = Number(cfg.agent.transcript?.epoch ?? 0);
                    const epoch = Number.isFinite(epochRaw) && epochRaw >= 0 ? Math.floor(epochRaw) : 0;
                    setAgent({ transcript: { ...(cfg.agent.transcript ?? {}), epoch: epoch + 1 } });
                  })(), { tag: 'LocalConversationSection.confirm.resetVoiceAgent' });
                  }}
                />
              ) : null}
            </ItemGroup>

            <ItemGroup title={t('settingsVoice.local.conversation.agentSettings.title')}>
              <DropdownMenu
                open={openMenu === 'mediatorBackend'}
                onOpenChange={(next) => setOpenMenu(next ? 'mediatorBackend' : null)}
                variant="selectable"
                search={false}
                selectedId={cfg.agent.backend}
                showCategoryTitles={false}
              matchTriggerWidth={true}
              connectToTrigger={true}
              rowKind="item"
              popoverBoundaryRef={props.popoverBoundaryRef}
              itemTrigger={{
                title: t('settingsVoice.local.mediatorBackend'),
                subtitleFormatter: () => {
                  if (cfg.agent.backend !== 'daemon') return t('settingsVoice.local.conversation.backend.openAiSubtitle');
                  return voiceAgentEnabled
                    ? t('settingsVoice.local.conversation.backend.daemonSubtitle')
                    : t('settingsVoice.local.conversation.resumability.disabledVoiceAgent');
                },
                detailFormatter: () => (cfg.agent.backend === 'daemon'
                  ? t('settingsVoice.local.mediatorBackendDaemon')
                  : t('settingsVoice.local.mediatorBackendOpenAi')),
              }}
              items={[
                {
                  id: 'daemon',
                  title: t('settingsVoice.local.mediatorBackendDaemon'),
                    subtitle: voiceAgentEnabled
                      ? t('settingsVoice.local.conversation.backend.daemonSubtitle')
                      : t('settingsVoice.local.conversation.resumability.disabledVoiceAgent'),
                    icon: <Ionicons name="server-outline" size={22} color={theme.colors.textSecondary} />,
                    disabled: !voiceAgentEnabled,
                  },
                  {
                    id: 'openai_compat',
                    title: t('settingsVoice.local.mediatorBackendOpenAi'),
                    subtitle: t('settingsVoice.local.conversation.backend.openAiSubtitle'),
                    icon: <Ionicons name="cloud-outline" size={22} color={theme.colors.textSecondary} />,
                  },
                ]}
                onSelect={(id) => {
                  setAgent({ backend: id as any });
                  setOpenMenu(null);
                }}
              />

              <DropdownMenu
                open={openMenu === 'mediatorMachineTarget'}
                onOpenChange={(next) => setOpenMenu(next ? 'mediatorMachineTarget' : null)}
                variant="selectable"
                search={false}
                selectedId={machineTargetSelectedId}
                showCategoryTitles={false}
                matchTriggerWidth={true}
                connectToTrigger={true}
                rowKind="item"
                popoverBoundaryRef={props.popoverBoundaryRef}
                itemTrigger={{
                  title: t('settingsVoice.local.conversation.agentMachine.title'),
                  subtitleFormatter: () => (machineTargetSelectedItem?.subtitle ?? t('settingsVoice.local.conversation.agentMachine.fallbackSubtitle')),
                  detailFormatter: () => (machineTargetSelectedItem?.title ?? machineTargetSelectedId),
                }}
                items={machineTargetDropdownItems}
                onSelect={(id) => {
                  if (id === 'auto') {
                    setAgent({ machineTargetMode: 'auto', machineTargetId: null });
                    setOpenMenu(null);
                    return;
                  }
                  const machineId = String(id ?? '').trim();
                  if (!machineId) return;
                  setAgent({ machineTargetMode: 'fixed', machineTargetId: machineId });
                  setOpenMenu(null);
                }}
              />

              <Item
                title={t('settingsVoice.local.conversation.agentMachine.stayInVoiceHomeTitle')}
                subtitle={
                  cfg.agent.stayInVoiceHome
                    ? t('settingsVoice.local.conversation.agentMachine.stayInVoiceHomeEnabledSubtitle')
                    : t('settingsVoice.local.conversation.agentMachine.stayInVoiceHomeDisabledSubtitle')
                }
                rightElement={
                  <Switch
                    value={cfg.agent.stayInVoiceHome === true}
                    onValueChange={(v) => setAgent({ stayInVoiceHome: v })}
                  />
                }
                onPress={() => setAgent({ stayInVoiceHome: cfg.agent.stayInVoiceHome !== true })}
                showChevron={false}
                selected={false}
              />

              <Item
                title={t('settingsVoice.local.conversation.agentMachine.allowTeleportTitle')}
                subtitle={
                  cfg.agent.teleportEnabled === false
                    ? t('settingsVoice.local.conversation.agentMachine.teleportDisabledSubtitle')
                    : t('settingsVoice.local.conversation.agentMachine.teleportEnabledSubtitle')
                }
                rightElement={
                  <Switch
                    value={cfg.agent.teleportEnabled !== false}
                    onValueChange={(v) => setAgent({ teleportEnabled: v })}
                  />
                }
                onPress={() => setAgent({ teleportEnabled: cfg.agent.teleportEnabled === false })}
                showChevron={false}
                selected={false}
              />

              <DropdownMenu
                open={openMenu === 'mediatorRootSessionPolicy'}
                onOpenChange={(next) => setOpenMenu(next ? 'mediatorRootSessionPolicy' : null)}
                variant="selectable"
                search={false}
                selectedId={cfg.agent.rootSessionPolicy ?? 'single'}
                showCategoryTitles={false}
                matchTriggerWidth={true}
                connectToTrigger={true}
                rowKind="item"
                popoverBoundaryRef={props.popoverBoundaryRef}
                itemTrigger={{
                  title: t('settingsVoice.local.conversation.rootSessionPolicy.title'),
                  subtitleFormatter: () => (rootSessionPolicySelectedItem?.subtitle ?? t('settingsVoice.local.conversation.rootSessionPolicy.fallbackSubtitle')),
                  detailFormatter: () => (rootSessionPolicySelectedItem?.title ?? t('settingsVoice.local.conversation.rootSessionPolicy.singleTitle')),
                }}
                items={rootSessionPolicyItems as any}
                onSelect={(id) => {
                  setAgent({ rootSessionPolicy: id as any });
                  setOpenMenu(null);
                }}
              />

              {cfg.agent.rootSessionPolicy === 'keep_warm' ? (
                <Item
                  title={t('settingsVoice.local.conversation.rootSessionPolicy.maxWarmRootsTitle')}
                  subtitle={t('settingsVoice.local.conversation.rootSessionPolicy.maxWarmRootsSubtitle')}
                  detail={String(cfg.agent.maxWarmRoots ?? 3)}
                  onPress={() => {
                    fireAndForget((async () => {
                      const raw = await Modal.prompt(t('settingsVoice.local.conversation.rootSessionPolicy.maxWarmRootsTitle'), undefined, {
                        inputType: 'numeric',
                        placeholder: String(cfg.agent.maxWarmRoots ?? 3),
                      });
                      if (raw === null) return;
                      const next = Number(String(raw).trim());
                      if (!Number.isFinite(next)) return;
                      const clamped = Math.max(1, Math.min(10, Math.floor(next)));
                      setAgent({ maxWarmRoots: clamped });
                    })(), { tag: 'LocalConversationSection.prompt.maxWarmRoots' });
                  }}
                />
              ) : null}
        <DropdownMenu
          open={openMenu === 'mediatorAgentSource'}
          onOpenChange={(next) => setOpenMenu(next ? 'mediatorAgentSource' : null)}
          variant="selectable"
          search={false}
          selectedId={cfg.agent.agentSource}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
            popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{
            title: t('settingsVoice.local.mediatorAgentSource'),
            subtitleFormatter: () => (cfg.agent.agentSource === 'session'
              ? t('settingsVoice.local.conversation.agentSource.followSessionSubtitle')
              : t('settingsVoice.local.conversation.agentSource.fixedAgentSubtitle')),
          }}
          items={[
            {
              id: 'session',
              title: t('settingsVoice.local.conversation.agentSource.followSessionTitle'),
              subtitle: t('settingsVoice.local.conversation.agentSource.followSessionSubtitle'),
              icon: <Ionicons name="swap-horizontal-outline" size={22} color={theme.colors.textSecondary} />,
            },
            {
              id: 'agent',
              title: t('settingsVoice.local.conversation.agentSource.fixedAgentTitle'),
              subtitle: t('settingsVoice.local.conversation.agentSource.fixedAgentSubtitle'),
              icon: <Ionicons name="person-outline" size={22} color={theme.colors.textSecondary} />,
            },
          ]}
          onSelect={(id) => {
            setAgent({ agentSource: id as any });
            setOpenMenu(null);
          }}
        />
        {cfg.agent.agentSource === 'agent' ? (
          <DropdownMenu
            open={openMenu === 'mediatorAgentId'}
            onOpenChange={(next) => setOpenMenu(next ? 'mediatorAgentId' : null)}
            variant="selectable"
            search={true}
            searchPlaceholder={t('settingsVoice.local.conversation.searchBackendsPlaceholder')}
            selectedId={selectedAgentIdForDropdown ?? ''}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            popoverBoundaryRef={props.popoverBoundaryRef}
            itemTrigger={{
              title: t('settingsVoice.local.mediatorAgentId'),
              subtitleFormatter: () => (agentIdMenuItems.find((it) => it.id === (selectedAgentIdForDropdown ?? ''))?.subtitle ?? t('settingsVoice.local.mediatorAgentIdSubtitle')),
              detailFormatter: () => selectedAgentIdLabel,
            }}
            items={agentIdMenuItems}
            onSelect={(id) => {
              if (id === '__custom__') {
                setOpenMenu(null);
                fireAndForget((async () => {
                  const raw = await Modal.prompt(
                    t('settingsVoice.local.mediatorAgentId'),
                    t('settingsVoice.local.mediatorAgentIdSubtitle'),
                    { placeholder: String(cfg.agent.agentId) },
                  );
                  if (raw === null) return;
                  const next = String(raw).trim();
                  if (!next) return;
                  setAgent({ agentId: next });
                })(), { tag: 'LocalConversationSection.prompt.agentId' });
                return;
              }

              const next = String(id ?? '').trim();
              if (!next) return;
              setAgent({ agentId: next });
              setOpenMenu(null);
            }}
          />
        ) : null}
        <DropdownMenu
          open={openMenu === 'mediatorPermissionPolicy'}
          onOpenChange={(next) => setOpenMenu(next ? 'mediatorPermissionPolicy' : null)}
          variant="selectable"
          search={false}
          selectedId={cfg.agent.permissionPolicy}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{
            title: t('settingsVoice.local.mediatorPermissionPolicy'),
          }}
          items={[
            {
              id: 'read_only',
              title: t('settingsVoice.local.mediatorPermissionReadOnly'),
              subtitle: t('settingsVoice.local.conversation.permissionPolicy.readOnlySubtitle'),
              icon: <Ionicons name="eye-outline" size={22} color={theme.colors.textSecondary} />,
            },
            {
              id: 'no_tools',
              title: t('settingsVoice.local.mediatorPermissionNoTools'),
              subtitle: t('settingsVoice.local.conversation.permissionPolicy.noToolsSubtitle'),
              icon: <Ionicons name="hand-left-outline" size={22} color={theme.colors.textSecondary} />,
            },
          ]}
          onSelect={(id) => {
            setAgent({ permissionPolicy: id as any });
            setOpenMenu(null);
          }}
        />

        <DropdownMenu
          open={openMenu === 'mediatorChatModelSource'}
          onOpenChange={(next) => setOpenMenu(next ? 'mediatorChatModelSource' : null)}
          variant="selectable"
          search={false}
          selectedId={cfg.agent.chatModelSource}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{
            title: t('settingsVoice.local.mediatorChatModelSource'),
          }}
          items={[
            {
              id: 'session',
              title: t('settingsVoice.local.mediatorChatModelSourceSession'),
              subtitle: t('settingsVoice.local.conversation.chatModelSource.sessionSubtitle'),
              icon: <Ionicons name="layers-outline" size={22} color={theme.colors.textSecondary} />,
            },
            {
              id: 'custom',
              title: t('settingsVoice.local.mediatorChatModelSourceCustom'),
              subtitle: t('settingsVoice.local.conversation.chatModelSource.customSubtitle'),
              icon: <Ionicons name="options-outline" size={22} color={theme.colors.textSecondary} />,
            },
          ]}
          onSelect={(id) => {
            setAgent({ chatModelSource: id as any });
            setOpenMenu(null);
          }}
        />
        {cfg.agent.chatModelSource === 'custom' ? (
          <DropdownMenu
            open={openMenu === 'mediatorChatModelId'}
            onOpenChange={(next) => setOpenMenu(next ? 'mediatorChatModelId' : null)}
            variant="selectable"
            search={true}
            searchPlaceholder={t('settingsVoice.local.conversation.searchModelsPlaceholder')}
            selectedId={String(cfg.agent.chatModelId ?? '').trim()}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
              popoverBoundaryRef={props.popoverBoundaryRef}
              itemTrigger={{
                title: t('settingsVoice.local.conversation.chatModelId.title'),
                subtitleFormatter: () => (
                  modelIdMenuItems.find((it) => it.id === String(cfg.agent.chatModelId ?? '').trim())?.subtitle
                  ?? t('settingsVoice.local.conversation.chatModelId.subtitle')
                ),
                detailFormatter: () => (
                  modelIdMenuItems.find((it) => it.id === String(cfg.agent.chatModelId ?? '').trim())?.title
                  ?? String(cfg.agent.chatModelId)
                ),
              }}
            items={modelIdMenuItems}
            onSelect={(id) => {
              if (id === REFRESH_MODELS_DROPDOWN_ITEM_ID) {
                preflightModels.probe.refresh();
                setOpenMenu(null);
                return;
              }
              if (id === '__custom__') {
                setOpenMenu(null);
                fireAndForget((async () => {
                  const raw = await Modal.prompt(
                    t('settingsVoice.local.conversation.chatModelId.title'),
                    t('settingsVoice.local.conversation.chatModelId.subtitle'),
                    { placeholder: String(cfg.agent.chatModelId) },
                  );
                  if (raw === null) return;
                  const next = String(raw).trim();
                  if (!next) return;
                  setAgent({ chatModelId: next });
                })(), { tag: 'LocalConversationSection.prompt.chatModelId' });
                return;
              }

              const next = String(id ?? '').trim();
              if (!next) return;
              setAgent({ chatModelId: next });
              setOpenMenu(null);
            }}
          />
        ) : null}
        <DropdownMenu
          open={openMenu === 'mediatorCommitModelSource'}
          onOpenChange={(next) => setOpenMenu(next ? 'mediatorCommitModelSource' : null)}
          variant="selectable"
          search={false}
          selectedId={cfg.agent.commitModelSource}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{
            title: t('settingsVoice.local.mediatorCommitModelSource'),
          }}
          items={[
            {
              id: 'chat',
              title: t('settingsVoice.local.mediatorCommitModelSourceChat'),
              subtitle: t('settingsVoice.local.conversation.commitModelSource.chatSubtitle'),
              icon: <Ionicons name="chatbubble-ellipses-outline" size={22} color={theme.colors.textSecondary} />,
            },
            {
              id: 'session',
              title: t('settingsVoice.local.mediatorCommitModelSourceSession'),
              subtitle: t('settingsVoice.local.conversation.commitModelSource.sessionSubtitle'),
              icon: <Ionicons name="layers-outline" size={22} color={theme.colors.textSecondary} />,
            },
            {
              id: 'custom',
              title: t('settingsVoice.local.mediatorCommitModelSourceCustom'),
              subtitle: t('settingsVoice.local.conversation.commitModelSource.customSubtitle'),
              icon: <Ionicons name="options-outline" size={22} color={theme.colors.textSecondary} />,
            },
          ]}
          onSelect={(id) => {
            setAgent({ commitModelSource: id as any });
            setOpenMenu(null);
          }}
        />
        {cfg.agent.commitModelSource === 'custom' ? (
          <DropdownMenu
            open={openMenu === 'mediatorCommitModelId'}
            onOpenChange={(next) => setOpenMenu(next ? 'mediatorCommitModelId' : null)}
            variant="selectable"
            search={true}
            searchPlaceholder={t('settingsVoice.local.conversation.searchModelsPlaceholder')}
            selectedId={String(cfg.agent.commitModelId ?? '').trim()}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
              popoverBoundaryRef={props.popoverBoundaryRef}
              itemTrigger={{
                title: t('settingsVoice.local.conversation.commitModelId.title'),
                subtitleFormatter: () => (
                  modelIdMenuItems.find((it) => it.id === String(cfg.agent.commitModelId ?? '').trim())?.subtitle
                  ?? t('settingsVoice.local.conversation.commitModelId.subtitle')
                ),
                detailFormatter: () => (
                  modelIdMenuItems.find((it) => it.id === String(cfg.agent.commitModelId ?? '').trim())?.title
                  ?? String(cfg.agent.commitModelId)
                ),
              }}
            items={modelIdMenuItems}
            onSelect={(id) => {
              if (id === REFRESH_MODELS_DROPDOWN_ITEM_ID) {
                preflightModels.probe.refresh();
                setOpenMenu(null);
                return;
              }
              if (id === '__custom__') {
                setOpenMenu(null);
                fireAndForget((async () => {
                  const raw = await Modal.prompt(
                    t('settingsVoice.local.conversation.commitModelId.title'),
                    t('settingsVoice.local.conversation.commitModelId.subtitle'),
                    { placeholder: String(cfg.agent.commitModelId) },
                  );
                  if (raw === null) return;
                  const next = String(raw).trim();
                  if (!next) return;
                  setAgent({ commitModelId: next });
                })(), { tag: 'LocalConversationSection.prompt.commitModelId' });
                return;
              }

              const next = String(id ?? '').trim();
              if (!next) return;
              setAgent({ commitModelId: next });
              setOpenMenu(null);
            }}
          />
        ) : null}
        {cfg.agent.backend === 'daemon' && voiceAgentEnabled ? (
          <Item
            title={t('settingsVoice.local.conversation.commitIsolation.title')}
            subtitle={t('settingsVoice.local.conversation.commitIsolation.subtitle')}
            rightElement={
              <Switch
                value={cfg.agent.commitIsolation === true}
                onValueChange={(v) => setAgent({ commitIsolation: v })}
              />
            }
            onPress={() => {
              setAgent({ commitIsolation: cfg.agent.commitIsolation !== true });
            }}
            showChevron={false}
            selected={false}
          />
        ) : null}
        <Item
          title={t('settingsVoice.local.mediatorIdleTtl')}
          detail={String(cfg.agent.idleTtlSeconds)}
          onPress={() => {
            fireAndForget((async () => {
              const raw = await Modal.prompt(t('settingsVoice.local.mediatorIdleTtlTitle'), t('settingsVoice.local.mediatorIdleTtlDescription'), {
                inputType: 'numeric',
                placeholder: String(cfg.agent.idleTtlSeconds),
              });
              if (raw === null) return;
              const next = Number(String(raw).trim());
              if (!Number.isFinite(next)) return;
              setAgent({ idleTtlSeconds: Math.max(60, Math.min(21600, Math.floor(next))) });
            })(), { tag: 'LocalConversationSection.prompt.idleTtlSeconds' });
          }}
        />
        <DropdownMenu
          open={openMenu === 'mediatorVerbosity'}
          onOpenChange={(next) => setOpenMenu(next ? 'mediatorVerbosity' : null)}
          variant="selectable"
          search={false}
          selectedId={cfg.agent.verbosity}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{
            title: t('settingsVoice.local.mediatorVerbosity'),
          }}
          items={[
            {
              id: 'short',
              title: t('settingsVoice.local.mediatorVerbosityShort'),
              subtitle: t('settingsVoice.local.conversation.verbosity.shortSubtitle'),
              icon: <Ionicons name="remove-outline" size={22} color={theme.colors.textSecondary} />,
            },
            {
              id: 'balanced',
              title: t('settingsVoice.local.mediatorVerbosityBalanced'),
              subtitle: t('settingsVoice.local.conversation.verbosity.balancedSubtitle'),
              icon: <Ionicons name="reorder-two-outline" size={22} color={theme.colors.textSecondary} />,
            },
          ]}
          onSelect={(id) => {
            setAgent({ verbosity: id as any });
            setOpenMenu(null);
          }}
        />
      </ItemGroup>

      {cfg.agent.backend === 'openai_compat' ? (
        <ItemGroup title={t('settingsVoice.local.mediatorBackendOpenAi')}>
          <Item
            title={t('settingsVoice.local.chatBaseUrl')}
            detail={cfg.agent.openaiCompat.chatBaseUrl ? String(cfg.agent.openaiCompat.chatBaseUrl) : t('settingsVoice.local.notSet')}
            onPress={() => {
              fireAndForget((async () => {
                const raw = await Modal.prompt(
                  t('settingsVoice.local.chatBaseUrlTitle'),
                  t('settingsVoice.local.chatBaseUrlDescription'),
                  { placeholder: cfg.agent.openaiCompat.chatBaseUrl ?? '' },
                );
                if (raw === null) return;
                setAgent({
                  openaiCompat: { ...cfg.agent.openaiCompat, chatBaseUrl: String(raw).trim() || null },
                });
              })(), { tag: 'LocalConversationSection.prompt.openaiCompat.chatBaseUrl' });
            }}
          />
          <Item
            title={t('settingsVoice.local.chatApiKey')}
            detail={cfg.agent.openaiCompat.chatApiKey ? t('settingsVoice.local.apiKeySet') : t('settingsVoice.local.notSet')}
            onPress={() => {
              fireAndForget((async () => {
                const raw = await Modal.prompt(
                  t('settingsVoice.local.chatApiKeyTitle'),
                  t('settingsVoice.local.chatApiKeyDescription'),
                  {
                    inputType: 'secure-text',
                  },
                );
                if (raw === null) return;
                setAgent({
                  openaiCompat: { ...cfg.agent.openaiCompat, chatApiKey: normalizeSecretStringPromptInput(raw) },
                });
              })(), { tag: 'LocalConversationSection.prompt.openaiCompat.chatApiKey' });
            }}
          />
          <Item
            title={t('settingsVoice.local.chatModel')}
            detail={String(cfg.agent.openaiCompat.chatModel)}
            onPress={() => {
              fireAndForget((async () => {
                const raw = await Modal.prompt(t('settingsVoice.local.chatModelTitle'), t('settingsVoice.local.chatModelDescription'), {
                  placeholder: String(cfg.agent.openaiCompat.chatModel),
                });
                if (raw === null) return;
                const next = String(raw).trim();
                if (!next) return;
                setAgent({ openaiCompat: { ...cfg.agent.openaiCompat, chatModel: next } });
              })(), { tag: 'LocalConversationSection.prompt.openaiCompat.chatModel' });
            }}
          />
          <Item
            title={t('settingsVoice.local.commitModel')}
            detail={String(cfg.agent.openaiCompat.commitModel)}
            onPress={() => {
              fireAndForget((async () => {
                const raw = await Modal.prompt(t('settingsVoice.local.commitModelTitle'), t('settingsVoice.local.commitModelDescription'), {
                  placeholder: String(cfg.agent.openaiCompat.commitModel),
                });
                if (raw === null) return;
                const next = String(raw).trim();
                if (!next) return;
                setAgent({ openaiCompat: { ...cfg.agent.openaiCompat, commitModel: next } });
              })(), { tag: 'LocalConversationSection.prompt.openaiCompat.commitModel' });
            }}
          />
          <Item
            title={t('settingsVoice.local.chatTemperature')}
            detail={String(cfg.agent.openaiCompat.temperature)}
            onPress={() => {
              fireAndForget((async () => {
                const raw = await Modal.prompt(t('settingsVoice.local.chatTemperatureTitle'), t('settingsVoice.local.chatTemperatureDescription'), {
                  placeholder: String(cfg.agent.openaiCompat.temperature),
                });
                if (raw === null) return;
                const next = Number(String(raw).trim());
                if (!Number.isFinite(next)) return;
                setAgent({ openaiCompat: { ...cfg.agent.openaiCompat, temperature: Math.max(0, Math.min(2, next)) } });
              })(), { tag: 'LocalConversationSection.prompt.openaiCompat.temperature' });
            }}
          />
          <Item
            title={t('settingsVoice.local.chatMaxTokens')}
            detail={
              cfg.agent.openaiCompat.maxTokens == null
                ? t('settingsVoice.local.chatMaxTokensUnlimited')
                : String(cfg.agent.openaiCompat.maxTokens)
            }
            onPress={() => {
              fireAndForget((async () => {
                const raw = await Modal.prompt(t('settingsVoice.local.chatMaxTokensTitle'), t('settingsVoice.local.chatMaxTokensDescription'), {
                  placeholder: cfg.agent.openaiCompat.maxTokens == null ? '' : String(cfg.agent.openaiCompat.maxTokens),
                });
                if (raw === null) return;
                const trimmed = String(raw).trim();
                if (!trimmed) {
                  setAgent({ openaiCompat: { ...cfg.agent.openaiCompat, maxTokens: null } });
                  return;
                }
                const next = Number(trimmed);
                if (!Number.isFinite(next)) return;
                setAgent({ openaiCompat: { ...cfg.agent.openaiCompat, maxTokens: Math.max(1, Math.floor(next)) } });
              })(), { tag: 'LocalConversationSection.prompt.openaiCompat.maxTokens' });
            }}
          />
        </ItemGroup>
      ) : null}

      <ItemGroup title={t('settingsVoice.local.conversation.streaming.title')}>
        <Item
          title={t('settingsVoice.local.conversation.streaming.enableTitle')}
          rightElement={<Switch value={cfg.streaming.enabled} onValueChange={(v) => setStreaming({ enabled: v })} />}
        />
        <Item
          title={t('settingsVoice.local.conversation.streaming.enableTtsTitle')}
          rightElement={<Switch value={cfg.streaming.ttsEnabled} onValueChange={(v) => setStreaming({ ttsEnabled: v })} />}
        />
        <Item
          title={t('settingsVoice.local.conversation.streaming.ttsChunkCharsTitle')}
          detail={String(cfg.streaming.ttsChunkChars)}
          onPress={() => {
            fireAndForget((async () => {
              const raw = await Modal.prompt(
                t('settingsVoice.local.conversation.streaming.ttsChunkCharsTitle'),
                t('settingsVoice.local.conversation.streaming.ttsChunkCharsPromptBody'),
                { inputType: 'numeric', placeholder: String(cfg.streaming.ttsChunkChars) },
              );
              if (raw === null) return;
              const next = Number(String(raw).trim());
              if (!Number.isFinite(next)) return;
              setStreaming({ ttsChunkChars: Math.max(32, Math.min(2000, Math.floor(next))) });
            })(), { tag: 'LocalConversationSection.prompt.streaming.ttsChunkChars' });
          }}
        />
      </ItemGroup>
        </>
      ) : null}

      <ItemGroup title={t('settingsVoice.local.conversation.network.title')}>
        <Item
          title={t('settingsVoice.local.conversation.network.timeoutTitle')}
          detail={String(cfg.networkTimeoutMs)}
          onPress={() => {
            fireAndForget((async () => {
              const raw = await Modal.prompt(
                t('settingsVoice.local.conversation.network.timeoutTitle'),
                t('settingsVoice.local.conversation.network.timeoutPromptBody'),
                {
                inputType: 'numeric',
                placeholder: String(cfg.networkTimeoutMs),
                }
              );
              if (raw === null) return;
              const next = Number(String(raw).trim());
              if (!Number.isFinite(next)) return;
              setCfg({ networkTimeoutMs: Math.max(1000, Math.min(60000, Math.floor(next))) });
            })(), { tag: 'LocalConversationSection.prompt.networkTimeoutMs' });
          }}
        />
      </ItemGroup>
    </>
  );
}
