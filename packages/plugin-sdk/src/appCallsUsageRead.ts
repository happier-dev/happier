import { DeploymentEnvironmentListResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { UsageAnalyticsQueryRequest, UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { UsageModelPriceReadResultSchema } from '@happier-dev/protocol/usage/usageModelPriceDelivery';
import type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { TELEMETRY_COSTS_READ_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { DatabaseCaptureCostsReadResultV1Schema, type DatabaseCaptureCostsReadInputV1, type DatabaseCaptureCostsReadResultV1 } from './database/databaseCaptureCosts.js';
import { projectAppCallsUsageSourcesV1, usageAppCallsSourceId } from './appCallsUsage.js';

export type UsageAppCallsExecute = (
  actionId: 'deployments.environments.list' | 'action.invoke',
  input: unknown,
  operation?: Readonly<{ signal?: AbortSignal; externalActionTarget?: { kind: 'machine'; machineId: string } }>,
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

const costsAction = parseQualifiedPluginActionId(TELEMETRY_COSTS_READ_ACTION_ID_V1)!;
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

/** Open the invoking Account's pricing basis for all the demanded windows in one catalog read. */
export async function readAppCallsPricingV1(input: Readonly<{
  modelIds: readonly string[];
  readOverrides: () => UsageModelPriceOverridesV1 | Promise<UsageModelPriceOverridesV1>;
  readCatalog: (modelIds: string[]) => Promise<unknown>;
}>): Promise<Readonly<{ catalog: UsageModelPriceCatalog; viewerOverrides: UsageModelPriceOverridesV1 }>> {
  const viewerOverrides = await input.readOverrides();
  const modelIds = [...new Set([...input.modelIds, ...Object.values(viewerOverrides).flatMap(value =>
    value.kind === 'map' ? [value.modelId] : [])])];
  const delivered = UsageModelPriceReadResultSchema.parse(await input.readCatalog(modelIds));
  const catalog = 'models' in delivered ? delivered : { v: delivered.v, models: {}, provenance: delivered.provenance };
  return { catalog, viewerOverrides };
}

export function appCallsPricingModelIds(parts: readonly { items: readonly { modelId: string | null; requestedModel: string | null }[] }[]): string[] {
  return [...new Set(parts.flatMap(read => read.items.flatMap(item =>
    [item.modelId, item.requestedModel].filter((id): id is string => id !== null))))];
}

/** Read the selected collector's raw, admitted operands without opening any pricing settings. */
export async function readAppCallsOperandsV1(
  execute: UsageAppCallsExecute,
  machineId: string,
  input: DatabaseCaptureCostsReadInputV1,
  signal?: AbortSignal,
): Promise<Extract<DatabaseCaptureCostsReadResultV1, { ok: true }>> {
  const read = DatabaseCaptureCostsReadResultV1Schema.parse(await execute(
    'action.invoke',
    { action: costsAction, input },
    { externalActionTarget: { kind: 'machine', machineId }, ...(signal ? { signal } : {}) },
  ));
  if (!read.ok) throw failure(read.code);
  return read;
}

export async function readUsageAppCallsAccounting(
  input: Readonly<{
    execute: UsageAppCallsExecute;
    serverId: string;
    request: UsageAnalyticsQueryRequest;
    environmentIds: readonly string[];
    readCatalog: (modelIds: string[], signal?: AbortSignal) => Promise<unknown>;
    readOverrides: () => UsageModelPriceOverridesV1 | Promise<UsageModelPriceOverridesV1>;
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
  const parts = await Promise.all(input.environmentIds.map(async environmentId => {
    const environment = listed.get(environmentId);
    if (!environment) throw failure('telemetry_collector_unavailable');
    const read = await readAppCallsOperandsV1(input.execute, environment.collectorMachineId, {
      source: { kind: 'environment', serverId: environment.serverId, environmentId }, since, until, granularity,
    }, input.signal);
    return { source: usageAppCallsSourceId(environmentId), label: environment.name, read };
  }));
  const pricing = await readAppCallsPricingV1({
    modelIds: appCallsPricingModelIds(parts.map(part => part.read)),
    readOverrides: input.readOverrides,
    readCatalog: modelIds => input.readCatalog(modelIds, input.signal),
  });
  return projectAppCallsUsageSourcesV1(parts, pricing.catalog, pricing.viewerOverrides,
    { granularity, costMode: input.request.costMode }).accounting;
}
