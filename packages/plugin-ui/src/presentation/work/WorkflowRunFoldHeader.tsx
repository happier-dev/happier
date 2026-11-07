import * as React from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { HappierPressable } from '../interaction/Pressable.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from '../interaction/pressFeedback.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { isHappierPageRowNarrow, isHappierPageRowAccessoryStacked } from '../layout/pageMetrics.js';
import type { HappierDisclosureHeaderState } from '../collection/Disclosure.js';
import type { HappierPortableStyle, HappierTextHostProps } from '../portableTypes.js';

export type HappierWorkflowRunFoldPresentation = Readonly<{
  verb: string;
  details: readonly string[];
  meta: string | null;
}>;

/** Exact theme facts supplied by core or the mounted public component adapter. */
export type HappierWorkflowRunFoldHeaderTheme = Readonly<{
  colors: Readonly<{ text: Readonly<{ primary: string; secondary: string; tertiary: string }>; border: Readonly<{ focus: string }> }>;
  borderStyle: Readonly<{ borderColor: string; borderWidth: number }>;
  space: Readonly<Record<'s2' | 's4' | 's6' | 's8' | 's10', number>>;
  borderRadius: Readonly<{ md: number; lg: number }>;
}>;

type FoldTextStyle = Pick<HappierPortableStyle, 'fontFamily' | 'fontSize' | 'lineHeight' | 'fontWeight' | 'letterSpacing'>;
export type HappierWorkflowRunFoldHeaderHost = Readonly<{
  Text: React.ComponentType<HappierTextHostProps>;
  textStyle: Readonly<{ meta: FoldTextStyle; strong: FoldTextStyle; action: FoldTextStyle }>;
  renderCaret(expanded: boolean): React.ReactNode;
}>;

export type HappierWorkflowRunFoldHeaderProps = Readonly<{
  runId: string;
  disclosure: Readonly<{ expanded: boolean; headerProps: HappierDisclosureHeaderState['headerProps'] }> | null;
  presentation: HappierWorkflowRunFoldPresentation;
  /** Already-admitted purpose or identity mark. */
  leading?: React.ReactNode;
  onOpen: (() => void) | null;
  openLabel: string;
  actions?: React.ReactNode;
  theme: HappierWorkflowRunFoldHeaderTheme;
  host: HappierWorkflowRunFoldHeaderHost;
}>;

/**
 * The one in-thread band for a managed Workflow Run: its purpose glyph, what it is and how it ended, and
 * Open. A Session transcript folds the Run's turns under it; a Discussion shows it under the message that
 * started the Run, with Another round when the Run offers it.
 */
