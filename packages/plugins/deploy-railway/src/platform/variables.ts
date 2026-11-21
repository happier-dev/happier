import {
  createDeploymentTargetVariableSyncV1, projectDeploymentTargetVariablesV1,
  type DeploymentTargetObservedVariableV1,
} from '@happier-dev/deployment-protocol/v1';
import {
  DeploymentTargetRoleInputProtocolSchemasV1 as inputs,
  DeploymentTargetVariablesReadResultV1ProtocolSchema as readOutput,
  DeploymentTargetVariablesSyncResultV1ProtocolSchema as syncOutput,
  type DeploymentTargetVariablesReadInputV1,
  type DeploymentTargetVariablesReadResultV1,
  type JsonValue,
} from '@happier-dev/plugin-sdk';
import type {
  DeploymentTargetVariablesSyncInputV1,
  DeploymentTargetVariablesSyncResultV1,
} from '@happier-dev/plugin-sdk/deployment-targets';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import {
  defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import { createRailwayProjectOperations, RailwayNativeError } from '@happier-dev/railway-api';
import { projectRailwayFailure, railwayAccountAction, railwayGraphql, railwayRequest } from './account.js';
import { railwayRoleInput, readRailwayCoordinates } from './coordinates.js';

type Read = DeploymentTargetVariablesReadInputV1;
type Sync = DeploymentTargetVariablesSyncInputV1;
type SyncResult = DeploymentTargetVariablesSyncResultV1;
type FailureCode = SyncResult['failures'][number]['code'];
type Coordinates = ReturnType<typeof readRailwayCoordinates>;
type Graphql = ReturnType<typeof railwayGraphql>;

const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1 });
const nullableText = defineProtocolUnion([text, defineProtocolLiteral(null)]);
const boolean = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const variable = defineProtocolObject({
  id: text, name: text, serviceId: nullableText, isSealed: boolean, updatedAt: text,
}, open);
const environment = defineProtocolObject({
  id: text, projectId: text,
  variables: defineProtocolObject({
    edges: defineProtocolArray(defineProtocolObject({ node: variable }, open)),
    pageInfo: defineProtocolObject({ hasNextPage: boolean, endCursor: nullableText }, open),
  }, open),
}, open);

type Snapshot = Map<string, DeploymentTargetObservedVariableV1>;

