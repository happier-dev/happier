import * as React from 'react';
import { Button, Card, HappierBodyEdgeContext, Chart, Column, Columns, HAPPIER_PRESS_FEEDBACK_V1, HappierPressable, HappierSkeletonRows, happierFocusRingStyle, Icon, List, Metric, Progress, Row, ScrollArea, Stack, Step, Text, usePluginTheme, usePluginTranslation, useSurfaceContext } from '@happier-dev/plugin-ui';
import { formatTriageTimestampV1 } from '@happier-dev/triage-protocol/v1';

import { summarizeTriageChangesV1, type TriageChangedFileV1, type TriageChangeTotalsV1 } from './changeSummary.js';
import { TriageStatusRow } from './statusRow.js';
import { TriageTextPreview } from './textPreview.js';

/** Composition only: the source retains ownership of evidence and its read lifecycle. */
const STORY_TITLES = Object.freeze({
  ask: { key: 'plugins.triage.detailStory.ask', fallback: 'The ask' },
  report: { key: 'plugins.triage.detailStory.report', fallback: 'The report' },
  error: { key: 'plugins.triage.detailStory.happened', fallback: 'What happened' },
});

/**
 * Composition only: the source retains ownership of evidence and its read lifecycle.
 * `kind` is the entry's subject: a pull request asks, an issue reports, an error group
 * says what happened.
 */
export function TriageDetailStory({ kind, children, loading, notice, changes, checks, trailing }: Readonly<{
  kind?: keyof typeof STORY_TITLES | undefined;
  children: React.ReactNode;
  /**
   * The source's first read of ① is still settling and it has nothing it could show yet (no last read, no
   * summary): the step keeps its place with lines of reading text where the words will land.
   */
  loading?: boolean;
  /**
   * The ask's own read state (a failed or retained read, with its Re-read), one line above the preview so it is
   * never clipped into it and the description it previews stays readable.
   */
  notice?: React.ReactNode;
  /** Step ②: what changed for a change request, the spread for an error group. */
  changes?: React.ReactNode;
  checks?: React.ReactNode;
  trailing?: React.ReactNode;
}>): React.ReactElement {
  const text = usePluginTranslation();
  if (kind === undefined) return <ScrollArea><Stack gap="large">{children}</Stack></ScrollArea>;
  const body = loading === true
    ? <TriageStoryLoadingLines label={text('plugins.triage.surface.detail.reading', 'Reading this entry')} />
    // The ask reads as text: a folded row in it (Facts) stands on the text's edge, not a list row's inset.
    : <HappierBodyEdgeContext.Provider value>
      <TriageTextPreview testID="triage-story-ask-body">{children}</TriageTextPreview>
    </HappierBodyEdgeContext.Provider>;
  return <Stack gap="large">
    <Step marker={{ kind: 'number', value: 1 }}
      title={STORY_TITLES[kind].fallback}
      titleKey={STORY_TITLES[kind].key} trailing={trailing}>
      {notice === undefined ? body
        : <Stack gap="small">
          {notice}
          {body}
        </Stack>}
    </Step>
    {changes}
    {checks}
  </Stack>;
}

/** A few lines of reading text: enough to hold the story's first step without promising its length. */
const STORY_LOADING_LINES = 3;
const STORY_LOADING_GEOMETRY = Object.freeze({ insetStart: 0, insetEnd: 0, glyphColumn: 0, gap: 0 });

/**
 * Where a story's text will land while its first read settles: lines of reading text in the shared
 * skeleton ink, announced once as busy. The detail frame shows the same lines before the source mounts,
 * so nothing jumps when the source takes over and its words arrive.
 */
export function TriageStoryLoadingLines({ label }: Readonly<{ label: string }>): React.ReactElement {
  const theme = usePluginTheme();
  const lineHeight = theme.typography.reading.lineHeight;
  return <HappierSkeletonRows testID="triage-story-loading" rows={STORY_LOADING_LINES} theme={theme}
    lineHeights={[lineHeight]} rowBox={{ minHeight: lineHeight, paddingVertical: 0 }}
    geometry={STORY_LOADING_GEOMETRY} accessibilityLabel={label} />;
}

