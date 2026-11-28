import * as React from 'react';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierDataRows, HappierPressable, type HappierChartDatum } from '@happier-dev/plugin-ui/presentation';
import type { ScmPullRequestSummary } from '@happier-dev/protocol/scm';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { Text } from '@/components/ui/text/Text';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Typography } from '@/constants/Typography';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { t } from '@/text';
import { UsageAgentMark, UsageBodyReading, UsageShowAllRows, leadingUsageRows, readUsageWorkReadAsOfMs, useUsagePluginTheme } from './usageBodyKit';
import { UsageWorkProviderMark, usageWorkProviderIdentities, usageWorkProviderNames } from './UsageWorkProviderMark';
import { usageAgentTitle } from '@/sync/domains/usage/usageLabels';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { usageWorkLinksNotice } from './usageWorkPresentation';
import { usageTokensFromPartsNote } from '../usageCostPresentation';
import { formatUsageObservedAt } from '@/sync/domains/usage/usageCalendarPresentation';
import type {
  UsageWorkIdentities,
  UsageWorkSessionPart,
  UsageWorkSessionRow,
  UsageWorkSummary,
  UsageWorkRetainedChange,
  UsageWorkMoneyBasis,
} from './usageWorkPresentation';

export { USAGE_WORK_UNALLOCATED_REASONS, usageWorkAllocationReasonLabel, usageWorkLinksNotice, usageWorkPageReadLabel } from './usageWorkPresentation';

/** The parts the Work bodies share: identity marks, an in-place disclosure and a Session's rows. */

