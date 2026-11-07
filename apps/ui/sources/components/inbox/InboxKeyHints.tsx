import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { useHardwareKeyboard } from '@/components/ui/selectionList/useHardwareKeyboard';
import { Text } from '@/components/ui/text/Text';
import {
  splitKeybindingLabel,
  KeyboardShortcutLabelsContext,
} from '@/keyboard/shortcutLabels';
import { t } from '@/text';

function Keys(props: Readonly<{ label: string }>) {
  return (
    <>
      {splitKeybindingLabel(props.label).map((key, index) => (
        <KeyHint key={`${key}-${index}`} label={key} />
      ))}
    </>
  );
}

/**
 * The Inbox's quiet key line (lab coordination P4): how to move, open the full page and close, as the
 * person has bound them. Shown only with a hardware keyboard and only for the keys that run here.
 */
export const InboxKeyHints = React.memo(function InboxKeyHints(
  props: Readonly<{
    /** An item is open beside the list: Return and Escape act on it. */
    itemOpen: boolean;
  }>,
) {
  const keyboard = useHardwareKeyboard();
  const labels = React.useContext(KeyboardShortcutLabelsContext);
  const previous = labels['inbox.item.previous'];
  const next = labels['inbox.item.next'];
  const open = labels['inbox.item.open'];
  const close = labels['inbox.item.close'];
  if (!keyboard || !previous || !next) return null;
  return (
    <View testID="inbox.key_hints" style={styles.row}>
      <View style={styles.hint}>
        <Keys label={previous} />
        <Keys label={next} />
        <Text variant="meta" style={styles.word}>{t('inbox.work.keyHints.move')}</Text>
      </View>
      {props.itemOpen && open ? (
        <View style={styles.hint}>
          <Keys label={open} />
          <Text variant="meta" style={styles.word}>{t('inbox.work.keyHints.fullPage')}</Text>
        </View>
      ) : null}
      {props.itemOpen && close ? (
        <View style={styles.hint}>
          <Keys label={close} />
          <Text variant="meta" style={styles.word}>{t('inbox.work.keyHints.close')}</Text>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    columnGap: theme.space.s16,
    rowGap: theme.space.s4,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s10,
  },
  hint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
  },
  word: {
    color: theme.colors.text.tertiary,
  },
}));
