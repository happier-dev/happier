import * as React from 'react';

import { Platform } from 'react-native';

import { VoiceRuntimePlatformSchema } from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';

import { getMachineDropdownMenuItems } from '@/components/settings/pickers/machineDropdownItems';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Icon } from '@/components/ui/icons/Icon';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import {
  voiceSettingsParse,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { useSettingsSelector } from '@/sync/domains/state/storage';
import { useAllMachines } from '@/sync/store/hooks';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { accountSettingsScopeKeySuffix } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { t } from '@/text';
import { resolveAccountVoiceCredentialSourceSelection } from '@/voice/credentials/accountVoiceCredential';
import { resolveVoiceDictationExecutionMachineRequirement } from '@/voice/dictation/voiceDictationReadiness';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { projectVoiceProviderSettings, type VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import {
  projectVoiceProviderRequirements,
  type VoiceProviderCredentialSourceKind,
} from '@/voice/registry/readiness';
import { resolveStoredVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';
import { applyVoiceExecutionMachineChoice } from '@/voice/settings/executionMachineChoice';
import { SettingAnchor, useSettingRevealRequested } from '@/components/settings/shell/SettingRow';
import { VOICE_ADVANCED_SETTINGS, VOICE_CONVERSATIONS_SETTINGS, VOICE_DICTATION_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';

const defaultRegistry = createDefaultVoiceProviderRegistry();

export function VoiceExecutionMachineSection(props: Readonly<{
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
  registry?: VoiceProviderRegistry;
  intent?: 'conversations' | 'dictation' | 'advanced';
  /** `chip`: the page header's "Runs on" chip; `section` (default): a page section with the field. */
  presentation?: 'section' | 'chip';
}>) {
  const { theme } = useUnistyles();
  const machines = useAllMachines();
  const accountSettings = useSettingsSelector((settings) => ({
      voiceSettingsV1: settings.voiceSettingsV1,
      secrets: settings.secrets,
      connectedAccountPurposeBindingsV1: settings.connectedAccountPurposeBindingsV1,
  }));
  const settingsScope = useAccountSettingsScope();
  const rememberedAutoMachineId = useVoiceTargetStore((state) => settingsScope
    ? state.autoTargetMachineByScope[accountSettingsScopeKeySuffix(settingsScope)]
    : undefined);
  const [open, setOpen] = React.useState(false);
  const setting = props.intent === 'advanced'
    ? VOICE_ADVANCED_SETTINGS.settings.executionMachine : props.intent === 'dictation'
      ? VOICE_DICTATION_SETTINGS.settings.executionMachine : VOICE_CONVERSATIONS_SETTINGS.settings.executionMachine;
  const revealRequested = useSettingRevealRequested([setting]);
  const voice = voiceSettingsParse(props.voice);
  const registry = props.registry ?? defaultRegistry;
  const providerId = resolveStoredVoiceProviderId(voice.providerId);
  const entry = providerId ? registry.get(providerId) : null;
  const providerEnvelope = providerId
    ? voice.providers[providerId] ?? null
    : null;
  const settingsProjection = providerId && entry
    ? projectVoiceProviderSettings(entry, providerEnvelope)
    : null;
  let credentialSourceKind: VoiceProviderCredentialSourceKind | null = null;
  if (
    entry?.kind === 'voice.conversation-provider.v1'
    && entry.declaration?.kind === 'conversation'
    && entry.declaration.credentials
  ) {
    try {
      credentialSourceKind = resolveAccountVoiceCredentialSourceSelection({
        settings: accountSettings,
        contribution: { pluginId: entry.pluginId, localId: entry.declaration.id },
        credentialSlotId: entry.declaration.credentials.slot.id,
        purpose: {
          consumer: { pluginId: entry.pluginId, localId: entry.declaration.id },
          purpose: entry.declaration.credentials.slot.purpose,
        },
        machineId: null,
      }).selection.kind;
    } catch {
      // An unreadable source cannot establish a machine dependency. The
      // canonical credential resolver retains its own fail-closed readiness.
      credentialSourceKind = null;
    }
  }
  const conversationRequiresExecutionMachine = entry && (
    settingsProjection === null || settingsProjection.status === 'ready'
  )
    ? projectVoiceProviderRequirements(
        entry,
        settingsProjection?.modeId ?? null,
        credentialSourceKind,
      )
      ?.includes('execution_machine') === true
    : false;
  const parsedPlatform = VoiceRuntimePlatformSchema.safeParse(Platform.OS);
  const dictationRequiresExecutionMachine = resolveVoiceDictationExecutionMachineRequirement({
        registry,
        settings: { voice },
        platform: parsedPlatform.success ? parsedPlatform.data : 'unknown',
      });
  const requiresExecutionMachine = props.intent === 'dictation'
    ? dictationRequiresExecutionMachine
    : props.intent === 'advanced'
      ? true // Advanced also owns speech-model management, independently of the selected service.
      : conversationRequiresExecutionMachine;

  const items = React.useMemo(() => getMachineDropdownMenuItems({
    machines,
    iconColor: theme.colors.text.secondary,
    includeAuto: true,
    autoTitle: t('settingsVoice.local.executionMachine.autoTitle'),
    autoSubtitle: t('settingsVoice.local.executionMachine.autoSubtitle'),
    onlineLabel: t('settingsVoice.local.executionMachine.onlineLabel'),
    offlineLabel: t('settingsVoice.local.executionMachine.offlineLabel'),
    unknownMachineLabel: t('settingsVoice.local.executionMachine.unknownMachineLabel'),
  }), [machines, theme.colors.text.secondary]);

  if (!requiresExecutionMachine && !revealRequested) return null;

  const fixedMachineId = voice.executionMachine.mode === 'fixed'
    ? String(voice.executionMachine.machineId ?? '').trim()
    : '';
  const stickyAutoMachineId = voice.executionMachine.mode === 'auto'
    ? String(rememberedAutoMachineId ?? '').trim()
    : '';
  const selectedId = fixedMachineId || 'auto';
  const selectedItem = items.find((item) => item.id === selectedId) ?? null;
  const stickyAutoItem = stickyAutoMachineId
    ? items.find((item) => item.id === stickyAutoMachineId) ?? null
    : null;

  const selectMachine = (id: string) => {
    const machineId = String(id ?? '').trim();
    if (!machineId) return;
    if (machineId === 'auto' && settingsScope) {
      useVoiceTargetStore.getState().rememberAutoTargetMachine(settingsScope, null);
    }
    props.setVoice(applyVoiceExecutionMachineChoice(voice, machineId));
    setOpen(false);
  };

  if (props.presentation === 'chip') {
    const fixedMachine = fixedMachineId ? machines.find((machine) => machine.id === fixedMachineId) ?? null : null;
    const shownMachineId = fixedMachineId || stickyAutoMachineId;
    const shownMachine = shownMachineId ? machines.find((machine) => machine.id === shownMachineId) ?? null : null;
    const valueLabel = selectedId === 'auto'
      ? (stickyAutoItem ? `${t('settingsVoice.local.executionMachine.autoTitle')} · ${stickyAutoItem.title}` : t('settingsVoice.local.executionMachine.autoTitle'))
      : (selectedItem?.title ?? fixedMachineId);
    return (
      <SettingAnchor setting={setting}>
      <SelectionListFilterChip
        filter={{
          id: 'voiceComputer',
          label: t('settingsVoice.pages.conversations.runsOn'),
          valueLabel,
          icon: <Icon name="desktop" size={14} color={theme.colors.text.secondary} />,
          ...(shownMachine ? { presence: isMachineOnline(shownMachine) ? 'online' as const : 'offline' as const } : {}),
          options: items.map((item) => ({ id: item.id, label: item.title, subtitle: item.subtitle, icon: item.icon })),
          selectedId,
          onChange: selectMachine,
          testID: 'settings.voice.executionMachine.chip',
          ...(fixedMachine === null && fixedMachineId ? { muted: true } : {}),
        }}
      />
      </SettingAnchor>
    );
  }

  return (
    <ItemGroup
      title={t('settingsVoice.pages.advanced.computerTitle')}
      description={t('settingsVoice.pages.advanced.computerDescription')}
    >
      <SettingAnchor setting={setting}>
      <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        variant="selectable"
        search={false}
        selectedId={selectedId}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
          // The section already says "Voice computer"; the row says what it decides.
          title: t('settingsVoice.pages.conversations.runsOn'),
          subtitleFormatter: () => selectedItem?.subtitle ?? t('settingsVoice.local.executionMachine.fallbackSubtitle'),
          detailFormatter: () => selectedId === 'auto' && stickyAutoItem
            ? `${selectedItem?.title ?? t('settingsVoice.local.executionMachine.autoTitle')} · ${stickyAutoItem.title}`
            : (selectedItem?.title ?? fixedMachineId) || selectedId,
        }}
        items={items}
        onSelect={selectMachine}
      />
      </SettingAnchor>
    </ItemGroup>
  );
}
