import type { ConnectedAccountMaterializationRequest, QualifiedConnectedAccountGroupV4,
  QualifiedConnectedAccountPurposeBindingTargetV1, QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { PluginError } from '../plugins/errors.js';
import type { ConnectedAccountConfiguredEndpoint } from './configuredOrigins.js';
import type { ConnectedAccountPurposeInventoryEntry } from './purposeInventory.js';
import { projectConnectedAccountPurposeInventory } from './purposeInventory.js';
import type { ConnectedAccountPurposeTargetObservation } from './purposeBinding.js';

type Inventory = Readonly<{ entries: readonly ConnectedAccountPurposeInventoryEntry[] }>;
type Target = QualifiedConnectedAccountPurposeBindingTargetV1;
type TargetRead = Readonly<{
  target: QualifiedConnectedAccountPurposeBindingTargetV1;
  signal: AbortSignal;
  /** Owned Account/Pool resolution supplies this; disclosed Team origins have no local V4 observation. */
  observation?: ConnectedAccountPurposeTargetObservation;
}>;
export type ConnectedAccountPurposeListedAccount = ConnectedAccountPurposeInventoryEntry & Readonly<{
  connectedAccountOrigins: readonly string[];
  connectedAccountBases: readonly string[];
}>;
export type ConnectedAccountPurposeMetadataList = Readonly<{
  status: 'complete' | 'truncated'; accounts: readonly ConnectedAccountPurposeListedAccount[];
}>;

/** The public listing request's existing positive safe-integer limit contract. */
export function readConnectedAccountListLimit(limit: unknown): number | undefined {
  if (limit === undefined) return undefined;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
    throw new PluginError({ code: 'plugin_connected_account_binding_out_of_scope',
      message: 'Connected Accounts owner returned a listing outside the request authorization' });
  }
  return limit;
}

export function connectedAccountListedAccountOutOfScope(): PluginError {
  return new PluginError({ code: 'plugin_connected_account_binding_out_of_scope',
    message: 'Connected Account is not currently authorized for this purpose' });
}

function configuredOriginsUnavailable(): PluginError {
  return new PluginError({ code: 'connected_account_configured_origins_unavailable',
    message: 'Connected Account configured-origin projection is unavailable for this runtime' });
}

/** A selected target's metadata, never a service-wide listing or selector. */
export async function readConnectedAccountPurposeTargetInventory(source: Readonly<{
  readInventory(input: Readonly<{ serviceRefs: readonly QualifiedConnectedAccountRef['service'][]; signal: AbortSignal }>): Promise<Inventory>;
  readGroup?(ref: Readonly<{ service: QualifiedConnectedAccountRef['service']; groupId: string }>, signal: AbortSignal): Promise<QualifiedConnectedAccountGroupV4 | null>;
}>, input: Readonly<{ target: Target; signal: AbortSignal }>): Promise<Inventory> {
  input.signal.throwIfAborted();
  const target = input.target;
  const service = target.kind === 'account' ? target.account.service : target.service;
  const inventory = await source.readInventory({ serviceRefs: Object.freeze([service]), signal: input.signal });
  const group = target.kind === 'group' ? await source.readGroup?.({ service, groupId: target.groupId }, input.signal) : undefined;
  input.signal.throwIfAborted();
  return projectTargetInventory(target, inventory, group);
}

/** Account/Pool membership from the same finite resolution, without another physical read. */
export function projectConnectedAccountPurposeTargetInventory(input: Readonly<{
  target: Target; observation: ConnectedAccountPurposeTargetObservation;
}>): Inventory {
  const service = input.target.kind === 'account' ? input.target.account.service : input.target.service;
  return projectTargetInventory(input.target,
    projectConnectedAccountPurposeInventory({ service, ...input.observation }), input.observation.group);
}

function projectTargetInventory(target: Target, inventory: Inventory, group: QualifiedConnectedAccountGroupV4 | null | undefined): Inventory {
  if (target.kind === 'account') return Object.freeze({ entries: Object.freeze(inventory.entries.filter(entry =>
    sameQualifiedConnectedAccountRef(entry.account, target.account))) });
  const service = target.service;
  if (!group || group.ref.groupId !== target.groupId || group.ref.service.pluginId !== service.pluginId
    || group.ref.service.localId !== service.localId) return Object.freeze({ entries: Object.freeze([]) });
  const memberIds = new Set(group.members.filter(member => member.enabled !== false).map(member => member.connectedAccountId));
  return Object.freeze({ entries: Object.freeze(inventory.entries.filter(entry => entry.account.service.pluginId === service.pluginId
    && entry.account.service.localId === service.localId && memberIds.has(entry.account.accountId))) });
}

/** The incumbent daemon projection, also consumed by portable Account purposes. */
export function createConnectedAccountPurposeTargetAccountListing(source: Readonly<{
  readTargetAccountInventory(input: TargetRead): Promise<Inventory>;
  resolveConnectedAccountEndpoints?(input: Readonly<{ account: QualifiedConnectedAccountRef; signal: AbortSignal }>): Promise<readonly ConnectedAccountConfiguredEndpoint[]>;
}>) {
  const readEndpoints = async (entry: ConnectedAccountPurposeInventoryEntry, signal: AbortSignal) => {
    if (!source.resolveConnectedAccountEndpoints) throw configuredOriginsUnavailable();
    const endpoints = await source.resolveConnectedAccountEndpoints({ account: entry.account, signal });
    signal.throwIfAborted();
    return Object.freeze([...new Map(endpoints.map(endpoint => [endpoint.base, endpoint])).values()]
      .sort((left, right) => left.base < right.base ? -1 : 1));
  };
  return Object.freeze({
    async projectTargetAccounts(input: TargetRead & Readonly<{ limit?: number }>): Promise<ConnectedAccountPurposeMetadataList> {
      if (!source.resolveConnectedAccountEndpoints) throw configuredOriginsUnavailable();
      const inventory = await source.readTargetAccountInventory(input);
      const page = inventory.entries.slice(0, input.limit);
      const accounts: ConnectedAccountPurposeListedAccount[] = [];
      for (const entry of page) {
        const endpoints = await readEndpoints(entry, input.signal);
        accounts.push(Object.freeze({ account: entry.account, displayName: entry.displayName, state: entry.state,
          connectedAccountOrigins: Object.freeze([...new Set(endpoints.map(endpoint => endpoint.origin))].sort()),
          connectedAccountBases: Object.freeze(endpoints.map(endpoint => endpoint.base)) }));
      }
      return Object.freeze({ status: page.length < inventory.entries.length ? 'truncated' as const : 'complete' as const,
        accounts: Object.freeze(accounts) });
    },
    async assertTargetAccountMaterializable(input: TargetRead & Readonly<{
      account: QualifiedConnectedAccountRef; request: ConnectedAccountMaterializationRequest;
    }>): Promise<void> {
      const inventory = await source.readTargetAccountInventory(input);
      const entry = inventory.entries.find(candidate => sameQualifiedConnectedAccountRef(candidate.account, input.account));
      if (!entry || entry.state !== 'connected') throw connectedAccountListedAccountOutOfScope();
      if (input.request.kind !== 'httpHeaders') return;
      const origins = new Set((await readEndpoints(entry, input.signal)).map(endpoint => endpoint.origin));
      // An unconfigured Account uses its service's materialization contract.
      if (origins.size > 0 && !origins.has(input.request.origin)) throw connectedAccountListedAccountOutOfScope();
    },
  });
}
