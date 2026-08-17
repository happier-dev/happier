import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { DEFAULT_AGENT_ID, getAgentCore, isAgentId } from '@/agents/catalog/catalog';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { getAgentDropdownMenuItems } from '@/components/settings/pickers/agentDropdownItems';
import { getModelDropdownMenuItems, REFRESH_MODELS_DROPDOWN_ITEM_ID } from '@/components/settings/pickers/modelDropdownItems';
import { renderDropdownItemIcon } from '@/components/settings/pickers/renderDropdownItemIcon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Modal } from '@/modal';
import {
  readLocalConversationVoiceSettings,
  voiceSettingsParse,
  writeLocalConversationVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { parseLocalVoiceSttSettings, parseLocalVoiceTtsSettings } from '@/voice/local/localVoiceSettings';
import { LocalVoiceSttGroup } from '@/voice/settings/panels/localStt/LocalVoiceSttGroup';
import { LocalVoiceTtsGroup } from '@/voice/settings/panels/localTts/LocalVoiceTtsGroup';
import {
  DaemonVoiceModelCatalogSection,
  type DaemonVoiceModelCatalogController,
} from '@/voice/settings/panels/modelCatalog/DaemonVoiceModelCatalogSection';
import type { VoiceDaemonRouteDiagnosticReason } from '@/voice/settings/voiceProviderLocalAvailability';
import { resetGlobalVoiceAgentPersistence } from '@/voice/agent/resetGlobalVoiceAgentPersistence';
import { canAgentResume } from '@/agents/runtime/resumeCapabilities';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useAllMachines } from '@/sync/store/hooks';
import { useSetting, useSettings } from '@/sync/domains/state/storage';
import { resolvePreferredMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import { resolveVoiceProviderIdFromSettings } from '@/voice/settings/resolveVoiceProviderId';
import { applyVoiceWelcomeSelection, resolveVoiceWelcomeSelection } from '@/voice/settings/welcome';
import { Icon } from '@/components/ui/icons/Icon';
import {
  completeLegacyVoiceOpenAiChatAgentSelection,
  LEGACY_VOICE_OPENAI_CHAT_COMPATIBLE_AGENT_ID,
} from '@/voice/adapters/localConversation/migrateLegacyOpenAiChatProvider';


export function LocalConversationSection(props: {
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
  daemonModelCatalog?: DaemonVoiceModelCatalogController;
  daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
  showProcessingDisclosure?: boolean;
}) {
  const { theme } = useUnistyles();
  const voiceAgentEnabled = useFeatureEnabled('voice.agent');
  const enabledAgentIds = useEnabledAgentIds();
  const settings = useSettings();
  const [openMenu, setOpenMenu] = React.useState<
    | null
    | 'conversationMode'
    | 'mediatorRootSessionPolicy'
    | 'mediatorAgentSource'
    | 'mediatorAgentId'
    | 'providerChatAgentSelection'
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

  const voice = voiceSettingsParse(props.voice);
  const cfg = readLocalConversationVoiceSettings(voice);
  const hasConfiguredProviderChat = cfg.agent.providerChat?.status === 'configured';
  const executionMachine = voice.executionMachine;
  const enabled = resolveVoiceProviderIdFromSettings(voice) === 'local_conversation';
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
        iconColor: theme.colors.text.secondary,
      }),
      {
        id: '__custom__',
        title: t('settingsVoice.local.modelCustomTitle'),
        subtitle: t('settingsVoice.local.conversation.customBackendIdSubtitle'),
        icon: renderDropdownItemIcon({
          name: 'pencil-simple',
          color: theme.colors.text.secondary,
        }),
      },
    ];
  }, [enabledAgentIds, theme.colors.text.secondary]);

  const selectedAgentIdForModelOptions = React.useMemo(() => {
    if (cfg.agent.agentSource !== 'agent') return null;
    const raw = String(cfg.agent.agentId ?? '').trim();
    if (!raw) return null;
    return isAgentId(raw as any) ? (raw as any) : null;
  }, [cfg.agent.agentId, cfg.agent.agentSource]);
  const effectiveAgentIdForModelOptions = selectedAgentIdForModelOptions ?? DEFAULT_AGENT_ID;

  const preflightMachineId = React.useMemo(() => {
    if (executionMachine.mode === 'fixed') {
      const machineId = String(executionMachine.machineId ?? '').trim();
      return machineId.length > 0 ? machineId : null;
    }

    return resolvePreferredMachineId({
      machines,
      recentMachinePaths: Array.isArray(recentMachinePaths) ? recentMachinePaths : [],
    });
  }, [executionMachine.machineId, executionMachine.mode, machines, recentMachinePaths]);

  const preflightModels = useNewSessionPreflightModelsState({
    backendTarget: hasConfiguredProviderChat
      ? null
      : { kind: 'backend', backendId: effectiveAgentIdForModelOptions },
    selectedMachineId: preflightMachineId,
    capabilityServerId: String(getActiveServerSnapshot().serverId ?? '').trim(),
  });

  const selectableModelMenuItems = React.useMemo(() => {
    return getModelDropdownMenuItems({
      modelOptions: preflightModels.modelOptions,
      iconColor: theme.colors.text.secondary,
      probe: {
        phase: preflightModels.probe.phase,
        onRefresh: preflightModels.probe.onRefresh,
      },
    });
  }, [preflightModels.modelOptions, preflightModels.probe.onRefresh, preflightModels.probe.phase, theme.colors.text.secondary]);

  const modelIdMenuItems = React.useMemo(() => {
    return [
      ...selectableModelMenuItems,
      {
        id: '__custom__',
        title: t('settingsVoice.local.modelCustomTitle'),
        subtitle: t('settingsVoice.local.modelCustomSubtitle'),
        icon: renderDropdownItemIcon({
          name: 'pencil-simple',
          color: theme.colors.text.secondary,
        }),
      },
    ];
  }, [selectableModelMenuItems, theme.colors.text.secondary]);

  const rootSessionPolicyItems = React.useMemo(() => {
    return [
      {
        id: 'single',
        title: t('settingsVoice.local.conversation.rootSessionPolicy.singleTitle'),
        subtitle: t('settingsVoice.local.conversation.rootSessionPolicy.singleSubtitle'),
        icon: <Icon name="radio-button" size={20} color={theme.colors.text.secondary} />,
      },
      {
        id: 'keep_warm',
        title: t('settingsVoice.local.conversation.rootSessionPolicy.keepWarmTitle'),
        subtitle: t('settingsVoice.local.conversation.rootSessionPolicy.keepWarmSubtitle'),
        icon: <Icon name="flame" size={20} color={theme.colors.text.secondary} />,
      },
    ] as const;
  }, [theme.colors.text.secondary]);

  const rootSessionPolicySelectedItem = React.useMemo(() => {
    const selectedId = cfg.agent.rootSessionPolicy === 'keep_warm' ? 'keep_warm' : 'single';
    return rootSessionPolicyItems.find((it) => it.id === selectedId) ?? rootSessionPolicyItems[0];
  }, [cfg.agent.rootSessionPolicy, rootSessionPolicyItems]);

  const providerResumeSupportedByAgent = React.useMemo(() => {
    if (!enabled) return true;
    if (cfg.agent.agentSource !== 'agent') return true;
    const agentId = String(cfg.agent.agentId ?? '').trim();
    if (!agentId) return false;
    return canAgentResume(agentId, { accountSettings: settings as any });
  }, [cfg.agent.agentId, cfg.agent.agentSource, enabled, settings]);

  if (!enabled) return null;

  const setCfg = (patch: Partial<typeof cfg>) => {
    props.setVoice(writeLocalConversationVoiceSettings(voice, { ...cfg, ...patch }));
  };

  const setAgent = (patch: Partial<typeof cfg.agent>) => setCfg({ agent: { ...cfg.agent, ...patch } });
  const setStreaming = (patch: Partial<typeof cfg.streaming>) => setCfg({ streaming: { ...cfg.streaming, ...patch } });

  const parsedStt = parseLocalVoiceSttSettings(cfg.stt);
  const parsedTts = parseLocalVoiceTtsSettings(cfg.tts);
  const sttProvider = parsedStt.provider;

  // Canonical per-kind default pack id. The daemon-local model catalog reuses the
  // existing local-neural `assetId` field as the selected-default selector rather
  // than introducing a parallel settings key.
  const selectedSttPackId = parsedStt.localNeural?.assetId ?? null;
  const selectedTtsPackId = parsedTts.localNeural?.assetId ?? null;

  const selectModelDefault = (kind: 'stt_sherpa' | 'tts_sherpa', packId: string) => {
    if (kind === 'stt_sherpa') {
      setCfg({ stt: { ...parsedStt, localNeural: { ...parsedStt.localNeural, assetId: packId } } });
      return;
    }
    setCfg({ tts: { ...parsedTts, localNeural: { ...parsedTts.localNeural, assetId: packId } } });
  };

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
              icon: <Icon name="chat-circle-dots" size={20} color={theme.colors.text.secondary} />,
            },
            {
              id: 'direct_session',
              title: t('settingsVoice.local.conversation.mode.directTitle'),
              subtitle: t('settingsVoice.local.conversation.mode.directSubtitle'),
              icon: <Icon name="paper-plane" size={20} color={theme.colors.text.secondary} />,
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
        voice={voice}
        setVoice={props.setVoice}
        popoverBoundaryRef={props.popoverBoundaryRef}
        daemonRouteDiagnosticReason={props.daemonRouteDiagnosticReason}
        showProcessingDisclosure={props.showProcessingDisclosure}
      />

      {sttProvider === 'device' ? (
        <ItemGroup title={t('settingsVoice.local.conversation.handsFree.title')}>
          <Item
            title={t('settingsVoice.local.conversation.handsFree.enableTitle')}
            rightElement={
              <Switch
                accessibilityLabel={t('settingsVoice.local.conversation.handsFree.enableTitle')}
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
        voice={voice}
        setVoice={props.setVoice}
        networkTimeoutMs={cfg.networkTimeoutMs}
        popoverBoundaryRef={props.popoverBoundaryRef}
        daemonRouteDiagnosticReason={props.daemonRouteDiagnosticReason}
        showProcessingDisclosure={props.showProcessingDisclosure}
      />

      <DaemonVoiceModelCatalogSection
        selectedSttPackId={selectedSttPackId}
        selectedTtsPackId={selectedTtsPackId}
        onSelectDefault={selectModelDefault}
        catalogController={props.daemonModelCatalog}
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
                  icon: <Icon name="lightning" size={20} color={theme.colors.text.secondary} />,
                },
                {
                  id: 'persistent',
                  title: t('settingsVoice.local.conversation.persistence.persistentTitle'),
                  subtitle: t('settingsVoice.local.conversation.persistence.persistentSubtitle'),
                  icon: <Icon name="infinity" size={20} color={theme.colors.text.secondary} />,
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
                      icon: <Icon name="clock" size={20} color={theme.colors.text.secondary} />,
                    },
                    {
                      id: 'provider_resume',
                      title: t('settingsVoice.local.conversation.resumability.providerResumeTitle'),
                      subtitle: !voiceAgentEnabled
                        ? t('settingsVoice.local.conversation.resumability.disabledVoiceAgent')
                        : cfg.agent.agentSource === 'agent' && !providerResumeSupportedByAgent
                            ? t('settingsVoice.local.conversation.resumability.disabledAgentNoProviderResume')
                            : t('settingsVoice.local.conversation.resumability.providerResumeSubtitle'),
                      disabled: !voiceAgentEnabled || (cfg.agent.agentSource === 'agent' && !providerResumeSupportedByAgent),
                      icon: <Icon name="arrow-clockwise" size={20} color={theme.colors.text.secondary} />,
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
                        accessibilityLabel={t('settingsVoice.local.conversation.providerResumeFallback.title')}
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
                      icon: <Icon name="chats-circle" size={20} color={theme.colors.text.secondary} />,
                    },
                    {
                      id: 'summary_plus_recent',
                      title: t('settingsSession.replayResume.strategy.summaryRecentTitle'),
                      subtitle: t('settingsSession.replayResume.strategy.summaryRecentSubtitle'),
                      icon: <Icon name="file-text" size={20} color={theme.colors.text.secondary} />,
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
                  accessibilityLabel={t('settingsVoice.local.conversation.prewarm.title')}
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
              selectedId={resolveVoiceWelcomeSelection(voice.welcome)}
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
                  icon: <Icon name="x" size={20} color={theme.colors.text.secondary} />,
                },
                {
                  id: 'immediate',
                  title: t('settingsVoice.local.conversation.welcome.immediateTitle'),
                  subtitle: t('settingsVoice.local.conversation.welcome.immediateSubtitle'),
                  icon: <Icon name="smiley" size={20} color={theme.colors.text.secondary} />,
                },
                {
                  id: 'on_first_turn',
                  title: t('settingsVoice.local.conversation.welcome.onFirstTurnTitle'),
                  subtitle: t('settingsVoice.local.conversation.welcome.onFirstTurnSubtitle'),
                  icon: <Icon name="chat" size={20} color={theme.colors.text.secondary} />,
                },
              ]}
              onSelect={(id) => {
                props.setVoice(applyVoiceWelcomeSelection(
                  voice,
                  id === 'on_first_turn' ? 'on_first_turn' : id === 'off' ? 'off' : 'immediate',
                ));
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
                  })(), { tag: 'LocalConversationSection.confirm.resetVoiceAgent' });
                  }}
                />
              ) : null}
            </ItemGroup>

            <ItemGroup title={t('settingsVoice.local.conversation.agentSettings.title')}>
              <Item
                title={t('settingsVoice.local.conversation.agentMachine.stayInVoiceHomeTitle')}
                subtitle={
                  cfg.agent.stayInVoiceHome
                    ? t('settingsVoice.local.conversation.agentMachine.stayInVoiceHomeEnabledSubtitle')
                    : t('settingsVoice.local.conversation.agentMachine.stayInVoiceHomeDisabledSubtitle')
                }
                rightElement={
                  <Switch
                    accessibilityLabel={t('settingsVoice.local.conversation.agentMachine.stayInVoiceHomeTitle')}
                    value={cfg.agent.stayInVoiceHome === true}
                    onValueChange={(v) => setAgent({ stayInVoiceHome: v })}
                  />
                }
                rightElementOutsidePressable
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
                    accessibilityLabel={t('settingsVoice.local.conversation.agentMachine.allowTeleportTitle')}
                    value={cfg.agent.teleportEnabled !== false}
                    onValueChange={(v) => setAgent({ teleportEnabled: v })}
                  />
                }
                rightElementOutsidePressable
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
        {cfg.agent.providerChat?.status === 'needs_selection' ? (
          <DropdownMenu
            open={openMenu === 'providerChatAgentSelection'}
            onOpenChange={(next) => setOpenMenu(next ? 'providerChatAgentSelection' : null)}
            variant="selectable"
            search={false}
            selectedId=""
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            popoverBoundaryRef={props.popoverBoundaryRef}
            itemTrigger={{
              title: t('settingsVoice.local.mediatorAgentId'),
              subtitleFormatter: () => t('settingsVoice.local.mediatorAgentIdSubtitle'),
            }}
            items={[{
              id: LEGACY_VOICE_OPENAI_CHAT_COMPATIBLE_AGENT_ID,
              title: t(getAgentCore(LEGACY_VOICE_OPENAI_CHAT_COMPATIBLE_AGENT_ID).displayNameKey),
              subtitle: t('settingsVoice.local.conversation.agentSource.fixedAgentSubtitle'),
              icon: <Icon name="person" size={20} color={theme.colors.text.secondary} />,
            }]}
            onSelect={(id) => {
              const providerChat = completeLegacyVoiceOpenAiChatAgentSelection(
                cfg.agent.providerChat as Extract<NonNullable<typeof cfg.agent.providerChat>, { status: 'needs_selection' }>,
                String(id),
              );
              if (!providerChat) return;
              setAgent({
                agentSource: 'agent',
                agentId: LEGACY_VOICE_OPENAI_CHAT_COMPATIBLE_AGENT_ID,
                providerChat,
              });
              setOpenMenu(null);
            }}
          />
        ) : null}
        {!hasConfiguredProviderChat ? (
          <>
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
              icon: <Icon name="arrows-left-right" size={20} color={theme.colors.text.secondary} />,
            },
            {
              id: 'agent',
              title: t('settingsVoice.local.conversation.agentSource.fixedAgentTitle'),
              subtitle: t('settingsVoice.local.conversation.agentSource.fixedAgentSubtitle'),
              icon: <Icon name="person" size={20} color={theme.colors.text.secondary} />,
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
          </>
        ) : null}
        <DropdownMenu
          open={openMenu === 'mediatorPermissionPolicy'}
          onOpenChange={(next) => setOpenMenu(next ? 'mediatorPermissionPolicy' : null)}
          variant="selectable"
          search={false}
          selectedId={cfg.agent.permissionIntent}
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
              id: 'default',
              title: t('agentInput.permissionMode.default'),
              subtitle: t('settingsActions.spawnPolicy.permissionCeiling.options.default.subtitle'),
              icon: <Icon name="eye" size={20} color={theme.colors.text.secondary} />,
            },
            {
              id: 'read-only',
              title: t('agentInput.permissionMode.readOnly'),
              subtitle: t('settingsActions.spawnPolicy.permissionCeiling.options.read-only.subtitle'),
              icon: <Icon name="hand" size={20} color={theme.colors.text.secondary} />,
            },
            {
              id: 'safe-yolo',
              title: t('agentInput.permissionMode.safeYolo'),
              subtitle: t('settingsActions.spawnPolicy.permissionCeiling.options.safe-yolo.subtitle'),
              icon: <Icon name="shield-check" size={20} color={theme.colors.text.secondary} />,
            },
            {
              id: 'yolo',
              title: t('agentInput.permissionMode.yolo'),
              subtitle: t('settingsActions.spawnPolicy.permissionCeiling.options.yolo.subtitle'),
              icon: <Icon name="lightning" size={20} color={theme.colors.text.secondary} />,
            },
          ]}
          onSelect={(id) => {
            setAgent({ permissionIntent: id as any });
            setOpenMenu(null);
          }}
        />

        {!hasConfiguredProviderChat ? (
          <>
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
              icon: <Icon name="stack-simple" size={20} color={theme.colors.text.secondary} />,
            },
            {
              id: 'custom',
              title: t('settingsVoice.local.mediatorChatModelSourceCustom'),
              subtitle: t('settingsVoice.local.conversation.chatModelSource.customSubtitle'),
              icon: <Icon name="sliders-horizontal" size={20} color={theme.colors.text.secondary} />,
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
                preflightModels.probe.onRefresh?.();
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
              icon: <Icon name="chat-circle-dots" size={20} color={theme.colors.text.secondary} />,
            },
            {
              id: 'session',
              title: t('settingsVoice.local.mediatorCommitModelSourceSession'),
              subtitle: t('settingsVoice.local.conversation.commitModelSource.sessionSubtitle'),
              icon: <Icon name="stack-simple" size={20} color={theme.colors.text.secondary} />,
            },
            {
              id: 'custom',
              title: t('settingsVoice.local.mediatorCommitModelSourceCustom'),
              subtitle: t('settingsVoice.local.conversation.commitModelSource.customSubtitle'),
              icon: <Icon name="sliders-horizontal" size={20} color={theme.colors.text.secondary} />,
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
                preflightModels.probe.onRefresh?.();
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
          </>
        ) : null}
        {voiceAgentEnabled ? (
          <Item
            title={t('settingsVoice.local.conversation.commitIsolation.title')}
            subtitle={t('settingsVoice.local.conversation.commitIsolation.subtitle')}
            rightElement={
              <Switch
                accessibilityLabel={t('settingsVoice.local.conversation.commitIsolation.title')}
                value={cfg.agent.commitIsolation === true}
                onValueChange={(v) => setAgent({ commitIsolation: v })}
              />
            }
            rightElementOutsidePressable
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
              icon: <Icon name="minus" size={20} color={theme.colors.text.secondary} />,
            },
            {
              id: 'balanced',
              title: t('settingsVoice.local.mediatorVerbosityBalanced'),
              subtitle: t('settingsVoice.local.conversation.verbosity.balancedSubtitle'),
              icon: <Icon name="list" size={20} color={theme.colors.text.secondary} />,
            },
          ]}
          onSelect={(id) => {
            setAgent({ verbosity: id as any });
            setOpenMenu(null);
          }}
        />
      </ItemGroup>

      <ItemGroup title={t('settingsVoice.local.conversation.streaming.title')}>
        <Item
          title={t('settingsVoice.local.conversation.streaming.enableTitle')}
          subtitle={t('settingsVoice.local.conversation.streaming.enableSubtitle')}
          rightElement={(
            <Switch
              accessibilityLabel={t('settingsVoice.local.conversation.streaming.enableTitle')}
              value={cfg.streaming.enabled}
              onValueChange={(v) => setStreaming({ enabled: v })}
            />
          )}
        />
        <Item
          title={t('settingsVoice.local.conversation.streaming.enableTtsTitle')}
          subtitle={t('settingsVoice.local.conversation.streaming.enableTtsSubtitle')}
          rightElement={(
            <Switch
              accessibilityLabel={t('settingsVoice.local.conversation.streaming.enableTtsTitle')}
              value={cfg.streaming.ttsEnabled}
              onValueChange={(v) => setStreaming({ ttsEnabled: v })}
            />
          )}
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