function TriageDetailChanges({ children, trailing, titleKey = 'plugins.triage.detailStory.changed', onOpen }: Readonly<{
  children: React.ReactNode;
  trailing?: React.ReactNode;
  titleKey?: string;
  onOpen?: (() => void) | undefined;
}>): React.ReactElement {
  return <Step marker={{ kind: 'number', value: 2 }} title="What changed"
    titleKey={titleKey} trailing={trailing} {...(onOpen === undefined ? {} : { onPress: onOpen })}>
    <Stack gap="small">{children}</Stack>
  </Step>;
}

const FAILING_CHECK_TEXT_STYLE = Object.freeze({ minWidth: 0 });

/** One column for the file rows' counts, wide enough for "+999 −999" at the micro step. */
const CHANGE_COUNTS_MIN_WIDTH_PX = 64;

type StoryCountV1 = (key: string, count: number, english: Readonly<{ one: string; other: string }>) => string;

/**
 * A count sentence in the reader's plural form: `<key>.<form>` from the catalog for the form
 * `Intl.PluralRules` selects, then `<key>.other`, then the English fallback.
 */
function useStoryCount(): StoryCountV1 {
  const text = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const rules = React.useMemo(() => {
    try { return new Intl.PluralRules(locale); } catch { return new Intl.PluralRules('en'); }
  }, [locale]);
  return React.useCallback((key, count, english) => {
    const values = { count: String(count) };
    const form = rules.select(count);
    const other = text(`plugins.triage.detailStory.${key}.other`, english.other, values);
    return form === 'other' ? other
      : text(`plugins.triage.detailStory.${key}.${form}`, form === 'one' ? english.one : other, values);
  }, [rules, text]);
}

/** A source's own next page of changed files, offered once the reader has every file read so far open. */
export type TriageDetailChangesLoadMoreV1 = Readonly<{ title: string; pending: boolean; onLoadMore: () => void }>;