/** A commit as people say it. The witnessed object id is unchanged; only its display is short. */
export function usageWorkShortCommit(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Each count names its immutable comparison target; never sum snapshots into authorship. A one-commit range names its
 * commit once, and not at all when the row already says that commit (`saidCommit`): "Commit 027cb70 · +1 / −0".
 */
export function usageWorkRetainedChangeLine(changes: readonly UsageWorkRetainedChange[], saidCommit?: string): string {
  // Nothing witnessed kept is not information: the cell stays empty rather than saying "Not recorded".
  return changes.length === 0 ? '' : changes.map(change => {
    const range = change.commitSha !== change.targetSha
      ? `${usageWorkShortCommit(change.commitSha)} → ${usageWorkShortCommit(change.targetSha)}: `
      : change.commitSha === saidCommit ? '' : `${usageWorkShortCommit(change.commitSha)}: `;
    return `${range}+${change.addedLines} / −${change.removedLines}`
      + (change.status === 'partial' ? ` · ${t('usage.board.work.linesKeptPartial')}` : '');
  }).join(' · ');
}

export function UsageWorkPendingNotice(props: Readonly<{
  notice: ReturnType<typeof usageWorkLinksNotice>; testID: string; fallback?: React.ReactNode;
}>) {
  if (!props.notice.progress) return props.fallback ?? null;
  return <SurfaceFreshnessLine testID={props.testID} busy
    reason={[props.notice.title, props.notice.cause].filter(Boolean).join(' · ')} />;
}

export function UsageWorkReading(props: Readonly<{ slice: UsageQueryResultSlice; testID: string }>) {
  const notice = usageWorkLinksNotice(props.slice);
  return <>
    <UsageBodyReading testID={`${props.testID}.loading`}
      waitingOn={notice.progress ? undefined : { slice: props.slice, sources: ['work'] }} />
    <UsageWorkPendingNotice notice={notice} testID={`${props.testID}.workProgress`} />
  </>;
}

/**
 * When the Work answer on screen was read: its own as-of, never accounting's. A usage event does not reread Work, so
 * the links can be older than the figures beside them; said always while a read Work answer is shown (J-A35).
 */
export function usageWorkLinksReadAt(slice: Pick<UsageQueryResultSlice, 'sources'>): string | null {
  const asOfMs = readUsageWorkReadAsOfMs(slice);
  return asOfMs === null ? null : t('usage.board.work.linksReadAt', { time: formatUsageObservedAt(asOfMs) });
}

export function usageWorkBranchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** Native state only: a closed PR is "closed", never "abandoned". */
export function usageWorkPullRequestState(pullRequest: ScmPullRequestSummary): string {
  if (pullRequest.state === 'merged') return t('usage.board.work.state_merged');
  if (pullRequest.state === 'draft') return t('usage.board.work.state_draft');
  if (pullRequest.state === 'open')
    return pullRequest.isDraft ? t('usage.board.work.state_draft') : t('usage.board.work.state_open');
  return t('usage.board.work.state_closed');
}

export function usageWorkPullRequestTitle(pullRequest: ScmPullRequestSummary): string {
  return pullRequest.number
    ? t('usage.board.work.prTitle', { number: pullRequest.number, title: pullRequest.title })
    : pullRequest.title;
}

/** What a Session is exactly linked to, in words. No link is "no linked outcome yet", never zero. */
export function usageWorkSessionOutcomeLine(
  row: Pick<UsageWorkSessionRow, 'outcomes'> | undefined,
): string {
  const outcomes = row?.outcomes ?? [];
  if (outcomes.length === 0) return t('usage.board.work.noOutcome');
  if (outcomes.length > 1) return t('usage.board.work.sessionLine', { prs: outcomes.length });
  const pullRequest = outcomes[0]!.pullRequest;
  return `${usageWorkPullRequestTitle(pullRequest)} · ${usageWorkPullRequestState(pullRequest)}`;
}

/**
 * Agent marks, then the witnessed Provider marks: two identities, never one inferred from the other. A lead keeps the
 * marks at their own width. With `fitWidth` (a row's trail, or the line under a name) the strip is one line that takes
 * the width the row gives it: the marks that fit, then "+n" for the rest (acceptance 1122 #46). Until that width is
 * known the line clips instead of wrapping, so nothing moves when the count appears.
 */
export function UsageWorkMarks(
  props: Pick<UsageWorkIdentities, 'agentIds' | 'providers'> &
    Readonly<{ serverId: string; testID?: string; fitWidth?: boolean }>,
) {
  const { theme } = useUnistyles();
  const metrics = usePageRowMetrics('list');
  const [width, setWidth] = React.useState<number | null>(null);
  const [countWidth, setCountWidth] = React.useState<number | null>(null);
  // One Provider on several Machines is one identity: it is drawn once, and two identities that share a name are
  // told apart in their spoken labels the way the detail line tells them apart (review J-B31).
  const providerIdentities = usageWorkProviderIdentities(props.providers);
  const providerNames = usageWorkProviderNames(providerIdentities, props.serverId, props.agentIds.map(id => usageAgentTitle(id)));
  const total = props.agentIds.length + providerIdentities.length;
  if (total === 0) return null;
  const gap = theme.space.s4;
  const slot = ICON_SIZE.sm + gap;
  const fits = !props.fitWidth || width === null || Math.floor((width + gap) / slot) >= total;
  // The count takes its measured width (one mark's width until measured); each shown mark takes its slot.
  const shown = fits ? total : Math.max(0, Math.floor((width - (countWidth ?? ICON_SIZE.sm)) / slot));
  const agents = props.agentIds.slice(0, shown);
  const providers = providerIdentities.slice(0, Math.max(0, shown - props.agentIds.length));
  // The line takes the width its row gives it (beside a name, or under it on a narrow card), never its content's
  // width: the marks sit on an absolutely placed strip so the count never feeds back into the width it is fit to.
  const marks = (
    <View style={props.fitWidth ? styles.marksFit : styles.marks}>
      {agents.map((agentId) => (
        <UsageAgentMark key={agentId} agentId={agentId} serverId={props.serverId} />
      ))}
      {providers.map((provider, index) => (
        <UsageWorkProviderMark
          key={provider.providerId}
          provider={provider}
          label={providerNames[index]}
          serverId={props.serverId}
          testID={props.testID ? `${props.testID}.provider.${provider.providerId}` : undefined}
        />
      ))}
      {fits ? null : (
        <Text style={[styles.marksMore, { fontSize: metrics.subtitle.fontSize, lineHeight: metrics.subtitle.lineHeight }]} numberOfLines={1}
          onLayout={(event) => setCountWidth(event.nativeEvent.layout.width)}>
          {t('usage.board.work.moreMarks', { count: total - shown })}
        </Text>
      )}
    </View>
  );
  if (!props.fitWidth) return marks;
  return (
    <View style={[styles.marksLine, { minHeight: Math.max(ICON_SIZE.sm, metrics.subtitle.lineHeight) }]}
      testID={props.testID ? `${props.testID}.marks` : undefined}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {marks}
    </View>
  );
}

/** A row's leading glyphs: the disclosure caret, then what the row is. */
export function UsageWorkRowLead(
  props: Readonly<{
    expanded?: boolean;
    icon?: React.ComponentProps<typeof Icon>['name'];
    color?: string;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.lead}>
      {props.expanded === undefined ? null : (
        <DisclosureCaret expanded={props.expanded} size={ICON_SIZE.xs} />
      )}
      {props.icon ? (
        <Icon
          name={props.icon}
          size={ICON_SIZE.sm}
          color={props.color ?? theme.colors.text.secondary}
        />
      ) : null}
    </View>
  );
}

