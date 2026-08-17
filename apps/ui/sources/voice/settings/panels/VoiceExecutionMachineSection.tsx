import * as React from 'react';

import { Platform } from 'react-native';

import { VoiceRuntimePlatformSchema } from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';

import { getMachineDropdownMenuItems } from '@/components/settings/pickers/machineDropdownItems';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  voiceSettingsParse,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { useSettings } from '@/sync/domains/state/storage';
import { useAllMachines } from '@/sync/store/hooks';
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

const defaultRegistry = createDefaultVoiceProviderRegistry();

export function VoiceExecutionMachineSection(props: Readonly<{
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
  registry?: VoiceProviderRegistry;
  intent?: 'conversations' | 'dictation' | 'advanced';
}>) {
  const { theme } = useUnistyles();
  const machines = useAllMachines();
  const accountSettings = useSettings();
  const [open, setOpen] = React.useState(false);
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
      ? conversationRequiresExecutionMachine || dictationRequiresExecutionMachine
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

  if (!requiresExecutionMachine) return null;

  const fixedMachineId = voice.executionMachine.mode === 'fixed'
    ? String(voice.executionMachine.machineId ?? '').trim()
    : '';
  const stickyAutoMachineId = voice.executionMachine.mode === 'auto'
    ? String(voice.executionMachine.autoMachineId ?? '').trim()
    : '';
  const selectedId = fixedMachineId || 'auto';
  const selectedItem = items.find((item) => item.id === selectedId) ?? null;
  const stickyAutoItem = stickyAutoMachineId
    ? items.find((item) => item.id === stickyAutoMachineId) ?? null
    : null;

  return (
    <ItemGroup
      title={t('settingsVoice.local.executionMachine.groupTitle')}
      footer={t('settingsVoice.local.executionMachine.groupFooter')}
    >
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
          title: t('settingsVoice.local.executionMachine.title'),
          subtitleFormatter: () => selectedItem?.subtitle ?? t('settingsVoice.local.executionMachine.fallbackSubtitle'),
          detailFormatter: () => selectedId === 'auto' && stickyAutoItem
            ? `${selectedItem?.title ?? t('settingsVoice.local.executionMachine.autoTitle')} · ${stickyAutoItem.title}`
            : (selectedItem?.title ?? fixedMachineId) || selectedId,
        }}
        items={items}
        onSelect={(id) => {
          if (id === 'auto') {
            props.setVoice({
              ...voice,
              executionMachine: {
                mode: 'auto',
                machineId: null,
                autoMachineId: null,
              },
            });
            setOpen(false);
            return;
          }

          const machineId = String(id ?? '').trim();
          if (!machineId) return;
          props.setVoice({
            ...voice,
            executionMachine: {
              ...voice.executionMachine,
              mode: 'fixed',
              machineId,
            },
          });
          setOpen(false);
        }}
      />
    </ItemGroup>
  );
}
