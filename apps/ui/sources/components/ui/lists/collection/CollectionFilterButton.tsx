import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { t } from '@/text';

/**
 * A list's filter button (lab `clfilter:filter`, `spfield` B): the funnel that opens the condition editor. It
 * ends the list's search field where there is one (Sessions' Find, a Settings column's search, the Store), else
 * it stands in the header actions (Workflows, Discussions). What is on is said by the token line under it, so
 * the funnel draws no count; its name still says how many.
 */
export const CollectionFilterButton = React.memo(function CollectionFilterButton(
  props: Readonly<{
    testID: string;
    activeCount: number;
    open: boolean;
    onPress: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const label =
    props.activeCount > 0
      ? t('sessionsList.filterButtonActive', { count: props.activeCount })
      : t('sessionsList.filterButton');
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      expanded={props.open}
      hasPopup="dialog"
      onPress={props.onPress}
      style={(state) => [
        {
          width: 30,
          height: 30,
          borderRadius: 8,
          alignItems: 'center',
          justifyContent: 'center',
        },
        props.open || state.hovered || state.pressed
          ? { backgroundColor: theme.colors.surface.selected }
          : null,
      ]}
    >
      <Icon name="funnel-simple" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
    </HappierPressable>
  );
});
