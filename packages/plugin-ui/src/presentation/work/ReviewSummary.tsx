import { memo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { HappierPressable } from '../interaction/Pressable.js';
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';
import type { HappierReviewSeverity } from '../status/ReviewSeverity.js';
import { HappierFactLine } from './FactLine.js';
import { resolveHappierWorkStatusWordColor } from './workStatus.js';
import {
  resolveHappierWorkHost,
  useHappierWorkTheme,
  type HappierWorkHost,
  type HappierWorkTheme,
} from './workTheme.js';

/** How a Review's verdict sentence speaks: quiet when healthy, the needs-you or failure ink otherwise. */
export type HappierReviewTone = 'quiet' | 'attention' | 'failed';

/** One verdict sentence and its facts (Reviews lab glance; no stat strip). */
export type HappierReviewGlance = Readonly<{
  sentence: string;
  tone: HappierReviewTone;
  facts: readonly string[];
}>;

/** Localized words supplied by each host; the Review owner's state and counts decide the verdict once. */
export function projectHappierReviewGlance(
  round: Readonly<{ state: string; summary?: string }> | undefined,
  review: Readonly<{ state: string; counts: Readonly<{ total: number; needsDecision: number }> }> | null,
  words: Readonly<{
    running: string; failed: string; noFindings: string; allDecided: string;
    toDecide: (count: number) => string;
    /** The total as a fact; omitted where the counts live elsewhere (the Review page's filter chips). */
    findingsCount?: (count: number) => string;
  }>,
): HappierReviewGlance | null {
  const state = round?.state ?? review?.state;
  if (!state) return null;
  if (state === 'running') return { sentence: words.running, tone: 'quiet', facts: [] };
  if (state === 'failed') return { sentence: words.failed, tone: 'failed', facts: [] };
  if (!review) return round?.summary ? { sentence: round.summary, tone: 'quiet', facts: [] } : null;
  const { total, needsDecision } = review.counts;
  const facts = round?.summary ? [round.summary] : [];
  if (total === 0) return { sentence: words.noFindings, tone: 'quiet', facts };
  // The total is a fact only when it says something the sentence does not ("1 to decide" of 1 is one fact).
  if (needsDecision > 0) return { sentence: words.toDecide(needsDecision), tone: 'attention',
    facts: [...(words.findingsCount && total !== needsDecision ? [words.findingsCount(total)] : []), ...facts] };
  return { sentence: words.allDecided, tone: 'quiet', facts: [...(words.findingsCount ? [words.findingsCount(total)] : []), ...facts] };
}

export type HappierReviewSummaryRow = Readonly<{
  rowId: string;
  severity: HappierReviewSeverity;
  /** The caller's word for the severity ("Blocker"); a node is the host's own (find-aware) text. */
  severityLabel: ReactNode;
  /** A string is drawn in the row's text; a node is the host's own (find-aware) text. */
  title: ReactNode;
  /** Who reported it ("Claude and Codex"); a string or the host's own text. */
  reviewer: ReactNode;
  /** Where it is ("SettingsModal.tsx:142"), drawn in the row's facts after the severity word. */
  location?: ReactNode;
  /** The row's decision glyph (the host's ink icon), in the leading column like the Review page's rows. */
  glyph?: ReactNode;
  /** The row's name for assistive technology when `title` is a node. */
  accessibilityLabel?: string;
}>;

export type HappierReviewSummaryProps = Readonly<{
  testID?: string;
  /** The word that names the card ("Review"), drawn after `headMark`. */
  heading: string;
  headMark?: ReactNode;
  /** What was reviewed ("this session", "#2481"); `null` when the host already names it. */
  subject: string | null;
  /** The Review's one state word on the head's right ("Needs decision"). */
  status?: Readonly<{ label: string; tone: HappierReviewTone }> | null;
  glance: HappierReviewGlance;
  /** The first findings, in the findings owner's order; the rest are counted in `more`. */
  rows: readonly HappierReviewSummaryRow[];
  onOpenRow?: (rowId: string) => void;
  /** The host's own "N more · Show" link. */
  more?: ReactNode;
  /** Who reviewed: the reviewers' own marks, then their names. */
  reviewerMarks?: ReactNode;
  reviewers: string;
  /** The way into the Review, and Implement fixes when the person accepted any: the host's buttons. */
  actions?: ReactNode;
  theme?: HappierWorkTheme;
  host?: HappierWorkHost;
}>;

const styles = StyleSheet.create({
  root: { gap: HAPPIER_PAGE_METRICS.rowCompactGapPx },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  subject: { flexShrink: 1, minWidth: 0 },
  status: { marginLeft: 'auto' },
  sentence: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rows: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, gap: HAPPIER_PAGE_METRICS.rowCompactGapPx },
  // Two lines like the Review page's rows (lab `session-card`): the title, then severity · place · who found it.
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, minWidth: 0 },
  glyph: { paddingTop: 2, flexShrink: 0 },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowFacts: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 8, rowGap: 2, minWidth: 0 },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  reviewers: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flex: 1,
    minWidth: 0,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});

function toneColor(
  tone: HappierReviewTone,
  theme: HappierWorkTheme,
): string | null {
  if (tone === 'quiet') return null;
  return resolveHappierWorkStatusWordColor(
    tone === 'failed' ? 'danger' : 'attention',
    theme.colors,
  );
}

