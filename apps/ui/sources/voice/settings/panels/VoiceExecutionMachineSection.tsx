import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { getMachineDropdownMenuItems } from '@/components/settings/pickers/machineDropdownItems';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  voiceSettingsParse,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { useAllMachines } from '@/sync/store/hooks';
import { t } from '@/text';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { projectVoiceProviderSettings, type VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { projectVoiceProviderRequirements } from '@/voice/registry/readiness';
import { resolveStoredVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';

const defaultRegistry = createDefaultVoiceProviderRegistry();

export function VoiceExecutionMachineSection(props: Readonly<{
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
  registry?: VoiceProviderRegistry;
}>) {
  const { theme } = useUnistyles();
  const machines = useAllMachines();
  const [open, setOpen] = React.useState(false);
  const voice = voiceSettingsParse(props.voice);
  const registry = props.registry ?? defaultRegistry;
  const providerId = resolveStoredVoiceProviderId(voice.providerId);
  const entry = providerId ? registry.get(providerId) : null;
  const settingsProjection = providerId && entry?.kind === 'voice.conversation-provider.v1'
    ? projectVoiceProviderSettings(entry, voice.providers[providerId] ?? null)
    : null;
  const requirements = settingsProjection?.status === 'ready' && entry
    ? projectVoiceProviderRequirements(entry, settingsProjection.modeId)
    : null;

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

  if (!requirements?.includes('execution_machine')) return null;

  const fixedMachineId = voice.executionMachine.mode === 'fixed'
    ? String(voice.executionMachine.machineId ?? '').trim()
    : '';
  const selectedId = fixedMachineId || 'auto';
  const selectedItem = items.find((item) => item.id === selectedId) ?? items[0] ?? null;

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
          detailFormatter: () => selectedItem?.title ?? selectedId,
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
