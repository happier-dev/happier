import * as React from 'react';
import { Chart, Column, Columns, Metric, Progress, Row, ScrollArea, Stack, Step, Text, usePluginTranslation, useSurfaceContext } from '@happier-dev/plugin-ui';
import { formatTriageTimestampV1 } from '@happier-dev/triage-protocol/v1';

import { summarizeTriageChangesV1, type TriageChangedFileV1, type TriageChangeTotalsV1 } from './changeSummary.js';

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
export function TriageDetailStory({ kind, children, changes, checks, trailing }: Readonly<{
  kind?: keyof typeof STORY_TITLES | undefined;
  children: React.ReactNode;
  /** Step ②: what changed for a change request, the spread for an error group. */
  changes?: React.ReactNode;
  checks?: React.ReactNode;
  trailing?: React.ReactNode;
}>): React.ReactElement {
  if (kind === undefined) return <ScrollArea><Stack gap="large">{children}</Stack></ScrollArea>;
  return <Stack gap="large">
    <Step marker={{ kind: 'number', value: 1 }}
      title={STORY_TITLES[kind].fallback}
      titleKey={STORY_TITLES[kind].key} trailing={trailing}>
      <Stack gap="large">{children}</Stack>
    </Step>
    {changes}
    {checks}
  </Stack>;
}

function TriageDetailChanges({ children, trailing, titleKey = 'plugins.triage.detailStory.changed' }: Readonly<{
  children: React.ReactNode;
  trailing?: React.ReactNode;
  titleKey?: string;
}>): React.ReactElement {
  return <Step marker={{ kind: 'number', value: 2 }} title="What changed"
    titleKey={titleKey} trailing={trailing}><Stack gap="small">{children}</Stack></Step>;
}

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

/**
 * Step ② of a change request (lab `heat`): the whole-change totals beside the title, the
 * largest files with their added and removed lines as one bar each, and how many files are
 * left. A provider that reports no line counts gets its files listed and a sentence saying
 * so; no number is drawn that the provider did not state. `children` carries the read's own
 * state (loading, a failure) from the source that owns it.
 */
