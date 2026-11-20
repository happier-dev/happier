import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';

import {
  reviewFindingDecisionLabel,
  type ReviewFindingDecision,
} from '@/components/sessions/reviews/findings/ReviewFindingRow';
import {
  REVIEW_SEVERITY_RANK,
  reviewSeverityLabel,
} from '@/components/sessions/reviews/findings/reviewFindingPresentation';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import {
  SegmentedTabBar,
  type SegmentedTab,
} from '@/components/ui/navigation/SegmentedTabBar';
import { t } from '@/text';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';

export type ReviewFindingsListRow = Readonly<{
  rowId: string;
  title?: string;
  severity: ReviewFinding['severity'];
  decision: ReviewFindingDecision | 'undecided';
}>;

type DecisionFilter = 'all' | ReviewFindingDecision | 'undecided';

const FILTER_ORDER: readonly DecisionFilter[] = [
  'all',
  'undecided',
  'accept',
  'reject',
  'defer',
];

/**
 * The Review page's findings (lab `detail-findings`): one-press decision filters carrying the only counts,
 * then one section per severity holding the rows. Each row is the shared finding row the Run page, PR and
 * Inbox draw (`renderRow`); this owner only filters and groups them.
 */
export function ReviewFindingsList(
  props: Readonly<{
    rows: readonly ReviewFindingsListRow[];
    renderRow: (rowId: string, divided: boolean) => React.ReactNode;
    selection?: Readonly<{ selectedRowIds: ReadonlySet<string>; onToggle: (rowId: string) => void; disabled?: boolean }>;
    /** Above the groups: the reviewers' open questions (structured answer cards). */
    before?: React.ReactNode;
    /** Below the groups: what the reviewers took as given, and anything not shown. */
    after?: React.ReactNode;
    testID?: string;
  }>,
): React.ReactElement {
  const [filter, setFilter] = React.useState<DecisionFilter>('all');
  const commands = useCurrentUiContextLocalCommands([{
    key: 'review.detail.filter_findings', title: t('runPage.review.findings'),
    description: 'Filter findings with {filter: all | undecided | accept | reject | defer}.',
    invoke: input => {
      if (!isJsonObject(input)) return false;
      const value = FILTER_ORDER.find(id => id === input.filter);
      if (value === undefined) return false;
      setFilter(value);
    },
  }], { unbound: 'local' });
  const counts = React.useMemo(() => {
    const next = new Map<DecisionFilter, number>([['all', props.rows.length]]);
    for (const row of props.rows)
      next.set(row.decision, (next.get(row.decision) ?? 0) + 1);
    return next;
  }, [props.rows]);
  // A decision nobody has taken is no filter; All and Pending always stand so the row never jumps.
  const tabs = React.useMemo(
    (): readonly SegmentedTab<DecisionFilter>[] =>
      FILTER_ORDER.filter(
        (id) => id === 'all' || id === 'undecided' || (counts.get(id) ?? 0) > 0,
      ).map((id) => ({
        id,
        label: id === 'all' ? t('common.all') : reviewFindingDecisionLabel(id),
        count: String(counts.get(id) ?? 0),
        testID: `review-findings:filter:${id}`,
      })),
    [counts],
  );
  const active = tabs.some((tab) => tab.id === filter) ? filter : 'all';
  const groups = React.useMemo(() => {
    const visible =
      active === 'all'
        ? props.rows
        : props.rows.filter((row) => row.decision === active);
    const bySeverity = new Map<
      ReviewFinding['severity'],
      ReviewFindingsListRow[]
    >();
    for (const row of visible)
      bySeverity.set(row.severity, [
        ...(bySeverity.get(row.severity) ?? []),
        row,
      ]);
    return [...bySeverity.entries()].sort(
      ([left], [right]) =>
        REVIEW_SEVERITY_RANK[left] - REVIEW_SEVERITY_RANK[right],
    );
  }, [active, props.rows]);
  const renderRow = (row: ReviewFindingsListRow, divided: boolean) => props.selection ? (
    <View style={styles.selectableRow}>
      <Pressable testID={`review-findings:select:${row.rowId}`} accessibilityRole="checkbox"
        accessibilityLabel={row.title ?? t('runPage.review.findings')} disabled={props.selection.disabled}
        accessibilityState={{ checked: props.selection.selectedRowIds.has(row.rowId), disabled: props.selection.disabled }}
        style={styles.select} onPress={() => props.selection?.onToggle(row.rowId)}>
        <SelectionCheckGlyph state={props.selection.selectedRowIds.has(row.rowId) ? 'checked' : 'unchecked'} />
      </Pressable>
      <View style={styles.selectedContent}>{props.renderRow(row.rowId, divided)}</View>
    </View>
  ) : props.renderRow(row.rowId, divided);
  // No findings is the page glance's sentence ("Nothing to fix"); the list says it once there, not twice.
  if (props.rows.length === 0) return null;
  return (
    <View testID={props.testID ?? 'review-findings'} style={styles.list}>
      <View style={styles.filters}>
      <SegmentedTabBar<DecisionFilter>
        role="radiogroup"
        presentation="pills"
        tabs={tabs}
        activeTabId={active}
        onSelectTab={filter => { void commands.invoke('review.detail.filter_findings', { filter }); }}
        segmentSizing="content"
        testIDPrefix="review-findings:filters"
        accessibilityLabel={t('runPage.review.findings')}
      />
      </View>
      {props.before ?? null}
      {groups.map(([severity, rows]) => (
        <ItemGroup
          key={severity}
          testID={`review-findings:group:${severity}`}
          title={reviewSeverityLabel(severity)}
        >
          {/* One body inside the section's sheet: the shared finding rows draw their own hairlines. */}
          <View style={styles.rows}>
            {rows.map((row, index) => (
              <React.Fragment key={row.rowId}>
                {renderRow(row, index > 0)}
              </React.Fragment>
            ))}
          </View>
        </ItemGroup>
      ))}
      {props.after ?? null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { gap: theme.space.s16 },
  // The filters stand on the sheets' edge, like the page lines above them.
  filters: { paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() },
  rows: { paddingHorizontal: theme.space.s16 },
  selectableRow: { flexDirection: 'row', alignItems: 'flex-start' },
  selectedContent: { flex: 1, minWidth: 0 },
  select: { padding: theme.space.s12 },
}));
