import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { SetupBlockGrid } from '@/components/ui/setupBlocks/SetupBlockGrid';
import { VoiceMarkArt } from '@/components/voice/presence/VoiceMark';
import { useVoicePresenceContainer } from '@/components/voice/presence/useVoicePresenceContainer';
import {
  readLocalConversationVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { useNavigationFocusReturn } from '@/utils/navigation/useNavigationFocusReturn';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import { useVoiceDictationReadinessModel } from '@/voice/dictation/DictationSettingsSection';
import { useVoiceConversationsReadinessModel } from '@/voice/settings/panels/VoiceProviderSection';
import { VoicePipelineCard } from '@/voice/settings/pipeline/VoicePipelineCard';
import { VoicePipelineView } from '@/voice/settings/pipeline/VoicePipelineView';
import { buildVoiceConversationsPipeline, buildVoiceDictationPipeline } from '@/voice/settings/pipeline/voicePipelineSteps';
import { useVoiceConversationsReadinessInputs } from '@/voice/settings/useVoiceConversationsReadinessInputs';
import { useVoiceSettingsMutable } from '@/voice/settings/useVoiceSettingsMutable';
import { useVoiceSetupBlock } from '@/voice/settings/setup/VoiceSetupItem';
import {
  resolveLegacyVoiceSettingsIntent,
  VOICE_SETTINGS_INTENTS,
} from '@/voice/settings/voiceSettingsIntents';

/** What the voice service reads when a conversation starts and whether its agent remembers, in one line. */
function describeVoicePrivacy(voice: VoiceSettings): string {
  const shared = [
    voice.privacy.shareSessionSummary ? t('settingsVoice.pages.hub.summarySessionSummaries') : null,
    voice.privacy.shareRecentMessages
      ? t('settingsVoice.pages.hub.summaryRecentMessages', { count: voice.privacy.recentMessagesCount })
      : null,
  ].filter((part): part is string => part !== null);
  const memory = readLocalConversationVoiceSettings(voice).agent.transcript.persistenceMode === 'persistent'
    ? t('settingsVoice.pages.hub.summaryRemembers')
    : t('settingsVoice.pages.hub.summaryForgets');
  return [shared.length > 0 ? shared.join(' · ') : t('settingsVoice.pages.hub.summaryNothingShared'), memory].join(' · ');
}

const PRESENCE_LABEL_KEYS = {
  top_bar: 'settingsVoice.ui.presenceContainer.topBar',
  island: 'settingsVoice.ui.presenceContainer.island',
  orb: 'settingsVoice.ui.presenceContainer.orb',
} as const;

/**
 * Settings → Voice: the two ways to use your voice shown as their live pipelines (what hears, thinks
 * and speaks, where each runs and whether it works), then Privacy & data, Advanced and Voice history.
 * Opening the hub reads only facts already on this device; it asks no machine anything.
 */
export function VoiceSettingsIntentIndexScreen() {
  const router = useRouter();
  const routeParams = useLocalSearchParams<{ focus?: string | string[] }>();
  const legacyIntent = resolveLegacyVoiceSettingsIntent(routeParams.focus);
  const navigateWithFocusReturn = useNavigationFocusReturn();
  const [voice, setVoice] = useVoiceSettingsMutable();
  const executionMachine = useVoiceExecutionMachinePresentation();
  const presence = useVoicePresenceContainer();
  const voiceSetup = useVoiceSetupBlock({ layout: 'row', span: 'row' });
  const inputs = useVoiceConversationsReadinessInputs(voice, { probeMachine: false });
  const conversations = useVoiceConversationsReadinessModel({
    voice,
    setVoice,
    happierVoiceSupported: inputs.happierVoiceSupported,
    localAvailability: inputs.localAvailability,
    executionMachineId: executionMachine.machineId,
    executionMachineSelectedId: executionMachine.selectedMachineId,
    executionMachineSelectionKind: executionMachine.selectionKind,
  });
  const dictation = useVoiceDictationReadinessModel({
    voice,
    setVoice,
    executionMachineId: executionMachine.machineId,
    executionMachineSelectionKind: executionMachine.selectionKind,
    localAvailability: inputs.localAvailability,
    daemonRouteDiagnosticReason: inputs.daemonRouteDiagnosticReason,
  });

  React.useEffect(() => {
    if (!legacyIntent) return;
    const definition = VOICE_SETTINGS_INTENTS.find((candidate) => candidate.id === legacyIntent);
    if (!definition) return;
    router.replace({
      pathname: definition.route as never,
      params: { focus: routeParams.focus as string },
    });
  }, [legacyIntent, routeParams.focus, router]);

  const open = (route: string) => navigateWithFocusReturn(() => router.push(route as never));
  const machine = { machineId: executionMachine.selectedMachineId, machineLabel: executionMachine.machineLabel };
  const serviceTitle = conversations.serviceTiles.find((tile) => tile.selected)?.title ?? null;
  const conversationsPipeline = buildVoiceConversationsPipeline({
    voice,
    serviceTitle,
    readiness: conversations.selectedProviderReadiness ?? null,
    localSpeechReadiness: conversations.selectedLocalSpeechReadiness,
    machine,
  });
  const dictationPipeline = buildVoiceDictationPipeline({
    sttProviderId: dictation.selectedStt.provider,
    sttTitle: dictation.providerSpec?.title ?? dictation.selectedStt.provider,
    localNeuralExecution: dictation.selectedStt.localNeural?.execution ?? null,
    readiness: dictation.readiness,
    machine,
    language: voice.dictation.language ?? null,
  });
  const advancedSummary = [
    executionMachine.machineLabel ? t('settingsVoice.pages.hub.summaryVoiceComputer', { machine: executionMachine.machineLabel }) : null,
    t(PRESENCE_LABEL_KEYS[presence]),
    voice.ui.activityFeedEnabled ? t('settingsVoice.pages.hub.summaryTranscript') : null,
  ].filter((part): part is string => part !== null).join(' · ');

  return (
    <ItemList testID="settings.voice.intents">
      <SettingsPageHeader
        description={t('settingsVoice.pages.hub.description')}
        leading={(
          <PageHeaderMarkSlot>
            <VoiceMarkArt pose="ready" size={44} still />
          </PageHeaderMarkSlot>
        )}
      />
      {voiceSetup ? (
        // Until Voice is set up, the page opens with the same setup block as Home (lab SV).
        <ItemGroup surface="none">
          <SetupBlockGrid testID="settings.voice.setup" items={[voiceSetup]} columns={1} />
        </ItemGroup>
      ) : null}
      <ItemGroup title={t('settingsVoice.pages.hub.modesTitle')} surface="none">
        <View style={styles.modes}>
        <VoicePipelineView
          testID="settings.voice.intent.dictation"
          title={t('settingsVoice.intents.dictation.title')}
          purpose={t('settingsVoice.pages.hub.dictationPurpose')}
          pipeline={dictationPipeline}
          onPress={() => open(SETTINGS_ROUTES.voiceDictation)}
        />
        {conversationsPipeline && serviceTitle ? (
          <VoicePipelineView
            testID="settings.voice.intent.conversations"
            title={t('settingsVoice.intents.conversations.title')}
            purpose={serviceTitle}
            pipeline={conversationsPipeline.pipeline}
            cardReadiness={conversationsPipeline.cardReadiness}
            onPress={() => open(SETTINGS_ROUTES.voiceConversations)}
          />
        ) : (
          <VoicePipelineCard
            testID="settings.voice.intent.conversations"
            title={t('settingsVoice.intents.conversations.title')}
            status={{ tone: 'unknown', text: t('settingsVoice.pages.pipeline.off') }}
            steps={[]}
            onPress={() => open(SETTINGS_ROUTES.voiceConversations)}
          />
        )}
        </View>
      </ItemGroup>
      <ItemGroup title={t('settingsVoice.pages.hub.moreTitle')}>
        <Item
          testID="settings.voice.intent.privacy"
          icon={<Icon name="shield-check" />}
          title={t('settingsVoice.intents.privacy.title')}
          subtitle={describeVoicePrivacy(voice)}
          subtitleLines={0}
          accessibilityRole="button"
          onPress={() => open(SETTINGS_ROUTES.voicePrivacy)}
        />
        <Item
          testID="settings.voice.intent.advanced"
          icon={<Icon name="sliders-horizontal" />}
          title={t('settingsVoice.intents.advanced.title')}
          subtitle={advancedSummary}
          subtitleLines={0}
          accessibilityRole="button"
          onPress={() => open(SETTINGS_ROUTES.voiceAdvanced)}
        />
        <Item
          testID="settings.voice.intent.history"
          icon={<Icon name="clock-counter-clockwise" />}
          title={t('settingsVoice.history.entryTitle')}
          subtitle={t('settingsVoice.history.entrySubtitle')}
          subtitleLines={0}
          accessibilityRole="button"
          onPress={() => open(SETTINGS_ROUTES.voiceHistory)}
        />
      </ItemGroup>
    </ItemList>
  );
}

const styles = StyleSheet.create({
  modes: {
    gap: 12,
  },
});
