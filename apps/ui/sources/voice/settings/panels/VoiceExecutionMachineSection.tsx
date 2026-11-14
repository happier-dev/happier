import * as React from 'react';

import { Platform } from 'react-native';

import { VoiceRuntimePlatformSchema } from '@happier-dev/protocol/voice/realtime/capabilities';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import {
  voiceSettingsParse,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { useSetting } from '@/sync/domains/state/storage';
import { useActiveMachineFacts } from '@/sync/store/hooks';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useConnectedAccountCatalog } from '@/sync/store/settings/useConnectedAccountCatalog';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
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
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
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
  /** The chip's chooser, opened by the page when a card asks for a machine, so the page has one machine control. */
  chooserOpen?: boolean;
  onChooserOpenChange?: (open: boolean) => void;
}>) {
  const machines = useActiveMachineFacts();
  const voiceSettingsV1 = useSetting('voiceSettingsV1');
  const secrets = useSetting('secrets');
  const accountSettings = React.useMemo(() => ({ voiceSettingsV1, secrets }), [voiceSettingsV1, secrets]);
  const settingsScope = useAccountSettingsScope();
  const purposes = useConnectedAccountCatalog('purposes', settingsScope);
  // The one machine projection the runtime uses: Automatic names the machine it would use now,
  // whether a conversation has already remembered it or it is the first online candidate.
  const executionMachinePresentation = useVoiceExecutionMachinePresentation();
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
        connectedPurposes: purposes.status === 'ready' && !purposes.stale ? purposes.value : null,
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
        settingsProjection?.status === 'ready' ? settingsProjection.requirements : undefined,
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

  if (!requiresExecutionMachine && !revealRequested) return null;

  const fixedMachineId = voice.executionMachine.mode === 'fixed'
    ? String(voice.executionMachine.machineId ?? '').trim()
    : '';
  const stickyAutoMachineId = voice.executionMachine.mode === 'auto'
    ? String(executionMachinePresentation.selectedMachineId ?? '').trim()
    : '';
  const missingMachineLabel = getMachineDisplayName({ id: fixedMachineId, absence: 'unlisted' });
  const stickyAutoMachine = stickyAutoMachineId
    ? machines.find((machine) => machine.id === stickyAutoMachineId) ?? null
    : null;
  const autoTitle = t('settingsVoice.local.executionMachine.autoTitle');
  // Automatic names the Machine it would use now, beside its own name.
  const autoChoice = {
    title: autoTitle,
    subtitle: t('settingsVoice.local.executionMachine.autoSubtitle'),
    value: stickyAutoMachine ? `${autoTitle} · ${getMachineDisplayName(stickyAutoMachine, machines)}` : autoTitle,
    onChoose: () => selectMachine('auto'),
  };

  const selectMachine = (id: string) => {
    const machineId = String(id ?? '').trim();
    if (!machineId) return;
    if (machineId === 'auto' && settingsScope) {
      useVoiceTargetStore.getState().rememberAutoTargetMachine(settingsScope, null);
    }
    props.setVoice(applyVoiceExecutionMachineChoice(voice, machineId));
  };
  // New Session's Machine picker, with Automatic first; a fixed Machine away right now stays chosen and choosable.
  const field = (presentation: 'field' | 'chip') => (
    <SessionMachineField
      presentation={presentation}
      testID={presentation === 'chip' ? 'settings.voice.executionMachine.chip' : 'settings.voice.executionMachine.field'}
      serverId={settingsScope?.serverId ?? ''}
      machineId={fixedMachineId || null}
      machineName={missingMachineLabel}
      title={t('settingsVoice.pages.conversations.runsOn')}
      {...(presentation === 'field' && !fixedMachineId ? { subtitle: autoChoice.subtitle } : {})}
      defaultChoice={autoChoice}
      awayMachinesChoosable
      presenceMachineId={fixedMachineId || stickyAutoMachineId || null}
      onSelectMachine={(machine) => selectMachine(machine.id)}
      {...(props.chooserOpen !== undefined ? { open: props.chooserOpen } : {})}
      {...(props.onChooserOpenChange ? { onOpenChange: props.onChooserOpenChange } : {})}
    />
  );

  if (props.presentation === 'chip') {
    return <SettingAnchor setting={setting}>{field('chip')}</SettingAnchor>;
  }

  return (
    <ItemGroup
      title={t('settingsVoice.pages.advanced.computerTitle')}
      description={t('settingsVoice.pages.advanced.computerDescription')}
    >
      <SettingAnchor setting={setting}>
      {field('field')}
      </SettingAnchor>
    </ItemGroup>
  );
}
