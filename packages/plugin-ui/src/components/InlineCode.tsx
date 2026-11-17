import type { ReactElement, ReactNode } from 'react';

import {
  HappierInlineCode,
  type HappierInlineCodeTextProps,
} from '../presentation/text/InlineCode.js';
import { HappierText } from '../presentation/text/Text.js';
import { usePluginTheme } from './PluginUiProvider.js';

export type InlineCodeProps = Readonly<{
  /** The command, flag or identifier itself; it is never translated. */
  children: ReactNode;
  testID?: string;
}>;

/**
 * A command, flag or identifier inside a sentence, set in the same chip Happier's own guidance draws
 * ("Run `happier` on that computer"). Place it inside a `Text` or a rich `ItemGroup` description; the
 * prose around it stays localized.
 */
export function InlineCode(props: InlineCodeProps): ReactElement {
  const theme = usePluginTheme();
  const fontFamily = theme.typography.code.fontFamily;
  return (
    <HappierInlineCode
      Text={InlineCodeText}
      {...(fontFamily ? { fontFamily } : {})}
      ink={theme.colors.text}
      fill={theme.colors.elevatedSurface}
      paddingHorizontalPx={theme.spacing.xsmall}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      {props.children}
    </HappierInlineCode>
  );
}

/** The plugin text owner, so the chip follows the surface's text scale. */
function InlineCodeText(props: HappierInlineCodeTextProps): ReactElement {
  return (
    <HappierText
      {...{ dataSet: props.dataSet }}
      style={props.style}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      {props.children}
    </HappierText>
  );
}