/** The Railway Variable connection includes sealed keys and revision metadata without selecting values. */
async function readSnapshot(graphql: Graphql, { projectId, environmentId, serviceId }: Coordinates): Promise<Snapshot> {
  const rows: Snapshot = new Map();
  let after: string | null = null;
  for (;;) {
    const data = await graphql(
      `query($projectId: String!, $environmentId: String!, $after: String) {
        environment(id: $environmentId, projectId: $projectId) {
          id projectId
          variables(after: $after) {
            edges { node { id name serviceId isSealed updatedAt } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { projectId, environmentId, after },
    );
    const parsed = environment.safeParse(data.environment);
    if (!parsed.success || parsed.data.id !== environmentId || parsed.data.projectId !== projectId) {
      throw new RailwayNativeError('railway_invalid_response');
    }
    const { edges, pageInfo } = parsed.data.variables;
    for (const { node } of edges) {
      if (node.serviceId !== serviceId) continue;
      if (rows.has(node.name)) throw new RailwayNativeError('railway_invalid_response');
      rows.set(node.name, { key: node.name, providerId: node.id, providerRevision: node.updatedAt, secret: node.isSealed });
    }
    if (!pageInfo.hasNextPage) return rows;
    if (pageInfo.endCursor === null || pageInfo.endCursor === after) throw new RailwayNativeError('railway_invalid_response');
    after = pageInfo.endCursor;
  }
}

async function observe(graphql: Graphql, coordinates: Coordinates, context: PluginAccountActionContext) {
  try {
    return await readSnapshot(graphql, coordinates);
  } catch (error) {
    return projectRailwayFailure(error, context, 'deployment.railway.variables.read');
  }
}

async function read(input: Read, context: PluginAccountActionContext): Promise<DeploymentTargetVariablesReadResultV1> {
  const coordinates = readRailwayCoordinates(input);
  const snapshot = await observe(railwayGraphql(context), coordinates, context);
  return { v: 1, variables: projectDeploymentTargetVariablesV1([...snapshot.values()], input.owned) };
}

function mutationFailureCode(error: unknown): FailureCode {
  const status = error instanceof RailwayNativeError ? error.status
    : isPluginError(error) ? error.data.failureCause?.httpStatus : undefined;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 ? 'provider_request_failed' : 'outcome_unknown';
}

async function sync(input: Sync, context: PluginAccountActionContext): Promise<SyncResult> {
  const coordinates = readRailwayCoordinates(input);
  const graphql = railwayGraphql(context);
  const observed = await observe(graphql, coordinates, context);
  const planned = createDeploymentTargetVariableSyncV1(input, [...observed.values()]);
  const updates = new Map<string, string>();
  for (const binding of planned.set) {
    const materialized = await planned.materialize(binding, context);
    if (materialized) updates.set(binding.name, materialized.value);
  }

  async function apply(keys: readonly string[], effect: () => Promise<void>): Promise<boolean> {
    if (keys.length === 0) return false;
    try {
      await effect();
      return true;
    } catch (error) {
      for (const key of keys) planned.fail(key, mutationFailureCode(error));
      return false;
    }
  }

  const updatedKeys = [...updates.keys()];
  const removedKeys = planned.remove.map(row => row.key);
  const updated = await apply(updatedKeys, () => createRailwayProjectOperations(railwayRequest(context), context.signal)
    .upsertServiceVariables({ ...coordinates, variables: Object.fromEntries(updates), skipDeploys: true }));
  const removed = await apply(removedKeys, async () => {
    // Railway's VariableDeleteInput has no deploy suppression. Commit only this
    // service's key deletions using Railway's direct EnvironmentConfig patch.
    const result = await graphql(
      `mutation($environmentId: String!, $patch: EnvironmentConfig!) {
        environmentPatchCommit(environmentId: $environmentId, patch: $patch, skipDeploys: true)
      }`,
      { environmentId: coordinates.environmentId,
        patch: { services: { [coordinates.serviceId]: { variables: Object.fromEntries(removedKeys.map(key => [key, null])) } } } },
    );
    if (typeof result.environmentPatchCommit !== 'string' || !result.environmentPatchCommit) {
      throw new RailwayNativeError('railway_invalid_response');
    }
  });

  // The merge call acknowledges with a Boolean and the patch returns an ID.
  // Observe once to capture new ownership and verify removals before recording them.
  if (!updated && !removed) return planned.result();

  let settled: Snapshot | undefined;
  try { settled = await readSnapshot(graphql, coordinates); } catch {
    // Preserve the previous evidence and report the unresolved effects per key.
  }
  if (updated) for (const key of updatedKeys) {
    const row = settled?.get(key);
    const previous = observed.get(key);
    // The grouped Boolean cannot confirm an individual key. Unchanged metadata
    // leaves the reviewed revision unconfirmed without reading secret values.
    if (row && (row.providerId !== previous?.providerId || row.providerRevision !== previous?.providerRevision)) {
      planned.acknowledgeSet(row);
    } else planned.fail(key, 'outcome_unknown');
  }
  if (removed) for (const { key, providerId } of planned.remove) {
    if (!settled || settled.get(key)?.providerId === providerId) planned.fail(key, 'outcome_unknown');
    else planned.acknowledgeRemove(key);
  }
  return planned.result(settled && [...settled.values()]);
}

export const variableActions = {
  'variables-read': { ...railwayAccountAction, title: 'Read Railway variable metadata', dangerLevel: 'safe', readOnly: true,
    inputSchema: railwayRoleInput(inputs['variables.read'].jsonSchema), resultSchema: readOutput.jsonSchema,
    run: (input: JsonValue, context: PluginAccountActionContext) => read(input as unknown as Read, context) },
  'variables-sync': { ...railwayAccountAction, title: 'Synchronize the reviewed Railway variables', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Save these variables to Railway?' },
    inputSchema: railwayRoleInput(inputs['variables.sync'].jsonSchema), resultSchema: syncOutput.jsonSchema,
    run: (input: JsonValue, context: PluginAccountActionContext) => sync(input as unknown as Sync, context) },
} as const;
