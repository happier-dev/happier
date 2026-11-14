import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

import { AGENT_INPUT_MENU_ICON_SIZE_PX } from '../definitions/agentInputChipIconMetrics';

/** The way back to To's targets from a step pushed in place (a model, Matching…, a Discussion): one row for all. */
export function SessionTalkStepBack(
  props: Readonly<{ testID: string; onBack: () => void }>,
) {
  const { theme } = useUnistyles();
  return (
    <Item
      testID={props.testID}
      rowRole="menu"
      showChevron={false}
      showDivider={false}
      icon={
        <Icon
          name="caret-left"
          size={AGENT_INPUT_MENU_ICON_SIZE_PX}
          color={theme.colors.text.secondary}
        />
      }
      title={t('common.back')}
      onPress={props.onBack}
    />
  );
}
