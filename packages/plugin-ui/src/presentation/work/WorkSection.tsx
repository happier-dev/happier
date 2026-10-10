import { memo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { HappierSkeletonRows } from '../feedback/Skeleton.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { HappierPageSectionHeader, HappierPageSheet } from '../layout/PageSection.js';
import {
  HAPPIER_WORK_PANE_METRICS,
  resolveHappierWorkHost,
  useHappierWorkTheme,
  type HappierWorkHost,
  type HappierWorkTheme,
} from './workTheme.js';

/**
 * One section of a Work pane. Two anatomies, one frame:
 *
 * - `list` (default): a group of the live work list (Needs you, Working, …): a compact sentence-case
 *   title with a quiet tabular count, then its rows.
 * - `page`: a configuration section under the list (Triggers, Roles, Notes; lab `convo-W8/W9`): the
 *   configuration-surfaces section anatomy laid flat on the pane. A full-width hairline opens it; the
 *   header is title · quiet count · ⓘ · one icon action; its rows sit on the shared page sheet with
 *   no sheet, on the Work list's own inset and with no hairlines between them. Group its rows with
 *   `HappierPageSheetGroup` (a `HappierCollectionListGroupLabel` header); the sheet draws the light
 *   separator between groups.
 *
 * While the section's source is still hydrating it keeps its title and reserves skeleton rows of its
 * own shape rather than claiming it is empty.
 *
 * Extracted from Happier core's `apps/ui/sources/components/sessions/work/WorkSection.tsx`, which now
 * binds it to the app's theme, text owner, count wording and ⓘ control.
 */
export type HappierWorkSectionProps = Readonly<{
  testID: string;
  title: string;
  /**
   * Beside the title, quiet: the rows' count or the section's own summary ("5 on"), already worded.
   * Empty or omitted draws none; it is hidden while loading.
   */
  count?: string | null;
  /** `attention` draws the count in the needs-you treatment (a count of rows waiting on the person). */
  countTone?: 'quiet' | 'attention';
  /** Defaults to `${testID}-count`. */
  countTestID?: string;
  /** `list` (default): a group of the live work list. `page`: a configuration section of the pane. */
  anatomy?: 'list' | 'page';
  /** `page` only: the control that explains what the section is and applies to (an ⓘ), before `action`. */
  info?: ReactNode;
  loading?: boolean;
  /** Anchor for a route that scrolls to this section. */
  nativeID?: string;
  /** One quiet operation on the whole section ("+", ✎, "Use defaults"), at the header's trailing edge. */
  action?: ReactNode;
  children?: ReactNode;
  /** Explicit empty state from the source owner, never inferred from child count. */
  empty?: HappierWorkSectionEmptyLineProps;
  /** A caller-owned disclosure of retained rows below this section. */
  more?: HappierWorkDisclosureLineProps;
  /** The resolved reduced-motion preference for the loading skeleton; omitted, the environment's. */
  reducedMotion?: boolean;
  /** Omitted inside a mounted plugin surface: the environment's theme. */
  theme?: HappierWorkTheme;
  /** Omitted inside a mounted plugin surface: the environment's text. */
  host?: HappierWorkHost;
}>;

const LOADING_SKELETON_ROWS = 2;

const styles = StyleSheet.create({
  section: { gap: 2 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 8,
    paddingLeft: HAPPIER_WORK_PANE_METRICS.rowPaddingPx,
    paddingBottom: 4,
  },
  headerAction: { marginLeft: 'auto' },
  // A configuration section spans the whole pane so its hairline does; its content keeps the
  // pane's column.
  pageSection: {
    marginHorizontal: -HAPPIER_WORK_PANE_METRICS.contentInsetPx,
    paddingHorizontal: HAPPIER_WORK_PANE_METRICS.contentInsetPx,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 16,
  },
  pageHeader: { paddingTop: 0, paddingBottom: 12 },
  pageTitleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, minWidth: 0 },
  pageActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
});

export const HappierWorkSection = memo(function HappierWorkSection(props: HappierWorkSectionProps) {
  return props.anatomy === 'page' ? <WorkPageSection {...props} /> : <WorkListSection {...props} />;
});

function readCount(props: HappierWorkSectionProps): string | null {
  if (props.loading || props.count === null || props.count === undefined) return null;
  return props.count.length > 0 ? props.count : null;
}

function WorkListSection(props: HappierWorkSectionProps) {
  const theme = useHappierWorkTheme(props.theme);
  const { Text } = resolveHappierWorkHost(props.host);
  const count = readCount(props);
  const attention = props.countTone === 'attention';

  return (
    <View testID={props.testID} nativeID={props.nativeID} style={styles.section}>
      <View style={styles.header}>
        <Text role="sectionTitle" accessibilityRole="header" style={{ color: theme.colors.text }}>{props.title}</Text>
        {count === null ? null : (
          <Text
            role="sectionCount"
            strong={attention}
            testID={props.countTestID ?? `${props.testID}-count`}
            style={{ color: attention ? theme.colors.attention.foreground : theme.colors.mutedText }}
          >
            {count}
          </Text>
        )}
        {props.action ? <View style={styles.headerAction}>{props.action}</View> : null}
      </View>
      {props.loading ? (
        <WorkSectionSkeleton
          testID={`${props.testID}-loading`}
          accessibilityLabel={props.title}
          theme={theme}
          reducedMotion={props.reducedMotion}
        />
      ) : <WorkSectionBody {...props} />}
    </View>
  );
}

