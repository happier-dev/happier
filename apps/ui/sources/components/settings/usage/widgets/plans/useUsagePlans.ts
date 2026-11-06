import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedServicePoolSelectionGetResponseV1 } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { useConnectedServiceQuotaSummaries } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { presentConnectedAccountNames, presentQualifiedConnectedAccountTarget } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { storage, useActiveServerAccountScope, useActiveServerAccountScopeLifetime, useActiveMachineFacts, useMachineListForServerSelection } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { useMachinePresenceSummaries, type MachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { useProjectedConnectedServicesRegistry, useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveConnectedServiceRegistryEntryDisplayName, resolveQualifiedConnectedServiceRegistryDisplayName, resolveQualifiedConnectedServiceRegistryEntry } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import type { QualifiedConnectedAccountGroupV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { selectConnectedMetadataLabels, useConnectedMetadataCatalog } from '@/hooks/server/connectedServices/useConnectedMetadataCatalog';
import { t } from '@/text';
import {
  projectUsagePlans,
  type UsagePlanAccount,
  type UsagePlansProjection,
} from './usagePlansModel';

export type UsagePlanAccountName = Readonly<{
  /** The account's distinct name through the canonical connected-account naming owner. */
  title: string;
  /** The plan and account identity, quiet beside the title. */
  qualifier: string;
  serviceLabel: string;
  legacyServiceId: ConnectedServiceId | null;
}>;

const accountKeyOf = (
  service: Readonly<{ pluginId: string; localId: string }>,
  accountId: string,
) => `${service.pluginId}/${service.localId}:${accountId}`;

const NO_GROUPS: readonly QualifiedConnectedAccountGroupV4[] = [];

/**
 * The Plans bodies' shared read of one slice. B facts come from the slice only; the incumbent
 * connected-account summaries owner supplies identity labels only. Quota, pool evidence and refresh
 * belong to the displayed Usage Resource; no mounted body creates another quota demand.
 * Nothing here ranks or weights accounts.
 */
export function useUsagePlans(slice: UsageQueryResultSlice, refresh: () => Promise<void>): Readonly<{
  projection: UsagePlansProjection;
  nameOf(account: UsagePlanAccount): UsagePlanAccountName;
  inUse: ReadonlySet<string>;
  refresh(): Promise<void>;
  nowMs: number;
}> {
  const nowMs = Date.now();
  const quota = slice.quota;
  // A fresh `now` per render would rebuild the projection on every parent render; minute precision
  // is what the reset/stale wording shows.
  const minute = Math.floor(nowMs / 60_000);
  const summaries = useConnectedServiceQuotaSummaries({ fetchPolicy: 'cache_only' });
  const registry = useProjectedConnectedServicesRegistry();
  const baseProjection = React.useMemo(
    () => projectUsagePlans(quota, minute * 60_000, slice.pools, slice.sources),
    [quota, minute, slice.pools, slice.sources],
  );
  const localizePluginText = useProjectedPluginLocalizedTextResolver();
  const scope = useActiveServerAccountScope();
  const groups = storage(state => areServerAccountScopesEqual(state.profileScope, scope)
    ? state.profile.connectedAccountGroupsV4 : NO_GROUPS);
  const labelsByKey = useConnectedMetadataCatalog(undefined, selectConnectedMetadataLabels);
  const projection = React.useMemo(() => ({ ...baseProjection, pools: baseProjection.pools.filter(pool => groups.some(group =>
    group.ref.groupId === pool.groupId && group.ref.service.pluginId === pool.service.pluginId
      && group.ref.service.localId === pool.service.localId)).map(pool => ({
    ...pool,
    name: presentQualifiedConnectedAccountTarget({ target: { kind: 'group', service: pool.service, groupId: pool.groupId },
      groups, accounts: [], labelsByKey,
      serviceTitle: resolveQualifiedConnectedServiceRegistryDisplayName(registry, pool.service, t, localizePluginText),
    }).primaryLabel,
  })) }), [baseProjection, groups, labelsByKey, registry, localizePluginText]);
  const serviceEntryOf = React.useCallback((account: UsagePlanAccount) =>
    resolveQualifiedConnectedServiceRegistryEntry(registry, account.service), [registry]);
  const { present } = useConnectedAccountIdentityPrivacy();
  const summaryByKey = React.useMemo(
    () =>
      new Map(
        summaries.accountIdentities.map((summary) => [
          accountKeyOf(summary.service, summary.profileId),
          summary,
        ]),
      ),
    [summaries.accountIdentities],
  );
  const serviceLabelOf = React.useCallback((account: UsagePlanAccount) => {
    // The catalog establishes identity independently of Usage read availability.
    const entry = serviceEntryOf(account);
    return entry ? resolveConnectedServiceRegistryEntryDisplayName(entry, t, localizePluginText)
      : t('connectedServices.fallbackName');
  }, [localizePluginText, serviceEntryOf]);
  const names = React.useMemo(
    () =>
      presentConnectedAccountNames(
        projection.accounts.map((account) => {
          const summary = summaryByKey.get(account.key);
          return {
            key: account.key,
            serviceTitle: serviceLabelOf(account),
            displayName:
              summary?.accountLabel ??
              summary?.profileLabel ??
              account.accountLabel ??
              null,
            email: summary?.accountEmail ?? null,
            accountId: account.accountId,
            presentIdentity: present,
          };
        }),
      ),
    [projection.accounts, summaryByKey, present, serviceLabelOf],
  );
  const nameOf = React.useCallback(
    (account: UsagePlanAccount): UsagePlanAccountName => {
      const summary = summaryByKey.get(account.key);
      const name = names.get(account.key);
      const serviceLabel = serviceLabelOf(account);
      const accountName = name?.primaryLabel ?? serviceLabel;
      const plan = account.planLabel;
      return {
        title: accountName,
        qualifier: [plan, name?.identityLabel ?? null]
          .filter(Boolean)
          .join(' · '),
        serviceLabel,
        legacyServiceId: summary?.legacyServiceId ?? serviceEntryOf(account)?.legacyServiceId ?? null,
      };
    },
    [names, summaryByKey, serviceLabelOf, serviceEntryOf],
  );
  const inUse = React.useMemo(
    () =>
      new Set(
        (slice.pools ?? []).flatMap(pool => pool.activeAccountId
          ? [accountKeyOf(pool.group.service, pool.activeAccountId)] : []),
      ),
    [slice.pools],
  );
  return {
    projection,
    nameOf,
    inUse,
    refresh,
    nowMs,
  };
}

/** An online machine of this Home: the daemon whose selector the read projects. */
export function useUsageSelectorMachineId(): string | null {
  const machines = useActiveMachineFacts();
  const scope = useActiveServerAccountScope();
  const reachabilityRevision = useMachineReachabilityRevision();
  const nowMs = useMachinePresenceNowMs(machines);
  return React.useMemo(
    () => machines.find((machine) => isMachineSelectableForFleet(scope, machine, nowMs))?.id ?? null,
    [machines, scope, reachabilityRevision, nowMs],
  );
}

function samePoolMachineReachability(left: readonly MachinePresenceSummary[], right: readonly MachinePresenceSummary[]): boolean {
  return left.length === right.length && left.every((summary, index) => summary.reachability === right[index]?.reachability);
}

/**
 * The Machines a pool's switching order can be read on under this Machines filter, by the names the
 * Machines filter shows. Mounted only while a person is asked to choose one (`choose_machine`).
 */
export function useUsagePoolMachineChoices(machineIds: readonly string[]): readonly Readonly<{ id: string; name: string }>[] {
  const lifetime = useActiveServerAccountScopeLifetime();
  const serverId = lifetime?.scope.serverId ?? '';
  const selectNames = useShallow(React.useCallback((machines: readonly Machine[]) => {
    // Peer names can change a displayed suffix; unrelated Machine facts cannot change this selection.
    const names = resolveMachineDisplayNames(machines);
    return new Map(machines.filter(machine => !isMachineReplaced(machine)
      && (machineIds.length === 0 || machineIds.includes(machine.id)))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(machine => [machine.id, names.get(machine.id) ?? machine.id] as const));
  }, [machineIds]));
  const names = useMachineListForServerSelection(serverId, selectNames);
  const ids = React.useMemo(() => [...names.keys()], [names]);
  const presence = useMachinePresenceSummaries(serverId, ids, lifetime, samePoolMachineReachability);
  return React.useMemo(() => ids.flatMap((id, index) => presence[index]?.reachability === 'reachable'
    ? [{ id, name: names.get(id) ?? id }] : []), [ids, names, presence]);
}

type ResolvedPoolSelection = Extract<ConnectedServicePoolSelectionGetResponseV1, { selection: unknown }>;
export type UsagePoolMemberStatus = 'none_known' | 'all_excluded' | 'known';
export type UsagePoolSelectionState =
  | (ResolvedPoolSelection & Readonly<{ memberStatus: UsagePoolMemberStatus; refreshError?: 'failed' | 'no_machine' }>)
  | Exclude<ConnectedServicePoolSelectionGetResponseV1, ResolvedPoolSelection>
  | 'loading'
  | 'failed'
  | 'no_machine'
  /** Several Machines are in scope and each keeps its own order: the person chooses whose order to see. */
  | 'choose_machine';

/**
 * The Resource's admitted selector projection. It is evidence, not a controller; this hook creates
 * no RPC, lifetime or polling path and never re-derives the selector's order.
 */
export function useUsagePoolSelections(
  slice: UsageQueryResultSlice,
): ReadonlyMap<string, UsagePoolSelectionState> {
  return React.useMemo(() => new Map<string, UsagePoolSelectionState>((slice.pools ?? []).map(pool => {
    const key = `${pool.group.service.pluginId}/${pool.group.service.localId}:${pool.group.groupId}`;
    const selection = pool.selection;
    const state = (selection.value && 'selection' in selection.value
      ? { ...selection.value, ...(selection.errorCode ? {
        refreshError: selection.errorCode === 'no_machine' ? 'no_machine' as const : 'failed' as const,
      } : {}) } : selection.value) ??
      (selection.status === 'pending' || selection.status === 'not_loaded' ? 'loading' :
        selection.errorCode === 'no_machine' ? 'no_machine'
          : selection.status === 'unknown' && !selection.machineId ? 'choose_machine' : 'failed');
    if (typeof state === 'string' || 'status' in state) return [key, state] as const;
    const { selected, excluded, decisionTrace } = state.selection;
    // A machine's empty trace is not evidence that the pool's accounts are unusable.
    const memberStatus: UsagePoolMemberStatus = !selected && decisionTrace.orderedEligibleCandidates.length === 0
      ? excluded.length > 0 && decisionTrace.candidates.every(candidate => excluded.some(entry => entry.profileId === candidate.profileId))
        ? 'all_excluded' : decisionTrace.candidates.length === 0 && excluded.length === 0 ? 'none_known' : 'known'
      : 'known';
    return [key, { ...state, memberStatus }] as const;
  })), [slice.pools]);
}
