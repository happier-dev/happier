import { useCallback, useState, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import type { ReviewCommentV1, ReviewFinding } from '@happier-dev/plugin-sdk/reviews';

import { DiffViewer, Markdown } from './Content.js';
import { Icon } from './Icon.js';
import { HappierPressable } from '../presentation/interaction/Pressable.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';
import { resolveHappierWorkHost, useHappierWorkTheme, type HappierWorkHost, type HappierWorkTheme } from '../presentation/work/workTheme.js';

/** A projection supplied by the comment owner, never inferred from presentation. */
export type HappierReviewFindingDecision = Exclude<ReviewCommentV1['reviewTriageStatus'], undefined | 'needs_refinement'> | 'undecided';

export type HappierReviewFindingProps = Readonly<{
  rowId: string;
  finding: Pick<ReviewFinding, 'title' | 'severity'>;
  severityLabel: ReactNode;
  location?: ReactNode;
  attribution?: ReactNode;
  facts?: readonly string[];
  /** Omit to let the title and its meta supply the disclosure's accessible name. */
  accessibilityLabel?: string;
  decision: Readonly<{ value: HappierReviewFindingDecision; label: string }> | null;
  /** Read-only rows retain the persisted decision; only its editing control disappears. */
  decisionEditable?: boolean;
  decisionControl?: ReactNode;
  decisionGlyph?: ReactNode;
  /**
   * Bulk selection (lab `detail-bulk`): the row itself is the checkbox. Its check takes the decision glyph's
   * place, so the title keeps its edge, and pressing the row selects it instead of opening it.
   */
  selection?: Readonly<{ selected: boolean; onToggle: (rowId: string) => void; glyph: ReactNode; disabled?: boolean; testID?: string }>;
  expanded: boolean;
  onToggleExpanded: (rowId: string) => void;
  divided?: boolean;
  children: ReactNode;
  theme?: HappierWorkTheme;
  host?: HappierWorkHost;
}>;

/** The finding's disclosure and decision anatomy, shared by native and contributed Review hosts. */
export function HappierReviewFinding(props: HappierReviewFindingProps) {
  const theme = useHappierWorkTheme(props.theme);
  const { Text } = resolveHappierWorkHost(props.host);
  const [narrow, setNarrow] = useState(false);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    if (!Number.isFinite(width) || width <= 0) return;
    const next = width < HAPPIER_PAGE_METRICS.rowStackBelowWidthPx;
    setNarrow(current => current === next ? current : next);
  }, []);
  const decisionControl = props.decisionEditable === false ? null : props.decisionControl;
  const ignored = props.decision?.value === 'reject';
  const decisionWord = props.decision && (!props.expanded || !decisionControl) ? (
    <Text role="cardMeta" testID={`review-finding-decision:${props.rowId}`}
      style={{ flexShrink: 0, color: props.decision.value === 'undecided' ? theme.colors.mutedText : theme.colors.secondaryText }}>
      {props.decision.label}
    </Text>
  ) : null;
  const selection = props.selection;
  const heading = (
    <View style={styles.titleColumn}>
      <Text role="pageRowTitle" strong style={{ color: ignored ? theme.colors.mutedText : theme.colors.text,
        ...(ignored ? { textDecorationLine: 'line-through' } : {}) }}>{props.finding.title}</Text>
      <View style={styles.meta}>
        {typeof props.severityLabel === 'string' ? <Text role="cardMeta" style={{ color: theme.colors.secondaryText }}>{props.severityLabel}</Text> : props.severityLabel}
        {typeof props.location === 'string' ? <Text role="cardMeta" numberOfLines={1} style={{ color: theme.colors.secondaryText, flexShrink: 1 }}>{props.location}</Text> : props.location}
        {props.attribution}
        {props.facts?.map(fact => <Text key={fact} role="cardMeta" numberOfLines={1}
          testID={`review-finding-fact:${props.rowId}`} style={{ color: theme.colors.secondaryText }}>{fact}</Text>)}
      </View>
    </View>
  );
  return (
    <View testID={`review-finding:${props.rowId}`} onLayout={onLayout}
      style={[styles.row, props.divided ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border } : null]}>
      <View style={styles.head}>
        {selection ? (
          <HappierPressable testID={selection.testID} accessibilityRole="checkbox" checked={selection.selected}
            accessibilityLabel={props.accessibilityLabel ?? props.finding.title} disabled={selection.disabled}
            onPress={() => selection.onToggle(props.rowId)} style={styles.toggle}>
            <View style={styles.glyph}>{selection.glyph}</View>
            {heading}
          </HappierPressable>
        ) : (
        <HappierPressable testID={`review-finding-toggle:${props.rowId}`} accessibilityRole="button"
          accessibilityLabel={props.accessibilityLabel} expanded={props.expanded}
          onPress={() => props.onToggleExpanded(props.rowId)} style={styles.toggle}>
          <View style={styles.glyph}>
            {props.decisionGlyph ?? <Icon name={props.decision?.value === 'accept' ? 'change-complete'
              : props.decision?.value === 'reject' ? 'pause' : props.decision?.value === 'defer' ? 'waiting' : 'change-open'} size="small" tone="secondary" />}
          </View>
          {heading}
        </HappierPressable>
        )}
        {props.expanded && !narrow ? decisionControl : null}
        {decisionWord}
      </View>
      {props.expanded ? <View style={[styles.opened, narrow ? null : styles.hung]}>
        {narrow && decisionControl ? <View style={styles.narrowDecision}>{decisionControl}</View> : null}
        {props.children}
      </View> : null}
    </View>
  );
}

