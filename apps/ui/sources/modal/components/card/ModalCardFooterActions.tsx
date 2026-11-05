import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { useSheetDismiss } from './sheetDragDismiss';

/**
 * The one footer of a short card form (anchored sheet, lab flows `form`/`sel`): Cancel quietly at the start,
 * an optional consequence note beside it, the actions at the end with the primary last. On a phone sheet the
 * grabber, drag and close already dismiss it, so Cancel and the note step aside and the actions take the width
 * above the home indicator.
 */
export function ModalCardFooterActions(
  props: Readonly<{
    cancel?: Readonly<{
      onPress: () => void;
      testID?: string;
      disabled?: boolean;
    }>;
    note?: string | null;
    noteTestID?: string;
    children?: React.ReactNode;
  }>,
): React.ReactElement {
  const phoneSheet = useSheetDismiss() !== null;
  if (phoneSheet) {
    return (
      <View style={styles.phoneRow}>
        {React.Children.map(props.children, (child) =>
          child == null || child === false ? null : (
            <View style={styles.phoneAction}>{child}</View>
          ),
        )}
      </View>
    );
  }
  return (
    <View style={styles.row}>
      {props.cancel ? (
        <RoundButton
          testID={props.cancel.testID}
          display="inverted"
          title={t('common.cancel')}
          disabled={props.cancel.disabled}
          onPress={props.cancel.onPress}
        />
      ) : null}
      <View style={styles.lead}>
        {props.note ? (
          <Text
            testID={props.noteTestID}
            variant="meta"
            numberOfLines={1}
            style={styles.note}
          >
            {props.note}
          </Text>
        ) : null}
      </View>
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  lead: {
    flex: 1,
    minWidth: 0,
  },
  note: {
    color: theme.colors.text.secondary,
  },
  phoneRow: {
    flexDirection: 'row',
    gap: theme.space.s8,
  },
  phoneAction: {
    flex: 1,
  },
}));
