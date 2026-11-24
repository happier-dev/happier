import type { ReactElement, ReactNode } from 'react';

import { HAPPIER_SPACE_STEPS } from '../environment/spacing.js';
import { HappierStack } from '../presentation/layout/Layout.js';
import type { HappierStyleProp } from '../presentation/portableTypes.js';
import { HappierText } from '../presentation/text/Text.js';
import { AnsiText, type AnsiTextProps } from './AnsiText.js';

export type LogLineProps = Readonly<{
  /**
   * The line's leading column: its number in a native log, its clock in a captured one. LogLine draws it as
   * the quiet, tabular gutter every log shares; `minChars` keeps a column of them right-aligned.
   */
  gutter?: Readonly<{ value: string; minChars?: number }>;
  /** Further source-owned columns after the gutter, such as a severity and a service; LogLine spaces them. */
  prefix?: ReactNode;
  prefixTestID?: string;
  /** Supply plainText for a structured log or pre-tokenized text for terminal output. */
  message?: Pick<AnsiTextProps, 'plainText' | 'tokens' | 'ranges' | 'tone' | 'selectable'>;
  testID?: string;
  messageTestID?: string;
  style?: HappierStyleProp;
}>;

/** One step between the gutter, each prefix column and the message; one line's breath above and below. */
const LOG_LINE_GAP = HAPPIER_SPACE_STEPS.s12;
const LOG_LINE_RHYTHM = Object.freeze({ paddingVertical: HAPPIER_SPACE_STEPS.s2 });
/** About one monospaced digit at the code size, so a gutter of n characters holds n digits. */
const LOG_LINE_GUTTER_CHAR_PX = HAPPIER_SPACE_STEPS.s8;

/**
 * One log row, the same in every log: a muted tabular gutter, the source's own columns, then the message,
 * which wraps in its own column. Lines stack flush; the row owns the rhythm between them.
 */
export function LogLine({ gutter, prefix, prefixTestID, message, testID, messageTestID, style }: LogLineProps): ReactElement {
  return (
    <HappierStack direction="horizontal" align="flex-start" gap={LOG_LINE_GAP} testID={testID} style={[LOG_LINE_RHYTHM, style]}>
      {(gutter !== undefined || prefix !== undefined) && (
        <HappierStack direction="horizontal" align="flex-start" gap={LOG_LINE_GAP} testID={prefixTestID}>
          {gutter && (
            <HappierText
              variant="code"
              tone="muted"
              tabularNumbers
              style={gutter.minChars ? { minWidth: gutter.minChars * LOG_LINE_GUTTER_CHAR_PX, textAlign: 'right' } : undefined}
            >
              {gutter.value}
            </HappierText>
          )}
          {prefix}
        </HappierStack>
      )}
      {message && (
        <HappierStack grow testID={messageTestID}>
          <AnsiText {...message} />
        </HappierStack>
      )}
    </HappierStack>
  );
}
