import * as React from 'react';
import {
  buildWidgetSurfaceArtifactIdV1,
  WidgetInstanceActionOutputSchemasV1,
  type WidgetAreaLayoutSummaryV1,
  type WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';
import type { AnchoredListPositionV1 } from '@happier-dev/protocol/actions/anchoredListOrderV1';
import type { ActionExecuteResult} from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { isPluginUiResourceReadAuthorityLost } from '@happier-dev/plugin-ui/advanced';

import { randomUUID } from '@/platform/randomUUID';
import { storage, useActiveServerAccountScope, useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { widgetAreaLayoutSurfaceKey } from '@/sync/domains/widgets/widgetAreaLayoutSurface';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { resumeActionExecutionResult } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

export type ProjectDashboardsState = Readonly<{
  status: 'loading' | 'ready' | 'offline';
  dashboards: readonly WidgetAreaLayoutSummaryV1[];
  readFailure?: Readonly<{ reasonCode: string }>;
}>;

export type ProjectDashboardMutation = Readonly<
  | { ok: true; approvalPending?: false; dashboard?: WidgetAreaLayoutSummaryV1 }
  | { ok: true; approvalPending: true; dashboard?: never }
  | { ok: false; errorCode: string; error?: string; details?: unknown }
>;

const LOADING_INVENTORY: ProjectDashboardsState = { status: 'loading', dashboards: [] };
// The acknowledged inventory belongs to the Account, beyond any one route's
// subscribers. Retirement discards the weakly held observation and private names.
const accountInventories = new WeakMap<ServerAccountScopeLifetime, Map<string, ProjectDashboardsState>>();

/** The acknowledged list owns row identity by Artifact, independently of order. */
function reconcileDashboardInventory(previous: ProjectDashboardsState, incoming: ProjectDashboardsState): ProjectDashboardsState {
  const byId = new Map(previous.dashboards.map(row => [row.artifactId, row]));
  const dashboards = incoming.dashboards.map(row => {
    const retained = byId.get(row.artifactId);
    return retained && sameStrictJsonValue(retained, row) ? retained : row;
  });
  const sameRows = dashboards.length === previous.dashboards.length
    && dashboards.every((row, index) => row === previous.dashboards[index]);
  if (sameRows && previous.status === incoming.status
    && previous.readFailure?.reasonCode === incoming.readFailure?.reasonCode) return previous;
  return { ...incoming, dashboards: sameRows ? previous.dashboards : dashboards };
}

/** A generic failure does not establish that a named-layout write never committed. */
export function isWidgetAreaLayoutOutcomeUnknown(errorCode: string | undefined): boolean {
  return errorCode === undefined || errorCode === 'action_failed' || /timeout|network|unknown|disconnect|transport/i.test(errorCode);
}

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
  callerContext?: ActionExecutorContext,
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
    (actionId: Extract<ActionId, `widgets.area.layout.${string}`>, args: unknown, context: Parameters<typeof frontDoor>[2], confirmed?: true) =>
      input.execute ? input.execute(actionId, args, context) : (confirmed ? frontDoor.confirmed : frontDoor)(actionId, args, context),
    [frontDoor, input.execute],
  );
  const surfaceKey = surface ? JSON.stringify([
    surface.serverId, surface.accountId, buildWidgetSurfaceArtifactIdV1(surface), surface.artifactId ?? null,
  ]) : null;
  const activeLifetime = useActiveServerAccountScopeLifetime();
  const lifetime = activeLifetime && areServerAccountScopesEqual(activeLifetime.scope, scope) ? activeLifetime : null;
  const retained = React.useMemo(() => {
    if (!lifetime) return null;
    let inventories = accountInventories.get(lifetime);
    if (!inventories) { inventories = new Map(); accountInventories.set(lifetime, inventories); }
    return inventories;
  }, [lifetime]);
  const observation = React.useMemo(() => ({ surfaceKey, lifetime }), [surfaceKey, lifetime]);
  const currentObservation = React.useRef(observation);
  currentObservation.current = observation;
  const mounted = React.useRef(true);
  const initial = surfaceKey ? retained?.get(surfaceKey) ?? LOADING_INVENTORY : LOADING_INVENTORY;
  const [inventory, setInventory] = React.useState(() => ({ observation, state: initial }));
  // Withdraw another scope's private names synchronously, before its replacement read settles.
  const state = inventory.observation === observation ? inventory.state : initial;
  const generation = React.useRef(0);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);
  const isCurrent = React.useCallback(() => mounted.current && currentObservation.current === observation
    && (lifetime?.isCurrent() ?? true), [observation, lifetime]);
  const interest = React.useMemo(() => ({ controller: new AbortController() }), [observation]);
  React.useEffect(() => {
    if (interest.controller.signal.aborted) interest.controller = new AbortController();
    const controller = interest.controller;
    return () => controller.abort();
  }, [interest]);
  const approval = useActionApprovalContinuation({ scopeKey: surfaceKey ?? '', serverId: scope?.serverId ?? '', onExecuted: () => {} });
  const publicationSurfaceKey = React.useMemo(() => surface ? widgetAreaLayoutSurfaceKey(surface) : null, [surface]);
  const publications = storage(store => publicationSurfaceKey
    ? store.artifactWidgetAreaLayoutPublications.bySurface.get(publicationSurfaceKey) : undefined);

  const run = React.useCallback(
    async (actionId: Extract<ActionId, `widgets.area.layout.${string}`>, args: unknown, confirmed?: true,
      callerContext?: ActionExecutorContext): Promise<ActionExecuteResult> => {
      if (!scope || !isCurrent())
        return {
          ok: false as const,
          errorCode: 'widget_area_scope_unavailable',
          error: t('errors.operationFailed'),
        };
      const result = await execute(actionId, args, {
        ...(callerContext ?? { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }),
        serverId: scope.serverId,
        expectedAccountId: scope.accountId,
        signal: interest.controller.signal,
      }, confirmed);
      return result;
    },
    [execute, interest, isCurrent, scope],
  );

  const load = React.useCallback(async (callerContext?: ActionExecutorContext) => {
    if (!surface || !isCurrent()) return null;
    const current = ++generation.current;
    let outcome: ActionExecuteResult;
    try {
      outcome = await run('widgets.area.layout.list', { surface }, undefined, callerContext);
    } catch (error) {
      if (!isCurrent() || current !== generation.current || interest.controller.signal.aborted) return null;
      if (error instanceof Error && error.name === 'AbortError') return null;
      outcome = { ok: false, errorCode: error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code : 'widget_area_unavailable', error: t('errors.operationFailed') };
    }
    const parsed = outcome.ok
      ? WidgetInstanceActionOutputSchemasV1[
          'widgets.area.layout.list'
        ].safeParse(outcome.result)
      : null;
    if (!isCurrent() || current !== generation.current) return null;
    if (!outcome.ok && outcome.errorCode === 'cancelled') return null;
    const authorityLost = !outcome.ok && isPluginUiResourceReadAuthorityLost({
      freshness: 'unknown', pending: 'idle', subscription: 'ended',
      error: { code: outcome.errorCode, message: outcome.error ?? outcome.errorCode ?? '' },
    });
    if (authorityLost && surfaceKey) retained?.delete(surfaceKey);
    const ready: ProjectDashboardsState | null = parsed?.success ? { status: 'ready', dashboards: parsed.data.layouts } : null;
    if (ready && surfaceKey) retained?.set(surfaceKey, reconcileDashboardInventory(retained.get(surfaceKey) ?? LOADING_INVENTORY, ready));
    setInventory(previous => {
      const baseline = previous.observation === observation ? previous.state : LOADING_INVENTORY;
      const state = reconcileDashboardInventory(baseline, ready
        ?? { status: 'offline', dashboards: !authorityLost ? baseline.dashboards : [],
          readFailure: { reasonCode: outcome.ok ? 'invalid_action_output' : outcome.errorCode ?? 'widget_area_unavailable' } });
      return previous.observation === observation && previous.state === state ? previous : { observation, state };
    });
    return parsed?.success ? parsed.data.layouts : null;
  }, [interest, isCurrent, observation, run, surface, surfaceKey, retained]);

  React.useEffect(() => {
    setInventory(previous => previous.observation === observation
      ? previous : { observation, state: surfaceKey ? retained?.get(surfaceKey) ?? LOADING_INVENTORY : LOADING_INVENTORY });
    // Same-area publications include newly created layouts, not only already-known inventory IDs.
    // Unrelated Artifact and store updates keep this subscription's projection unchanged.
    void load();
    return () => { generation.current++; };
  }, [load, observation, publications, retained, surfaceKey]);

  React.useEffect(() => {
    if (!scope) return;
    return subscribeHomeAccountChange(event => {
      if (event.source === 'connected' && areServerProfileIdentifiersEquivalent(event.serverId, scope.serverId)) void load();
    }, { serverIds: [scope.serverId], reconnect: 'refresh' });
  }, [load, scope]);

  const reportFailure = React.useCallback((result: ActionExecuteResult, retry?: () => void): ProjectDashboardMutation => {
    if (isCurrent()) publishPresentationNotice({ key: 'widget-area-layout:outcome', severity: 'error',
      message: resolveActionExecutionFailureMessage(result, t('errors.operationFailed')) ?? t('errors.operationFailed'),
      ...(retry && !result.ok && !isWidgetAreaLayoutOutcomeUnknown(result.errorCode)
        ? { undo: { label: t('common.retry'), run: () => { if (isCurrent()) retry(); } } } : {}) });
    return !result.ok ? result : { ok: false, errorCode: 'invalid_action_output' };
  }, [isCurrent]);

  const select = React.useCallback(async (dashboard: Pick<WidgetAreaLayoutSummaryV1, 'surface'>, callerContext?: ActionExecutorContext): Promise<ActionExecuteResult> => {
    let outcome: ActionExecuteResult;
    try { outcome = await run('widgets.area.layout.select', { surface: dashboard.surface }, undefined, callerContext); }
    catch (error) {
      outcome = { ok: false, errorCode: error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code : 'widget_area_unavailable', error: t('errors.operationFailed') };
    }
    if (!outcome.ok) reportFailure(outcome);
    return outcome;
  }, [reportFailure, run]);

  const mutate = React.useCallback(
    async (
      actionId: Extract<ActionId, `widgets.area.layout.${string}`>,
      args: unknown,
      /** The caller's way to repeat exactly what was asked (a rename starts again from the asked-for name). */
      retry?: () => void,
      /** The person already confirmed this exact request on the surface (a named delete). */
      confirmed?: true,
      callerContext?: ActionExecutorContext,
    ): Promise<ProjectDashboardMutation> => {
      const refusal = (result: ActionExecuteResult) => reportFailure(result, retry);
      if (!scope || !isCurrent()) return { ok: false, errorCode: 'widget_area_scope_unavailable' };
      let outcome: ActionExecuteResult;
      try {
        outcome = await resumeActionExecutionResult({ result: await run(actionId, args, confirmed, callerContext), actionId, actionInput: args,
          scope, signal: interest.controller.signal, onApprovalPending: registration => {
            if (!isCurrent()) return;
            approval.requestApproval(registration);
            publishPresentationNotice({ key: 'widget-area-layout:outcome', severity: 'info', message: t('widgetAdd.areaApprovalPending') });
          } });
      } catch (error) {
        return refusal({ ok: false, errorCode: error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code : 'widget_area_unavailable', error: t('errors.operationFailed') });
      }
      if (!isCurrent()) return { ok: false, errorCode: 'widget_area_scope_unavailable' };
      if (!outcome.ok) { await load(callerContext); return refusal(outcome); }
      const parsed = getActionSpec(actionId).outputSchema?.safeParse(outcome.result);
      if (!parsed?.success) return refusal({ ok: false, errorCode: 'invalid_action_output', error: t('errors.operationFailed') });
      await load(callerContext);
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
    [approval.requestApproval, interest, isCurrent, load, reportFailure, run, scope],
  );

  return React.useMemo(
    () => ({
      state,
      readFailure: state.readFailure ? { ...state.readFailure, retry: load } : undefined,
      approvalId: approval.approvalId,
      approvalPending: approval.approvalPending,
      reload: load,
      select,
      prepareToShare: (dashboard: WidgetAreaLayoutSummaryV1): Promise<ProjectDashboardMutation> =>
        dashboard.isPreset && dashboard.revision === null
          // The existing rename owner intentionally materializes a missing host preset through
          // its one Artifact/CAS path. Retain its exact identity, name and default contents.
          ? mutate('widgets.area.layout.rename', { surface: dashboard.surface, expectedRevision: null, name: dashboard.name })
          : Promise.resolve({ ok: true, dashboard }),
      create: (name: string, fromSurface?: WidgetSurfaceRefV1, retry?: () => void, callerContext?: ActionExecutorContext) =>
        surface
          ? mutate('widgets.area.layout.create', {
              surface,
              layoutId: randomUUID(),
              name,
              ...(fromSurface ? { fromSurface } : {}),
            }, retry, undefined, callerContext)
          : Promise.resolve({
              ok: false as const,
              errorCode: 'widget_area_scope_unavailable',
            }),
      rename: (dashboard: Pick<WidgetAreaLayoutSummaryV1, 'surface' | 'revision'>, name: string, retry?: () => void, callerContext?: ActionExecutorContext) =>
        mutate('widgets.area.layout.rename', {
          surface: dashboard.surface,
          expectedRevision: dashboard.revision,
          name,
        }, retry, undefined, callerContext),
      /** `confirmed`: the person confirmed it with `confirmDashboardDelete`; otherwise the Action's own policy asks. */
      remove: (dashboard: WidgetAreaLayoutSummaryV1, retry?: () => void, confirmed?: true) =>
        mutate('widgets.area.layout.delete', {
          surface: dashboard.surface,
          expectedRevision: dashboard.revision,
        }, retry, confirmed),
      reorder: (
        dashboard: WidgetAreaLayoutSummaryV1,
        position: AnchoredListPositionV1,
        retry?: () => void,
      ) =>
        mutate('widgets.area.layout.reorder', {
          surface: dashboard.surface,
          expectedRevision: dashboard.revision,
          position,
        }, retry),
    }),
    [approval.approvalId, approval.approvalPending, load, mutate, run, select, state, surface],
  );
}
