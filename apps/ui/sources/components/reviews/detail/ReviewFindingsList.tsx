import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';
import { List } from '@happier-dev/plugin-ui/components';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

import {
  reviewFindingDecisionLabel,
  type ReviewFindingDecision,
} from '@/components/sessions/reviews/findings/ReviewFindingRow';
import {
  REVIEW_SEVERITY_RANK,
  reviewSeverityLabel,
} from '@/components/sessions/reviews/findings/reviewFindingPresentation';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import {
  SegmentedTabBar,
  type SegmentedTab,
} from '@/components/ui/navigation/SegmentedTabBar';
import { t } from '@/text';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';

export type ReviewFindingsListRow = Readonly<{
  rowId: string;
  title?: string;
  severity: ReviewFinding['severity'];
  decision: ReviewFindingDecision | 'undecided';
  /** Its fix landed (the protocol's fixed fact): it leaves the decision filters for Fixed. */
  fixed?: boolean;
}>;

export type ReviewFindingsRowSelection = Readonly<{ selected: boolean; onToggle: (rowId: string) => void; disabled?: boolean }>;

type DecisionFilter = 'all' | ReviewFindingDecision | 'undecided' | 'fixed';
const rowFilter = (row: ReviewFindingsListRow): Exclude<DecisionFilter, 'all'> => row.fixed ? 'fixed' : row.decision;

const FILTER_ORDER: readonly DecisionFilter[] = [
  'all',
  'undecided',
  'accept',
  'fixed',
  'reject',
  'defer',
];
const FINDING_PAGE_LAYOUT = { estimatedRowHeight: HAPPIER_PAGE_METRICS.rowMinHeightPx };
const findingRowKey = (row: ReviewFindingsListRow) => row.rowId;

/**
 * The Review page's findings (lab `detail-findings`): one-press decision filters carrying the only counts,
 * then one section per severity holding the rows. Each row is the shared finding row the Run page, PR and
 * Inbox draw (`renderRow`); this owner only filters and groups them.
 */
export function ReviewFindingsList(
  props: Readonly<{
    rows: readonly ReviewFindingsListRow[];
    /** `selection` is set while selecting: the row draws its check in its glyph's place and pressing it selects. */
    renderRow: (rowId: string, divided: boolean, selection?: ReviewFindingsRowSelection) => React.ReactNode;
    /**
     * Bulk selection (lab `detail-bulk`): at rest each row shows its status glyph only and the filter line carries
     * "Select"; once `active`, each row's check replaces its glyph. The host owns the mode so its action bar can end it.
     */
    selection?: Readonly<{ selectedRowIds: ReadonlySet<string>; onToggle: (rowId: string) => void; disabled?: boolean;
      active: boolean; onStart: () => void }>;
    /** Above the groups: the reviewers' open questions (structured answer cards). */
    before?: React.ReactNode;
    /** Below the groups: what the reviewers took as given, and anything not shown. */
    after?: React.ReactNode;
    testID?: string;
  }>,
): React.ReactElement | null {
  const [filter, setFilter] = React.useState<DecisionFilter>('all');
  const commands = useCurrentUiContextLocalCommands([{
    key: 'review.detail.filter_findings', title: t('runPage.review.findings'),
    description: 'Filter findings with {filter: all | undecided | accept | fixed | reject | defer}.',
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
      next.set(rowFilter(row), (next.get(rowFilter(row)) ?? 0) + 1);
    return next;
  }, [props.rows]);
  // A decision nobody has taken is no filter; All and Pending always stand so the row never jumps, and a chip with
  // nothing under it carries no count ("Pending", never "Pending 0").
  const tabs = React.useMemo(
    (): readonly SegmentedTab<DecisionFilter>[] =>
      FILTER_ORDER.filter(
        (id) => id === 'all' || id === 'undecided' || (counts.get(id) ?? 0) > 0,
      ).map((id) => ({
        id,
        label: id === 'all' ? t('common.all') : id === 'fixed' ? t('reviewWalkthrough.detail.fixed') : reviewFindingDecisionLabel(id),
        ...((counts.get(id) ?? 0) > 0 ? { count: String(counts.get(id)) } : {}),
        testID: `review-findings:filter:${id}`,
      })),
    [counts],
  );
  const active = tabs.some((tab) => tab.id === filter) ? filter : 'all';
  const groups = React.useMemo(() => {
    const visible =
      active === 'all'
        ? props.rows
        : props.rows.filter((row) => rowFilter(row) === active);
    const bySeverity = new Map<
      ReviewFinding['severity'],
      ReviewFindingsListRow[]
    >();
    for (const row of visible) {
      const group = bySeverity.get(row.severity);
      if (group) group.push(row);
      else bySeverity.set(row.severity, [row]);
    }
    return [...bySeverity.entries()].sort(
      ([left], [right]) =>
        REVIEW_SEVERITY_RANK[left] - REVIEW_SEVERITY_RANK[right],
    );
  }, [active, props.rows]);
  const selection = props.selection;
  const renderRow = (row: ReviewFindingsListRow, divided: boolean) => props.renderRow(row.rowId, divided,
    selection?.active ? { selected: selection.selectedRowIds.has(row.rowId), onToggle: selection.onToggle,
      ...(selection.disabled ? { disabled: true } : {}) } : undefined);
  // No findings is the page glance's sentence ("Nothing to fix"); the list says it once there, not twice.
  if (props.rows.length === 0) return null;
  return (
    <View testID={props.testID ?? 'review-findings'} style={styles.list}>
      <View style={styles.filters}>
      <View style={styles.filterTabs}>
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
      {props.selection && !props.selection.active ? <TextLinkButton testID="review-findings:select-mode" tone="strong"
        label={t('sessionsList.selectionSelect')} onPress={props.selection.onStart} /> : null}
      </View>
      {props.before ?? null}
      <CorePluginUiPresentationScope>
      {groups.map(([severity, rows]) => (
        <ItemGroup
          key={severity}
          testID={`review-findings:group:${severity}`}
          title={reviewSeverityLabel(severity)}
        >
          {/* One body inside the section's sheet: the shared finding rows draw their own hairlines. */}
          <View style={styles.rows}>
            <List items={rows} keyForItem={findingRowKey} pageLayout={FINDING_PAGE_LAYOUT}
              density="flush" renderItem={(row, index) => renderRow(row, index > 0)} />
          </View>
        </ItemGroup>
      ))}
      </CorePluginUiPresentationScope>
      {props.after ?? null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The severity sections bring their own page section gap; the list adds none on top of it.
  list: {},
  // The filters stand on the sheets' edge, like the page lines above them; Select sits at the line's end.
  filters: { paddingHorizontal: resolveItemGroupContentHorizontalInsetPx(), flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', gap: theme.space.s12 },
  filterTabs: { flexShrink: 1, minWidth: 0 },
  rows: { paddingHorizontal: theme.space.s16 },
}));
