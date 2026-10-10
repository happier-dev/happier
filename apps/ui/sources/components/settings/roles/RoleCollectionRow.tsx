import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';

import { Item } from '@/components/ui/lists/Item';
import { collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { RoleCatalogEntry } from '@/sync/domains/roles/roleCatalog';
import { t } from '@/text';

/**
 * One role in Settings › Roles, the same row in the rail beside a role's detail and in the phone
 * list (lab `settings-R`): the role's mark, its name with a quiet "Edited" tag when the reader
 * changed it, and one line of engine and runs-as. A turned-off role is dimmed. The parent supplies
 * the mark and the line so a list reads the engine catalog once, not once per row.
 */
export const RoleCollectionRow = React.memo(function RoleCollectionRow(
  props: Readonly<{
    entry: RoleCatalogEntry;
    testID: string;
    /** `rail`: a compact collection row that shows selection; `page`: a phone list row that pushes. */
    presentation: 'rail' | 'page';
    mark: React.ReactNode;
    facts: string;
    selected?: boolean;
    onPress: () => void;
  }>,
) {
  const { entry, presentation } = props;
  const dimmed = !entry.role.enabled;
  return (
    <Item
      testID={props.testID}
      title={entry.role.name}
      titleStyle={dimmed ? collectionListStyles.dimmedTitle : undefined}
      titleAccessory={
        entry.override ? (
          <Text testID={`${props.testID}.edited`} style={styles.edited}>
            {t('roles.settings.edited')}
          </Text>
        ) : undefined
      }
      subtitle={props.facts}
      icon={
        <HappierCollectionListMark dimmed={dimmed}>
          {props.mark}
        </HappierCollectionListMark>
      }
      onPress={props.onPress}
      {...(presentation === 'rail'
        ? {
            selected: props.selected === true,
            density: 'compact' as const,
            showChevron: false,
            pressableStyle: collectionListStyles.row,
          }
        : {})}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  edited: {
    ...Typography.rowMeta(),
    color: theme.colors.text.tertiary,
  },
}));
