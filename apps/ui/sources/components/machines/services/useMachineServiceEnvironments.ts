import * as React from 'react';
import { useDeploymentInventory } from '@/components/projects/deployments/useDeploymentProject';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { readMachineDeploymentReferencesV1, type MachineDeploymentReferencesPageV1,
  type MachineReferenceV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { readDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { isAccountCurrentnessEntityIdV1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiMachineDeploymentReferenceReader } from '@/sync/ops/actions/managedMachineReferenceDeps';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { readServerAccountScopeOwnerLifetime, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

export type MachineServiceEnvironmentHeader = Readonly<{ title: string; projectSourceId: string }>;

export type MachineDeploymentRoleEnvironment = MachineServiceEnvironmentHeader & Readonly<{
  environmentId: string; roles: NonNullable<MachineReferenceV1['deploymentRoles']>;
}>;

type CensusRead = Readonly<{ value: MachineDeploymentReferencesPageV1 | null }>;
type CensusEntry = { read: CensusRead | null; listeners: Set<() => void>; load: () => void; start: () => void; stop: (() => void) | null };

/**
 * One census read per Machine per Account lifetime, however many surfaces show it (the Machine page header's role
 * facts and the Services tab's roles section): every consumer subscribes to the same entry. The entry keeps its last
 * answer while nothing is subscribed, so a surface presented again shows it while the refresh runs.
 */
const censusEntries = new WeakMap<ServerAccountScopeLifetime, Map<string, CensusEntry>>();

function censusEntry(lifetime: ServerAccountScopeLifetime, serverId: string, machineId: string): CensusEntry {
  let byMachine = censusEntries.get(lifetime);
  if (!byMachine) { byMachine = new Map(); censusEntries.set(lifetime, byMachine); }
  const existing = byMachine.get(machineId);
  if (existing) return existing;
  let controller: AbortController | null = null;
  let reading = false;
  let pending = false;
  const entry: CensusEntry = { read: null, listeners: new Set(), stop: null, load: () => {}, start: () => {} };
  const publish = (value: MachineDeploymentReferencesPageV1 | null) => {
    entry.read = { value };
    entry.listeners.forEach(listener => listener());
  };
  entry.load = () => {
    const signal = controller?.signal;
    if (!signal || signal.aborted || !lifetime.isCurrent()) return;
    if (reading) { pending = true; return; }
    reading = true;
    void (async () => {
      do {
        pending = false;
        let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
        try {
          account = await captureLazyActionAccountContext(serverId, signal);
          if (account.accountId !== lifetime.scope.accountId || !account.serverIdentityId) throw new Error('deployment_references_unavailable');
          const readPage = createUiMachineDeploymentReferenceReader(account);
          const value = await readMachineDeploymentReferencesV1({ homeId: account.serverIdentityId,
            machineId, signal }, selection => readPage(selection, signal));
          account.assertCurrent();
          if (!signal.aborted && lifetime.isCurrent()) publish(value);
        } catch {
          if (!signal.aborted && lifetime.isCurrent()) publish(null);
        } finally { account?.dispose(); }
      } while (pending && !signal.aborted);
      reading = false;
    })();
  };
  entry.start = () => {
    controller = new AbortController();
    const current = controller;
    const stopRetirement = lifetime.onRetire(() => current.abort());
    const stopChanges = subscribeHomeAccountChange(event => {
      if (event.changeKinds && !event.changeKinds.includes('account')) return;
      if (!event.entityIds || event.entityIds.some(id => isAccountCurrentnessEntityIdV1(id)
        || id === PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 || id === TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1
        || readDeploymentAccountChangeV1({ kind: 'account', entityId: id }))) entry.load();
    }, { serverIds: [serverId] });
    entry.stop = () => { current.abort(); stopChanges(); stopRetirement.dispose(); reading = false; pending = false; entry.stop = null; };
    entry.load();
  };
  byMachine.set(machineId, entry);
  return entry;
}

function subscribeCensus(entry: CensusEntry, listener: () => void): () => void {
  entry.listeners.add(listener);
  if (entry.listeners.size === 1) entry.start();
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) entry.stop?.();
  };
}

const NO_SUBSCRIPTION = () => () => {};

/** Role-only Machines need no service inventory. Roles come from the same exact
 * relational owner as reboot review; names come only from admitted headers. */
export function useMachineDeploymentRoles(input: Readonly<{ serverId: string; machineId: string; active: boolean }>) {
  const { binding: lifetime } = useServerCredentialAccountScopeBinding(input.serverId);
  const live = lifetime?.isCurrent() ? lifetime : null;
  // Keyed by the Account's owner lifetime, which every reader of this Home/Account shares (each reader's own binding
  // differs), so the header and the Services tab land on one entry.
  const entry = React.useMemo(() => live && input.machineId
    ? censusEntry(readServerAccountScopeOwnerLifetime(live), input.serverId, input.machineId) : null,
    [live, input.serverId, input.machineId]);
  const subscribe = React.useMemo(() => entry && input.active ? (listener: () => void) => subscribeCensus(entry, listener)
    : NO_SUBSCRIPTION, [entry, input.active]);
  const read = React.useSyncExternalStore(subscribe, () => entry?.read ?? null, () => entry?.read ?? null);
  const refresh = React.useCallback(() => entry?.load(), [entry]);
  const currentRead = live ? read : null;
  const value = currentRead?.value;
  const environmentIds = React.useMemo(() => [...new Set(value?.references.map(reference => reference.id) ?? [])], [value]);
  const { headers, settled, status: headerStatus } = useMachineServiceEnvironments({ serverId: input.serverId, environmentIds, active: input.active });
  const environments = React.useMemo(() => (value?.references ?? []).flatMap(reference => {
    const header = headers.get(reference.id);
    return header ? [{ ...header, environmentId: reference.id, roles: reference.deploymentRoles ?? [] }] : [];
  }), [value, headers]);
  const status = currentRead === null || environmentIds.length > 0 && !settled ? 'loading' as const
    : !value || value.coverage === 'partial' || headerStatus === 'unavailable' ? 'unavailable' as const : 'ready' as const;
  return React.useMemo(() => ({ environments, status, refresh }), [environments, status, refresh]);
}

/**
 * The admitted headers of exactly the Environments visible service rows belong to (plan 30 §3.8 "One Environment
 * grouping"): one read through the deployment owner's exact-id selector, never an Account-wide inventory scan or a
 * per-service read. An Environment the person can't read stays absent; its group keeps the generic name.
 */
export function useMachineServiceEnvironments(input: Readonly<{
  serverId: string; environmentIds: readonly string[]; active: boolean;
}>): Readonly<{ headers: ReadonlyMap<string, MachineServiceEnvironmentHeader>; settled: boolean;
  status: ReturnType<typeof useDeploymentInventory>['snapshot']['status'] }> {
  const { binding: lifetime } = useServerCredentialAccountScopeBinding(input.serverId);
  const demand = React.useMemo(() => ({ mounted: input.active, visible: input.active, focused: input.active }), [input.active]);
  const read = useDeploymentInventory(input.environmentIds.length === 0 ? null : lifetime, demand,
    { environmentIds: input.environmentIds });
  const items = read.snapshot.value?.items;
  // Settled: the read answered, so an Environment it left out is one the person can't read (not one still loading).
  const settled = read.snapshot.status === 'ready' || read.snapshot.status === 'unavailable';
  const headers = React.useMemo(() => new Map((items ?? []).map(item => [item.environment.id, {
    title: item.title, projectSourceId: item.environment.projectSourceId,
  }])), [items]);
  const status = read.snapshot.status;
  return React.useMemo(() => ({ headers, settled, status }), [headers, settled, status]);
}

/** The admitted Source's name, read once per distinct visible Source through its existing detail reader. */
export function useMachineServiceSourceName(serverId: string, sourceId: string | null, active = true): string | null {
  const { binding: lifetime } = useServerCredentialAccountScopeBinding(serverId);
  return useProjectSource(active ? lifetime : null, sourceId).source?.source.name ?? null;
}
