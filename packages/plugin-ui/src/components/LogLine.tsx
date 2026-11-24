import type { ReactElement, ReactNode } from 'react';

import { HappierStack } from '../presentation/layout/Layout.js';
import type { HappierStyleProp } from '../presentation/portableTypes.js';
import { AnsiText, type AnsiTextProps } from './AnsiText.js';

export type LogLineProps = Readonly<{
  /** Source-owned metadata, such as a line number or a timestamp and severity. */
  prefix?: ReactNode;
  /** Supply plainText for a structured log or pre-tokenized text for terminal output. */
  message?: Pick<AnsiTextProps, 'plainText' | 'tokens' | 'ranges' | 'tone' | 'selectable'>;
  testID?: string;
  messageTestID?: string;
  style?: HappierStyleProp;
}>;

/** One log row. Its message wraps in its own column alongside the source metadata. */
export function LogLine({ prefix, message, testID, messageTestID, style }: LogLineProps): ReactElement {
  return (
    <HappierStack direction="horizontal" align="flex-start" testID={testID} style={style}>
      {prefix}
      {message && (
        <HappierStack grow testID={messageTestID}>
          <AnsiText {...message} />
        </HappierStack>
      )}
    </HappierStack>
  );
}