/** The existing finding location formatter, also consumed by native finding adapters. */
export function formatHappierReviewFindingLocation(finding: Pick<ReviewFinding, 'filePath' | 'startLine' | 'endLine'>): string | null {
  if (!finding.filePath) return null;
  if (typeof finding.startLine === 'number' && typeof finding.endLine === 'number' && finding.endLine !== finding.startLine) {
    return `${finding.filePath}:${finding.startLine}-${finding.endLine}`;
  }
  return typeof finding.startLine === 'number' ? `${finding.filePath}:${finding.startLine}` : finding.filePath;
}

export type HappierReviewFindingBodyProps = Readonly<{
  rowId: string;
  finding: ReviewFinding;
  currentBodyMarkdown?: string;
  labels: Readonly<{ where: string; verification: string; conversation: string }>;
  notice?: ReactNode;
  reviewers?: ReactNode;
  conversation: ReactNode;
  extensions?: ReactNode;
  seenBefore?: ReactNode;
  /** Native hosts bind their incumbent Markdown renderer; mounted plugins use the public host. */
  renderMarkdown?: (markdown: string, role: 'cause' | 'verification' | 'suggestion') => ReactNode;
  /** Native hosts preserve their incumbent code frame, copy control and diff renderer. */
  renderWhere?: (finding: ReviewFinding) => ReactNode;
  theme?: HappierWorkTheme;
  host?: HappierWorkHost;
}>;

/** One opened finding: why, code, verification, contributed evidence, history, then conversation. */
export function HappierReviewFindingBody(props: HappierReviewFindingBodyProps) {
  const theme = useHappierWorkTheme(props.theme);
  const { Text } = resolveHappierWorkHost(props.host);
  const { finding, rowId } = props;
  const markdown = props.renderMarkdown ?? ((value: string) => <Markdown value={value} />);
  const location = formatHappierReviewFindingLocation(finding);
  const heading = (label: string) => <Text role="pageRowTitle" strong accessibilityRole="header" style={{ color: theme.colors.text }}>{label}</Text>;
  const where = location || finding.patch || finding.suggestion;
  return (
    <View testID={`review-finding-body:${rowId}`} style={styles.body}>
      <View style={styles.why}>
        {finding.whyItMatters ? <Text role="pageRowLine" strong style={{ color: theme.colors.text }}>{finding.whyItMatters}</Text> : null}
        {props.currentBodyMarkdown !== undefined ? markdown(props.currentBodyMarkdown, 'cause')
          : <Text role="pageRowLine" strong={!finding.whyItMatters} style={{ color: finding.whyItMatters ? theme.colors.secondaryText : theme.colors.text }}>{finding.summary}</Text>}
        {props.notice}
      </View>
      {where ? props.renderWhere ? props.renderWhere(finding) : (
        <View testID={`review-finding-where:${rowId}`} style={styles.section}>
          {heading(props.labels.where)}
          {finding.patch ? <DiffViewer unifiedDiff={finding.patch} filePath={finding.filePath} label={location ?? props.labels.where} />
            : location ? <Text role="cardMeta" style={{ color: theme.colors.secondaryText }}>{location}</Text> : null}
          {finding.suggestion && !finding.patch ? markdown(finding.suggestion, 'suggestion') : null}
        </View>
      ) : null}
      {finding.evidence ? <View testID={`review-finding-verified:${rowId}`} style={styles.section}>
        {heading(props.labels.verification)}
        {markdown(finding.evidence, 'verification')}
      </View> : null}
      {props.extensions}
      {props.seenBefore}
      {/* A finding nobody can talk about yet (no reviewers named, no thread, nowhere to ask) draws no empty heading. */}
      {props.reviewers || props.conversation ? <View testID={`review-finding-conversation:${rowId}`} style={styles.section}>
        {heading(props.labels.conversation)}
        {props.reviewers}
        {props.conversation}
      </View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: HAPPIER_PAGE_METRICS.rowPaddingVerticalPx, gap: 16 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  toggle: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-start', gap: HAPPIER_PAGE_METRICS.rowLeadingGapPx },
  glyph: { width: HAPPIER_PAGE_METRICS.rowLeadingColumnPx, alignItems: 'center', paddingTop: 2 },
  titleColumn: { flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0, gap: 2 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 2 },
  opened: { gap: 16 },
  hung: { marginLeft: HAPPIER_PAGE_METRICS.rowLeadingColumnPx + HAPPIER_PAGE_METRICS.rowLeadingGapPx },
  narrowDecision: { alignSelf: 'stretch' },
  body: { gap: 24 },
  why: { gap: 4 },
  section: { gap: 10 },
});