/**
 * A Work pane's flat sheet: rows laid on the pane (no sheet, edge or radius), on the Work list's own
 * inset and with no hairlines between them (lab `convo-W8/W9`). A page section's body, and the top
 * value rows (Role, Goal) that open a Work tab.
 */
export function HappierWorkFlatSheet(props: Readonly<{
  testID?: string;
  children?: ReactNode;
  theme?: HappierWorkTheme;
}>) {
  const theme = useHappierWorkTheme(props.theme);
  return (
    <HappierPageSheet
      testID={props.testID}
      surface="none"
      colors={theme.palette}
      rowInsetPx={HAPPIER_WORK_PANE_METRICS.rowInsetPx}
      rowDividers={false}
    >
      {props.children}
    </HappierPageSheet>
  );
}

function WorkPageSection(props: HappierWorkSectionProps) {
  const theme = useHappierWorkTheme(props.theme);
  const { Text } = resolveHappierWorkHost(props.host);
  const count = readCount(props);
  const hasActions = Boolean(props.info) || Boolean(props.action);

  return (
    <View
      testID={props.testID}
      nativeID={props.nativeID}
      style={[styles.pageSection, { borderTopColor: theme.colors.sectionRule }]}
    >
      <HappierPageSectionHeader
        insetPx={HAPPIER_WORK_PANE_METRICS.rowInsetPx}
        style={styles.pageHeader}
        // ⓘ and the one icon action stay on the title line at the pane's narrowest width.
        actionLayout="trailing"
        title={(
          <View style={styles.pageTitleRow}>
            <Text
              role="pageSectionTitle"
              accessibilityRole="header"
              numberOfLines={1}
              style={{ color: theme.colors.text, flexShrink: 1 }}
            >
              {props.title}
            </Text>
            {count === null ? null : (
              <Text
                role="pageSectionCount"
                testID={props.countTestID ?? `${props.testID}-count`}
                numberOfLines={1}
                style={{ color: theme.colors.mutedText, flexShrink: 1 }}
              >
                {count}
              </Text>
            )}
          </View>
        )}
        action={hasActions ? (
          <View style={styles.pageActions}>
            {props.info ?? null}
            {props.action ?? null}
          </View>
        ) : undefined}
      />
      {props.loading ? (
        <WorkSectionSkeleton
          testID={`${props.testID}-loading`}
          accessibilityLabel={props.title}
          theme={theme}
          reducedMotion={props.reducedMotion}
        />
      ) : (
        <HappierWorkFlatSheet theme={theme}><WorkSectionBody {...props} /></HappierWorkFlatSheet>
      )}
    </View>
  );
}

function WorkSectionBody(props: HappierWorkSectionProps) {
  return (
    <>
      {props.empty ? <HappierWorkSectionEmptyLine theme={props.theme} host={props.host} {...props.empty} /> : props.children}
      {props.more ? <HappierWorkDisclosureLine theme={props.theme} host={props.host} {...props.more} /> : null}
    </>
  );
}

export type HappierWorkSectionEmptyLineProps = Readonly<{
  testID?: string;
  text: string;
  onPress?: () => void;
  theme?: HappierWorkTheme;
  host?: HappierWorkHost;
}>;

/**
 * A Work section's description on its rows' text edge, optionally the whole invitation to start.
 * Unlike a generic empty list row, it has no row-title/glyph/trailing-action anatomy or row height.
 */
export function HappierWorkSectionEmptyLine(props: HappierWorkSectionEmptyLineProps) {
  const theme = useHappierWorkTheme(props.theme);
  const { Text } = resolveHappierWorkHost(props.host);
  const style = { paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowInsetPx, paddingBottom: 2 };
  const line = <Text role="pageSectionDescription" style={{ color: theme.colors.secondaryText }}>{props.text}</Text>;
  return props.onPress ? (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.text}
      onPress={props.onPress}
      style={style}
    >
      {line}
    </HappierPressable>
  ) : <View testID={props.testID} style={style}>{line}</View>;
}

export type HappierWorkDisclosureLineProps = Readonly<{
  testID?: string;
  label: string;
  onPress: () => void;
  /** The surrounding anatomy supplies its text edge; default is below a Work row title. */
  insetPx?: number;
  theme?: HappierWorkTheme;
  host?: HappierWorkHost;
}>;

/** Show the rest in place; visibility and expansion remain source-owned. */
export function HappierWorkDisclosureLine(props: HappierWorkDisclosureLineProps) {
  const theme = useHappierWorkTheme(props.theme);
  const { Text } = resolveHappierWorkHost(props.host);
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={{ minHeight: 32, justifyContent: 'center', paddingLeft: props.insetPx ?? HAPPIER_WORK_PANE_METRICS.rowInsetPx + 40 }}
    >
      <Text role="sectionTitle" style={{ color: theme.colors.secondaryText }}>{props.label}</Text>
    </HappierPressable>
  );
}

/** Reserved rows while a section hydrates: the shared skeleton owner, in the section's theme. */
function WorkSectionSkeleton(props: Readonly<{
  testID: string;
  accessibilityLabel: string;
  theme: HappierWorkTheme;
  reducedMotion: boolean | undefined;
}>) {
  return (
    <HappierSkeletonRows
      testID={props.testID}
      rows={LOADING_SKELETON_ROWS}
      theme={props.theme.base}
      accessibilityLabel={props.accessibilityLabel}
      {...(props.reducedMotion === undefined ? {} : { reducedMotion: props.reducedMotion })}
    />
  );
}
