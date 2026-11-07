import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_COLLECTION_ROW_METRICS,
  HappierCollectionRowContent,
  resolveHappierCollectionRowLineMetrics,
  resolveHappierCollectionRowTitleMetrics,
  type HappierCollectionRowContentProps,
  type HappierCollectionRowDensity,
} from '@happier-dev/plugin-ui/presentation';

import { Text, type AppTextProps } from '@/components/ui/text/Text';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Typography } from '@/constants/Typography';
import { useIsTablet, usePresentationWindowDimensions } from '@/utils/platform/responsive';
import { VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX } from '@/utils/platform/viewportClass';

export type { HappierCollectionRowDensity as CollectionRowDensity };

/**
 * Happier core's binding of the shared work-row content (`HappierCollectionRowContent`, the one geometry owner):
 * the plane's selected chip and hover fills, and core's text owner for the title and quiet lines. Sessions,
 * Runs, scheduled work and the Settings previews draw their rows through it.
 */
export function CollectionRowContent(
  props: Omit<HappierCollectionRowContentProps, 'fills' | 'separator'>,
): React.ReactElement {
  const { theme } = useUnistyles();
  // The column's own row fills: the plane's selected chip and `Item`'s hover, as every navigation row draws them.
  const fills = React.useMemo(
    () => ({
      selected: theme.colors.surface.elevated,
      hover: theme.colors.surface.hover,
    }),
    [theme.colors.surface.elevated, theme.colors.surface.hover],
  );
  return (
    <HappierCollectionRowContent
      {...props}
      fills={fills}
    />
  );
}

/** Whether a compact row is drawn for a finger: a phone-width window, native or web. */
export function shouldUseTouchCompactRow(
  options: Readonly<{
    isTablet: boolean;
    platform: string;
    windowWidth?: number;
  }>,
): boolean {
  return (
    !options.isTablet &&
    (options.platform === 'ios' ||
      options.platform === 'android' ||
      (options.platform === 'web' &&
        options.windowWidth !== undefined &&
        options.windowWidth < VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX.tabletMin))
  );
}

/** A compact row on a phone-width window is drawn at the readable touch size, whichever kind of row it is. */
export function useTouchCompactRow(compact: boolean): boolean {
  const isTablet = useIsTablet();
  const { width: windowWidth } = usePresentationWindowDimensions();
  return (
    compact &&
    shouldUseTouchCompactRow({ isTablet, platform: Platform.OS, windowWidth })
  );
}

const styles = StyleSheet.create((theme) => ({
  // The title hugs its text so its qualifiers (a server, a reminder, a lead's progress) sit right after it.
  title: {
    ...Typography.default(),
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.text.secondary,
  },
  // News (needs you, failed, finished unseen) is medium (lab `clstatus`); the open row is semi-bold, since its
  // chip alone is too faint to carry the state.
  medium: { ...Typography.default('medium') },
  semiBold: { ...Typography.default('semiBold') },
  line: { ...Typography.default(), color: theme.colors.text.secondary },
}));

type RowTextProps = AppTextProps &
  Readonly<{
    density: HappierCollectionRowDensity;
    touchCompact?: boolean;
    textScale?: number;
  }>;

/** A row's title at its density: one line, two while text is scaled up so a long name stays readable. */
export function CollectionRowTitle({
  density,
  touchCompact,
  textScale,
  emphasis,
  color,
  style,
  ...props
}: RowTextProps &
  Readonly<{ emphasis?: 'medium' | 'semiBold'; color?: string }>): React.ReactElement {
  return (
    <Text
      {...props}
      numberOfLines={textScale && textScale > 1.1 ? 2 : 1}
      style={[
        styles.title,
        resolveHappierCollectionRowTitleMetrics(
          density,
          Platform.OS,
          touchCompact === true,
        ),
        emphasis ? styles[emphasis] : null,
        color ? { color } : null,
        style,
      ]}
    />
  );
}

/** A row's quiet line (its context, a status word) at its density. */
export function CollectionRowLine({
  density,
  touchCompact,
  textScale,
  style,
  ...props
}: RowTextProps): React.ReactElement {
  return (
    <Text
      {...props}
      numberOfLines={textScale && textScale > 1.1 ? 2 : 1}
      style={[
        styles.line,
        resolveHappierCollectionRowLineMetrics(density, Platform.OS, touchCompact === true),
        style,
      ]}
    />
  );
}

/**
 * One quiet qualifier on a row's title line (lab `clctx` `.bdg`): where the work runs — its Project, branch or
 * Machine — in the tertiary micro role, with an optional glyph. It yields width before the title does and
 * ellipsizes inside its own short width.
 */
export function CollectionRowBadge(props: Readonly<{ icon?: IconName; label: string; testID?: string }>): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <View testID={props.testID} style={badgeStyles.badge}>
      {props.icon ? <Icon name={props.icon} size={11} color={theme.colors.text.tertiary} /> : null}
      <Text variant="micro" numberOfLines={1} style={badgeStyles.label}>{props.label}</Text>
    </View>
  );
}

const badgeStyles = StyleSheet.create((theme) => ({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    // A qualifier yields twice as fast as the title but keeps its glyph and a few letters, so a narrow
    // column still reads the title first (lab `.bdg`: flex 0 2 auto, min 46, max 92).
    flexShrink: 2,
    minWidth: 46,
    maxWidth: 92,
    gap: 3,
  },
  label: { color: theme.colors.text.tertiary, flexShrink: 1, minWidth: 0 },
}));

/**
 * Content that belongs to the comfortable row above it (a Bot's readiness in the roster): it starts on the
 * row's title edge, past the identity column, so it reads as part of that row rather than a new one.
 */
export function CollectionRowFooter(
  props: Readonly<{
    children: React.ReactNode;
    testID?: string;
  }>,
) {
  return (
    <View
      testID={props.testID}
      style={footerStyles.footer}
    >
      {props.children}
    </View>
  );
}

const M = HAPPIER_COLLECTION_ROW_METRICS;
const footerStyles = StyleSheet.create((theme) => ({
  footer: {
    paddingLeft:
      M.padding.comfortable +
      M.identity.comfortable.slotSize +
      M.contentGap.comfortable,
    paddingRight: M.padding.comfortable,
    // Tucks under the row's own last line instead of starting a new row's rhythm.
    marginTop: -theme.space.s8,
    paddingBottom: theme.space.s10,
  },
}));