/** One changed file: its path, then its added and removed lines as one bar and one right-aligned count. */
function TriageChangeFileRow({ file, scale, onOpen }: Readonly<{
  file: TriageChangedFileV1;
  scale: number;
  onOpen?: ((path: string) => void) | undefined;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const theme = usePluginTheme();
  const row = file.lines === undefined
    ? <Row gap="small" align="center">
      <Stack grow><Text variant="code" numberOfLines={1} value={file.path} /></Stack>
      {file.note === undefined ? null : <Text variant="micro" tone="secondary" value={file.note} />}
    </Row>
    // The bar, then its counts in one right-aligned column, so every bar starts and ends on the same edges (lab `heat`).
    : <Row gap="medium" align="center">
      <Stack grow><Text variant="code" numberOfLines={1} value={file.path} /></Stack>
      <Stack style={{ width: '25%', maxWidth: 120 }}>
        <Progress label={text('plugins.triage.detailStory.fileLines', '{path}: {additions} added, {deletions} removed', {
          path: file.path, additions: String(file.lines.additions), deletions: String(file.lines.deletions),
        })} segments={scale === 0 ? [] : [
          { value: file.lines.additions / scale, tone: 'success' },
          { value: file.lines.deletions / scale, tone: 'danger' },
        ]} />
      </Stack>
      <Stack align="flex-end" style={{ minWidth: CHANGE_COUNTS_MIN_WIDTH_PX }}>
        <Text variant="micro" tone="secondary" value={`+${String(file.lines.additions)} −${String(file.lines.deletions)}`} />
      </Stack>
    </Row>;
  if (onOpen === undefined) return row;
  // The path opens that file where the source reviews its changes; the row keeps its look and gains a press.
  return <HappierPressable accessibilityRole="link" accessibilityLabel={file.path} onPress={() => onOpen(file.path)}
    style={(state) => ({ opacity: state.pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1,
      ...happierFocusRingStyle({ visible: state.focused, color: theme.colors.focus }) })}>
    {row}
  </HappierPressable>;
}

/**
 * Step ② of a change request (lab `heat`): the whole-change totals beside the title, the
 * largest files with their added and removed lines as one bar each, and how many files are
 * left. A provider that reports no line counts gets its files listed and a sentence saying
 * so; no number is drawn that the provider did not state. `children` carries the read's own
 * state (loading, a failure) from the source that owns it.
 *
 * "N smaller files" opens the whole list read so far in place; a source with further pages
 * passes its own `loadMore`. A source that can show the changes passes `onOpenChanges` (the
 * title opens them) and `onOpenFile` (a file opens there); without them the step only reads.
 */
export function TriageDetailChangeSummary({ rows, more, totals, titleKey, children, onOpenChanges, onOpenFile, loadMore }: Readonly<{
  rows: readonly TriageChangedFileV1[];
  /** The provider has more changed files than the pages read so far. */
  more: boolean;
  /** The provider's own whole-change counts, when it states them. */
  totals?: TriageChangeTotalsV1 | undefined;
  titleKey?: string;
  children?: React.ReactNode;
  onOpenChanges?: (() => void) | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
  loadMore?: TriageDetailChangesLoadMoreV1 | undefined;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const count = useStoryCount();
  const theme = usePluginTheme();
  const [expanded, setExpanded] = React.useState(false);
  const { locale } = useSurfaceContext();
  const summary = summarizeTriageChangesV1({ rows, more, totals });
  // Open, every file read so far in the same order; what is left is the files not read yet.
  const listed = expanded ? summarizeTriageChangesV1({ rows, more, totals, shown: rows.length }) : summary;
  const expandable = summary.restCount > 0 && (rows.length > summary.files.length || loadMore !== undefined);
  const known = rows.length > 0 || totals !== undefined;
  const files = { count: String(summary.fileCount) };
  const trailing = !known ? undefined : summary.lines === null
    ? <Text variant="micro" tone="secondary" value={summary.complete
      ? count('files', summary.fileCount, { one: '{count} file', other: '{count} files' })
      : text('plugins.triage.detailStory.filesPartial', '{count}+ files', files)} />
    : <Row gap="xsmall" align="center">
      {/* Grouped as the header's diff size groups them, so one page never spells one count two ways. */}
      <Text variant="micro" tone="success" value={`+${summary.lines.additions.toLocaleString(locale)}`} />
      <Text variant="micro" tone="danger" value={`−${summary.lines.deletions.toLocaleString(locale)}`} />
      <Text variant="micro" tone="secondary" value={summary.complete
        ? count('inFiles', summary.fileCount, { one: 'in {count} file', other: 'in {count} files' })
        : text('plugins.triage.detailStory.inFilesPartial', 'in {count}+ files', files)} />
    </Row>;
  const rest = summary.sortedBySize
    ? count('smallerFiles', summary.restCount, { one: '{count} smaller file', other: '{count} smaller files' })
    : count('moreFiles', summary.restCount, { one: '{count} more file', other: '{count} more files' });
  return <TriageDetailChanges trailing={trailing} {...(titleKey === undefined ? {} : { titleKey })} onOpen={onOpenChanges}>
    {children}
    {expanded ? (
      <List items={listed.files} keyForItem={file => file.path}
        pageLayout={{
          estimatedRowHeight: (theme.typography.code ?? theme.typography.reading).lineHeight,
          rowGapPx: theme.spacing.small,
        }}
        renderItem={file => <TriageChangeFileRow file={file} scale={listed.scale} onOpen={onOpenFile} />} />
    ) : summary.files.map(file => <TriageChangeFileRow key={file.path} file={file} scale={summary.scale} onOpen={onOpenFile} />)}
    {summary.restCount === 0 ? null : !expanded
      ? expandable
        ? <Row><Button title={rest} variant="plain" size="small" onPress={() => setExpanded(true)} /></Row>
        : <Text variant="micro" tone="secondary" value={rest} />
      : <Row gap="small" align="center" wrap>
        {listed.restCount === 0 ? null
          : <Text variant="micro" tone="secondary" value={count('moreFiles', listed.restCount, { one: '{count} more file', other: '{count} more files' })} />}
        {listed.restCount === 0 || loadMore === undefined ? null
          : <Button title={loadMore.title} variant="plain" size="small" busy={loadMore.pending} onPress={loadMore.onLoadMore} />}
        <Button title="Show less" titleKey="plugins.triage.detailStory.showLess" variant="plain" size="small"
          onPress={() => setExpanded(false)} />
      </Row>}
    {!known || summary.lines !== null ? null
      : <Text variant="micro" tone="secondary" valueKey="plugins.triage.detailStory.noLineCounts" fallback="Line counts not reported" />}
  </TriageDetailChanges>;
}

/** One failing check the source read, named the way the provider names it. */
export type TriageDetailFailingCheckV1 = Readonly<{ id: string; name: string; detail?: string }>;

/**
 * The checks the source counted. A complete rollup carries all three counts. An `incomplete`
 * one is what the source read before it stopped short: the failing and running checks seen
 * so far, never a passing verdict about the checks nobody read.
 */
export type TriageDetailChecksRollupV1 =
  | Readonly<{ incomplete?: false; failingCount?: number; runningCount?: number; passingCount?: number }>
  | Readonly<{ incomplete: true; failingCount: number; runningCount: number; passingCount?: number }>;

type ChecksRollupLine = Readonly<{
  state: 'failed' | 'running' | 'passed';
  label: string;
  lead: string | null;
  line: string;
}>;

/**
 * The one sentence a checks rollup says (lab `checksRight`): the failing count leads in the danger
 * tone, the rest of the line stays quiet. Null when the rollup does not state enough to say anything.
 */
function useChecksRollupLine(rollup: TriageDetailChecksRollupV1 | null, latestCommit: boolean): ChecksRollupLine | null {
  const text = usePluginTranslation();
  const count = useStoryCount();
  if (rollup === null || rollup.failingCount === undefined || rollup.runningCount === undefined) return null;
  const incomplete = rollup.incomplete === true;
  const passing = incomplete ? undefined : rollup.passingCount;
  if (!incomplete && passing === undefined) return null;
  const state = rollup.failingCount > 0 ? 'failed' : rollup.runningCount > 0 ? 'running'
    : passing !== undefined && passing > 0 ? 'passed' : null;
  if (state === null) return null;
  const label = text(`plugins.triage.detailStory.${state}`,
    state === 'failed' ? '{count} failed' : state === 'running' ? 'Running' : 'Passed',
    { count: rollup.failingCount });
  let lead: string | null = null;
  let line: string;
  if (incomplete) {
    const notAllRead = text('plugins.triage.detailStory.notAllRead', 'more checks not read');
    if (state === 'failed') {
      lead = count('failingSoFar', rollup.failingCount, { one: '{count} failing so far', other: '{count} failing so far' });
      line = `· ${notAllRead}`;
    } else {
      line = `${count('runningSoFar', rollup.runningCount, { one: '{count} running so far', other: '{count} running so far' })} · ${notAllRead}`;
    }
  } else {
    const passed = count('passedCount', passing!, { one: '{count} passed', other: '{count} passed' });
    const running = count('runningCount', rollup.runningCount, { one: '{count} running', other: '{count} running' });
    if (state === 'failed') {
      lead = count('failing', rollup.failingCount, { one: '{count} failing', other: '{count} failing' });
      line = `· ${[passed, ...(rollup.runningCount > 0 ? [running] : [])].join(' · ')}`;
    } else {
      line = state === 'running' ? `${running} · ${passed}`
        : latestCommit
          ? count('allPassedLatest', passing!, { one: '{count} passed on the latest commit', other: 'All {count} passed on the latest commit' })
          : count('allPassed', passing!, { one: '{count} passed', other: 'All {count} passed' });
    }
  }
  return { state, label, lead, line };
}

/** `micro` trails a story step's title; `body` is the line that stands alone above a checks list. */
function ChecksRollupSentence({ lead, line, variant = 'micro' }: Readonly<{
  lead: string | null;
  line: string;
  variant?: 'micro' | 'meta' | 'body';
}>): React.ReactElement {
  return lead === null ? <Text variant={variant} tone="secondary" value={line} />
    : <Row gap="xsmall" align="center">
      <Text variant={variant} tone="danger" value={lead} />
      <Text variant={variant} tone="secondary" value={line} />
    </Row>;
}

/**
 * A checks rollup as one calm line ("4 failing · 14 passed"), for a source's own checks list that
 * draws the rows itself. The same sentence the detail story's Checks step carries, so one rollup
 * never reads two ways. Nothing is drawn when the rollup does not state its counts.
 */
export function TriageChecksRollupLine({ rollup, latestCommit = false, variant = 'body' }: Readonly<{
  rollup: TriageDetailChecksRollupV1 | null;
  latestCommit?: boolean;
  /** `body` stands alone above a checks list; `meta` is one fact in an entry's facts row. */
  variant?: 'meta' | 'body';
}>): React.ReactElement | null {
  const sentence = useChecksRollupLine(rollup, latestCommit);
  return sentence === null ? null : <ChecksRollupSentence lead={sentence.lead} line={sentence.line} variant={variant} />;
}

/**
 * The checks state of a change request: the marker, the rollup sentence beside the title and the
 * failing checks under it. Counts are canonical provider rollups, never inferred from the
 * currently loaded page, and only a source whose rollup is the latest commit's says so
 * (`latestCommit`). An incomplete rollup keeps the failures already read and says the count is
 * incomplete.
 */
export function TriageDetailChecks({ title, titleKey, rollup, failing, latestCommit = false, children, onOpenChecks }: Readonly<{
  title: string;
  titleKey: string;
  rollup: TriageDetailChecksRollupV1 | null;
  failing?: readonly TriageDetailFailingCheckV1[];
  latestCommit?: boolean;
  children?: React.ReactNode;
  /** The source's own checks view; the step title opens it. Without it the step only reads. */
  onOpenChecks?: (() => void) | undefined;
}>): React.ReactElement | null {
  const sentence = useChecksRollupLine(rollup, latestCommit);
  if (sentence === null) return null;
  const listed = sentence.state === 'failed' && failing !== undefined && failing.length > 0;
  return <Step title={title} titleKey={titleKey} marker={{ kind: 'state', state: sentence.state, label: sentence.label }}
    {...(onOpenChecks === undefined ? {} : { onPress: onOpenChecks })}
    trailing={<ChecksRollupSentence lead={sentence.lead} line={sentence.line} />}>
    {listed || children !== undefined ? <Stack gap="small">
      {/* What failed is the chapter's point: one card, each row led by its failure mark (lab `checksRight`). */}
      {listed ? <Card padding="small">
        <Stack gap="small">
          {failing.map((check) => <Row key={check.id} gap="small" align="flex-start">
            <Icon name="failure" size="small" tone="danger" />
            <Stack grow style={FAILING_CHECK_TEXT_STYLE}>
              <TriageStatusRow presentation="summary" name={check.name} status={check.detail} />
            </Stack>
          </Row>)}
        </Stack>
      </Card> : null}
      {children}
    </Stack> : null}
  </Step>;
}

/** One stated fact of an error group's reach, already formatted by the source that read it. */
export type TriageDetailSpreadTileV1 = Readonly<{ id: string; label: string; value: string }>;

/** The source's own occurrence series: counts per period, oldest first. */
export type TriageDetailTrendV1 = Readonly<{
  /** What one point counts ("Events per hour"); it leads what the chart says to assistive technology. */
  label: string;
  /** The window the series covers, beside the step title ("Last 24 hours"). */
  windowLabel: string;
  points: readonly Readonly<{ atMs: number; count: number }>[];
}>;

/**
 * Step ② of an error group: how far it reaches — the counts the source states, and the
 * trend it reads. Every number is the provider's own; a fact the source did not state is
 * absent rather than zero, and with nothing stated the step is not drawn.
 */
export function TriageDetailSpread({ tiles, trend, locale, nowMs }: Readonly<{
  tiles: readonly TriageDetailSpreadTileV1[];
  trend: TriageDetailTrendV1 | null;
  locale: string;
  nowMs: number;
}>): React.ReactElement | null {
  const points = trend === null ? [] : trend.points;
  if (tiles.length === 0 && points.length === 0) return null;
  const tileRow = tiles.length === 0 ? null : <Row gap="large" style={{ flexWrap: 'wrap' }}>
    {tiles.map((tile) => <Metric key={tile.id} size="stat" label={tile.label} value={tile.value} caption={tile.label} />)}
  </Row>;
  const chart = trend === null || points.length === 0 ? null : <Chart style="line" label={trend.label}
    points={points.map((point) => ({
      x: formatTriageTimestampV1(locale, point.atMs, 'relative', nowMs), y: point.count,
    }))} />;
  return <Step marker={{ kind: 'number', value: 2 }} title="Spread" titleKey="plugins.triage.detailStory.spread"
    trailing={trend === null ? undefined : <Text variant="micro" tone="neutral" value={trend.windowLabel} />}>
    {tileRow === null || chart === null ? tileRow ?? chart
      // Beside each other when the pane holds two columns, stacked when it does not: the
      // count comes from the width `Columns` itself measured.
      : <Columns columns={2}><Column>{tileRow}</Column><Column>{chart}</Column></Columns>}
  </Step>;
}
