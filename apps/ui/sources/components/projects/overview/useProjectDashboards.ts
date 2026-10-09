import * as React from 'react';
import {
  WidgetInstanceActionOutputSchemasV1,
  type WidgetDashboardSummaryV1,
  type WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';
import type { AnchoredListPositionV1 } from '@happier-dev/protocol/actions/anchoredListOrderV1';

import { randomUUID } from '@/platform/randomUUID';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

export type ProjectDashboardsState = Readonly<{
  status: 'loading' | 'ready' | 'offline';
  dashboards: readonly WidgetDashboardSummaryV1[];
}>;

export type ProjectDashboardMutation = Readonly<
  | { ok: true; dashboard?: WidgetDashboardSummaryV1 }
  | { ok: false; errorCode: string }
>;

/**
 * One Project's named dashboards (12s2) through the canonical `widgets.area.dashboard.*` Actions: the
 * paged personal inventory plus create/rename/reorder/delete on exact documents. It holds no
 * inventory of its own beyond the last acknowledged list, and selection stays with the route.
 */
export function useProjectDashboards(
  input: Readonly<{ serverId: string; projectKey: string | null }>,
) {
  const scope = useActiveServerAccountScope(input.serverId);
  const [execute] = React.useState(() => createFrontDoorActionExecute());
  const surface = React.useMemo(
    (): WidgetSurfaceRefV1 | null =>
      scope && input.projectKey
        ? {
            serverId: scope.serverId,
            accountId: scope.accountId,
            owner: { kind: 'project', projectId: input.projectKey },
          }
        : null,
    [input.projectKey, scope],
  );
  const [state, setState] = React.useState<ProjectDashboardsState>({
    status: 'loading',
    dashboards: [],
  });
  const generation = React.useRef(0);

  const run = React.useCallback(
    async (actionId: Parameters<typeof execute>[0], args: unknown) => {
      if (!scope)
        return {
          ok: false as const,
          errorCode: 'widget_area_scope_unavailable',
        };
      const result = await execute(actionId, args, {
        surface: 'ui',
        serverId: scope.serverId,
        expectedAccountId: scope.accountId,
      });
      return result.ok
        ? { ok: true as const, result: result.result }
        : {
            ok: false as const,
            errorCode: result.errorCode ?? 'widget_area_unavailable',
          };
    },
    [execute, scope],
  );

  const load = React.useCallback(async () => {
    if (!surface) return;
    const current = ++generation.current;
    const outcome = await run('widgets.area.dashboard.list', { surface });
    if (current !== generation.current) return;
    const parsed = outcome.ok
      ? WidgetInstanceActionOutputSchemasV1[
          'widgets.area.dashboard.list'
        ].safeParse(outcome.result)
      : null;
    setState((previous) =>
      parsed?.success
        ? { status: 'ready', dashboards: parsed.data.dashboards }
        : { status: 'offline', dashboards: previous.dashboards },
    );
  }, [run, surface]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const mutate = React.useCallback(
    async (
      actionId: Parameters<typeof execute>[0],
      args: unknown,
    ): Promise<ProjectDashboardMutation> => {
      const outcome = await run(actionId, args);
      await load();
      if (!outcome.ok) return outcome;
      const summary =
        actionId === 'widgets.area.dashboard.delete'
          ? null
          : WidgetInstanceActionOutputSchemasV1[
              'widgets.area.dashboard.create'
            ].safeParse(outcome.result);
      return summary?.success
        ? { ok: true, dashboard: summary.data }
        : { ok: true };
    },
    [load, run],
  );

  return React.useMemo(
    () => ({
      state,
      reload: load,
      create: (name: string) =>
        surface
          ? mutate('widgets.area.dashboard.create', {
              surface,
              dashboardId: randomUUID(),
              name,
            })
          : Promise.resolve({
              ok: false as const,
              errorCode: 'widget_area_scope_unavailable',
            }),
      rename: (dashboard: WidgetDashboardSummaryV1, name: string) =>
        mutate('widgets.area.dashboard.rename', {
          surface: dashboard.surface,
          expectedRevision: dashboard.revision,
          name,
        }),
      remove: (dashboard: WidgetDashboardSummaryV1) =>
        mutate('widgets.area.dashboard.delete', {
          surface: dashboard.surface,
          expectedRevision: dashboard.revision,
        }),
      reorder: (
        dashboard: WidgetDashboardSummaryV1,
        position: AnchoredListPositionV1,
      ) =>
        mutate('widgets.area.dashboard.reorder', {
          surface: dashboard.surface,
          expectedRevision: dashboard.revision,
          position,
        }),
    }),
    [load, mutate, state, surface],
  );
}
