import * as React from 'react';
import {
  acquireProviderConnectionUsageRefreshResource,
  type ProviderConnectionUsageRefreshResource,
  type ProviderConnectionUsageRefreshSnapshot,
} from '@/sync/domains/connectedServices/accountUsage/providerConnectionUsageRefreshResource';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
  areServerAccountScopesEqual,
  type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { SavedSecretSlotBindingsV1 } from '@happier-dev/protocol/providers/settings/v1';
import { getSavedSecretCatalogSnapshot, readSavedSecretCatalogEntry, subscribeSavedSecretCatalogSnapshots } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { observeSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import type { ProviderUsageSourceV1 } from '@happier-dev/protocol/providers/contributions';
import type { AccountProviderDeclarationV1 } from '@happier-dev/protocol/providers/catalog/accountModelProjectionV1';
import type { ProviderConnectionV1 } from '@happier-dev/protocol/providers/connections/v1';

/** Settings and source browsing must join the same exact declaration/key authority. */
export function providerConnectionUsageAuthority(input: Readonly<{
  sources: readonly ProviderUsageSourceV1[];
  connection: ProviderConnectionV1 | null | undefined;
  declaration: AccountProviderDeclarationV1 | null;
  secretBindings?: SavedSecretSlotBindingsV1;
  machineId: string | null;
}>): Readonly<{ identity: string; secretBindings: SavedSecretSlotBindingsV1 | undefined }> {
  const bindings = { ...input.secretBindings?.account,
    ...(input.machineId ? input.secretBindings?.byMachineId?.[input.machineId] : {}) };
  const definition = input.declaration?.definition;
  const slots = new Set<string>();
  const requests = input.sources.map(source => {
    const endpoint = definition?.endpointTemplates.find(endpoint => endpoint.id === source.endpointTemplateId);
    const credential = source.billingCredential ? null : definition?.credential;
    const transports = credential?.transports.filter(transport => transport.uses.includes('probe')
      && endpoint && transport.protocols.includes(endpoint.protocol)) ?? [];
    if (source.billingCredential) slots.add(source.billingCredential.slotId);
    else if (credential) {
      slots.add(credential.slotId);
      for (const transport of transports) for (const additional of transport.additionalCredentials ?? []) slots.add(additional.slotId);
    }
    return {
      id: source.id, endpointTemplateId: source.endpointTemplateId, path: source.path, parser: source.parser,
      billingCredential: source.billingCredential
        ? { slotId: source.billingCredential.slotId, destination: source.billingCredential.destination } : null,
      endpoint: endpoint ? { id: endpoint.id, protocol: endpoint.protocol, baseUrl: endpoint.baseUrl,
        localUrlCandidates: endpoint.localUrlCandidates, publicHeaders: endpoint.publicHeaders,
        requiresEndpointOverride: endpoint.requiresEndpointOverride, addressConstraint: endpoint.addressConstraint,
        requiredPublicHeaders: endpoint.requiredPublicHeaders } : null,
      accountOverride: input.connection?.endpointOverrides?.find(override => override.endpointTemplateId === source.endpointTemplateId),
      machineOverride: input.machineId ? input.connection?.endpointOverridesByMachineId?.[input.machineId]
        ?.find(override => override.endpointTemplateId === source.endpointTemplateId) : undefined,
      credential: credential ? { slotId: credential.slotId, required: credential.required,
        transports: transports.map(transport => ({
          destination: transport.destination,
          additionalCredentials: transport.additionalCredentials?.map(({ slotId, destination }) => ({ slotId, destination })),
        })) } : null,
    };
  });
  const select = (values: Readonly<Record<string, string>> | undefined) => Object.fromEntries(
    Object.entries(values ?? {}).filter(([slot]) => slots.has(slot)).sort(([a], [b]) => a.localeCompare(b)));
  // Keep the binding's original scope for presentation while the identity and
  // Saved Secret subscription both use only this read's declared credentials.
  const secretBindings = input.secretBindings ? { account: select(input.secretBindings.account),
    ...(input.machineId ? { byMachineId: { [input.machineId]: select(input.secretBindings.byMachineId?.[input.machineId]) } } : {}) } : undefined;
  return { identity: JSON.stringify([input.declaration?.contributionKey, input.connection?.deployment, requests, select(bindings)]), secretBindings };
}

type Invoke = Parameters<typeof acquireProviderConnectionUsageRefreshResource>[0]['invoke'];

export type ProviderConnectionUsageState = ProviderConnectionUsageRefreshSnapshot & Readonly<{
  /** Null while no machine or Account can answer for this connection. */
  refresh: (() => void) | null;
}>;

type Held = Readonly<{
  identity: string;
  resource: ProviderConnectionUsageRefreshResource;
  setActive(active: boolean): void;
}>;
const EMPTY: ProviderConnectionUsageRefreshSnapshot = Object.freeze({ view: null, refreshing: false, failed: false, pendingApproval: null });
const noSubscription = () => () => {};
const readEmpty = () => EMPTY;

/**
 * One usage refresh lifetime per exact Home, Account, connection, machine, usage declaration and selected
 * credentials (`identity`): any change retires the previous lifetime, so figures read with an old key or
 * declaration never survive the change. Presented consumers share one read; hidden pages read nothing.
 */
export function useProviderConnectionUsage(
  input: Readonly<{
    scope: ServerAccountScope | null;
    connectionId: string;
    machineId: string | null;
    /** Declaration and selected-credential facts whose change invalidates what was read. */
    identity: string;
    secretBindings?: SavedSecretSlotBindingsV1;
    active: boolean;
    invoke: Invoke;
  }>,
): ProviderConnectionUsageState {
  const { scope, connectionId, machineId } = input;
  const accountLifetime = captureActiveServerAccountScopeLifetime();
  const { accountScope: { binding }, ready } = useProviderActionClient(scope?.serverId ?? []);
  const invokeRef = React.useRef(input.invoke);
  invokeRef.current = input.invoke;
  const refsKey = JSON.stringify([...new Set(Object.values({ ...input.secretBindings?.account,
    ...(machineId ? input.secretBindings?.byMachineId?.[machineId] : {}) }))].sort());
  const readCredentialIdentity = React.useCallback(() => {
    const refs: string[] = JSON.parse(refsKey);
    if (refs.length > 0 && !getSavedSecretCatalogSnapshot(scope)?.data) return null;
    return JSON.stringify(refs.map(ref => {
      const entry = readSavedSecretCatalogEntry(scope, ref);
      return [ref, entry?.revision ?? null, entry?.materialStatus ?? null, entry?.capabilities.use ?? null];
    }));
  }, [scope?.serverId, scope?.accountId, refsKey]);
  const subscribeCredentials = React.useCallback((listener: () => void) =>
    subscribeSavedSecretCatalogSnapshots(listener, { scope, refs: JSON.parse(refsKey) as string[] }),
  [scope?.serverId, scope?.accountId, refsKey]);
  const credentialIdentity = React.useSyncExternalStore(subscribeCredentials, readCredentialIdentity, readCredentialIdentity);
  React.useEffect(() => scope && input.active && refsKey !== '[]'
    ? observeSavedSecretCatalog(scope, { includeMaterial: false }) : undefined,
  [scope?.serverId, scope?.accountId, input.active, refsKey]);
  const identity =
    scope && machineId && credentialIdentity !== null && binding?.isCurrent() && ready && accountLifetime?.isCurrent()
      && areServerAccountScopesEqual(accountLifetime.scope, scope) && areServerAccountScopesEqual(binding.scope, scope)
      ? JSON.stringify([
          scope.serverId,
          scope.accountId,
          connectionId,
          machineId,
          input.identity,
          credentialIdentity,
          binding.credentialKey,
        ])
      : null;
  const [held, setHeld] = React.useState<Held | null>(null);
  React.useEffect(() => {
    if (!identity || !scope || !machineId || !accountLifetime || !binding) return;
    const acquired = acquireProviderConnectionUsageRefreshResource({
      serverId: scope.serverId,
      accountId: scope.accountId,
      connectionId,
      machineId,
      identity,
      active: false,
      invoke: (request, options) => invokeRef.current(request, options),
      lifetime: {
        isCurrent: () => accountLifetime.isCurrent(),
        onRetire: retire => {
          const account = accountLifetime.onRetire(retire);
          const credential = subscribeHomeCredentialChange(event => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, scope.serverId)) retire();
          });
          return { dispose() { account.dispose(); credential(); } };
        },
      },
    });
    setHeld({ identity, ...acquired });
    return acquired.release;
    // Binding objects retire locally; their counters are not shared authority.
    // Rejoin after renewal even when the actual credential fingerprint is equal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, binding, accountLifetime]);
  const current = held && held.identity === identity ? held : null;
  React.useEffect(() => {
    current?.setActive(input.active);
    return () => current?.setActive(false);
  }, [current, input.active]);
  const snapshot = React.useSyncExternalStore(current?.resource.subscribe ?? noSubscription,
    current?.resource.getSnapshot ?? readEmpty, readEmpty);
  const refresh = React.useCallback(() => {
    if (input.active) void current?.resource.refresh().catch(() => {});
  }, [current, input.active]);
  return {
    ...snapshot,
    refresh: current && input.active ? refresh : null,
  };
}
