import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import { useVoiceConversationsReadinessModel } from '@/voice/settings/panels/VoiceProviderSection';
import { useVoiceConversationsReadinessInputs } from '@/voice/settings/useVoiceConversationsReadinessInputs';
import { useVoiceSettingsMutable } from '@/voice/settings/useVoiceSettingsMutable';

/**
 * Voice conversations → Service on a phone: the gallery's services as a list, each with its
 * readiness. Choosing one uses the gallery's own selection (never another service's setup) and goes
 * back to the page.
 */
export function VoiceServiceListScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const [voice, setVoice] = useVoiceSettingsMutable();
  const executionMachine = useVoiceExecutionMachinePresentation();
  const inputs = useVoiceConversationsReadinessInputs(voice, { probeMachine: false });
  const model = useVoiceConversationsReadinessModel({
    voice,
    setVoice,
    happierVoiceSupported: inputs.happierVoiceSupported,
    localAvailability: inputs.localAvailability,
    executionMachineId: executionMachine.machineId,
    executionMachineSelectedId: executionMachine.selectedMachineId,
    executionMachineSelectionKind: executionMachine.selectionKind,
  });
  const check = <Icon name="check-circle" size={22} color={theme.colors.text.primary} />;
  const choose = (apply: () => void) => {
    apply();
    router.back();
  };

  return (
    <ItemList testID="settings.voice.service.list">
      <SettingsPageHeader description={t('settingsVoice.pages.conversations.serviceDescription')} />
      <ItemGroup>
        {model.serviceTiles.map((tile) => (
          <Item
            key={tile.id}
            testID={tile.testID}
            icon={<Icon name="microphone" size={20} color={theme.colors.text.secondary} />}
            title={tile.title}
            subtitle={tile.status?.text ?? tile.subtitle}
            subtitleLines={0}
            accessibilityRole="radio"
            webRole="radio"
            selected={tile.selected && !model.isOff}
            disabled={tile.disabled}
            rightElement={tile.selected && !model.isOff ? check : null}
            showChevron={false}
            onPress={tile.disabled ? undefined : () => choose(() => model.selectService(tile.id))}
          />
        ))}
        <Item
          testID="settings.voice.provider.off"
          icon={<Icon name="x" size={20} color={theme.colors.text.secondary} />}
          title={t('settingsVoice.mode.off')}
          subtitle={t('settingsVoice.pages.conversations.offDescription')}
          subtitleLines={0}
          accessibilityRole="radio"
          webRole="radio"
          selected={model.isOff}
          rightElement={model.isOff ? check : null}
          showChevron={false}
          onPress={() => choose(() => model.select({ ...model.voice, providerId: null }))}
        />
      </ItemGroup>
    </ItemList>
  );
}
