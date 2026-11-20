import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';

export type RelayChoiceAction = Readonly<{
  id: string;
  title: string;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}>;

/**
 * A Home choice's own operations, beside its card rather than inside the choice (option F cards): Retry for a Home that
 * could not be reached, and the "…" of a saved Home (retry, remove).
 */
export const RelayChoiceActions = React.memo(function RelayChoiceActions(
  props: Readonly<{
    testID: string;
    retry?: Readonly<{ testID: string; title: string; onPress: () => void }>;
    menuActions?: ReadonlyArray<RelayChoiceAction>;
  }>,
) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuActions = props.menuActions ?? [];
  const menuItems = React.useMemo(
    () =>
      menuActions.map((action) => ({
        id: action.id,
        title: action.title,
        disabled: action.disabled,
      })),
    [menuActions],
  );
  if (!props.retry && menuItems.length === 0) return null;
  return (
    <View style={styles.root}>
      {props.retry ? (
        <RoundButton
          testID={props.retry.testID}
          size="small"
          display="inverted"
          title={props.retry.title}
          onPress={props.retry.onPress}
        />
      ) : null}
      {menuItems.length > 0 ? (
        <DropdownMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          items={menuItems}
          onSelect={(itemId) => {
            menuActions.find((action) => action.id === itemId)?.onPress();
            setMenuOpen(false);
          }}
          placement="left"
          matchTriggerWidth={false}
          variant="slim"
          trigger={({ toggle }) => (
            <IconButton
              testID={`${props.testID}-menu`}
              accessibilityLabel={t('common.more')}
              iconName="dots-three"
              variant="plain"
              onPress={toggle}
            />
          )}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
}));
