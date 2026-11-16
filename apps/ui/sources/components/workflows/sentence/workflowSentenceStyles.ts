import { StyleSheet } from 'react-native-unistyles';

/**
 * The sentence's layout (lab round 1116c `.sv`, `.svl`): one clause per line, words and chips wrapping
 * like prose within it. The trigger owner's When lines and the view's own lines share it.
 */
export const workflowSentenceStyles = StyleSheet.create((theme) => ({
  sentence: {
    gap: theme.space.s8,
  },
  line: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space.s6,
    rowGap: theme.space.s8,
    minWidth: 0,
  },
}));
