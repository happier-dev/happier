import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

export type VisibleAgentsSettingsGroupProps = Readonly<{
  assembleTeamOnLeadAssignment: boolean;
  teamTemplateSummary: string;
  onAssemblyEnabledChange: (enabled: boolean) => void;
  onEditTeamTemplate: () => void;
}>;

export const VisibleAgentsSettingsGroup = React.memo(function VisibleAgentsSettingsGroup(
  props: VisibleAgentsSettingsGroupProps,
) {
  const { theme } = useUnistyles();

  return (
    <ItemGroup
      title={t('visibleAgents.teamGroupTitle')}
      footer={t('visibleAgents.teamFooter')}
    >
      <Item
        testID="visible-agents-assemble-team"
        title={t('visibleAgents.assembly.title')}
        subtitle={t('visibleAgents.assembly.subtitle')}
        icon={<Icon name="users" size={29} color={theme.colors.accent.indigo} />}
        rightElement={(
          <Switch
            value={props.assembleTeamOnLeadAssignment}
            onValueChange={props.onAssemblyEnabledChange}
          />
        )}
        showChevron={false}
        onPress={() => props.onAssemblyEnabledChange(!props.assembleTeamOnLeadAssignment)}
      />
      <Item
        testID="visible-agents-team-template"
        title={t('visibleAgents.teamTemplate.title')}
        subtitle={props.teamTemplateSummary || t('visibleAgents.teamTemplate.empty')}
        icon={<Icon name="list-checks" size={29} color={theme.colors.accent.blue} />}
        onPress={props.onEditTeamTemplate}
      />
    </ItemGroup>
  );
});
