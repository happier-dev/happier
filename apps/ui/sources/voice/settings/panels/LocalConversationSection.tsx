import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { useUnistyles } from 'react-native-unistyles';

import { DEFAULT_AGENT_ID, isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { getResolvedAgentCatalogEntries, resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { getModelDropdownMenuItems, REFRESH_MODELS_DROPDOWN_ITEM_ID } from '@/components/settings/pickers/modelDropdownItems';
import { renderDropdownItemIcon } from '@/components/settings/pickers/renderDropdownItemIcon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { SettingAnchor, SettingRow, useSettingRevealRequested } from '@/components/settings/shell/SettingRow';
import { VOICE_CONVERSATIONS_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import {
  readLocalConversationVoiceSettings,
  voiceSettingsParse,
  writeLocalConversationVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { parseLocalVoiceTtsSettings } from '@/voice/local/localVoiceSettings';
import { LocalVoiceSttGroup } from '@/voice/settings/panels/localStt/LocalVoiceSttGroup';
import { VoiceHearControls } from '@/voice/settings/panels/VoiceHearControls';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { resolveVoiceSttCapturePlan } from '@/voice/runtime/input/resolveVoiceSttCapturePlan';
import { LocalVoiceTtsGroup } from '@/voice/settings/panels/localTts/LocalVoiceTtsGroup';
import type { VoiceDaemonRouteDiagnosticReason } from '@/voice/settings/voiceProviderLocalAvailability';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { resolveFeatureAvailabilityArm } from '@/hooks/server/resolveFeatureAvailabilityArm';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useSettingsSelector } from '@/sync/domains/state/storage';
import { useAcpCatalog } from '@/sync/store/useAcpCatalog';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import { resolveVoiceProviderIdFromSettings } from '@/voice/settings/resolveVoiceProviderId';
import { applyVoiceWelcomeSelection, resolveVoiceWelcomeSelection } from '@/voice/settings/welcome';
import { VoiceGreetingItem } from '@/voice/settings/panels/VoiceGreetingItem';
import { applyVoiceAgentSelection } from '@/voice/settings/voiceAgentSelection';
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Modal } from '@/modal';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { backendTargetKeysMatch } from '@/agents/backendCatalog/backendTargetKeyV2';
import { resolveVoiceAgentCatalogSelectionV1, voiceAgentCatalogSelectionValueV1 } from '@happier-dev/protocol/voice/settings/voiceAgentSelection';
import { Icon } from '@/components/ui/icons/Icon';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import {
  LEGACY_VOICE_OPENAI_CHAT_COMPATIBLE_AGENT_ID,
  importLegacyVoiceOpenAiChatProvider,
} from '@/voice/adapters/localConversation/migrateLegacyOpenAiChatProvider';


/** The rows inside "Advanced agent behaviour": search opening one of them opens the disclosure. */
const ADVANCED_AGENT_SETTINGS = [
  VOICE_CONVERSATIONS_SETTINGS.settings.rootSessionPolicy,
  VOICE_CONVERSATIONS_SETTINGS.settings.maxWarmRoots,
  VOICE_CONVERSATIONS_SETTINGS.settings.idleTtlSeconds,
  VOICE_CONVERSATIONS_SETTINGS.settings.prewarmOnConnect,
  VOICE_CONVERSATIONS_SETTINGS.settings.teleportEnabled,
  VOICE_CONVERSATIONS_SETTINGS.settings.stayInVoiceHome,
  VOICE_CONVERSATIONS_SETTINGS.settings.commitModelSource,
  VOICE_CONVERSATIONS_SETTINGS.settings.commitModelId,
  VOICE_CONVERSATIONS_SETTINGS.settings.commitIsolation,
  VOICE_CONVERSATIONS_SETTINGS.settings.streamingEnabled,
  VOICE_CONVERSATIONS_SETTINGS.settings.streamingTtsEnabled,
  VOICE_CONVERSATIONS_SETTINGS.settings.ttsChunkChars,
] as const;

export function LocalConversationSection(props: {
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
  daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
}) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const voiceAgentDecision = useFeatureDecision('voice.agent');
  const voiceAgentEnabled = voiceAgentDecision?.state === 'enabled';
  const voiceAgentAvailability = resolveFeatureAvailabilityArm(voiceAgentDecision);
  const missingFeature = voiceAgentDecision?.diagnostics.includes('dependency:execution.runs:disabled')
    ? t('settingsFeatures.expExecutionRuns')
    : voiceAgentDecision?.diagnostics.includes('dependency:voice:disabled')
      ? t('settingsFeatures.voice') : t('settingsFeatures.expVoiceAgent');
  const voiceAgentUnavailableReason = voiceAgentEnabled ? undefined
    : voiceAgentAvailability === 'policy_disabled'
      ? t('settingsVoice.pages.conversations.agentFeatureRequired', { feature: missingFeature })
      : voiceAgentAvailability === 'server_disabled'
        ? t('voice.readiness.server_feature_disabled')
        : t('voice.readiness.runtime_unknown');
  const enabledAgentIds = useEnabledAgentIds();
  const { snapshot: acpCatalog } = useAcpCatalog();
  const settings = useSettingsSelector((settings) => ({
      backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
  }));
  // "Custom…" in a model or agent menu opens an inline field under that menu, not a prompt.
  const [advancedAgentExpanded, setAdvancedAgentExpanded] = React.useState(false);
  const [customEntry, setCustomEntry] = React.useState<null | 'agentId' | 'chatModelId' | 'commitModelId'>(null);
  const [openMenu, setOpenMenu] = React.useState<
    | null
    | 'mediatorAgentId'
    | 'providerChatAgentSelection'
    | 'mediatorChatModelId'
    | 'mediatorCommitModelId'
  >(null);

  const voice = voiceSettingsParse(props.voice);
  const cfg = readLocalConversationVoiceSettings(voice);
  const hasConfiguredProviderChat = cfg.agent.providerChat?.status === 'configured';
  const executionMachine = useVoiceExecutionMachinePresentation();
  const enabled = resolveVoiceProviderIdFromSettings(voice) === 'local_conversation';
  const customAgentRequested = useSettingRevealRequested([VOICE_CONVERSATIONS_SETTINGS.settings.customAgent]);
  const customChatModelRequested = useSettingRevealRequested([VOICE_CONVERSATIONS_SETTINGS.settings.chatModelId]);
  const customCommitModelRequested = useSettingRevealRequested([VOICE_CONVERSATIONS_SETTINGS.settings.commitModelId]);
  React.useEffect(() => {
    if (customAgentRequested && enabled && cfg.conversationMode === 'agent'
      && !hasConfiguredProviderChat && cfg.agent.agentSource === 'agent') {
      setCustomEntry('agentId');
    }
  }, [customAgentRequested, enabled, cfg.conversationMode, hasConfiguredProviderChat, cfg.agent.agentSource]);
  React.useEffect(() => {
    if (!enabled || cfg.conversationMode !== 'agent' || hasConfiguredProviderChat) return;
    if (customChatModelRequested && cfg.agent.chatModelSource === 'custom') setCustomEntry('chatModelId');
    if (customCommitModelRequested && cfg.agent.commitModelSource === 'custom') setCustomEntry('commitModelId');
  }, [customChatModelRequested, customCommitModelRequested, enabled, cfg.conversationMode,
    hasConfiguredProviderChat, cfg.agent.chatModelSource, cfg.agent.commitModelSource]);

  // The configured voice Agent may be any installed Agent, bundled or plugin-contributed, so its
  // id goes to the model preflight as-is. Narrowing to the bundled ids here would preflight the
  // default Agent's catalog and offer models the selected Agent cannot run.
  const selectedAgentIdForModelOptions = React.useMemo(() => {
    if (cfg.agent.agentSource !== 'agent') return null;
    const raw = String(cfg.agent.agentId ?? '').trim();
    return raw.length > 0 ? raw : null;
  }, [cfg.agent.agentId, cfg.agent.agentSource]);
  const effectiveAgentIdForModelOptions = selectedAgentIdForModelOptions ?? DEFAULT_AGENT_ID;

  const preflightMachineId = executionMachine.machineId;

  const capabilityServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
  const voiceSettingsScope = useAccountSettingsScope();
  const voiceSettingsScopeKey = voiceSettingsScope ? `${voiceSettingsScope.serverId}:${voiceSettingsScope.accountId}` : 'unavailable';
  const legacyChatOrigin = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    const origin = new AbortController();
    legacyChatOrigin.current = origin;
    return () => {
      origin.abort();
      if (legacyChatOrigin.current === origin) legacyChatOrigin.current = null;
    };
  }, [voiceSettingsScopeKey]);
  const legacyChatApproval = useActionApprovalContinuation({
    scopeKey: voiceSettingsScopeKey,
    serverId: voiceSettingsScope?.serverId ?? '',
    onExecuted: () => {},
  });
  const importedChatModels = useProviderModelProjection({
    enabled: Boolean(voiceSettingsScope) && cfg.agent.providerChat?.status === 'needs_selection',
    machineId: preflightMachineId,
    serverId: voiceSettingsScope?.serverId ?? null,
    agentTargetKey: buildAgentUniverseBackendTargetKey(LEGACY_VOICE_OPENAI_CHAT_COMPATIBLE_AGENT_ID),
    mode: 'picker',
  });
  const currentVoiceRef = React.useRef(props.voice);
  currentVoiceRef.current = props.voice;
  const daemonMergedProjection = useDaemonMergedProjectionInputs({
    machineId: preflightMachineId,
    serverId: capabilityServerId,
    enabled: Boolean(preflightMachineId),
  });
  const currentDaemonProjectionInputs = daemonMergedProjection.phase === 'ready'
    ? daemonMergedProjection.inputs
    : null;
  const enabledBuiltInAgentIds = React.useMemo(
    () => new Set<string>(enabledAgentIds),
    [enabledAgentIds],
  );
  const resolvedAgentEntries = React.useMemo(() => getResolvedAgentCatalogEntries({
    enabledAgentIds,
    acpCatalogSnapshot: acpCatalog?.catalog,
    backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
    mergedProviderProjectionById: currentDaemonProjectionInputs?.mergedProviderProjectionById ?? null,
    mergedBackendProjectionById: currentDaemonProjectionInputs?.mergedBackendProjectionById ?? null,
  }).filter((entry) => (
    entry.isBuiltIn
      ? enabledBuiltInAgentIds.has(entry.agentId)
      : entry.enabled !== false
  )), [
    currentDaemonProjectionInputs?.mergedBackendProjectionById,
    currentDaemonProjectionInputs?.mergedProviderProjectionById,
    enabledBuiltInAgentIds,
    enabledAgentIds,
    acpCatalog?.catalog,
    settings.backendEnabledByTargetKey,
  ]);
  const selectedAgentEntry = React.useMemo(() => cfg.agent.agentTargetKey
    ? resolvedAgentEntries.find((entry) => backendTargetKeysMatch(entry.backendTargetKey, cfg.agent.agentTargetKey!))
    : resolveVoiceAgentCatalogSelectionV1(resolvedAgentEntries, cfg.agent.agentId),
  [cfg.agent.agentId, cfg.agent.agentTargetKey, resolvedAgentEntries]);
  const selectedAgentIdForDropdown = selectedAgentEntry
    ? voiceAgentCatalogSelectionValueV1(selectedAgentEntry)
    : String(cfg.agent.agentId ?? '').trim() || null;
  const selectedAgentIdLabel = React.useMemo(() => {
    const raw = String(cfg.agent.agentId ?? '').trim();
    if (!raw) return t('settingsVoice.local.notSet');
    if (selectedAgentEntry) return selectedAgentEntry.title;
    if (isBundledAgentId(raw)) return resolveAgentCatalogTitle(raw);
    return raw;
  }, [cfg.agent.agentId, selectedAgentEntry]);
  const agentIdMenuItems = React.useMemo(() => [
    ...resolvedAgentEntries.map((entry) => ({
      id: voiceAgentCatalogSelectionValueV1(entry),
      title: entry.title,
      subtitle: entry.subtitle ?? entry.qualifiedId,
      icon: (
        <AgentCatalogIdentityIcon
          entry={entry}
          machineId={preflightMachineId}
          serverId={capabilityServerId || null}
          current={daemonMergedProjection.phase === 'ready'}
          size={22}
        />
      ),
    })),
    {
      id: '__custom__',
      title: t('settingsVoice.local.modelCustomTitle'),
      subtitle: t('settingsVoice.local.conversation.customBackendIdSubtitle'),
      icon: renderDropdownItemIcon({
        name: 'pencil-simple',
        color: theme.colors.text.secondary,
      }),
    },
  ], [
    capabilityServerId,
    daemonMergedProjection.phase,
    preflightMachineId,
    resolvedAgentEntries,
    theme.colors.text.secondary,
  ]);

  const preflightModels = useNewSessionPreflightModelsState({
    backendTarget: hasConfiguredProviderChat
      ? null
      : { kind: 'backend', backendId: effectiveAgentIdForModelOptions },
    // This id is an Agent id, not a backend id, so name it as the runtime carrier:
    // a non-bundled backend id alone leaves the preflight with no Agent to probe.
    runtimeCarrierAgentId: effectiveAgentIdForModelOptions as AgentId,
    selectedMachineId: preflightMachineId,
    capabilityServerId,
    enabled: Boolean(preflightMachineId),
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

  const rootSessionPolicyOptions = React.useMemo(() => [
    {
      id: 'single' as const,
      label: t('settingsVoice.local.conversation.rootSessionPolicy.singleTitle'),
      description: t('settingsVoice.local.conversation.rootSessionPolicy.singleSubtitle'),
    },
    {
      id: 'keep_warm' as const,
      label: t('settingsVoice.local.conversation.rootSessionPolicy.keepWarmTitle'),
      description: t('settingsVoice.local.conversation.rootSessionPolicy.keepWarmSubtitle'),
    },
  ], []);


  if (!enabled) return null;

  const setCfg = (patch: Partial<typeof cfg>) => {
    props.setVoice(writeLocalConversationVoiceSettings(voice, { ...cfg, ...patch }));
  };

  const setAgent = (patch: Partial<typeof cfg.agent>) => setCfg({ agent: { ...cfg.agent, ...patch } });
  const setStreaming = (patch: Partial<typeof cfg.streaming>) => setCfg({ streaming: { ...cfg.streaming, ...patch } });


  return (
    <>
      <LocalVoiceSttGroup
        cfgStt={cfg.stt}
        setStt={(next) => setCfg({ stt: next })}
        voice={voice}
        setVoice={props.setVoice}
        popoverBoundaryRef={props.popoverBoundaryRef}
        daemonRouteDiagnosticReason={props.daemonRouteDiagnosticReason}
      >
        <VoiceHearControls
          handsFree={cfg.handsFree}
          handsFreeSupported={resolveVoiceSttCapturePlan({ voice }).provider !== 'recorded_audio'}
          setHandsFree={(handsFree) => setCfg({ handsFree })}
          bargeInEnabled={parseLocalVoiceTtsSettings(cfg.tts).bargeInEnabled}
          setBargeInEnabled={(bargeInEnabled) => setCfg({ tts: { ...parseLocalVoiceTtsSettings(cfg.tts), bargeInEnabled } })}
          testIDPrefix="settings.voice.local"
        />
      </LocalVoiceSttGroup>

      <ItemGroup
        title={t('settingsVoice.pages.conversations.thinkTitle')}
        description={t('settingsVoice.pages.conversations.thinkDescription')}
      >
        <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.conversationMode}>
        <>
        <SegmentedChoiceItem
          title={t(VOICE_CONVERSATIONS_SETTINGS.settings.conversationMode.titleKey)}
          subtitleLines={0}
          testIDPrefix="settings.voice.local.conversationMode"
          value={cfg.conversationMode}
          onChange={(next) => {
            if (next === 'agent' && !voiceAgentEnabled) return;
            setCfg({ conversationMode: next });
          }}
          options={[
            { id: 'direct_session', label: t('settingsVoice.pages.conversations.talkToSession'), description: t('settingsVoice.pages.conversations.talkToSessionDescription') },
            { id: 'agent', label: t('settingsVoice.pages.conversations.talkToAgent'), description: t('settingsVoice.pages.conversations.talkToAgentDescription'), unavailableReason: voiceAgentUnavailableReason },
          ]}
        />
        {voiceAgentAvailability === 'policy_disabled' ? <Item
          title={t('settingsFeatures.expVoiceAgent')}
          subtitle={voiceAgentUnavailableReason}
          subtitleLines={0}
          showChevron={false}
          accessoryLayout="adaptive"
          rightElementOutsidePressable
          rightElement={<RoundButton title={t('settingsVoice.pages.conversations.turnOnVoiceAgent')}
            testID="settings.voice.local.turnOnVoiceAgent" display="secondary" size="small"
            onPress={() => router.push(SETTINGS_ROUTES.features)} />}
        /> : null}
        </>
        </SettingAnchor>
      {cfg.conversationMode === 'agent' ? (
        <>
        {cfg.agent.providerChat?.status === 'needs_selection'
          || (cfg.agent.providerChat?.status === 'migration_required'
            && cfg.agent.providerChat.reason === 'provider_catalog_import_required') ? (
          <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.agent}>
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
              title: resolveAgentCatalogTitle(LEGACY_VOICE_OPENAI_CHAT_COMPATIBLE_AGENT_ID),
              subtitle: t('settingsVoice.local.conversation.agentSource.fixedAgentSubtitle'),
              icon: <Icon name="person" size={20} color={theme.colors.text.secondary} />,
            }]}
            onSelect={(id) => {
              const capturedVoice = props.voice;
              const origin = legacyChatOrigin.current;
              fireAndForget((async () => {
                if (cfg.agent.providerChat?.status === 'migration_required') {
                  if (!voiceSettingsScope || String(id) !== LEGACY_VOICE_OPENAI_CHAT_COMPATIBLE_AGENT_ID) return;
                  if (!origin || origin.signal.aborted || legacyChatApproval.approvalPending) return;
                  const imported = await importLegacyVoiceOpenAiChatProvider(voiceSettingsScope, {
                    onApprovalPending: legacyChatApproval.requestApproval,
                    signal: origin.signal,
                  });
                  if (origin.signal.aborted) return;
                  if (imported.status !== 'applied' && imported.status !== 'unchanged') throw new Error('voice_chat_import_failed');
                  setOpenMenu(null);
                  return;
                }
                const projection = await importedChatModels.refreshWithResult(false);
                if (currentVoiceRef.current !== capturedVoice || projection?.status !== 'success') return;
                const nextVoice = applyVoiceAgentSelection(voice, {
                  kind: 'legacy_provider_chat', agentId: String(id), modelProjection: projection,
                });
                if (nextVoice === voice) return;
                props.setVoice(nextVoice);
                setOpenMenu(null);
              })(), { tag: 'Voice imported Chat Agent selection', logError: false,
                onError: () => { if (!origin?.signal.aborted) Modal.alert(t('common.error'), t('common.saveError')); } });
            }}
          />
          </SettingAnchor>
        ) : null}
        {!hasConfiguredProviderChat ? (
          <>
        <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.agentSource}>
        <SegmentedChoiceItem
          title={t(VOICE_CONVERSATIONS_SETTINGS.settings.agentSource.titleKey)}
          subtitleLines={0}
          testIDPrefix="settings.voice.local.mediatorAgentSource"
          value={cfg.agent.agentSource}
          onChange={(next) => setAgent({ agentSource: next })}
          options={[
            { id: 'session', label: t('settingsVoice.local.conversation.agentSource.followSessionTitle'), description: t('settingsVoice.local.conversation.agentSource.followSessionSubtitle') },
            { id: 'agent', label: t('settingsVoice.local.conversation.agentSource.fixedAgentTitle'), description: t('settingsVoice.local.conversation.agentSource.fixedAgentSubtitle') },
          ]}
        />
        </SettingAnchor>
        {cfg.agent.agentSource === 'agent' ? (
          <>
          <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.agent}>
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
                setCustomEntry('agentId');
                return;
              }

              const next = String(id ?? '').trim();
              const entry = resolveVoiceAgentCatalogSelectionV1(resolvedAgentEntries, next);
              if (!entry) return;
              props.setVoice(applyVoiceAgentSelection(voice, { kind: 'catalog', entry }));
              setOpenMenu(null);
            }}
          />
          </SettingAnchor>
          {customEntry === 'agentId' ? (
            <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.customAgent}>
            <FieldValueItem
              title={t('settingsVoice.local.mediatorAgentId')}
              subtitle={t('settingsVoice.local.mediatorAgentIdSubtitle')}
              fieldTestID="settings.voice.local.agentId.custom.field"
              monospace
              autoFocus
              value={String(cfg.agent.agentId ?? '')}
              onCommit={(draft) => {
                setCustomEntry(null);
                const nextVoice = applyVoiceAgentSelection(voice, { kind: 'custom', agentId: draft });
                if (nextVoice === voice) return String(cfg.agent.agentId ?? '');
                props.setVoice(nextVoice);
              }}
            />
            </SettingAnchor>
          ) : null}
          </>
        ) : null}
          </>
        ) : null}
        <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.permissionIntent}>
        <SegmentedChoiceItem
          title={t(VOICE_CONVERSATIONS_SETTINGS.settings.permissionIntent.titleKey)}
          subtitleLines={0}
          testIDPrefix="settings.voice.local.mediatorPermissionPolicy"
          value={cfg.agent.permissionIntent}
          onChange={(next) => setAgent({ permissionIntent: next })}
          options={[
            { id: 'read-only', label: t('settingsVoice.pages.conversations.itMayReadOnly'), description: t('settingsVoice.pages.conversations.itMayReadOnlyDescription') },
            { id: 'default', label: t('settingsVoice.pages.conversations.itMayAsk'), description: t('settingsVoice.pages.conversations.itMayAskDescription') },
            { id: 'safe-yolo', label: t('settingsVoice.pages.conversations.itMaySafe'), description: t('settingsVoice.pages.conversations.itMaySafeDescription') },
            { id: 'yolo', label: t('settingsVoice.pages.conversations.itMayAnything'), description: t('settingsVoice.pages.conversations.itMayAnythingDescription') },
          ]}
        />
        </SettingAnchor>
        {!hasConfiguredProviderChat ? (
          <>
        <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.chatModelSource}>
        <SegmentedChoiceItem
          title={t(VOICE_CONVERSATIONS_SETTINGS.settings.chatModelSource.titleKey)}
          subtitleLines={0}
          testIDPrefix="settings.voice.local.mediatorChatModelSource"
          value={cfg.agent.chatModelSource}
          onChange={(next) => setAgent({ chatModelSource: next })}
          options={[
            { id: 'session', label: t('settingsVoice.local.mediatorChatModelSourceSession'), description: t('settingsVoice.local.conversation.chatModelSource.sessionSubtitle') },
            { id: 'custom', label: t('settingsVoice.local.mediatorChatModelSourceCustom'), description: t('settingsVoice.local.conversation.chatModelSource.customSubtitle') },
          ]}
        />
        </SettingAnchor>
        {cfg.agent.chatModelSource === 'custom' ? (
          <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.chatModelId}>
          <>
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
                setCustomEntry('chatModelId');
                return;
              }

              const next = String(id ?? '').trim();
              if (!next) return;
              setAgent({ chatModelId: next });
              setOpenMenu(null);
            }}
          />
          {customEntry === 'chatModelId' ? (
            <FieldValueItem
              title={t('settingsVoice.local.conversation.chatModelId.title')}
              subtitle={t('settingsVoice.local.conversation.chatModelId.subtitle')}
              fieldTestID="settings.voice.local.chatModelId.custom.field"
              monospace
              autoFocus
              value={String(cfg.agent.chatModelId ?? '')}
              onCommit={(draft) => {
                setCustomEntry(null);
                if (!draft) return String(cfg.agent.chatModelId ?? '');
                setAgent({ chatModelId: draft });
              }}
            />
          ) : null}
          </>
          </SettingAnchor>
        ) : null}
          </>
        ) : null}
        <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.verbosity}>
        <SegmentedChoiceItem
          title={t(VOICE_CONVERSATIONS_SETTINGS.settings.verbosity.titleKey)}
          subtitleLines={0}
          testIDPrefix="settings.voice.local.mediatorVerbosity"
          value={cfg.agent.verbosity}
          onChange={(next) => setAgent({ verbosity: next })}
          options={[
            { id: 'short', label: t('settingsVoice.pages.conversations.repliesShort'), description: t('settingsVoice.local.conversation.verbosity.shortSubtitle') },
            { id: 'balanced', label: t('settingsVoice.pages.conversations.repliesBalanced'), description: t('settingsVoice.local.conversation.verbosity.balancedSubtitle') },
          ]}
        />
        </SettingAnchor>
            <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.greeting}>
            <VoiceGreetingItem
              value={resolveVoiceWelcomeSelection(voice.welcome)}
              onChange={(next) => props.setVoice(applyVoiceWelcomeSelection(voice, next))}
            />
            </SettingAnchor>
        <SettingAnchor settings={ADVANCED_AGENT_SETTINGS}>
          <ExpandableItem
            testID="settings.voice.local.advancedAgent"
            expanded={advancedAgentExpanded}
            onExpandedChange={setAdvancedAgentExpanded}
            header={(state) => (
              <Item
                testID="settings.voice.local.advancedAgent.header"
                {...state.headerProps}
                title={t('settingsVoice.pages.conversations.advancedAgentTitle')}
                subtitle={t('settingsVoice.pages.conversations.advancedAgentDescription')}
                rightElement={<Icon name={state.expanded ? 'caret-down' : 'caret-right'} size={14} color={theme.colors.text.secondary} />}
                showChevron={false}
              />
            )}
          >
                <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.rootSessionPolicy}>
                <SegmentedChoiceItem
                  title={t(VOICE_CONVERSATIONS_SETTINGS.settings.rootSessionPolicy.titleKey)}
                  subtitleLines={0}
                  testIDPrefix="settings.voice.local.mediatorRootSessionPolicy"
                  value={cfg.agent.rootSessionPolicy === 'keep_warm' ? 'keep_warm' : 'single'}
                  onChange={(next) => setAgent({ rootSessionPolicy: next })}
                  options={rootSessionPolicyOptions}
                />
                </SettingAnchor>

                {cfg.agent.rootSessionPolicy === 'keep_warm' ? (
                  <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.maxWarmRoots}>
                  <FieldValueItem
                    title={t(VOICE_CONVERSATIONS_SETTINGS.settings.maxWarmRoots.titleKey)}
                    subtitle={t('settingsVoice.local.conversation.rootSessionPolicy.maxWarmRootsSubtitle')}
                    fieldTestID="settings.voice.local.maxWarmRoots.field"
                    kind="integer"
                    value={String(cfg.agent.maxWarmRoots)}
                    onCommit={(draft) => {
                      const next = Math.max(1, Math.floor(Number(draft)));
                      setAgent({ maxWarmRoots: next });
                      return String(next);
                    }}
                  />
                  </SettingAnchor>
                ) : null}
          <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.idleTtlSeconds}>
          <FieldValueItem
            title={t(VOICE_CONVERSATIONS_SETTINGS.settings.idleTtlSeconds.titleKey)}
            subtitle={t('settingsVoice.local.mediatorIdleTtlDescription')}
            fieldTestID="settings.voice.local.idleTtlSeconds.field"
            kind="integer"
            value={String(cfg.agent.idleTtlSeconds)}
            onCommit={(draft) => {
              const next = Math.max(1, Math.floor(Number(draft)));
              setAgent({ idleTtlSeconds: next });
              return String(next);
            }}
          />
          </SettingAnchor>
              <SettingRow
                setting={VOICE_CONVERSATIONS_SETTINGS.settings.prewarmOnConnect}
                subtitle={t('settingsVoice.local.conversation.prewarm.subtitle')}
                rightElement={
                  <Switch
                    accessibilityLabel={t('settingsVoice.local.conversation.prewarm.title')}
                    value={cfg.agent.prewarmOnConnect === true}
                    onValueChange={(v) => setAgent({ prewarmOnConnect: v })}
                  />
                }
              />
                <SettingRow
                  setting={VOICE_CONVERSATIONS_SETTINGS.settings.teleportEnabled}
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
                <SettingRow
                  setting={VOICE_CONVERSATIONS_SETTINGS.settings.stayInVoiceHome}
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

          {!hasConfiguredProviderChat ? (
            <>
          <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.commitModelSource}>
          <SegmentedChoiceItem
            title={t(VOICE_CONVERSATIONS_SETTINGS.settings.commitModelSource.titleKey)}
            subtitleLines={0}
            testIDPrefix="settings.voice.local.mediatorCommitModelSource"
            value={cfg.agent.commitModelSource}
            onChange={(next) => setAgent({ commitModelSource: next })}
            options={[
              { id: 'chat', label: t('settingsVoice.local.mediatorCommitModelSourceChat'), description: t('settingsVoice.local.conversation.commitModelSource.chatSubtitle') },
              { id: 'session', label: t('settingsVoice.local.mediatorCommitModelSourceSession'), description: t('settingsVoice.local.conversation.commitModelSource.sessionSubtitle') },
              { id: 'custom', label: t('settingsVoice.local.mediatorCommitModelSourceCustom'), description: t('settingsVoice.local.conversation.commitModelSource.customSubtitle') },
            ]}
          />
          </SettingAnchor>
          {cfg.agent.commitModelSource === 'custom' ? (
            <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.commitModelId}>
            <>
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
                  setCustomEntry('commitModelId');
                  return;
                }

                const next = String(id ?? '').trim();
                if (!next) return;
                setAgent({ commitModelId: next });
                setOpenMenu(null);
              }}
            />
            {customEntry === 'commitModelId' ? (
              <FieldValueItem
                title={t('settingsVoice.local.conversation.commitModelId.title')}
                subtitle={t('settingsVoice.local.conversation.commitModelId.subtitle')}
                fieldTestID="settings.voice.local.commitModelId.custom.field"
                monospace
                autoFocus
                value={String(cfg.agent.commitModelId ?? '')}
                onCommit={(draft) => {
                  setCustomEntry(null);
                  if (!draft) return String(cfg.agent.commitModelId ?? '');
                  setAgent({ commitModelId: draft });
                }}
              />
            ) : null}
            </>
            </SettingAnchor>
          ) : null}
            </>
          ) : null}
          {voiceAgentEnabled ? (
            <SettingRow
              setting={VOICE_CONVERSATIONS_SETTINGS.settings.commitIsolation}
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
          <SettingRow
            setting={VOICE_CONVERSATIONS_SETTINGS.settings.streamingEnabled}
            subtitle={t('settingsVoice.local.conversation.streaming.enableSubtitle')}
            rightElement={(
              <Switch
                accessibilityLabel={t('settingsVoice.local.conversation.streaming.enableTitle')}
                value={cfg.streaming.enabled}
                onValueChange={(v) => setStreaming({ enabled: v })}
              />
            )}
          />
          <SettingRow
            setting={VOICE_CONVERSATIONS_SETTINGS.settings.streamingTtsEnabled}
            subtitle={t('settingsVoice.local.conversation.streaming.enableTtsSubtitle')}
            rightElement={(
              <Switch
                accessibilityLabel={t('settingsVoice.local.conversation.streaming.enableTtsTitle')}
                value={cfg.streaming.ttsEnabled}
                onValueChange={(v) => setStreaming({ ttsEnabled: v })}
              />
            )}
          />
          <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.ttsChunkChars}>
          <FieldValueItem
            title={t(VOICE_CONVERSATIONS_SETTINGS.settings.ttsChunkChars.titleKey)}
            subtitle={t('settingsVoice.local.conversation.streaming.ttsChunkCharsPromptBody')}
            fieldTestID="settings.voice.local.streaming.ttsChunkChars.field"
            kind="integer"
            value={String(cfg.streaming.ttsChunkChars)}
            onCommit={(draft) => {
              const next = Math.max(1, Math.floor(Number(draft)));
              setStreaming({ ttsChunkChars: next });
              return String(next);
            }}
          />
          </SettingAnchor>
            <Item
              testID="settings.voice.local.memoryLink"
              icon={<Icon name="shield-check" />}
              title={t('settingsVoice.pages.conversations.memoryLinkTitle')}
              subtitle={t('settingsVoice.pages.conversations.memoryLinkDescription')}
              onPress={() => router.push(SETTINGS_ROUTES.voicePrivacy as never)}
            />
          </ExpandableItem>
        </SettingAnchor>
        </>
      ) : null}
      </ItemGroup>

      <LocalVoiceTtsGroup
        cfgTts={cfg.tts}
        setTts={(next) => setCfg({ tts: next })}
        voice={voice}
        setVoice={props.setVoice}
        networkTimeoutMs={cfg.networkTimeoutMs}
        popoverBoundaryRef={props.popoverBoundaryRef}
        daemonRouteDiagnosticReason={props.daemonRouteDiagnosticReason}
      />

    </>
  );
}
