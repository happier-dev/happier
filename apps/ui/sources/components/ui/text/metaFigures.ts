import type { TextStyle } from 'react-native';

const HYPHENATED_TEXT = /\S-\S/;
const PROPORTIONAL_FIGURES: TextStyle = { fontVariant: ['proportional-nums'] };

/**
 * Meta columns use tabular figures so counts and times line up. Inter's tabular figures set a hyphen on a
 * figure-wide cell too ("NLDW3 - 5 - 36 - 33"), so a hyphenated name, id or date keeps its natural figures:
 * put this after the column's tabular style.
 */
export function metaFigureStyle(text: string | number | null | undefined): TextStyle | null {
    return typeof text === 'string' && HYPHENATED_TEXT.test(text) ? PROPORTIONAL_FIGURES : null;
}
