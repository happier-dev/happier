import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierDataRows, HappierPressable } from '@happier-dev/plugin-ui/presentation';
import type { ScmPullRequestSummary } from '@happier-dev/protocol/scm';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { t } from '@/text';
import { UsageAgentMark, useUsagePluginTheme } from './usageBodyKit';
import { UsageWorkProviderMark } from './UsageWorkProviderMark';
import type {
  UsageWorkIdentities,
  UsageWorkSessionPart,
  UsageWorkSessionRow,
  UsageWorkSummary,
} from './usageWorkPresentation';

/** The parts the Work bodies share: identity marks, an in-place disclosure and a Session's rows. */

/** A commit as people say it. The witnessed object id is unchanged; only its display is short. */
export function usageWorkShortCommit(sha: string): string {
  return sha.slice(0, 7);
}

export function usageWorkBranchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** Native state only: a closed PR is "closed", never "abandoned". */
export function usageWorkPullRequestState(pullRequest: ScmPullRequestSummary): string {
  if (pullRequest.state === 'merged') return t('usage.board.work.state_merged');
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

/** Agent marks, then the witnessed Provider marks: two identities, never one inferred from the other. */
export function UsageWorkMarks(
  props: Pick<UsageWorkIdentities, 'agentIds' | 'providers'> &
    Readonly<{ serverId: string; testID?: string }>,
) {
  if (props.agentIds.length === 0 && props.providers.length === 0) return null;
  return (
    <View style={styles.marks}>
      {props.agentIds.map((agentId) => (
        <UsageAgentMark key={agentId} agentId={agentId} serverId={props.serverId} />
      ))}
      {props.providers.map((provider) => (
        <UsageWorkProviderMark
          key={`${provider.providerId}\u0000${provider.machineId ?? ''}`}
          {...provider}
          serverId={props.serverId}
          testID={props.testID ? `${props.testID}.provider.${provider.providerId}` : undefined}
        />
      ))}
    </View>
  );
}

export function usageWorkProviderUnknownLine(row: Pick<UsageWorkIdentities, 'providerUnknown'>): string {
  return row.providerUnknown
    ? `${t('usage.board.work.provider')}: ${t('usage.board.howYouWork.notRecorded')}`
    : '';
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
        <Icon
          name={props.expanded ? 'caret-down' : 'caret-right'}
          size={ICON_SIZE.xs}
          color={theme.colors.text.tertiary}
        />
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
    onToggle: () => void;
    label: string;
    testID: string;
    children: React.ReactNode;
    detail: () => React.ReactNode;
  }>,
) {
  return (
    <View>
      <HappierPressable
        accessibilityRole="button"
        accessibilityLabel={props.label}
        expanded={props.expanded}
        testID={`${props.testID}.toggle`}
        onPress={props.onToggle}
      >
        {props.children}
      </HappierPressable>
      {props.expanded ? (
        <View testID={`${props.testID}.detail`} style={styles.detail}>
          {props.detail()}
        </View>
      ) : null}
    </View>
  );
}

/** Which rows of one body are open. Several can be: comparing two projects is the point. */
export function useUsageWorkDisclosures(): Readonly<{
  isOpen(id: string): boolean;
  toggle(id: string): void;
}> {
  const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set());
  const toggle = React.useCallback((id: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  return React.useMemo(() => ({ isOpen: (id: string) => open.has(id), toggle }), [open, toggle]);
}

/**
 * Every Session of a row with its exact part of that row. Each opens that Session's own autopsy
 * through the one Session Usage route.
 */
export function UsageWorkSessionRows(
  props: Readonly<{
    parts: readonly UsageWorkSessionPart[];
    summary: UsageWorkSummary;
    format: (value: number | null) => string;
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
  return (
    <HappierDataRows
      theme={theme}
      label={t('usage.board.work.funnelSessions')}
      testID={props.testID}
      density="compact"
      showProportionShares={false}
      valueFormatter={props.format}
      rowIds={props.parts.map((part) => part.sessionId)}
      rowLeads={props.parts.map((part) => {
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
      rows={props.parts.map((part) => [
        props.sessionLabel(part.sessionId),
        part.amount ?? props.format(null),
        usageWorkSessionOutcomeLine(bySession.get(part.sessionId)),
      ])}
      renderRow={(_row, visual, index) => {
        const part = props.parts[index]!;
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
}

const styles = StyleSheet.create((theme) => ({
  marks: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
  lead: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  sectionTitle: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8 },
  sectionName: { ...Typography.default('semiBold'), color: theme.colors.text.primary },
  sectionQuiet: { ...Typography.default('semiBold'), color: theme.colors.text.secondary },
  sectionCaption: { ...Typography.default(), color: theme.colors.text.tertiary },
  // Indented by the caret column, so what a row holds reads as inside it without a box.
  detail: { gap: 10, paddingTop: 10, paddingBottom: 6, paddingLeft: ICON_SIZE.xs + 4, minWidth: 0 },
}));
