import * as React from 'react';
import type { AccessibilityRole, StyleProp, TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
  HappierApprovalPromptChrome,
  resolveHappierWorkStatusGlyphColor,
  type HappierApprovalPromptTextRender,
} from '@happier-dev/plugin-ui/presentation';

import { readPluginUiHostTypography } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Icon } from '@/components/ui/icons/Icon';
import type { IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { projectWorkColors } from '@/components/work/status/workStatusTreatment';

const renderText: HappierApprovalPromptTextRender = (input) => (
  <Text style={input.style as StyleProp<TextStyle>} numberOfLines={input.numberOfLines}>{input.text}</Text>
);

/**
 * A room several approval cards share (the composer's attention tray). Each card reports the height it would
 * take; `boundFor` gives it its part of the room. Bounded, a card's facts scroll and its decision stays
 * pinned, so Approve and Reject never need a scroll to reach.
 */
export type ApprovalPromptRoom = Readonly<{
  boundFor: (cardId: string) => number;
  report: (cardId: string, heights: ApprovalPromptCardHeights | null) => void;
}>;
export type ApprovalPromptCardHeights = Readonly<{ natural: number; minimum: number }>;
export const ApprovalPromptRoomContext = React.createContext<ApprovalPromptRoom | null>(null);

/**
 * Shares `available` height between measured cards. Every card first gets its minimum (head and decision);
 * the room left goes to the cards with the fewest hidden facts first, so a short request shows whole and the
 * long one scrolls its facts. What no card can use stays unspent. When even the minimums do not fit, the
 * decisions cannot all be in view, so cutting facts would buy nothing: each card takes what the tray can show
 * and the tray scrolls between them.
 */
export function shareApprovalPromptRoom(available: number,
  heights: ReadonlyMap<string, ApprovalPromptCardHeights>): Map<string, number> {
  const bounds = new Map<string, number>();
  let spare = available;
  for (const [, card] of heights) spare -= card.minimum;
  for (const [cardId, card] of heights) {
    bounds.set(cardId, spare <= 0 ? Math.max(card.minimum, Math.min(card.natural, available)) : card.minimum);
  }
  if (spare <= 0) return bounds;
  const byExtra = [...heights].sort(([, a], [, b]) => (a.natural - a.minimum) - (b.natural - b.minimum));
  byExtra.forEach(([cardId, card], index) => {
    const fair = Math.max(0, spare) / (byExtra.length - index);
    const give = Math.floor(Math.min(card.natural - card.minimum, fair));
    bounds.set(cardId, card.minimum + give);
    spare -= give;
  });
  return bounds;
}

/**
 * The one anatomy of an in-transcript request for the person's decision: a shield, what is asked and
 * by whom, the exact facts it decides, then the decision. Every approval prompt card (Session permissions,
 * Action approvals, Session Action confirmations, Project setup consent) draws through this chrome; each owns only its
 * facts and its decision path.
 */
export const ApprovalPromptChrome = React.memo(function ApprovalPromptChrome(
  props: Readonly<{
    testID: string;
    title: string;
    /** One quiet line under the title (the request summary, who asked). */
    subtitle?: string | null;
    /**
     * `attention` (a request the person did not start): the shared needs-you ring and tint, and the glyph in its ink.
     * `danger` (an approved request whose effect failed): the same, in the trouble hue.
     */
    tone?: 'neutral' | 'attention' | 'danger';
    titleNumberOfLines?: number;
    subtitleNumberOfLines?: number;
    icon?: IconName;
    /** A compact control at the end of the header row (open the tool). */
    headerAccessory?: React.ReactNode;
    chrome?: 'card' | 'inline';
    /** Preserve a host body's own spacing when it meets the decision row. */
    bodyBottomInset?: number;
    accessibilityRole?: AccessibilityRole;
    /** The exact facts being decided; omitted when there are none. */
    children?: React.ReactNode;
    /** The decision row (or its settled outcome). */
    footer?: React.ReactNode;
  }>,
) {
  const { theme } = useUnistyles();
  const status = projectWorkColors(theme);
  const room = React.useContext(ApprovalPromptRoomContext);
  const cardId = React.useId();
  const report = room?.report;
  const onMeasure = React.useCallback((heights: ApprovalPromptCardHeights) => report?.(cardId, heights), [cardId, report]);
  React.useEffect(() => () => report?.(cardId, null), [cardId, report]);
  return (
    <HappierApprovalPromptChrome
      {...props}
      maxHeight={room ? room.boundFor(cardId) : undefined}
      onMeasure={room ? onMeasure : undefined}
      cardRadius={theme.parts.approvalCard.radius}
      spacing={{ small: theme.space.s8, medium: theme.space.s12 }}
      typography={readPluginUiHostTypography()}
      renderText={renderText}
      colors={{
        border: theme.colors.border.default,
        surface: theme.colors.surface.elevated,
        title: theme.colors.text.primary,
        subtitle: theme.colors.text.secondary,
        status,
      }}
      icon={<Icon name={props.icon ?? 'shield-check'} size={16}
        color={props.tone === 'attention' || props.tone === 'danger'
          ? resolveHappierWorkStatusGlyphColor(props.tone, status)
          : theme.colors.state.neutral.foreground} />}
    />
  );
});
