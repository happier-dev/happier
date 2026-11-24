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
 * The lead (gutter and prefix columns) keeps its words together on its line. The message wants at least half the
 * line beside it; where the lead leaves less (a phone), the message moves under the whole lead at the full width,
 * so a source column (a service name) is never orphaned on a line of its own and the message is never squeezed.
 */
const LOG_LINE_LEAD: HappierStyleProp = Object.freeze({ flexShrink: 1, minWidth: 0 });
const LOG_LINE_MESSAGE: HappierStyleProp = Object.freeze({ flexBasis: '50%', minWidth: 0 });
/** A message moved under its lead stays with it: one small step, not the column gap. */
const LOG_LINE_WRAPPED: HappierStyleProp = Object.freeze({ rowGap: HAPPIER_SPACE_STEPS.s2 });

/**
 * One log row, the same in every log: a muted tabular gutter, the source's own columns, then the message,
 * which wraps in its own column. Lines stack flush; the row owns the rhythm between them.
 */
export function LogLine({ gutter, prefix, prefixTestID, message, testID, messageTestID, style }: LogLineProps): ReactElement {
  return (
    <HappierStack direction="horizontal" align="flex-start" gap={LOG_LINE_GAP} wrap testID={testID}
      style={[LOG_LINE_RHYTHM, LOG_LINE_WRAPPED, style]}>
      {(gutter !== undefined || prefix !== undefined) && (
        <HappierStack direction="horizontal" align="flex-start" gap={LOG_LINE_GAP} wrap testID={prefixTestID} style={LOG_LINE_LEAD}>
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
        <HappierStack grow testID={messageTestID} style={LOG_LINE_MESSAGE}>
          <AnsiText {...message} />
        </HappierStack>
      )}
    </HappierStack>
  );
}
