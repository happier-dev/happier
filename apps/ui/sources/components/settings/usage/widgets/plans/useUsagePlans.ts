import * as React from 'react';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedServicePoolSelectionGetResponseV1 } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { useConnectedServiceQuotaSummaries } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { presentConnectedAccountNames } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { useAllMachines } from '@/sync/domains/state/storage';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import {
  projectUsagePlans,
  type UsagePlanAccount,
  type UsagePlansProjection,
} from './usagePlansModel';

export type UsagePlanAccountName = Readonly<{
  /** "Claude Pro" when the plan is known, else the account's name through the one naming owner. */
  title: string;
  /** The account identity and service, quiet beside the title. */
  qualifier: string;
  serviceLabel: string;
  legacyServiceId: ConnectedServiceId | null;
}>;

const accountKeyOf = (
  service: Readonly<{ pluginId: string; localId: string }>,
  accountId: string,
) => `${service.pluginId}/${service.localId}:${accountId}`;

/**
 * The Plans bodies' shared read of one slice. B facts come from the slice only; the incumbent
 * connected-account summaries owner supplies identity labels only. Quota, pool evidence and refresh
 * belong to the displayed Usage Resource; no mounted body creates another quota demand.
 * Nothing here ranks or weights accounts.
 */
export function useUsagePlans(slice: UsageQueryResultSlice, resource: Readonly<{
  refresh(): Promise<void>;
  refreshing: boolean;
}>): Readonly<{
  projection: UsagePlansProjection;
  nameOf(account: UsagePlanAccount): UsagePlanAccountName;
  inUse: ReadonlySet<string>;
  refresh(): Promise<void>;
  refreshing: boolean;
  nowMs: number;
}> {
  const nowMs = Date.now();
  const quota = slice.quota;
  // A fresh `now` per render would rebuild the projection on every parent render; minute precision
  // is what the reset/stale wording shows.
  const minute = Math.floor(nowMs / 60_000);
  const projection = React.useMemo(
    () => projectUsagePlans(quota, minute * 60_000, slice.pools),
    [quota, minute, slice.pools],
  );
  const summaries = useConnectedServiceQuotaSummaries({ fetchPolicy: 'cache_only' });
  const { present } = useConnectedAccountIdentityPrivacy();
  const summaryByKey = React.useMemo(
    () =>
      new Map(
        summaries.summaries.map((summary) => [
          accountKeyOf(summary.service, summary.profileId),
          summary,
        ]),
      ),
    [summaries.summaries],
  );
  const names = React.useMemo(
    () =>
      presentConnectedAccountNames(
        projection.accounts.map((account) => {
          const summary = summaryByKey.get(account.key);
          return {
            key: account.key,
            serviceTitle: summary?.serviceLabel ?? account.service.localId,
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
    [projection.accounts, summaryByKey, present],
  );
  const nameOf = React.useCallback(
    (account: UsagePlanAccount): UsagePlanAccountName => {
      const summary = summaryByKey.get(account.key);
      const name = names.get(account.key);
      const serviceLabel = summary?.serviceLabel ?? account.service.localId;
      const accountName = name?.primaryLabel ?? serviceLabel;
      const plan = account.planLabel;
      return {
        title: plan ?? accountName,
        qualifier: [plan ? accountName : null, name?.identityLabel ?? null]
          .filter(Boolean)
          .join(' · '),
        serviceLabel,
        legacyServiceId: summary?.legacyServiceId ?? null,
      };
    },
    [names, summaryByKey],
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
    refresh: resource.refresh,
    refreshing: resource.refreshing,
    nowMs,
  };
}

/** An online machine of this Home: the daemon whose selector the read projects. */
export function useUsageSelectorMachineId(): string | null {
  const machines = useAllMachines();
  return React.useMemo(
    () => machines.find((machine) => isMachineOnline(machine))?.id ?? null,
    [machines],
  );
}

export type UsagePoolSelectionState =
  | ConnectedServicePoolSelectionGetResponseV1
  | 'loading'
  | 'failed'
  | 'no_machine';

/**
 * The Resource's admitted selector projection. It is evidence, not a controller; this hook creates
 * no RPC, lifetime or polling path and never re-derives the selector's order.
 */
export function useUsagePoolSelections(
  slice: UsageQueryResultSlice,
): ReadonlyMap<string, UsagePoolSelectionState> {
  return React.useMemo(() => new Map((slice.pools ?? []).map(pool => {
    const selection = pool.selection;
    const state: UsagePoolSelectionState = selection.value ??
      (selection.status === 'pending' || selection.status === 'not_loaded' ? 'loading' :
        selection.errorCode === 'no_machine' ? 'no_machine' : 'failed');
    return [`${pool.group.service.pluginId}/${pool.group.service.localId}:${pool.group.groupId}`, state];
  })), [slice.pools]);
}