export function UsageWorkSectionTitle(
  props: Readonly<{ children: string; caption?: string; quiet?: boolean }>,
) {
  const metrics = usePageRowMetrics('list');
  const size = { fontSize: metrics.subtitle.fontSize, lineHeight: metrics.subtitle.lineHeight };
  return (
    <View style={styles.sectionTitle}>
      <Text
        style={[props.quiet ? styles.sectionQuiet : styles.sectionName, size]}
        accessibilityRole="header"
      >
        {props.children}
      </Text>
      {props.caption ? <Text style={[styles.sectionCaption, size]}>{props.caption}</Text> : null}
    </View>
  );
}

/**
 * A row that opens in place. Nothing animates: the rows beneath move once, by exactly the height of
 * what was asked for, and the row itself keeps its position.
 */
export function UsageWorkDisclosure(
  props: Readonly<{
    expanded: boolean;
    testID: string;
    children: React.ReactNode;
    detail: () => React.ReactNode;
  }>,
) {
  return (
    <View>
      {props.children}
      {props.expanded ? (
        <View testID={`${props.testID}.detail`} style={styles.detail}>
          {props.detail()}
        </View>
      ) : null}
    </View>
  );
}

/** Which rows of one body are open. Several can be: comparing two projects is the point. */
export function useUsageWorkDisclosures(rows: readonly Readonly<{ id: string; title: string }>[]): Readonly<{
  isOpen(id: string): boolean;
  toggle(id: string): void;
}> {
  const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set());
  const toggleRow = React.useCallback((id: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const commands = useCurrentUiContextLocalCommands(rows.map(row => ({ key: row.id,
    title: `${row.title}: ${t(open.has(row.id) ? 'usage.showLess' : 'common.details')}`,
    invoke: () => toggleRow(row.id),
  })));
  const toggle = React.useCallback((id: string) => { void commands.invoke(id); }, [commands.invoke]);
  return React.useMemo(() => ({ isOpen: (id: string) => open.has(id), toggle }), [open, toggle]);
}

/**
 * Every Session of a row with its exact part of that row, the largest first and the rest behind the Usage
 * "Show all · n" footer (a Project can hold hundreds, acceptance r224 #48). Each opens that Session's own
 * autopsy through the one Session Usage route. Under a `title`, the outcome state follows the Work coverage decision
 * (review J-B34): a group that has Sessions, whose linked PRs were read (`outcomesRead`) and none is linked, says so
 * once beside the title; rows name only a linked PR, or its absence beside a sibling that has one. No Sessions, or
 * PRs not read, claims nothing.
 */
export function UsageWorkSessionRows(
  props: Readonly<{
    title?: string;
    outcomesRead?: boolean;
    parts: readonly UsageWorkSessionPart[];
    summary: UsageWorkSummary;
    format: (value: number | null, moneyBasis?: UsageWorkMoneyBasis | null) => string;
    cell: (value: number | null, moneyBasis: UsageWorkMoneyBasis | null) => number | string;
    datum: (label: string, value: number | null, moneyBasis: UsageWorkMoneyBasis | null) => HappierChartDatum | null;
    sessionLabel: (sessionId: string) => string;
    openSession: (sessionId: string) => void;
    serverId: string;
    testID: string;
  }>,
) {
  const theme = useUsagePluginTheme();
  const bySession = React.useMemo(
    () => new Map(props.summary.sessions.map((row) => [row.sessionId, row])),
    [props.summary.sessions],
  );
  const [expanded, setExpanded] = React.useState(false);
  const shown = leadingUsageRows(props.parts, expanded);
  const linked = (sessionId: string) => (bySession.get(sessionId)?.outcomes.length ?? 0) > 0;
  const anyLinked = props.parts.some(part => linked(part.sessionId));
  const outcomeOnce = props.title !== undefined && props.outcomesRead === true && props.parts.length > 0 && !anyLinked;
  const outcomeLine = (sessionId: string) => props.title === undefined || linked(sessionId)
    || props.outcomesRead === true && anyLinked ? usageWorkSessionOutcomeLine(bySession.get(sessionId)) : null;
  // Under a titled group the parts qualifier is said once in the group's caption, never on each of its rows (r225 #60).
  const partsSaidOnce = props.title === undefined ? null : usageTokensFromPartsNote(shown.rows.map(part => part.tokensFromParts));
  const rows = (
    <HappierDataRows
      theme={theme}
      label={t('usage.board.work.funnelSessions')}
      testID={props.testID}
      density="compact"
      showProportionShares={false}
      valueFormatter={props.format}
      rowIds={shown.rows.map((part) => part.sessionId)}
      rowLeads={shown.rows.map((part) => {
        const row = bySession.get(part.sessionId);
        return row ? (
          <UsageWorkMarks agentIds={row.agentIds} providers={row.providers} serverId={props.serverId} />
        ) : undefined;
      })}
      columns={[
        { label: t('usage.board.work.funnelSessions') },
        { label: t('usage.board.work.valueLabel'), proportion: true },
        { label: t('usage.board.work.linkedOutcome') },
      ]}
      rows={shown.rows.map((part) => [
        props.sessionLabel(part.sessionId),
        props.cell(part.amount, part.moneyBasis),
        [outcomeLine(part.sessionId),
          part.tokensFromParts && props.title === undefined ? t('usage.board.page.tokensFromParts') : null].filter(Boolean).join(' · '),
      ])}
      rowDatums={shown.rows.map(part => props.datum(props.sessionLabel(part.sessionId), part.amount, part.moneyBasis))}
      renderIdentity={(_row, visual, index) => {
        const part = shown.rows[index]!;
        return (
          <HappierPressable
            accessibilityRole="button"
            testID={`${props.testID}.open.${part.sessionId}`}
            accessibilityLabel={t('usage.board.work.openSession', {
              title: props.sessionLabel(part.sessionId),
            })}
            onPress={() => props.openSession(part.sessionId)}
          >
            {visual}
          </HappierPressable>
        );
      }}
    />
  );
  const more = (
    <UsageShowAllRows label={props.title ?? t('usage.board.work.funnelSessions')} total={props.parts.length}
      hidden={shown.hidden} expanded={expanded} onToggle={() => setExpanded(value => !value)} testID={`${props.testID}.more`} />
  );
  if (props.title === undefined) return <>{rows}{more}</>;
  return (
    <View style={styles.group}>
      <UsageWorkSectionTitle quiet caption={[outcomeOnce ? t('usage.board.work.noOutcome') : null, partsSaidOnce]
        .filter(Boolean).join(' · ') || undefined}>{props.title}</UsageWorkSectionTitle>
      {rows}
      {more}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  marks: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.s4 },
  marksLine: { flexGrow: 1, alignSelf: 'stretch', minWidth: 0 },
  marksFit: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, flexDirection: 'row', flexWrap: 'nowrap', overflow: 'hidden',
    alignItems: 'center', gap: theme.space.s4 },
  marksMore: { ...Typography.default(), color: theme.colors.text.secondary, flexShrink: 0 },
  group: { gap: theme.space.s6, minWidth: 0 },
  lead: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
  sectionTitle: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: theme.space.s8 },
  sectionName: { ...Typography.default('semiBold'), color: theme.colors.text.primary },
  sectionQuiet: { ...Typography.default('semiBold'), color: theme.colors.text.secondary },
  sectionCaption: { ...Typography.default(), color: theme.colors.text.tertiary },
  // Indented by the caret column, so what a row holds reads as inside it without a box.
  detail: { gap: theme.space.s10, paddingTop: theme.space.s10, paddingBottom: theme.space.s6, paddingLeft: ICON_SIZE.xs + 4, minWidth: 0 },
}));