export function TriageDetailChangeSummary({ rows, more, totals, titleKey, children }: Readonly<{
  rows: readonly TriageChangedFileV1[];
  /** The provider has more changed files than the pages read so far. */
  more: boolean;
  /** The provider's own whole-change counts, when it states them. */
  totals?: TriageChangeTotalsV1 | undefined;
  titleKey?: string;
  children?: React.ReactNode;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const count = useStoryCount();
  const summary = summarizeTriageChangesV1({ rows, more, totals });
  const known = rows.length > 0 || totals !== undefined;
  const files = { count: String(summary.fileCount) };
  const trailing = !known ? undefined : summary.lines === null
    ? <Text variant="caption" tone="secondary" value={summary.complete
      ? count('files', summary.fileCount, { one: '{count} file', other: '{count} files' })
      : text('plugins.triage.detailStory.filesPartial', '{count}+ files', files)} />
    : <Row gap="xsmall" align="center">
      <Text variant="caption" tone="success" value={`+${String(summary.lines.additions)}`} />
      <Text variant="caption" tone="danger" value={`−${String(summary.lines.deletions)}`} />
      <Text variant="caption" tone="secondary" value={summary.complete
        ? count('inFiles', summary.fileCount, { one: 'in {count} file', other: 'in {count} files' })
        : text('plugins.triage.detailStory.inFilesPartial', 'in {count}+ files', files)} />
    </Row>;
  return <TriageDetailChanges trailing={trailing} {...(titleKey === undefined ? {} : { titleKey })}>
    {children}
    {summary.files.map((file) => file.lines === undefined
      ? <Row key={file.path} gap="small" align="center">
        <Stack style={{ flex: 1, minWidth: 0 }}><Text variant="code" numberOfLines={1} value={file.path} /></Stack>
        {file.note === undefined ? null : <Text variant="caption" tone="secondary" value={file.note} />}
      </Row>
      : <Row key={file.path} gap="medium" align="center">
        <Stack style={{ flex: 1, minWidth: 0 }}><Text variant="code" numberOfLines={1} value={file.path} /></Stack>
        <Stack style={{ width: '25%', maxWidth: 120 }}>
          <Progress label={text('plugins.triage.detailStory.fileLines', '{path}: {additions} added, {deletions} removed', {
            path: file.path, additions: String(file.lines.additions), deletions: String(file.lines.deletions),
          })} segments={summary.scale === 0 ? [] : [
            { value: file.lines.additions / summary.scale, tone: 'success' },
            { value: file.lines.deletions / summary.scale, tone: 'danger' },
          ]} />
        </Stack>
        <Text variant="caption" tone="secondary" value={`+${String(file.lines.additions)} −${String(file.lines.deletions)}`} />
      </Row>)}
    {summary.restCount === 0 ? null : <Text variant="caption" tone="secondary" value={summary.sortedBySize
      ? count('smallerFiles', summary.restCount, { one: '{count} smaller file', other: '{count} smaller files' })
      : count('moreFiles', summary.restCount, { one: '{count} more file', other: '{count} more files' })} />}
    {!known || summary.lines !== null ? null
      : <Text variant="caption" tone="secondary" valueKey="plugins.triage.detailStory.noLineCounts" fallback="Line counts not reported" />}
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

/**
 * The checks state of a change request (lab `checksRight`): the marker, the counts beside the
 * title and the failing checks under it. Counts are canonical provider rollups, never
 * inferred from the currently loaded page, and only a source whose rollup is the latest
 * commit's says so (`latestCommit`). An incomplete rollup keeps the failures already read
 * and says the count is incomplete.
 */
export function TriageDetailChecks({ title, titleKey, rollup, failing, latestCommit = false, children }: Readonly<{
  title: string;
  titleKey: string;
  rollup: TriageDetailChecksRollupV1 | null;
  failing?: readonly TriageDetailFailingCheckV1[];
  latestCommit?: boolean;
  children?: React.ReactNode;
}>): React.ReactElement | null {
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
  // Lab `checksRight`: the failing count leads in the danger tone, the rest of the line stays quiet.
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
  const trailing = lead === null ? <Text variant="caption" tone="secondary" value={line} />
    : <Row gap="xsmall" align="center">
      <Text variant="caption" tone="danger" value={lead} />
      <Text variant="caption" tone="secondary" value={line} />
    </Row>;
  const listed = state === 'failed' && failing !== undefined && failing.length > 0;
  return <Step title={title} titleKey={titleKey} marker={{ kind: 'state', state, label }} trailing={trailing}>
    {listed || children !== undefined ? <Stack gap="small">
      {listed ? failing.map((check) => <Stack key={check.id} gap="none">
        <Text variant="label" value={check.name} />
        {check.detail === undefined ? null : <Text variant="caption" tone="secondary" value={check.detail} />}
      </Stack>) : null}
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
    {tiles.map((tile) => <Stack key={tile.id} gap="none">
      <Metric label={tile.label} value={tile.value} />
      <Text variant="caption" tone="neutral" value={tile.label} />
    </Stack>)}
  </Row>;
  const chart = trend === null || points.length === 0 ? null : <Chart style="line" label={trend.label}
    points={points.map((point) => ({
      x: formatTriageTimestampV1(locale, point.atMs, 'relative', nowMs), y: point.count,
    }))} />;
  return <Step marker={{ kind: 'number', value: 2 }} title="Spread" titleKey="plugins.triage.detailStory.spread"
    trailing={trend === null ? undefined : <Text variant="caption" tone="neutral" value={trend.windowLabel} />}>
    {tileRow === null || chart === null ? tileRow ?? chart
      // Beside each other when the pane holds two columns, stacked when it does not: the
      // count comes from the width `Columns` itself measured.
      : <Columns columns={2}><Column>{tileRow}</Column><Column>{chart}</Column></Columns>}
  </Step>;
}
