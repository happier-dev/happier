import * as React from 'react';
import { formatHappierDataValue, type HappierChartDatum } from '@happier-dev/plugin-ui/presentation';
import { UsageAccountingMetricSchema, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useMachineDisplayById, useSessionListRowsByServerId } from '@/sync/store/hooks';
import { getSessionMachineLabel, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { formatUsageCalendarDate } from '@/sync/domains/usage/usageCalendarPresentation';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { getPreferredLanguage, t } from '@/text';
import {
  summarizeUsageWork,
  type UsageWorkSummary,
  type UsageWorkMoneyBasis,
  type UsageWorkSessionIdentity,
} from './usageWorkPresentation';
import { useUsageAnalyticsView, useUsageProjectAnchorOf, useUsageProjectNames, usageMachinePlace } from './usageBodyKit';
import { readUsageWidgetPageScope, readUsageWidgetQueryOverrides } from '../usageWidgetPageContext';
import { buildUsageRouteParams } from '../usageRouteParams';
import { usageCostKindPhrase } from '../usageCostPresentation';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

function countLabels(labels: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return counts;
}

const summaries = new WeakMap<object, Map<string, UsageWorkSummary>>();
const EMPTY_SESSION_IDENTITIES: readonly UsageWorkSessionIdentity[] = Object.freeze([]);
const EMPTY_MACHINE_IDS: readonly string[] = Object.freeze([]);

/** The Work bodies' shared reading of one slice: U7's allocation grouped once, labels and drill. */
export function useUsageWork(
  slice: UsageQueryResultSlice,
  query: UsageQuery,
  serverId: string,
) {
  const work = slice.work;
  const view = useUsageAnalyticsView(slice, query);
  const projectNames = useUsageProjectNames(serverId, view?.breakdowns.projects);
  const projectLabels = projectNames.labels;
  const namedProjectKeys = React.useMemo(() => new Set(projectLabels.keys()), [projectLabels]);
  // Usage stamped by a checkout before it joined a Project counts under that Project (owner 11-08).
  const anchorOf = useUsageProjectAnchorOf(serverId);
  const namesKey = JSON.stringify([...namedProjectKeys].sort());
  const summary = React.useMemo(() => {
    if (!work) return null;
    const key = `${query.metric}\u0000${query.costBasis}\u0000${namesKey}\u0000${anchorOf.joinedKey}`;
    let byKey = summaries.get(work);
    if (!byKey) {
      byKey = new Map();
      summaries.set(work, byKey);
    }
    const cached = byKey.get(key);
    if (cached) return cached;
    const built = summarizeUsageWork(work, {
      metric: query.metric,
      costBasis: query.costBasis,
    }, namedProjectKeys, anchorOf.resolve);
    byKey.set(key, built);
    return built;
  }, [work, query.metric, query.costBasis, namesKey, namedProjectKeys, anchorOf]);
  const format = React.useCallback(
    (value: number | null, moneyBasis: UsageWorkMoneyBasis | null = summary?.moneyBasis ?? null) =>
      value === null ? t('usage.board.recap.money_unpriced') : query.metric === 'cost'
        ? moneyBasis ? `${formatUsageCost(value, moneyBasis.currency)} ${usageCostKindPhrase(moneyBasis.kind)}`
          : t('usage.board.recap.money_unpriced')
        : formatTokenCount(value),
    [summary?.moneyBasis, query.metric],
  );
  const cell = React.useCallback((value: number | null, moneyBasis: UsageWorkMoneyBasis | null) =>
    query.metric !== 'cost' || moneyBasis !== null && summary?.moneyBasis?.kind === moneyBasis.kind
      && summary.moneyBasis.currency === moneyBasis.currency ? value ?? format(null) : format(value, moneyBasis),
    [format, query.metric, summary?.moneyBasis]);
  // A mixed whole has no numeric column formatter; retain each admitted row's own exact amount and basis.
  const datum = React.useCallback((label: string, value: number | null, moneyBasis: UsageWorkMoneyBasis | null = summary?.moneyBasis ?? null): HappierChartDatum | null => {
    if (value === null || query.metric === 'cost' && moneyBasis === null) return null;
    const exact = formatHappierDataValue(value, getPreferredLanguage());
    const visible = format(value, moneyBasis);
    return visible.includes(exact) ? null : { label,
      value: query.metric === 'cost' ? `${moneyBasis!.currency} ${exact}` : `${exact} ${t('usage.board.page.tokensUnit')}`,
      subtitle: visible };
  }, [format, query.metric, summary?.moneyBasis]);
  const basisLabel = React.useCallback((moneyBasis: UsageWorkMoneyBasis | null) => moneyBasis
    ? `${usageCostKindPhrase(moneyBasis.kind)} · ${moneyBasis.currency}` : undefined, []);
  const projectMachineIds = React.useMemo(() => summary?.projects.flatMap(row => row.machineIds) ?? EMPTY_MACHINE_IDS, [summary]);
  const { machineNames, machinePlace, sessionLabel, openSession } = useUsageWorkSessionNavigation(
    summary?.sessions ?? EMPTY_SESSION_IDENTITIES, query, serverId, projectMachineIds,
  );
  // Two rows never read alike: a Project name several share keeps its name whole; where it ran is a separate fact the
  // row carries on its own line, so a narrow screen never truncates the part that tells the rows apart.
  const projectName = projectNames.label;
  const projectPlaces = React.useMemo(() => new Map((summary?.projects ?? []).map(row =>
    [row.projectKey, row.projectKey === null ? '' : machinePlace(row.machineIds)] as const)), [summary, machinePlace]);
  const projectPlace = React.useCallback((projectKey: string | null) => projectPlaces.get(projectKey) ?? '', [projectPlaces]);
  return { summary, format, cell, datum, basisLabel, projectLabel: projectName, projectPlace, sessionLabel, openSession, machineNames };
}

/** Session controls need identity and labels even when an empty body consumes no Work amounts. */
export function useUsageWorkSessionNavigation(
  sessions: readonly UsageWorkSessionIdentity[],
  query: UsageQuery,
  serverId: string,
  machineIds: readonly string[] = EMPTY_MACHINE_IDS,
) {
  const metric = UsageAccountingMetricSchema.parse(query.metric);
  const sessionHomes = React.useMemo(() => [serverId], [serverId]);
  const renderablesByHome = useSessionListRowsByServerId(sessionHomes);
  const renderables = renderablesByHome[serverId];
  // The display owner retains opened names through an unavailable inventory.
  // A cold read can still name the exact Machine from its retained Session host.
  const selectedMachineNames = useMachineDisplayById(React.useCallback(displays => {
    const referenced = new Set([...machineIds, ...sessions.flatMap(row => row.machineIds)]);
    const sessionMachines = new Map(sessions.flatMap(row => {
      const metadata = renderables?.[row.sessionId]?.metadata;
      return metadata?.machineId && metadata.host?.trim() ? [[metadata.machineId, metadata] as const] : [];
    }));
    return Object.fromEntries([...resolveMachineDisplayNames([...Object.values(displays),
      ...[...referenced].filter(id => !displays[id]).map(id => {
        const session = sessionMachines.get(id);
        return session?.host?.trim()
          ? { id, metadata: { displayName: getSessionMachineLabel({ machineId: id, machine: null, session }) } }
          : { id, absence: 'unlisted' as const };
      })])].filter(([id]) => referenced.has(id)));
  }, [sessions, machineIds, renderables]));
  // Fact lines retain the Machine owner's distinction between same-named registrations.
  const machinePlace = React.useCallback((ids: readonly string[]) =>
    usageMachinePlace(ids, selectedMachineNames), [selectedMachineNames]);
  const isSessionVisible = useSessionRecordingVisibility();
  const displaySessionLabels = React.useMemo(() => {
    const base = (sessionId: string) => {
      if (!isSessionVisible({ sessionId, serverId })) return t('session.untitled');
      const renderable = renderables?.[sessionId];
      return renderable ? getSessionName(renderable, serverId) : t('session.untitled');
    };
    const counts = countLabels(sessions.map(row => base(row.sessionId)));
    return new Map(sessions.map(row => {
      const label = base(row.sessionId);
      if (!isSessionVisible({ sessionId: row.sessionId, serverId }) || counts.get(label)! < 2) return [row.sessionId, label] as const;
      const when = row.lastObservedAtMs > 0 ? formatUsageCalendarDate(row.lastObservedAtMs, query.timeZoneOffsetMinutes ?? 0,
        { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      return [row.sessionId, [label, when, machinePlace(row.machineIds)].filter(Boolean).join(' · ')] as const;
    }));
  }, [sessions, renderables, serverId, machinePlace, query.timeZoneOffsetMinutes, isSessionVisible]);
  const sessionLabel = React.useCallback(
    (sessionId: string) => !isSessionVisible({ sessionId, serverId }) ? t('session.untitled')
      : displaySessionLabels.get(sessionId)
        ?? (renderables?.[sessionId] ? getSessionName(renderables[sessionId]!, serverId) : t('session.untitled')),
    [displaySessionLabels, renderables, serverId, isSessionVisible],
  );
  const router = useRouter();
  const navigateSession = React.useCallback(
    (sessionId: string) => {
      router.push(
        buildScopedSessionRouteHref({ sessionId, serverId, suffix: '/usage', query: buildUsageRouteParams({
          scope: { ...readUsageWidgetPageScope(query), session: sessionId }, metric,
          queryOverrides: readUsageWidgetQueryOverrides(query),
          costMode: query.costBasis === 'estimated' ? 'estimated' : query.costBasis === 'reported' ? 'reported' : 'auto',
        }) }) as Parameters<
          typeof router.push
        >[0],
      );
    },
    [router, serverId, query, metric],
  );
  const sessionCommands = useCurrentUiContextLocalCommands(sessions.map(row => ({
      key: row.sessionId,
      title: `${t('common.open')}: ${sessionLabel(row.sessionId)}`,
      invoke: () => navigateSession(row.sessionId),
    })));
  const openSession = React.useCallback((sessionId: string) => {
    void sessionCommands.invoke(sessionId);
  }, [sessionCommands.invoke]);
  return { sessionLabel, openSession, machinePlace, machineNames: selectedMachineNames };
}
