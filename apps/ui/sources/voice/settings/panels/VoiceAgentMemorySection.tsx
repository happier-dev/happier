import * as React from 'react';

import { canAgentResume } from '@/agents/runtime/resumeCapabilities';
import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import { useSettings } from '@/sync/domains/state/storage';
import {
  readLocalConversationVoiceSettings,
  voiceSettingsParse,
  writeLocalConversationVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resetGlobalVoiceAgentPersistence } from '@/voice/agent/resetGlobalVoiceAgentPersistence';
import {
  applyVoiceMemoryRestoreChoice,
  resolveVoiceMemoryRestoreChoice,
  type VoiceMemoryRestoreChoice,
} from '@/voice/settings/memoryRestore';
import { VOICE_PRIVACY_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';

/**
 * "Voice agent memory": whether the Voice agent remembers past conversations and how it restores
 * them. It applies to Local voice with a Voice agent; the rows stay visible on every service so the
 * choice can be made ahead, and a dependent row says which choice unlocks it.
 */
export function VoiceAgentMemorySection(props: Readonly<{
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
}>) {
  const voiceAgentEnabled = useFeatureEnabled('voice.agent');
  const accountSettings = useSettings();
  const voice = voiceSettingsParse(props.voice);
  const cfg = readLocalConversationVoiceSettings(voice);
  const agent = cfg.agent;
  const remembers = agent.transcript.persistenceMode === 'persistent';
  const restoreChoice = resolveVoiceMemoryRestoreChoice(voice);
  const agentCanResume = agent.agentSource !== 'agent' || canAgentResume(agent.agentId, { accountSettings });
  const resumeUnavailableReason = !voiceAgentEnabled
    ? t('settingsVoice.pages.privacy.restoreResumeFeatureOff')
    : !agentCanResume
      ? t('settingsVoice.pages.privacy.restoreResumeAgentCannot')
      : undefined;
  const setAgent = (patch: Partial<typeof agent>) => {
    props.setVoice(writeLocalConversationVoiceSettings(voice, { ...cfg, agent: { ...agent, ...patch } }));
  };
  const restoreOptions = [
    { id: 'recent_messages' as const, label: t('settingsVoice.pages.privacy.restoreRecent') },
    { id: 'summary_plus_recent' as const, label: t('settingsVoice.pages.privacy.restoreSummary') },
    {
      id: 'provider_resume' as const,
      label: t('settingsVoice.pages.privacy.restoreResume'),
      // A stored native-resume choice stays selectable to leave; only a new choice needs the prerequisite.
      ...(resumeUnavailableReason && restoreChoice !== 'provider_resume' ? { unavailableReason: resumeUnavailableReason } : {}),
    },
  ];
  const resuming = restoreChoice === 'provider_resume';
  const forget = () => {
    fireAndForget((async () => {
      const confirmed = await Modal.confirm(
        t('settingsVoice.local.conversation.resetVoiceAgent.title'),
        t('settingsVoice.local.conversation.resetVoiceAgent.confirmBody'),
        { confirmText: t('common.reset') },
      );
      if (!confirmed) return;
      await resetGlobalVoiceAgentPersistence();
    })(), { tag: 'VoiceAgentMemorySection.confirm.forget' });
  };

  return (
    <SettingSection section={VOICE_PRIVACY_SETTINGS.sectionRefs.memory}>
      <ItemGroup
        title={t('settingsVoice.pages.privacy.memoryTitle')}
        description={t('settingsVoice.pages.privacy.memoryDescription')}
      >
        <SettingRow
          setting={VOICE_PRIVACY_SETTINGS.settings.rememberPastConversations}
          subtitle={remembers
            ? t('settingsVoice.pages.privacy.rememberOnDescription')
            : t('settingsVoice.pages.privacy.rememberOffDescription')}
          rightElement={(
            <Switch
              testID="settings.voice.memory.remember"
              accessibilityLabel={t(VOICE_PRIVACY_SETTINGS.settings.rememberPastConversations.titleKey)}
              value={remembers}
              onValueChange={(on) => setAgent({ transcript: { ...agent.transcript, persistenceMode: on ? 'persistent' : 'ephemeral' } })}
            />
          )}
        />
        <SettingAnchor setting={VOICE_PRIVACY_SETTINGS.settings.restoreMemoryBy}>
          <SegmentedChoiceItem<VoiceMemoryRestoreChoice>
            title={t(VOICE_PRIVACY_SETTINGS.settings.restoreMemoryBy.titleKey)}
            subtitle={remembers ? undefined : t('settingsVoice.pages.privacy.restoreUnavailable')}
            subtitleLines={0}
            testIDPrefix="settings.voice.memory.restore"
            disabled={!remembers}
            value={restoreChoice}
            options={restoreOptions}
            onChange={(choice) => props.setVoice(applyVoiceMemoryRestoreChoice(voice, choice))}
          />
        </SettingAnchor>
        <SettingRow
          setting={VOICE_PRIVACY_SETTINGS.settings.fallbackToReplay}
          subtitleLines={0}
          disabled={!remembers || !resuming}
          rightElement={(
            <Switch
              testID="settings.voice.memory.fallbackToReplay"
              accessibilityLabel={t(VOICE_PRIVACY_SETTINGS.settings.fallbackToReplay.titleKey)}
              value={agent.providerResume.fallbackToReplay}
              disabled={!remembers || !resuming}
              onValueChange={(fallbackToReplay) => setAgent({ providerResume: { ...agent.providerResume, fallbackToReplay } })}
            />
          )}
        />
        <SettingAnchor setting={VOICE_PRIVACY_SETTINGS.settings.restoreMessagesCount}>
          <FieldValueItem
            title={t(VOICE_PRIVACY_SETTINGS.settings.restoreMessagesCount.titleKey)}
            subtitle={remembers
              ? t('settingsVoice.pages.privacy.restoreCountDescription')
              : t('settingsVoice.pages.privacy.restoreUnavailable')}
            fieldTestID="settings.voice.local.replay.recentMessagesCount.field"
            kind="integer"
            stepper={{ min: 1, max: 100, step: 1 }}
            unit={t('settingsVoice.pages.privacy.messagesUnit')}
            disabled={!remembers}
            value={String(agent.replay.recentMessagesCount)}
            onCommit={(draft) => {
              const next = Math.max(1, Math.min(100, Math.floor(Number(draft))));
              if (!Number.isFinite(next)) return String(agent.replay.recentMessagesCount);
              setAgent({ replay: { ...agent.replay, recentMessagesCount: next } });
              return String(next);
            }}
          />
        </SettingAnchor>
        <SettingRow
          setting={VOICE_PRIVACY_SETTINGS.settings.forgetVoiceAgentMemory}
          subtitleLines={0}
          rightElement={(
            <RoundButton
              testID="settings.voice.memory.forget"
              size="small"
              display="destructive"
              title={t('settingsVoice.pages.privacy.forgetAction')}
              onPress={forget}
            />
          )}
        />
      </ItemGroup>
    </SettingSection>
  );
}