/**
 * A Review's verdict: the one sentence (with the needs-you or failure dot when it speaks), then its facts on
 * one quiet line. The Review page's glance and every embedded summary draw this same line.
 */
export const HappierReviewGlanceLine = memo(function HappierReviewGlanceLine(
  props: Readonly<{
    glance: HappierReviewGlance;
    testID?: string;
    /** The facts line's own test id; defaults to `<testID>:facts`. */
    factsTestID?: string;
    theme?: HappierWorkTheme;
    host?: HappierWorkHost;
  }>,
) {
  const theme = useHappierWorkTheme(props.theme);
  const { Text } = resolveHappierWorkHost(props.host);
  const dot = toneColor(props.glance.tone, theme);
  return (
    <View testID={props.testID} style={{ gap: 4 }}>
      <View style={styles.sentence}>
        {dot ? <View style={[styles.dot, { backgroundColor: dot }]} /> : null}
        <Text
          role="pageSectionTitle"
          style={{ color: theme.colors.text, flexShrink: 1 }}
        >
          {props.glance.sentence}
        </Text>
      </View>
      <HappierFactLine
        facts={props.glance.facts}
        testID={props.factsTestID ?? (props.testID ? `${props.testID}:facts` : undefined)}
        theme={props.theme}
        host={props.host}
      />
    </View>
  );
});

/**
 * The one Review summary (Reviews lab `session-card`, `triage-inbox`, `pr-verdict`): Review and its subject,
 * the verdict sentence, the first findings as hairline rows, how many more, who reviewed, and the way into
 * the Review. Content only: a Session transcript, the Inbox, a pull request page or a Team list draws it
 * inside its own frame, and supplies its own words, marks and buttons.
 *
 * Extracted from Happier core's Review summary, which now binds this content to the app's text, Agent
 * marks and buttons.
 */
export const HappierReviewSummary = memo(function HappierReviewSummary(
  props: HappierReviewSummaryProps,
) {
  const theme = useHappierWorkTheme(props.theme);
  const { Text } = resolveHappierWorkHost(props.host);
  const statusColor = props.status
    ? (toneColor(props.status.tone, theme) ?? theme.colors.secondaryText)
    : null;
  return (
    <View testID={props.testID ?? 'review-summary'} style={styles.root}>
      <View style={styles.head}>
        {props.headMark ?? null}
        <Text role="cardTitle" style={{ color: theme.colors.text }}>
          {props.heading}
        </Text>
        {props.subject ? (
          <Text
            role="cardWord"
            numberOfLines={1}
            style={[styles.subject, { color: theme.colors.secondaryText }]}
          >
            {props.subject}
          </Text>
        ) : null}
        {props.status ? (
          <Text
            role="cardMeta"
            numberOfLines={1}
            style={[styles.status, { color: statusColor ?? undefined }]}
          >
            {props.status.label}
          </Text>
        ) : null}
      </View>
      <HappierReviewGlanceLine
        glance={props.glance}
        theme={props.theme}
        host={props.host}
      />
      {props.rows.length > 0 ? (
        <View style={[styles.rows, { borderTopColor: theme.colors.border }]}>
          {props.rows.map((row) => {
            // The severity word stays ink (colour means state, DESIGN): the row's facts, not a red sign.
            const fact = (value: ReactNode) => typeof value === 'string'
              ? <Text role="rowLine" numberOfLines={1} style={{ color: theme.colors.secondaryText }}>{value}</Text> : value;
            const content = (
              <>
                {row.glyph ? <View style={styles.glyph}>{row.glyph}</View> : null}
                <View style={styles.rowBody}>
                  {typeof row.title === 'string' ? (
                    <Text role="rowTitle" numberOfLines={1} style={{ color: theme.colors.text }}>{row.title}</Text>
                  ) : row.title}
                  <View style={styles.rowFacts}>
                    {fact(row.severityLabel)}
                    {row.location ? fact(row.location) : null}
                    {fact(row.reviewer)}
                  </View>
                </View>
              </>
            );
            return props.onOpenRow ? (
              <HappierPressable
                key={row.rowId}
                testID={`review-summary:row:${row.rowId}`}
                accessibilityRole="button"
                accessibilityLabel={row.accessibilityLabel ?? (typeof row.title === 'string' ? row.title : undefined)}
                onPress={() => props.onOpenRow?.(row.rowId)}
                style={styles.row}
              >
                {content}
              </HappierPressable>
            ) : (
              <View
                key={row.rowId}
                testID={`review-summary:row:${row.rowId}`}
                style={styles.row}
              >
                {content}
              </View>
            );
          })}
          {props.more ?? null}
        </View>
      ) : null}
      <View style={[styles.foot, { borderTopColor: theme.colors.border }]}>
        <View style={styles.reviewers}>
          {props.reviewerMarks ?? null}
          <Text
            role="cardFact"
            numberOfLines={1}
            style={{ color: theme.colors.secondaryText, flexShrink: 1 }}
          >
            {props.reviewers}
          </Text>
        </View>
        {props.actions ? (
          <View style={styles.actions}>{props.actions}</View>
        ) : null}
      </View>
    </View>
  );
});
