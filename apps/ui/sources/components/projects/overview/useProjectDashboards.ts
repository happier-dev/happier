import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  buildWidgetSurfaceArtifactIdV1,
  WidgetInstanceActionOutputSchemasV1,
  type WidgetAreaLayoutSummaryV1,
  type WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';
import type { AnchoredListPositionV1 } from '@happier-dev/protocol/actions/anchoredListOrderV1';
import type { ActionExecuteResult, ActionId } from '@happier-dev/protocol';

import { randomUUID } from '@/platform/randomUUID';
import { storage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

export type ProjectDashboardsState = Readonly<{
  status: 'loading' | 'ready' | 'offline';
  dashboards: readonly WidgetAreaLayoutSummaryV1[];
}>;

export type ProjectDashboardMutation = Readonly<
  | { ok: true; dashboard?: WidgetAreaLayoutSummaryV1 }
  | { ok: false; errorCode: string }
>;

const LOADING_INVENTORY: ProjectDashboardsState = { status: 'loading', dashboards: [] };

/**
 * One Project's named dashboards (12s2) through the canonical `widgets.area.layout.*` Actions: the
 * paged personal inventory plus create/rename/reorder/delete on exact documents. It holds no
 * inventory of its own beyond the last acknowledged list, and selection stays with the route.
 */
export function useProjectDashboards(
  input: Readonly<{ serverId: string; projectKey: string | null }>,
) {
  const scope = useActiveServerAccountScope(input.serverId);
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
  return useWidgetAreaLayouts({ surface });
}

/** Executes one admitted layout Action; a core page lends its preset-aware area port. */
export type WidgetAreaLayoutsExecute = (
  actionId: Extract<ActionId, `widgets.area.layout.${string}`>,
  args: unknown,
) => Promise<ActionExecuteResult>;

/**
 * Any area owner's named layouts (Project dashboards, a core page's presets and user views) through
 * the one `widgets.area.layout.*` family. A core page passes its binding's executor so host presets
 * are listed beside the viewer's own views.
 */
export function useWidgetAreaLayouts(
  input: Readonly<{ surface: WidgetSurfaceRefV1 | null; execute?: WidgetAreaLayoutsExecute }>,
) {
  const surface = input.surface;
  const scope = React.useMemo(() => surface ? { serverId: surface.serverId, accountId: surface.accountId } : null,
    [surface?.serverId, surface?.accountId]);
  const [frontDoor] = React.useState(() => createFrontDoorActionExecute());
  const execute = React.useCallback(
    (actionId: Extract<ActionId, `widgets.area.layout.${string}`>, args: unknown, context: Parameters<typeof frontDoor>[2]) =>
      input.execute ? input.execute(actionId, args) : frontDoor(actionId, args, context),
    [frontDoor, input.execute],
  );
  const surfaceKey = surface ? JSON.stringify([
    surface.serverId, surface.accountId, buildWidgetSurfaceArtifactIdV1(surface), surface.artifactId ?? null,
  ]) : null;
  const observation = React.useMemo(() => ({ surfaceKey }), [surfaceKey]);
  const currentObservation = React.useRef(observation);
  currentObservation.current = observation;
  const mounted = React.useRef(true);
  const [inventory, setInventory] = React.useState(() => ({ observation, state: LOADING_INVENTORY }));
  // Withdraw another scope's private names synchronously, before its replacement read settles.
  const state = inventory.observation === observation ? inventory.state : LOADING_INVENTORY;
  const generation = React.useRef(0);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);
  const isCurrent = React.useCallback(() => mounted.current && currentObservation.current === observation, [observation]);
  const publicationIds = React.useMemo(() => [...new Set([
    ...(surface ? [surface.artifactId ?? buildWidgetSurfaceArtifactIdV1(surface)] : []),
    ...state.dashboards.map(dashboard => dashboard.artifactId),
  ])], [surface, state.dashboards]);
  const publications = storage(useShallow(store => publicationIds.map(id => store.artifacts[id])));

  const run = React.useCallback(
    async (actionId: Extract<ActionId, `widgets.area.layout.${string}`>, args: unknown) => {
      if (!scope || !isCurrent())
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
    [execute, isCurrent, scope],
  );

  const load = React.useCallback(async () => {
    if (!surface || !isCurrent()) return null;
    const current = ++generation.current;
    const outcome = await run('widgets.area.layout.list', { surface });
    const parsed = outcome.ok
      ? WidgetInstanceActionOutputSchemasV1[
          'widgets.area.layout.list'
        ].safeParse(outcome.result)
      : null;
    if (!isCurrent() || current !== generation.current) return null;
    setInventory((previous) => ({ observation, state: parsed?.success
      ? { status: 'ready', dashboards: parsed.data.layouts }
      : { status: 'offline', dashboards: previous.observation === observation ? previous.state.dashboards : [] },
    }));
    return parsed?.success ? parsed.data.layouts : null;
  }, [isCurrent, observation, run, surface]);

  React.useEffect(() => {
    setInventory(previous => previous.observation === observation
      ? previous : { observation, state: LOADING_INVENTORY });
    // The same exact Artifact publications that renew the area's preset read renew its inventory.
    // Unrelated Artifact and store updates keep this subscription's projection unchanged.
    void load();
    return () => { generation.current++; };
  }, [load, observation, publications]);

  const mutate = React.useCallback(
    async (
      actionId: Extract<ActionId, `widgets.area.layout.${string}`>,
      args: unknown,
    ): Promise<ProjectDashboardMutation> => {
      const outcome = await run(actionId, args);
      await load();
      if (!outcome.ok) return outcome;
      const summary =
        actionId === 'widgets.area.layout.delete'
          ? null
          : WidgetInstanceActionOutputSchemasV1[
              'widgets.area.layout.create'
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
      select: (dashboard: WidgetAreaLayoutSummaryV1) => run('widgets.area.layout.select', { surface: dashboard.surface }),
      create: (name: string, fromSurface?: WidgetSurfaceRefV1) =>
        surface
          ? mutate('widgets.area.layout.create', {
              surface,
              layoutId: randomUUID(),
              name,
              ...(fromSurface ? { fromSurface } : {}),
            })
          : Promise.resolve({
              ok: false as const,
              errorCode: 'widget_area_scope_unavailable',
            }),
      rename: (dashboard: WidgetAreaLayoutSummaryV1, name: string) =>
        mutate('widgets.area.layout.rename', {
          surface: dashboard.surface,
          expectedRevision: dashboard.revision,
          name,
        }),
      remove: (dashboard: WidgetAreaLayoutSummaryV1) =>
        mutate('widgets.area.layout.delete', {
          surface: dashboard.surface,
          expectedRevision: dashboard.revision,
        }),
      reorder: (
        dashboard: WidgetAreaLayoutSummaryV1,
        position: AnchoredListPositionV1,
      ) =>
        mutate('widgets.area.layout.reorder', {
          surface: dashboard.surface,
          expectedRevision: dashboard.revision,
          position,
        }),
    }),
    [load, mutate, run, state, surface],
  );
}
