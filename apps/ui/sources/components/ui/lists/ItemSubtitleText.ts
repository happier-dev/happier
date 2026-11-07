import React from 'react';
import type { StyleProp, TextStyle } from 'react-native';

/**
 * The row's own subtitle text style (role size, line height and ink, stepped down when the row is
 * dimmed). A composed subtitle (an element rather than a string) reads it so its text keeps the row's
 * subtitle role instead of falling back to the default text size and outweighing the title.
 */
const ItemSubtitleTextStyleContext =
  React.createContext<StyleProp<TextStyle> | null>(null);

export const ItemSubtitleTextStyleProvider =
  ItemSubtitleTextStyleContext.Provider;

export function useItemSubtitleTextStyle(): StyleProp<TextStyle> | null {
  return React.useContext(ItemSubtitleTextStyleContext);
}
