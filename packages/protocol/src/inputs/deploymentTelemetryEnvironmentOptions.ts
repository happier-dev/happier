import type { ActionExecuteFailure } from '../actions/actionExecutionResult.js';
import type {
  ActionExecutorContext,
  ActionExecutorDeps,
} from '../actions/executor/types.js';
import { DeploymentEnvironmentListResultV1Schema } from '../deployments/deploymentActionsV1.js';
import type { InputOption } from './inputFields.js';
import { readNonEmptyString, readRecord, readRecordListProperty } from './inputRecords.js';
import { DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1, databaseActionLocalIdV1 } from '../actions/actionIdsDatabaseV1.js';

/** The host option source a widget or Action field names to pick one Environment whose telemetry is on. */
export const DEPLOYMENT_TELEMETRY_ENVIRONMENTS_OPTIONS_SOURCE_ID_V1 =
  'deployments.environments.telemetry' as const;

/**
 * `deployments.environments.telemetry`: the selected Home's Environments that send telemetry to a collector,
 * named the way the deployments pages name them ("billing-api · Production"). The value is the Environment's
 * address only; the collector read that consumes it admits the viewer again (R16), so this list never grants a read.
 */
export async function resolveDeploymentTelemetryEnvironmentOptionsV1(
  params: Readonly<{
    deps: ActionExecutorDeps;
    ctx: ActionExecutorContext;
    readFailure: (result: unknown) => ActionExecuteFailure | null;
  }>,
): Promise<
  ActionExecuteFailure | Readonly<{ ok: true; result: readonly InputOption[] }>
> {
  const serverId = readNonEmptyString(params.ctx.serverId);
  if (!serverId)
    return {
      ok: false,
      errorCode: 'server_not_selected',
      error: 'server_not_selected',
    };
  const { createActionExecutor } = await import('../actions/actionExecutor.js');
  const executor = createActionExecutor(params.deps);
  const options: InputOption[] = [];
  let cursor: string | null = null;
  // Every page of the Home's Environments: the list is paged by its owner, never cut here.
  do {
    const executed = await executor.execute('deployments.environments.list',
      { serverId, ...(cursor === null ? {} : { cursor }) }, params.ctx);
    if (!executed.ok) return executed;
    const failure = params.readFailure(executed.result);
    if (failure) return failure;
    params.ctx.signal?.throwIfAborted();
    const parsed = DeploymentEnvironmentListResultV1Schema.safeParse(executed.result);
    if (!parsed.success || !('items' in parsed.data)) {
      return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    }
    const sourceNames = new Map((parsed.data.projectSources ?? []).map(source => [source.id, source.name] as const));
    for (const environment of parsed.data.items) {
      // Telemetry is on exactly when a collector Machine is chosen for the Environment.
      if (!environment.telemetryMachineId || environment.deletedAtMs !== undefined) continue;
      const label = [sourceNames.get(environment.projectSourceId), environment.name]
        .filter((part): part is string => typeof part === 'string' && part.length > 0).join(' · ');
      options.push({ value: { serverId: environment.serverId, environmentId: environment.id }, label: label || environment.id });
    }
    cursor = parsed.data.nextCursor;
  } while (cursor !== null);
  return { ok: true, result: options };
}

/** The host option source a Telemetry widget's Route field names: the routes the chosen Environment served. */
export const DEPLOYMENT_TELEMETRY_ROUTES_OPTIONS_SOURCE_ID_V1 =
  'deployments.environments.telemetry.routes' as const;

const TELEMETRY_PLUGIN_ID = 'happier.telemetry';
/** The routes a person picks from: what the collector saw over the last day, the same window a new widget reads. */
const ROUTE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** One collector page per read; the list continues by cursor until the collector has no more. */
const ROUTE_PAGE_LIMIT = 100;

/**
 * `deployments.environments.telemetry.routes`: the routes the draft's Environment served, read from its collector
 * through the telemetry endpoints Action (which admits the viewer, R16), valued `{ method, route }` and named
 * "POST /checkout". A route served by two services is offered once: a route measure selects by method and route.
 */
export async function resolveDeploymentTelemetryRouteOptionsV1(
  params: Readonly<{
    deps: ActionExecutorDeps;
    ctx: ActionExecutorContext;
    input: Readonly<Record<string, unknown>>;
    readFailure: (result: unknown) => ActionExecuteFailure | null;
  }>,
): Promise<
  ActionExecuteFailure | Readonly<{ ok: true; result: readonly InputOption[] }>
> {
  const environment = readRecord(params.input.environment);
  const serverId = readNonEmptyString(environment.serverId);
  const environmentId = readNonEmptyString(environment.environmentId);
  if (!serverId || !environmentId) {
    return { ok: false, errorCode: 'missing_option_dependency', error: 'missing_option_dependency',
      details: { requiredDraftPath: 'environment' } };
  }
  const { createActionExecutor } = await import('../actions/actionExecutor.js');
  const executor = createActionExecutor(params.deps);
  const listed = await executor.execute('deployments.environments.list', { serverId, environmentIds: [environmentId] }, params.ctx);
  if (!listed.ok) return listed;
  const listFailure = params.readFailure(listed.result);
  if (listFailure) return listFailure;
  // The collector Machine answers the read, as every Environment telemetry read is targeted.
  const collectorMachineId = readNonEmptyString(readRecordListProperty(listed.result, 'items')
    .find(item => item.id === environmentId)?.telemetryMachineId);
  if (!collectorMachineId) return { ok: false, errorCode: 'telemetry_not_set_up', error: 'telemetry_not_set_up' };
  const until = Date.now();
  const window = { since: Math.max(0, until - ROUTE_WINDOW_MS), until };
  const options = new Map<string, InputOption>();
  let before: Readonly<Record<string, unknown>> | null = null;
  do {
    const executed = await executor.execute('action.invoke', {
      action: { pluginId: TELEMETRY_PLUGIN_ID, localId: databaseActionLocalIdV1(DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1) },
      input: { source: { kind: 'environment', serverId, environmentId }, ...window,
        page: { limit: ROUTE_PAGE_LIMIT, ...(before === null ? {} : { before }) } },
    }, { ...params.ctx, externalActionTarget: { kind: 'machine', machineId: collectorMachineId } });
    if (!executed.ok) return executed;
    const failure = params.readFailure(executed.result);
    if (failure) return failure;
    params.ctx.signal?.throwIfAborted();
    const page = readRecord(executed.result);
    // The collector answers its own typed failures in-band.
    if (page.ok === false) {
      const code = readNonEmptyString(page.code) ?? 'telemetry_unavailable';
      return { ok: false, errorCode: code, error: code };
    }
    for (const item of readRecordListProperty(page, 'items')) {
      const method = readNonEmptyString(item.method);
      const route = readNonEmptyString(item.route);
      if (!method || !route) continue;
      const label = `${method} ${route}`;
      if (!options.has(label)) options.set(label, { value: { method, route }, label });
    }
    const next = readRecord(page.nextCursor);
    before = Object.keys(next).length > 0 ? next : null;
  } while (before !== null);
  return { ok: true, result: [...options.values()] };
}
