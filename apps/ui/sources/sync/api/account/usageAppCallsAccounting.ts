import { DeploymentEnvironmentListResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type {
  UsageAnalyticsQueryRequest,
  UsageAnalyticsQueryResponse,
} from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { DatabaseCaptureCostsReadResultV1Schema } from '@happier-dev/database-protocol';
import { TELEMETRY_COSTS_READ_ACTION_ID_V1, databaseActionLocalIdV1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { projectDatabaseCaptureUsageSourcesV1 } from '@happier-dev/databases/app-usage';
import type { UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { usageAppCallsSourceId } from '@/sync/domains/usage/usageAppCallsSource';

/** The front door the Usage reads already use (`createFrontDoorUiActionExecutor`): throws typed failures. */
export type UsageAppCallsExecute = (
  actionId: 'deployments.environments.list' | 'action.invoke',
  input: unknown,
  operation?: UiActionOperation,
) => Promise<unknown>;

/** An Environment whose deployed app can report model calls: it has a collector Machine. */
export type UsageAppEnvironment = Readonly<{
  environmentId: string;
  /** The Home identity the Environment names; the collector admits reads against it. */
  serverId: string;
  name: string;
  projectSourceId: string;
  /** The app's name (its Project source); `null` while its presentation is not disclosed. */
  projectName: string | null;
  collectorMachineId: string;
}>;

const TELEMETRY_PLUGIN_ID = 'happier.telemetry';
const failure = (code: string) => Object.assign(new Error(code), { code });

/** The viewer's Environments with a collector, in the deployments owner's order. One paged header read. */
export async function listUsageAppEnvironments(
  execute: UsageAppCallsExecute,
  serverId: string,
  signal?: AbortSignal,
): Promise<readonly UsageAppEnvironment[]> {
  const environments: UsageAppEnvironment[] = [];
  let cursor: string | null = null;
  do {
    const read = DeploymentEnvironmentListResultV1Schema.parse(
      await execute(
        'deployments.environments.list',
        { serverId, ...(cursor ? { cursor } : {}) },
        signal ? { signal } : undefined,
      ),
    );
    if (!read.ok)
      throw failure('errorCode' in read && typeof read.errorCode === 'string' ? read.errorCode : 'deployment_unavailable');
    const projects = new Map(
      (read.projectSources ?? []).map((source) => [source.id, source.name]),
    );
    for (const item of read.items) {
      if (!item.telemetryMachineId || item.deletedAtMs !== undefined) continue;
      environments.push({
        environmentId: item.id,
        serverId: item.serverId,
        name: item.name ?? item.id,
        projectSourceId: item.projectSourceId,
        projectName: projects.get(item.projectSourceId) ?? null,
        collectorMachineId: item.telemetryMachineId,
      });
    }
    cursor = read.nextCursor;
  } while (cursor);
  return environments;
}

/**
 * The selected Environments' App calls as one Usage accounting answer. Each collector reads its own
 * operands (R16 admits the viewer per request); the shared catalog prices them here and the Usage page's
 * existing price owner applies the viewer's own overrides and cost basis, as it does for Agents.
 */
export async function readUsageAppCallsAccounting(
  input: Readonly<{
    execute: UsageAppCallsExecute;
    serverId: string;
    request: UsageAnalyticsQueryRequest;
    environmentIds: readonly string[];
    readCatalog: (signal?: AbortSignal) => Promise<UsageModelPriceCatalog>;
    signal?: AbortSignal;
  }>,
): Promise<UsageAnalyticsQueryResponse> {
  const until = input.request.dateRange?.endMs ?? Date.now();
  const since = Math.min(input.request.dateRange?.startMs ?? 0, until - 1);
  // The collector buckets by hour or day; coarser Usage periods draw its days.
  const granularity =
    input.request.granularity === 'hour' ? ('hour' as const) : ('day' as const);
  const listed = new Map(
    (
      await listUsageAppEnvironments(
        input.execute,
        input.serverId,
        input.signal,
      )
    ).map((environment) => [environment.environmentId, environment]),
  );
  const [catalog, parts] = await Promise.all([
    input.readCatalog(input.signal),
    Promise.all(
      input.environmentIds.map(async (environmentId) => {
        const environment = listed.get(environmentId);
        if (!environment)
          throw failure('telemetry_collector_unavailable');
        const read = DatabaseCaptureCostsReadResultV1Schema.parse(
          await input.execute(
            'action.invoke',
            {
              action: {
                pluginId: TELEMETRY_PLUGIN_ID,
                localId: databaseActionLocalIdV1(
                  TELEMETRY_COSTS_READ_ACTION_ID_V1,
                ),
              },
              input: {
                source: {
                  kind: 'environment',
                  serverId: environment.serverId,
                  environmentId,
                },
                since,
                until,
                granularity,
              },
            },
            {
              externalActionTarget: {
                kind: 'machine',
                machineId: environment.collectorMachineId,
              },
              ...(input.signal ? { signal: input.signal } : {}),
            },
          ),
        );
        if (!read.ok)
          throw failure(read.code);
        return {
          source: usageAppCallsSourceId(environmentId),
          label: environment.name,
          read,
        };
      }),
    ),
  ]);
  // Priced at the shared catalog only; overrides are the viewer's and apply where Usage prices every source.
  return {
    ...projectDatabaseCaptureUsageSourcesV1(parts, catalog, {}, { granularity })
      .accounting,
    priceCatalog: catalog,
  };
}
