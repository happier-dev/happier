import type { ActionExecuteFailure } from '../actions/actionExecutionResult.js';
import type {
  ActionExecutorContext,
  ActionExecutorDeps,
} from '../actions/executor/types.js';
import { DeploymentEnvironmentListResultV1Schema } from '../deployments/deploymentActionsV1.js';
import type { InputOption } from './inputFields.js';
import { readNonEmptyString } from './inputRecords.js';

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