export function HappierWorkflowRunFoldHeader(props: HappierWorkflowRunFoldHeaderProps) {
  const { theme, host } = props;
  const Text = host.Text;
  const styles = React.useMemo(() => createStyles(theme, host.textStyle), [theme, host.textStyle]);
  const [headerWidth, setHeaderWidth] = React.useState<number | null>(null);
  const [actionsWidth, setActionsWidth] = React.useState<number | null>(null);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    setHeaderWidth(event.nativeEvent.layout.width);
  }, []);
  const onActionsLayout = React.useCallback((event: LayoutChangeEvent) => {
    setActionsWidth(event.nativeEvent.layout.width);
  }, []);
  const narrow = isHappierPageRowNarrow(headerWidth);
  const open = props.onOpen;
  const hasActions = props.actions != null;
  // The row's operations never squeeze out what the Run is: by the page row rule for operations they
  // move beneath the line when they would leave it less than its label column. Open, short, stays.
  const stacked = hasActions && isHappierPageRowAccessoryStacked({
    kind: 'operation',
    rowWidthPx: headerWidth,
    accessoryWidthPx: actionsWidth,
  });
  const { verb, details, meta } = props.presentation;
  const line = [verb, ...details].join(' · ');
  // The outcome is the fact the row exists for: on a narrow row it wraps rather than ellipsizes, and the
  // trailing workflow/trigger fact is what gives way.
  const summary = (
    <>
      <View style={styles.glyph}>{props.leading}</View>
      <Text
        numberOfLines={narrow || stacked ? 3 : 1}
        ellipsizeMode="tail"
        style={styles.line}
      >
        <Text style={styles.verb}>{verb}</Text>
        {details.map((part, index) => (
          <Text key={index} style={styles.detail}>{` · ${part}`}</Text>
        ))}
      </Text>
      {meta && !narrow && !stacked ? (
        <Text numberOfLines={1} ellipsizeMode="tail" style={styles.meta}>
          {meta}
        </Text>
      ) : null}
    </>
  );
  const { disclosure } = props;
  const openAction = open ? (
    <HappierPressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={`${props.openLabel}: ${verb}`}
      testID={`workflow-run-fold-open:${props.runId}`}
      style={({ pressed, focused }) => [
        styles.open,
        pressed
          ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle }
          : null,
        happierFocusRingStyle({ visible: focused, color: theme.colors.border.focus }),
      ]}
    >
      <Text style={styles.openLabel}>{props.openLabel}</Text>
    </HappierPressable>
  ) : null;
  // Measured only inline: that is the cluster's natural width the stacking rule compares.
  const actions = stacked ? null : (
    <View style={styles.actions} onLayout={onActionsLayout}>
      {props.actions}
      {openAction}
    </View>
  );
  return (
    <View
      style={[styles.header, stacked ? styles.headerStacked : null]}
      onLayout={onLayout}
    >
      <View style={styles.summaryRow}>
        {disclosure ? (
          <HappierPressable
            {...disclosure.headerProps}
            expanded={disclosure.expanded}
            accessibilityLabel={line}
            testID={`workflow-run-fold-toggle:${props.runId}`}
            style={({ pressed, focused }) => [
              styles.toggle,
              pressed
                ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle }
                : null,
              happierFocusRingStyle({ visible: focused, color: theme.colors.border.focus }),
            ]}
          >
            {summary}
          </HappierPressable>
        ) : (
          <View style={styles.toggle} testID={`workflow-run-fold:${props.runId}`}>
            {summary}
          </View>
        )}
        {stacked ? openAction : actions}
        {disclosure ? (
          // The caret ends the row, past the action. It repeats the row toggle for the pointer only; keyboard
          // and assistive technology reach the one toggle above.
          <View aria-hidden style={styles.caretHost}>
            <HappierPressable
              onPress={disclosure.headerProps.onPress}
              tabIndex={-1}
              style={styles.caret}
            >
              {host.renderCaret(disclosure.expanded)}
            </HappierPressable>
          </View>
        ) : null}
      </View>
      {stacked ? <View style={styles.actionsStacked}>{props.actions}</View> : null}
    </View>
  );
}

const FOLD_ROW_HEIGHT = 36;

function createStyles(theme: HappierWorkflowRunFoldHeaderTheme, textStyle: HappierWorkflowRunFoldHeaderHost['textStyle']) {
  return StyleSheet.create({
  header: {
    minHeight: FOLD_ROW_HEIGHT,
    borderRadius: theme.borderRadius.lg,
    ...theme.borderStyle,
    paddingLeft: theme.space.s10,
    paddingRight: theme.space.s8,
  },
  headerStacked: { paddingBottom: theme.space.s6 },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: FOLD_ROW_HEIGHT,
    gap: theme.space.s8,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: theme.space.s8,
  },
  // Beneath the line, starting under it; wraps rather than overflowing the column.
  actionsStacked: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8 },
  toggle: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minHeight: FOLD_ROW_HEIGHT,
    paddingVertical: theme.space.s4,
    borderRadius: theme.borderRadius.md,
  },
  glyph: { flexShrink: 0 },
  line: {
    ...textStyle.meta,
    color: theme.colors.text.secondary,
    flexShrink: 1,
    minWidth: 0,
  },
  verb: {
    ...textStyle.strong,
    color: theme.colors.text.primary,
  },
  detail: { ...textStyle.meta, color: theme.colors.text.secondary },
  meta: {
    ...textStyle.meta,
    color: theme.colors.text.tertiary,
    flexShrink: 1000,
    minWidth: 0,
    marginLeft: 'auto',
  },
  open: {
    minHeight: FOLD_ROW_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: theme.space.s8,
    borderRadius: theme.borderRadius.md,
  },
  openLabel: {
    ...textStyle.action,
    color: theme.colors.text.primary,
  },
  caretHost: { flexShrink: 0 },
  caret: {
    minHeight: FOLD_ROW_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: theme.space.s2,
  },
  });
}
