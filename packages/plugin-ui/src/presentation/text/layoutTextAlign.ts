import { I18nManager } from 'react-native';

import { useOptionalHappierUiLocalization } from '../../environment/context.js';

const LAYOUT_TEXT_LEFT = Object.freeze({ textAlign: 'left' as const });
const LAYOUT_TEXT_RIGHT = Object.freeze({ textAlign: 'right' as const });

/**
 * The text alignment of a title that stands beside its mark (a page header's title, a collection row's title): the
 * layout's own start side. Each text keeps its own reading order (`dir="auto"`), so a title whose first word is Arabic
 * or Hebrew still reads right to left, but it starts on the page's edge beside its mark instead of the far side of an
 * LTR row, which is where the text's own direction would put it.
 */
export function useHappierLayoutTextAlign():
  | typeof LAYOUT_TEXT_LEFT
  | typeof LAYOUT_TEXT_RIGHT {
  const localization = useOptionalHappierUiLocalization();
  const rtl = localization
    ? localization.direction === 'rtl'
    : I18nManager.isRTL;
  return rtl ? LAYOUT_TEXT_RIGHT : LAYOUT_TEXT_LEFT;
}
