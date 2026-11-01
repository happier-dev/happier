import type { ProviderConnectionsCatalogV1 } from './catalogSchemasV1.js';
import { getProviderExperimentalConfirmationKeyV1 } from '../settings/v1.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';

function retainEqualFields<T extends object>(previous: T | undefined, incoming: T): T {
  if (!previous || previous === incoming) return previous ?? incoming;
  let changed = Object.keys(previous).length !== Object.keys(incoming).length;
  const next = { ...incoming };
  for (const key of Object.keys(incoming) as Array<keyof T>) {
    if (sameStrictJsonValue(previous[key], incoming[key])) next[key] = previous[key];
    else changed = true;
  }
  return changed ? next : previous;
}

function reconcileRows<T extends object>(previous: T[], incoming: T[], keyOf: (row: T) => string): T[] {
  if (previous === incoming) return previous;
  const previousById = new Map(previous.map(row => [keyOf(row), row]));
  let changed = previous.length !== incoming.length;
  const rows = incoming.map((row, index) => {
    const admitted = retainEqualFields(previousById.get(keyOf(row)), row);
    if (admitted !== previous[index]) changed = true;
    return admitted;
  });
  return changed ? rows : previous;
}

function reconcileModels(previous: ProviderConnectionsCatalogV1['manualModelsByConnectionId'],
  incoming: ProviderConnectionsCatalogV1['manualModelsByConnectionId']): ProviderConnectionsCatalogV1['manualModelsByConnectionId'] {
  if (previous === incoming) return previous;
  const next = { ...incoming };
  for (const key of Object.keys(incoming) as Array<keyof typeof incoming>) {
    next[key] = reconcileRows(previous[key] ?? [], incoming[key]!, row => row.id);
  }
  return retainEqualFields(previous, next);
}

/** Reconcile admitted catalog rows by domain identity at each client's publication cut. */
export function reconcileProviderConnectionsCatalogV1(previous: ProviderConnectionsCatalogV1 | null | undefined,
  incoming: ProviderConnectionsCatalogV1): ProviderConnectionsCatalogV1;
export function reconcileProviderConnectionsCatalogV1(previous: ProviderConnectionsCatalogV1 | null | undefined,
  incoming: ProviderConnectionsCatalogV1 | null): ProviderConnectionsCatalogV1 | null;
export function reconcileProviderConnectionsCatalogV1(previous: ProviderConnectionsCatalogV1 | null | undefined,
  incoming: ProviderConnectionsCatalogV1 | null): ProviderConnectionsCatalogV1 | null {
  if (!previous || !incoming || previous === incoming) return incoming;
  return retainEqualFields(previous, {
    ...incoming,
    connections: reconcileRows(previous.connections, incoming.connections, row => row.id),
    connectionTombstones: reconcileRows(previous.connectionTombstones, incoming.connectionTombstones, row => row.id),
    accountGrants: reconcileRows(previous.accountGrants, incoming.accountGrants, row => row.connectionId),
    machineGrants: reconcileRows(previous.machineGrants, incoming.machineGrants, row => JSON.stringify([row.connectionId, row.machineId])),
    secretBindingsByConnectionId: retainEqualFields(previous.secretBindingsByConnectionId, incoming.secretBindingsByConnectionId),
    manualModelsByConnectionId: reconcileModels(previous.manualModelsByConnectionId, incoming.manualModelsByConnectionId),
    experimentalBindingConfirmations: reconcileRows(previous.experimentalBindingConfirmations,
      incoming.experimentalBindingConfirmations, getProviderExperimentalConfirmationKeyV1),
  });
}
