import { isDeepStrictEqual } from 'node:util';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { computeTeamCredentialSourceMemberKeyV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import type { TeamCredentialSourceBindingV1, TeamCredentialSourceMemberV1, TeamCredentialDirectMaterialReconcileOutputV1 } from '@happier-dev/protocol/teams';
import { readCustodianTeamCredentialDirectResources } from '@/session/services/sessionTeamCredentialCatalog';
import type {
  QualifiedConnectedAccountGroupV4,
  QualifiedConnectedAccountProfileV4,
  QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { logger } from '@/utils/logger';
import type { ApiMachineClient } from '@/api/apiMachine';
import {
  createConnectedAccountTeamCredentialSourceSnapshot,
  createConnectedPoolMemberTeamCredentialSourceSnapshot,
  type TeamCredentialSourceSnapshot,
} from '@/providers/broker/teamCredentialSourceSnapshot';
import type { QualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { sameProviderConnectionsDirectMaterial } from '@/providers/lifecycle/currentAccountSettingsSnapshot';
import {
  fetchTeamCredentialDirectMaterialCensus,
  fetchTeamCredentialDirectMaterialPreparation,
  upsertTeamCredentialDirectMaterial,
  withdrawTeamCredentialDirectMaterial,
} from './teamCredentialDirectMaterialHttp';
import { reconcileTeamCredentialDirectMaterial } from './reconcileTeamCredentialDirectMaterial';
import {
  getActiveAccountSettingsSnapshotLifetimeToken,
  subscribeActiveAccountSettingsSnapshotChanges,
  type ActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

// These are the Account facts read by Provider direct-source admission and
// connected-account materialization. Other opened catalogs share the snapshot
// publication cut but do not change credential material.
type DirectMaterialSourcePredicate =
  | 'provider-catalog-authority' | 'connected-configuration-revision' | 'connected-configuration-content'
  | 'saved-secret-resources' | 'saved-secret-state' | 'secrets' | 'read-keys'
  | 'source' | 'scope' | 'account-lifetime';

type DirectMaterialSourceRevisions = Readonly<{
  settings: number | null;
  providerCatalog: number | 'absent' | null;
  connectedConfiguration: number | null;
  accountLifetime: number | null;
}>;

type DirectMaterialSnapshotWake = Readonly<{
  predicates: readonly DirectMaterialSourcePredicate[];
  previousRevisions: DirectMaterialSourceRevisions;
  nextRevisions: DirectMaterialSourceRevisions;
}>;

export type TeamCredentialDirectMaterialSourceWake = DirectMaterialSnapshotWake;

function sourceRevisions(snapshot: ActiveAccountSettingsSnapshot | null, lifetime: number): DirectMaterialSourceRevisions {
  return {
    settings: snapshot?.settingsVersion ?? null,
    providerCatalog: snapshot?.providerConnectionsCatalog?.status === 'ready' ? snapshot.providerConnectionsCatalog.revision : null,
    connectedConfiguration: snapshot?.connectedConfigurationCatalog?.status === 'ready' ? snapshot.connectedConfigurationCatalog.revision : null,
    accountLifetime: snapshot ? lifetime : null,
  };
}

export function subscribeTeamCredentialDirectMaterialSourceChanges(
  listener: (previous: ActiveAccountSettingsSnapshot | null, next: ActiveAccountSettingsSnapshot | null,
    wake: DirectMaterialSnapshotWake) => void,
): () => void {
  let previousLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
  return subscribeActiveAccountSettingsSnapshotChanges((previous, next) => {
    // Catalog producers also publish real source/history cleanup diagnostics.
    // Direct delivery consumes the admitted row, not its maintenance outcome.
    const previousConfiguration = previous?.connectedConfigurationCatalog;
    const nextConfiguration = next?.connectedConfigurationCatalog;
    const sameConfigurationContent = previousConfiguration === nextConfiguration
      || previousConfiguration?.status === 'ready' && nextConfiguration?.status === 'ready'
        && isDeepStrictEqual(previousConfiguration.record, nextConfiguration.record);
    const nextLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
    const previousRevisions = sourceRevisions(previous, previousLifetime);
    const nextRevisions = sourceRevisions(next, nextLifetime);
    previousLifetime = nextLifetime;
    const predicates: DirectMaterialSourcePredicate[] = [];
    if (!sameProviderConnectionsDirectMaterial(previous?.providerConnectionsCatalog, next?.providerConnectionsCatalog)) predicates.push('provider-catalog-authority');
    if (previousRevisions.connectedConfiguration !== nextRevisions.connectedConfiguration) predicates.push('connected-configuration-revision');
    if (!sameConfigurationContent) predicates.push('connected-configuration-content');
    if (previous?.savedSecretResources !== next?.savedSecretResources) predicates.push('saved-secret-resources');
    if (previous?.savedSecretCatalogState !== next?.savedSecretCatalogState) predicates.push('saved-secret-state');
    if (!isDeepStrictEqual(previous?.settings.secrets, next?.settings.secrets)) predicates.push('secrets');
    if (!isDeepStrictEqual(previous?.settingsSecretsReadKeys, next?.settingsSecretsReadKeys)) predicates.push('read-keys');
    if (previous?.source !== next?.source) predicates.push('source');
    if (previous?.scopeKey !== next?.scopeKey) predicates.push('scope');
    if (previousRevisions.accountLifetime !== nextRevisions.accountLifetime) predicates.push('account-lifetime');
    if (predicates.length === 0) return;
    listener(previous, next, { predicates, previousRevisions, nextRevisions });
  });
}

type HomeDomainAction = NonNullable<ActionExecutorDeps['homeDomainAction']>;

export function subscribeTeamCredentialDirectMaterialAccountChanges(
  apiMachine: Pick<ApiMachineClient, 'onManagedProviderRetainedCurrentnessInvalidation'>,
  listener: (wakeReason: TeamCredentialDirectMaterialWakeReason) => void,
): () => void {
  return apiMachine.onManagedProviderRetainedCurrentnessInvalidation(change => {
    // Material authority (including read keys) already publishes through the
    // snapshot. Credential mutations publish the affected Team audience in the
    // same transaction; unrelated services cannot change Team material. Keep
    // service facts for retained authorization, and census only Team changes
    // and completeness recovery here; a live `all` is for retained checks.
    if (change.facts.some(fact => fact === 'teams'
      || fact === 'all' && change.source !== 'changes')) {
      listener(`account-${change.source}`);
    }
  });
}

export type TeamCredentialDirectMaterialWakeReason =
  | 'request' | 'startup' | 'source-snapshot'
  | 'registry-applied' | 'registry-invalidated'
  | 'account-connect' | 'account-reconnect' | 'account-changes'
  | 'account-page-limit' | 'account-cursor-gone';

function connectedMember(account: QualifiedConnectedAccountRef): TeamCredentialSourceMemberV1 {
  return {
    kind: 'connected_account',
    service: account.service,
    connectedAccountId: account.accountId,
  };
}

export function createDaemonTeamCredentialDirectMaterialReconciler(params: Readonly<{
  token: string;
  accountId: string;
  signal?: AbortSignal;
  isAccountChangesObserverCurrent?: () => boolean;
  homeDomainAction: HomeDomainAction;
  establishedRuntimeOwner: Pick<QualifiedConnectedAccountEstablishedRuntimeOwner, 'readMaterialSnapshot'>;
  listAccounts(service: QualifiedConnectedAccountRef['service'], signal: AbortSignal): Promise<Readonly<{
    accounts: readonly QualifiedConnectedAccountProfileV4[];
  }>>;
  readGroup(source: Extract<TeamCredentialSourceBindingV1, { kind: 'connected_pool' }>, signal: AbortSignal): Promise<QualifiedConnectedAccountGroupV4 | null>;
  resolveProviderSource(source: Extract<TeamCredentialSourceBindingV1, { kind: 'provider_connection' }>, signal: AbortSignal): Promise<TeamCredentialSourceSnapshot | null>;
  serverUrl?: string;
}>): Readonly<{
  reconcile(wakeReason?: TeamCredentialDirectMaterialWakeReason,
    sourceWake?: TeamCredentialDirectMaterialSourceWake): Promise<TeamCredentialDirectMaterialReconcileOutputV1>;
}> {
  const resolveConnectedSnapshot = async (
    source: Extract<TeamCredentialSourceBindingV1, { kind: 'connected_account' }>,
    account: QualifiedConnectedAccountRef,
    profiles: readonly QualifiedConnectedAccountProfileV4[],
    signal: AbortSignal,
  ): Promise<TeamCredentialSourceSnapshot | null> => {
    const profile = profiles.find((candidate) => (
      candidate.ref.accountId === account.accountId
      && candidate.ref.service.pluginId === account.service.pluginId
      && candidate.ref.service.localId === account.service.localId
    ));
    if (!profile || profile.status !== 'connected') return null;
    const material = await params.establishedRuntimeOwner.readMaterialSnapshot({ account, signal });
    return createConnectedAccountTeamCredentialSourceSnapshot({
      source,
      material,
      authenticationKind: 'manual',
      // The Home rechecks the pinned credential incarnation on both census and
      // upsert. The local snapshot owner independently fences all mutable
      // credential/configuration/contribution facts.
      isPersistedSourceCurrent: () => true,
    });
  };

  return Object.freeze({
    async reconcile(wakeReason = 'request', sourceWake) {
      const signal = params.signal;
      const observerCurrent = params.isAccountChangesObserverCurrent?.() === true;
      const readsIssued = { teamPages: 0, resourcePages: 0, qualifiedAccountLists: 0,
        qualifiedGroupReads: 0, preparationPages: 0, censusPages: 0 };
      const accountsByService = new Map<string, Promise<Readonly<{
        accounts: readonly QualifiedConnectedAccountProfileV4[];
      }>>>();
      const readGroup: typeof params.readGroup = (source, currentSignal) => {
        readsIssued.qualifiedGroupReads++;
        return params.readGroup(source, currentSignal);
      };
      try {
        const resources = await readCustodianTeamCredentialDirectResources({
          homeDomainAction: request => {
            readsIssued.resourcePages++;
            return params.homeDomainAction(request);
          },
          ...(signal ? { signal } : {}),
        });
        let prepared = 0;
        const failures: TeamCredentialDirectMaterialReconcileOutputV1['failures'][number][] = [];
        // The service inventory is one read for this pass, even when resources,
        // pool members or preparation pages share it. Material and its currentness
        // remain fresh per preparation; no inventory survives into the next pass.
        const listAccounts = (service: QualifiedConnectedAccountRef['service'], currentSignal: AbortSignal) => {
          const key = buildQualifiedPluginContributionKey(service);
          let listed = accountsByService.get(key);
          if (!listed) {
            readsIssued.qualifiedAccountLists++;
            listed = params.listAccounts(service, currentSignal);
            accountsByService.set(key, listed);
          }
          return listed;
        };
        for (const resource of resources) {
          signal?.throwIfAborted();
          const source = resource.source!;
          let members: readonly TeamCredentialSourceMemberV1[];
          if (source.kind === 'connected_account') {
            members = [connectedMember(source.target.account)];
          } else if (source.kind === 'connected_pool') {
            const group = await readGroup(source, signal ?? new AbortController().signal);
            if (!group || group.incarnation !== source.poolIncarnation) continue;
            members = group.members.filter((member) => member.enabled).map((member) => connectedMember({
              service: source.target.service,
              accountId: member.connectedAccountId,
            }));
          } else {
            members = [{
              kind: 'provider_credential_slot',
              connectionId: source.connectionId,
              credentialSlotId: source.credentialSlotId,
            }];
          }
          for (const member of members) {
            const sourceMemberKey = computeTeamCredentialSourceMemberKeyV1(member);
            const result = await reconcileTeamCredentialDirectMaterial({
              teamId: resource.teamId,
              resourceId: resource.id,
              sourceMemberKey,
              fetchPreparation: (request) => {
                readsIssued.preparationPages++;
                return fetchTeamCredentialDirectMaterialPreparation({
                  token: params.token,
                  ...(params.serverUrl ? { serverUrl: params.serverUrl } : {}),
                  ...request,
                });
              },
              resolveSourceSnapshot: async ({
                source: currentSource,
                sourceMember,
                sourceCredentialIncarnation,
                signal: currentSignal,
              }) => {
                const effectiveSignal = currentSignal ?? new AbortController().signal;
                if (currentSource.kind === 'connected_account' && sourceMember.kind === 'connected_account') {
                  const account = currentSource.target.account;
                  const listed = await listAccounts(account.service, effectiveSignal);
                  return await resolveConnectedSnapshot(currentSource, account, listed.accounts, effectiveSignal);
                }
                if (currentSource.kind === 'provider_connection' && sourceMember.kind === 'provider_credential_slot') {
                  return await params.resolveProviderSource(currentSource, effectiveSignal);
                }
                if (currentSource.kind !== 'connected_pool' || sourceMember.kind !== 'connected_account') return null;
                const group = await readGroup(currentSource, effectiveSignal);
                const groupMember = group?.members.find((candidate) => (
                  candidate.connectedAccountId === sourceMember.connectedAccountId && candidate.enabled
                ));
                if (
                  !group
                  || group.incarnation !== currentSource.poolIncarnation
                  || !groupMember
                  || !sourceCredentialIncarnation
                ) return null;
                const account = { service: currentSource.target.service, accountId: sourceMember.connectedAccountId };
                const listed = await listAccounts(account.service, effectiveSignal);
                const profile = listed.accounts.find((candidate) => candidate.ref.accountId === account.accountId);
                if (!profile || profile.status !== 'connected') return null;
                const material = await params.establishedRuntimeOwner.readMaterialSnapshot({ account, signal: effectiveSignal });
                return createConnectedPoolMemberTeamCredentialSourceSnapshot({
                  source: currentSource,
                  sourceAccount: account,
                  sourceCredentialIncarnation,
                  memberEnabled: true,
                  material,
                  authenticationKind: 'manual',
                  isPersistedSourceCurrent: async () => {
                    const currentGroup = await readGroup(currentSource, effectiveSignal);
                    return currentGroup?.incarnation === currentSource.poolIncarnation
                      && currentGroup.members.some((candidate) => (
                        candidate.connectedAccountId === sourceMember.connectedAccountId && candidate.enabled
                      ));
                  },
                });
              },
              upsert: async (item) => {
                const response = await upsertTeamCredentialDirectMaterial({
                  token: params.token,
                  teamId: resource.teamId,
                  resourceId: resource.id,
                  body: { items: [item] },
                  ...(params.serverUrl ? { serverUrl: params.serverUrl } : {}),
                  ...(signal ? { signal } : {}),
                });
                const result = response.results[0];
                return result?.status === 'stored'
                  ? { ok: true as const }
                  : { ok: false as const, reason: result?.reason ?? 'source_changed' };
              },
              withdrawPublication: async (body) => {
                await withdrawTeamCredentialDirectMaterial({
                  token: params.token,
                  teamId: resource.teamId,
                  resourceId: resource.id,
                  body,
                  ...(params.serverUrl ? { serverUrl: params.serverUrl } : {}),
                  ...(signal ? { signal } : {}),
                });
                return { ok: true };
              },
              ...(signal ? { signal } : {}),
            });
            prepared += result.prepared;
            if (!result.ok) failures.push({ sourceMemberKey, reason: result.reason });
          }
        }
        let remaining = 0;
        for (const resource of resources) {
          let cursor: string | undefined;
          do {
            readsIssued.censusPages++;
            const page = await fetchTeamCredentialDirectMaterialCensus({
              token: params.token,
              teamId: resource.teamId,
              resourceId: resource.id,
              ...(cursor ? { cursor } : {}),
              ...(params.serverUrl ? { serverUrl: params.serverUrl } : {}),
              ...(signal ? { signal } : {}),
            });
            remaining += page.recipients.filter((recipient) => recipient.readiness !== 'ready').length;
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
        }
        return { prepared, remaining, failures };
      } finally {
        // One payload-free join per pass, including failed/cancelled passes.
        // Counts cover this owner's read boundaries, not nested material reads.
        logger.debug('[DAEMON RUN] Team credential direct-material pass', {
          wakeReason, observerCurrent, selectedServiceCount: accountsByService.size, readsIssued,
          ...(sourceWake ?? {}),
          ...(wakeReason.startsWith('account-') ? { accountInvalidationReason: wakeReason.slice('account-'.length) } : {}),
        });
      }
    },
  });
}
