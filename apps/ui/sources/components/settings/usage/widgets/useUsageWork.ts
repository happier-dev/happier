import * as React from 'react';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useSessionListRenderablesById } from '@/sync/store/hooks';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { t } from '@/text';
import {
  summarizeUsageWork,
  type UsageWorkSummary,
} from './usageWorkPresentation';
import { useUsageAnalyticsView } from './usageBodyKit';
import { readUsageWidgetPageScope, readUsageWidgetQueryOverrides } from '../usageWidgetPageContext';
import { buildUsageRouteParams } from '../usageRouteParams';

const summaries = new WeakMap<object, Map<string, UsageWorkSummary>>();

/** The Work bodies' shared reading of one slice: U7's allocation grouped once, labels and drill. */
export function useUsageWork(
  slice: UsageQueryResultSlice,
  query: UsageQuery,
  serverId: string,
) {
  const work = slice.work;
  const view = useUsageAnalyticsView(slice, query);
  const summary = React.useMemo(() => {
    if (!work) return null;
    const key = `${query.metric}\u0000${query.costBasis}`;
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
    });
    byKey.set(key, built);
    return built;
  }, [work, query.metric, query.costBasis]);
  const currency =
    slice.accounting?.costPresentation?.currency ??
    slice.accounting?.totals.cost.currency ??
    'USD';
  const format = React.useCallback(
    (value: number | null) =>
      value === null ? t('usage.board.recap.money_unpriced') : query.metric === 'cost'
        ? formatUsageCost(value, currency)
        : formatTokenCount(value),
    [currency, query.metric],
  );
  const projectLabels = React.useMemo(
    () =>
      new Map(
        (view?.breakdowns.projects ?? []).map((row) => [row.key, row.label]),
      ),
    [view?.breakdowns.projects],
  );
  const projectLabel = React.useCallback(
    (projectKey: string | null) =>
      projectKey === null
        ? t('usage.board.work.unknownProject')
        : (projectLabels.get(projectKey) ?? projectKey),
    [projectLabels],
  );
  const renderables = useSessionListRenderablesById();
  const sessionLabel = React.useCallback(
    (sessionId: string) => {
      const renderable = renderables[sessionId];
      return renderable
        ? getSessionName(renderable)
        : t('usage.board.work.sessionFallback', { id: sessionId.slice(0, 8) });
    },
    [renderables],
  );
  const router = useRouter();
  const openSession = React.useCallback(
    (sessionId: string) => {
      router.push(
        buildScopedSessionRouteHref({ sessionId, serverId, suffix: '/usage', query: buildUsageRouteParams({
          scope: { ...readUsageWidgetPageScope(query), session: sessionId }, metric: query.metric,
          queryOverrides: readUsageWidgetQueryOverrides(query),
          costMode: query.costBasis === 'estimated' ? 'estimated' : query.costBasis === 'reported' ? 'reported' : 'auto', layoutId: 'work',
        }) }) as Parameters<
          typeof router.push
        >[0],
      );
    },
    [router, serverId, query],
  );
  return { summary, format, projectLabel, sessionLabel, openSession };
}
