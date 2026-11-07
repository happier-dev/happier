import * as React from 'react';

import { StyleSheet } from 'react-native-unistyles';
import {
  HappierCollectionAddMenu,
  type HappierCollectionAddMenuHost,
  type HappierCollectionAddMenuProps,
} from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { HEADER_ACTIONS_GAP_PX } from '@/components/ui/layout/PageHeaderEntityParts';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
  DropdownMenu,
  type DropdownMenuItem,
  type DropdownMenuSelection,
} from '@/components/ui/forms/dropdown/DropdownMenu';

export { COLLECTION_ADD_MENU_SEARCH_THRESHOLD } from '@happier-dev/plugin-ui/presentation';

/** Only platform/theme bindings; both core and public authors use the shared composition. */
export const CORE_COLLECTION_ADD_MENU_HOST: HappierCollectionAddMenuHost<DropdownMenuSelection> = {
  Menu: DropdownMenu,
  renderTrigger(props) {
    return <IconButton
      testID={props.testID}
      iconName="plus"
      accessibilityLabel={props.label}
      tooltip={props.label}
      tooltipHidden={props.open}
      variant="plain"
      // Sits in a header's action row beside the page's ⋯: their finger frames split the row's gap.
      interactiveTargetGapPx={HEADER_ACTIONS_GAP_PX}
      disabled={props.disabled}
      onPress={props.onPress}
    />;
  },
  Notice: function CollectionAddMenuNotice(props) {
    // A failed read the choices depend on is the shared line state at the menu rows' inset, recovered in place.
    if (props.action) {
      return <SurfaceStateCard
        testID={props.testID}
        size="line"
        lineDensity="menu"
        kind="warning"
        title={props.children}
        action={{ label: props.action.label, onPress: props.action.onPress, testID: `${props.testID}:action` }}
      />;
    }
    return <Text testID={props.testID} style={styles.notice}>{props.children}</Text>;
  },
};

/**
 * A collection's "+" as a grouped, searchable menu of what can be added (P8-R3, lab `s2svc:menu`): each entry a
 * bare mark, its name, one purpose line and how many are already added. Choosing one opens its draft in the
 * collection's detail; nothing is created by opening or choosing. Providers, Connected services and New pool share
 * this one composition over `DropdownMenu` (escape, outside press, focus return and the phone sheet are its own).
 */
export const CollectionAddMenu = React.memo(function CollectionAddMenu(
  props: Omit<HappierCollectionAddMenuProps<DropdownMenuSelection>, 'host' | 'items'> & Readonly<{
    items: readonly DropdownMenuItem[];
  }>,
) {
  return <HappierCollectionAddMenu {...props} host={CORE_COLLECTION_ADD_MENU_HOST} />;
});

const styles = StyleSheet.create((theme) => ({
  notice: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    paddingHorizontal: theme.space.s12,
    paddingTop: theme.space.s8,
    paddingBottom: theme.space.s4,
  },
}));
