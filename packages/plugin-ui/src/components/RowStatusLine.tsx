import type { ComponentProps, ReactElement } from 'react';

import { useOptionalHappierUiTypography } from '../environment/context.js';
import { HappierSpinner } from '../presentation/feedback/Spinner.js';
import { HappierTextLinkButton } from '../presentation/interaction/TextLinkButton.js';
import { HAPPIER_PAGE_TEXT, happierPageTextMetrics, resolveHappierPageTextStyle, resolveHappierTextStepStyle } from '../presentation/layout/pageText.js';
import {
  HappierRowStatusLine,
  type HappierRowStatusLineContentProps,
  type HappierRowStatusTone,
  type HappierRowStatusAction,
} from '../presentation/status/RowStatusLine.js';
import { HappierStatusDot } from '../presentation/status/StatusDot.js';
import { HappierText } from '../presentation/text/Text.js';
import { usePluginTheme } from './PluginUiProvider.js';

export type RowStatusTone = HappierRowStatusTone;
export type RowStatusAction = HappierRowStatusAction;
export type RowStatusLineProps = HappierRowStatusLineContentProps;

function LinkText(props: ComponentProps<ComponentProps<typeof HappierTextLinkButton>['Text']>): ReactElement {
  return <HappierText {...props} />;
}

/**
 * Quiet row metadata; trouble adds colour and a dot, and work may retain one recovery link. A run's line can
 * lead with its command in mono (`yarn lint · Exited with code 1`), and a row whose mark already shows the
 * state passes `marked` to keep the tone without the dot.
 */
export function RowStatusLine(props: RowStatusLineProps): ReactElement {
  const theme = usePluginTheme();
  const typography = useOptionalHappierUiTypography();
  const metrics = happierPageTextMetrics('rowDescription');
  const textStyle = resolveHappierPageTextStyle('rowDescription', typography);
  const actionStyle = {
    ...resolveHappierTextStepStyle({ ...HAPPIER_PAGE_TEXT.rowDescription, weight: 'semiBold' }, typography),
    ...metrics,
    color: theme.colors.text,
  };
  return <HappierRowStatusLine {...props} host={{
    colors: { quiet: theme.colors.secondaryText, warn: theme.colors.warning, bad: theme.colors.danger },
    actionGap: theme.spacing.small,
    renderBusy: ({ size }) => <HappierSpinner size={size} color={theme.colors.mutedText} style={{ width: size, height: size }} />,
    renderIndicator: ({ size, color }) => <HappierStatusDot size={size} color={color} />,
    renderText: ({ text, numberOfLines, style, mono }) => <HappierText tabularNumbers numberOfLines={numberOfLines}
      style={{ ...textStyle, ...(mono && theme.typography.code.fontFamily ? { fontFamily: theme.typography.code.fontFamily } : null), ...style }}>{text}</HappierText>,
    renderAction: (action) => <HappierTextLinkButton {...action} Text={LinkText} labelStyle={actionStyle} hoverColor={theme.colors.text} focusColor={theme.colors.accent} />,
  }} />;
}
