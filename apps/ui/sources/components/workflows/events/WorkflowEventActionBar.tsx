import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { HEADER_BAND_HORIZONTAL_PADDING_PX } from '@/components/ui/layout/headerBand';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export type WorkflowEventMenuItem = DropdownMenuItem &
  Readonly<{ run: () => void }>;

/** An event's ⋯: what it allows beyond its one primary, in the menu every event host shares. */
export function WorkflowEventMoreMenu(
  props: Readonly<{
    items: readonly WorkflowEventMenuItem[];
    /** The event's title, read with the ⋯ by assistive technology. */
    hint: string;
    /** Where a builder or editor the menu opens hangs from. */
    anchorRef: React.Ref<View>;
    testID: string;
  }>,
) {
  const [open, setOpen] = React.useState(false);
  const { items } = props;
  return (
    <View ref={props.anchorRef} collapsable={false}>
      <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        items={items.map(({ run: _run, ...item }) => ({
          ...item,
          testID: `${props.testID}:${item.id}`,
        }))}
        onSelect={(id) => items.find((item) => item.id === id)?.run()}
        placement="auto"
        matchTriggerWidth={false}
        trigger={({ open: shown, toggle }) => (
          <IconButton
            testID={props.testID}
            iconName="dots-three"
            variant="plain"
            accessibilityRole="button"
            accessibilityLabel={t('common.moreActions')}
            accessibilityHint={props.hint}
            onPress={toggle}
            expanded={shown}
            hasPopup="menu"
          />
        )}
      />
    </View>
  );
}

/**
 * A phone surface's foot for one event (lab `events:A:selected` 390, `companion:v:open` 390): ⋯ leads and the one
 * primary takes the rest of the bar, within reach of a thumb; a line about what the primary does may stand above.
 */
export function WorkflowEventActionBar(
  props: Readonly<{
    more: React.ReactNode;
    primary: React.ReactNode;
    note?: string | null;
    testID: string;
  }>,
) {
  return (
    <View testID={props.testID} style={styles.bar}>
      {props.note ? (
        <Text
          testID={`${props.testID}:note`}
          variant="meta"
          style={styles.note}
        >
          {props.note}
        </Text>
      ) : null}
      <View style={styles.row}>
        {props.more}
        <View style={styles.primary}>{props.primary}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // A hairline over the content, the actions on the head's band edge.
  bar: {
    gap: theme.space.s8,
    paddingHorizontal: HEADER_BAND_HORIZONTAL_PADDING_PX,
    paddingTop: theme.space.s8,
    paddingBottom: theme.space.s12,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border.divider,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  primary: { flex: 1, minWidth: 0 },
  note: { color: theme.colors.text.secondary },
}));
