import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { describeTtsSampleFailure } from '@/voice/settings/panels/localTts/ttsSampleFailureMessage';
import { getLocalTtsProviderSpec, useLocalTtsProviderSpecs } from '@/voice/settings/panels/localTts/providers/registry';
import type { VoiceDaemonRouteDiagnosticReason } from '@/voice/settings/voiceProviderLocalAvailability';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Icon } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { VOICE_CONVERSATIONS_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import { useVoiceSettingsSearchPrerequisite } from '@/voice/settings/VoiceSettingsSearchPrerequisite';
import { getVoiceContributedSettingRefs, useVoiceContributedSettingsDeclarations } from '@/voice/settings/useVoiceContributedSettingRefs';

const LOCAL_NEURAL_TTS_SETTINGS = Object.entries(VOICE_CONVERSATIONS_SETTINGS.settings)
  .filter(([id, setting]) => id.startsWith('tts') && id !== 'ttsProvider'
    && setting.sectionId === VOICE_CONVERSATIONS_SETTINGS.settings.ttsProvider.sectionId)
  .map(([, setting]) => setting);
export const VOICE_LOCAL_TTS_SETTINGS = [VOICE_CONVERSATIONS_SETTINGS.settings.ttsProvider,
  VOICE_CONVERSATIONS_SETTINGS.settings.autoSpeakReplies, VOICE_CONVERSATIONS_SETTINGS.settings.testTts,
  ...LOCAL_NEURAL_TTS_SETTINGS];

export function LocalVoiceTtsGroup(props: {
  cfgTts: VoiceLocalTtsSettings;
  /** A shared speech contribution's fields may already be drawn by Hear. */
  otherSpeechProviderId?: string;
  setTts: (next: VoiceLocalTtsSettings) => void;
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  networkTimeoutMs: number;
  popoverBoundaryRef?: React.RefObject<any> | null;
  daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
}) {
  const searchPrerequisite = useVoiceSettingsSearchPrerequisite();
  const scope = useAccountSettingsScope();
  const { execute } = useMountedActionExecution(scope);
  const { theme } = useUnistyles();
  const providerSpecs = useLocalTtsProviderSpecs();
  const declarations = useVoiceContributedSettingsDeclarations('voiceConversations');
  const [openMenu, setOpenMenu] = React.useState<null | 'ttsProvider'>(null);
  const [testStatus, setTestStatus] = React.useState<'idle' | 'speaking'>('idle');

  const cfg = props.cfgTts;
  const providerSpec = getLocalTtsProviderSpec(cfg.provider);
  const setCfg = (patch: Partial<VoiceLocalTtsSettings>) => props.setTts({ ...cfg, ...patch });

  return (
    <ItemGroup
      title={t('settingsVoice.pages.conversations.speakTitle')}
      description={t('settingsVoice.pages.conversations.speakDescription')}
    >
      <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.ttsProvider}>
      <DropdownMenu
        open={openMenu === 'ttsProvider'}
        onOpenChange={(next) => setOpenMenu(next ? 'ttsProvider' : null)}
        variant="selectable"
        search={false}
        selectedId={cfg.provider}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
          title: t('settingsVoice.pages.conversations.voiceEngineTitle'),
        }}
        items={providerSpecs.map((spec) => ({
          id: spec.id,
          title: spec.title,
          subtitle: spec.subtitle,
          icon: <Icon name={spec.iconName as any} size={20} color={theme.colors.text.secondary} />,
        }))}
        onSelect={(id) => {
          setCfg({ provider: id as any });
          setOpenMenu(null);
        }}
      />
      </SettingAnchor>

      {providerSpec ? (
        <providerSpec.Settings
          cfgTts={cfg}
          setTts={props.setTts}
          voice={props.voice}
          setVoice={props.setVoice}
          networkTimeoutMs={props.networkTimeoutMs}
          popoverBoundaryRef={props.popoverBoundaryRef}
          daemonRouteDiagnosticReason={props.daemonRouteDiagnosticReason}
        />
      ) : (
        <Item title={t('common.unavailable')} />
      )}

      {providerSpecs.filter((spec) => spec.id !== providerSpec?.id).map((spec) => (
        searchPrerequisite({ settings: [...(spec.id === props.otherSpeechProviderId ? [] : getVoiceContributedSettingRefs(declarations, spec.id)),
            ...(spec.id === 'local_neural' ? LOCAL_NEURAL_TTS_SETTINGS : [])], reason: t('settingsVoice.pages.search.select', { choice: spec.title, control: t('settingsVoice.pages.conversations.voiceEngineTitle') }) })
      ))}

      <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.autoSpeakReplies}>
      <Item
        title={t('settingsVoice.local.autoSpeak')}
        subtitle={t('settingsVoice.local.autoSpeakSubtitle')}
        rightElement={(
          <Switch
            accessibilityLabel={t('settingsVoice.local.autoSpeak')}
            value={cfg.autoSpeakReplies}
            onValueChange={(v) => setCfg({ autoSpeakReplies: v })}
          />
        )}
      />
      </SettingAnchor>

      <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.testTts}>
      <Item
        title={t('settingsVoice.local.testTts')}
        subtitle={testStatus === 'speaking' ? t('settingsVoice.local.speaking') : t('settingsVoice.local.testTtsSubtitle')}
        showChevron={false}
        rightElementOutsidePressable
        rightElement={<IconButton
          testID="settings.voice.local.testTts"
          iconName="play"
          accessibilityLabel={t('settingsVoice.local.testTts')}
          tooltip={t('settingsVoice.local.testTts')}
          disabled={testStatus === 'speaking'}
          onPress={() => {
          fireAndForget((async () => {
            try {
              if (testStatus === 'speaking') return;
              setTestStatus('speaking');
              const outcome = await execute('settings.invoke', { anchor: VOICE_CONVERSATIONS_SETTINGS.settings.testTts.anchor });
              if (!outcome.ok && presentActionTurnedOffNoticeIfOff(outcome, 'settings.invoke')) return;
              if (!outcome.ok && isActionApprovalDeclinedErrorCode(outcome.errorCode)) return;
              requireActionSuccess(outcome);
              const result = SettingsDeclarationActionOutputSchemasV1['settings.invoke'].parse(outcome.result);
              if (result.status === 'unavailable') throw new Error(result.reason ?? 'voice_tts_provider_unavailable');
            } catch (err) {
              fireAndForget(Promise.resolve().then(() => Modal.alert(t('common.error'), describeTtsSampleFailure(err instanceof Error ? err.message : null))), {
                tag: 'LocalVoiceTtsGroup.alert.testTtsFailed',
              });
            } finally {
              setTestStatus('idle');
            }
          })(), { tag: 'LocalVoiceTtsGroup.testTts' });
          }}
        />}
      />
      </SettingAnchor>
    </ItemGroup>
  );
}
