import { useMemo, type ReactElement } from 'react';
import { View } from 'react-native';

import { useOptionalHappierUiLocalization, useOptionalHappierUiTypography } from '../../environment/context.js';
import { formatHappierDataValue } from '../data/dataModel.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierTextLinkButton } from '../interaction/TextLinkButton.js';
import { HappierText } from '../text/Text.js';
import { resolveHappierTypeRoleStyle } from '../text/typeRole.js';

/** A list leads with its first rows; a long tail stays one press away, never a wall. */
const LEADING_ROWS = 6;
/** A tail this short is shown whole: a disclosure for a row or two is only noise. */
const SHORT_TAIL_ROWS = 2;

/**
 * The rows a bounded list draws: all of them when expanded or when the tail is short, otherwise its
 * leading rows. The caller owns the order; `hidden` is how many sit behind the footer's Show all.
 */
export function leadHappierListRows<Row>(
  rows: readonly Row[],
  expanded: boolean,
): Readonly<{ rows: readonly Row[]; hidden: number }> {
  if (expanded || rows.length <= LEADING_ROWS + SHORT_TAIL_ROWS)
    return { rows, hidden: 0 };
  return {
    rows: rows.slice(0, LEADING_ROWS),
    hidden: rows.length - LEADING_ROWS,
  };
}

export type HappierListOverflowFooterLabels = Readonly<{
  /** "Show all" — followed by the listed total. */
  showAll?: string;
  /** Said instead of Show all when the source returned only part of the list. */
  showAvailable?: string;
  showLess?: string;
}>;

export type HappierListOverflowFooterProps = Readonly<{
  theme: HappierUiTheme;
  /** What the list is, for the toggle's accessible name ("Projections: Show all · 12"). */
  label: string;
  /** Rows the list holds (shown and folded). */
  total: number;
  /** Rows folded behind Show all right now; 0 while expanded or when the list is short. */
  hidden: number;
  expanded: boolean;
  onToggle: () => void;
  /** False when the source returned only part of the list: the toggle says it shows what is available. */
  complete?: boolean;
  /** The one sentence about what the list cannot show ("10 windows not reported"), said once beside the toggle. */
  unlisted?: string | null;
  labels?: HappierListOverflowFooterLabels;
  testID?: string;
}>;

/**
 * The one footer under a bounded list: the Show all · N / Show less disclosure and, beside it, what is
 * not in the list at all, each said once. Nothing is drawn when there is nothing to fold or report.
 */
export function HappierListOverflowFooter(
  props: HappierListOverflowFooterProps,
): ReactElement | null {
  const typography = useOptionalHappierUiTypography();
  const locale = useOptionalHappierUiLocalization()?.locale;
  const styles = useMemo(() => {
    const meta = resolveHappierTypeRoleStyle('meta', props.theme, typography);
    const link = resolveHappierTypeRoleStyle(
      'meta',
      props.theme,
      typography,
      'semiBold',
    );
    return {
      link: {
        ...link,
        lineHeight:
          link.lineHeight ??
          meta.lineHeight ??
          props.theme.typography.body.lineHeight,
        color: props.theme.colors.secondaryText,
      },
      note: { ...meta, color: props.theme.colors.mutedText },
    };
  }, [props.theme, typography]);
  const foldable = props.hidden > 0 || props.expanded;
  const unlisted = props.unlisted ? props.unlisted : null;
  if (!foldable && !unlisted) return null;
  const labels = props.labels ?? {};
  const toggle = props.expanded
    ? (labels.showLess ?? 'Show less')
    : `${props.complete === false ? (labels.showAvailable ?? 'Show available') : (labels.showAll ?? 'Show all')} · ${formatHappierDataValue(props.total, locale)}`;
  return (
    <View
      testID={props.testID}
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        columnGap: props.theme.spacing.small,
        rowGap: props.theme.spacing.xsmall,
      }}
    >
      {foldable ? (
        <HappierTextLinkButton
          label={toggle}
          accessibilityLabel={`${props.label}: ${toggle}`}
          expanded={props.expanded}
          onPress={props.onToggle}
          testID={props.testID ? `${props.testID}.toggle` : undefined}
          Text={HappierText}
          labelStyle={styles.link}
          hoverColor={props.theme.colors.text}
          focusColor={props.theme.colors.focus}
        />
      ) : null}
      {foldable && unlisted ? (
        <HappierText
          style={styles.note}
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          ·
        </HappierText>
      ) : null}
      {unlisted ? (
        <HappierText
          style={styles.note}
          tabularNumbers
          testID={props.testID ? `${props.testID}.unlisted` : undefined}
        >
          {unlisted}
        </HappierText>
      ) : null}
    </View>
  );
}
