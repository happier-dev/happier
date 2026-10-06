import { computeTeamCredentialSourceMemberKeyV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { TeamCredentialResourcePageV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import type { TeamCredentialResourceSummaryV1, TeamCredentialSourceBindingV1, TeamCredentialSourceMemberV1, TeamCredentialDirectMaterialCensusInputV1, TeamCredentialDirectMaterialCensusOutputV1, TeamCredentialDirectMaterialReconcileInputV1, TeamCredentialDirectMaterialReconcileOutputV1 } from '@happier-dev/protocol/teams';
import { TeamsPageV1Schema } from '@happier-dev/protocol/teams/projections';
import type {
  QualifiedConnectedAccountGroupV4,
  QualifiedConnectedAccountProfileV4,
  QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import type { ActionExecutorDeps } from '@happier-dev/protocol';
import {
  createConnectedAccountTeamCredentialSourceSnapshot,
  createConnectedPoolMemberTeamCredentialSourceSnapshot,
  type TeamCredentialSourceSnapshot,
} from '@/providers/broker/teamCredentialSourceSnapshot';
import type { QualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import {
  fetchTeamCredentialDirectMaterialCensus,
  fetchTeamCredentialDirectMaterialPreparation,
  upsertTeamCredentialDirectMaterial,
  withdrawTeamCredentialDirectMaterial,
} from './teamCredentialDirectMaterialHttp';
import { reconcileTeamCredentialDirectMaterial } from './reconcileTeamCredentialDirectMaterial';

type HomeDomainAction = NonNullable<ActionExecutorDeps['homeDomainAction']>;

function isActionFailure(value: unknown): value is Readonly<{ ok: false }> {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
}

async function listOwnedResources(input: Readonly<{
  accountId: string;
  homeDomainAction: HomeDomainAction;
  signal?: AbortSignal;
}>): Promise<readonly TeamCredentialResourceSummaryV1[]> {
  const resources: TeamCredentialResourceSummaryV1[] = [];
  let cursor: string | null = null;
  do {
    const page = await input.homeDomainAction({
      actionId: 'teams.list',
      input: { v: 1, scope: 'member', archived: 'active', limit: 100, cursor },
      context: { surface: 'cli' },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (isActionFailure(page)) return resources;
    const parsedPage = TeamsPageV1Schema.safeParse(page);
    if (!parsedPage.success) return resources;
    for (const team of parsedPage.data.items) {
      // The administration list is paginated and carries no custodian filter,
      // so every page is drained before the owned direct rows are selected.
      let resourceCursor: string | undefined;
      do {
        const listed = await input.homeDomainAction({
          actionId: 'teams.credentials.list',
          input: { teamId: team.id, ...(resourceCursor ? { cursor: resourceCursor } : {}) },
          context: { surface: 'cli' },
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (isActionFailure(listed)) break;
        const parsedListed = TeamCredentialResourcePageV1Schema.safeParse(listed);
        if (!parsedListed.success) break;
        resources.push(...parsedListed.data.resources.filter((resource) => (
          resource.custodianAccountId === input.accountId
          && resource.enabled
          && resource.disclosureCeiling === 'direct_allowed'
          && resource.source !== null
        )));
        resourceCursor = parsedListed.data.nextCursor ?? undefined;
      } while (resourceCursor);
    }
    cursor = parsedPage.data.nextCursor;
  } while (cursor);
  return resources;
}

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
  homeDomainAction: HomeDomainAction;
  establishedRuntimeOwner: Pick<QualifiedConnectedAccountEstablishedRuntimeOwner, 'readMaterialSnapshot'>;
  listAccounts(service: QualifiedConnectedAccountRef['service'], signal: AbortSignal): Promise<Readonly<{
    accounts: readonly QualifiedConnectedAccountProfileV4[];
  }>>;
  readGroup(source: Extract<TeamCredentialSourceBindingV1, { kind: 'connected_pool' }>, signal: AbortSignal): Promise<QualifiedConnectedAccountGroupV4 | null>;
  resolveProviderSource(source: Extract<TeamCredentialSourceBindingV1, { kind: 'provider_connection' }>, signal: AbortSignal): Promise<TeamCredentialSourceSnapshot | null>;
  serverUrl?: string;
}>): Readonly<{
  census(input: TeamCredentialDirectMaterialCensusInputV1, signal?: AbortSignal): Promise<TeamCredentialDirectMaterialCensusOutputV1>;
  reconcile(input?: TeamCredentialDirectMaterialReconcileInputV1, signal?: AbortSignal): Promise<TeamCredentialDirectMaterialReconcileOutputV1>;
}> {
  const resolveConnectedSnapshot = async (
    source: Extract<TeamCredentialSourceBindingV1, { kind: 'connected_account' }>,
    account: QualifiedConnectedAccountRef,
    signal: AbortSignal,
  ): Promise<TeamCredentialSourceSnapshot | null> => {
    const listed = await params.listAccounts(account.service, signal);
    const profile = listed.accounts.find((candidate) => (
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
    async census(input, signal) {
      return await fetchTeamCredentialDirectMaterialCensus({
        token: params.token,
        teamId: input.teamId,
        resourceId: input.resourceId,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(params.serverUrl ? { serverUrl: params.serverUrl } : {}),
        ...(signal ? { signal } : {}),
      });
    },
    async reconcile(target, signal) {
      const resources = await listOwnedResources({
        accountId: params.accountId,
        homeDomainAction: params.homeDomainAction,
        ...(signal ? { signal } : {}),
      }).then((listed) => target
        ? listed.filter((resource) => resource.teamId === target.teamId && resource.id === target.resourceId)
        : listed);
      let prepared = 0;
      const failures: TeamCredentialDirectMaterialReconcileOutputV1['failures'][number][] = [];
      for (const resource of resources) {
        signal?.throwIfAborted();
        const source = resource.source!;
        let members: readonly TeamCredentialSourceMemberV1[];
        if (source.kind === 'connected_account') {
          members = [connectedMember(source.target.account)];
        } else if (source.kind === 'connected_pool') {
          const group = await params.readGroup(source, signal ?? new AbortController().signal);
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
            fetchPreparation: (request) => fetchTeamCredentialDirectMaterialPreparation({
              token: params.token,
              ...(params.serverUrl ? { serverUrl: params.serverUrl } : {}),
              ...request,
            }),
            resolveSourceSnapshot: async ({
              source: currentSource,
              sourceMember,
              sourceCredentialIncarnation,
              signal: currentSignal,
            }) => {
              const effectiveSignal = currentSignal ?? new AbortController().signal;
              if (currentSource.kind === 'connected_account' && sourceMember.kind === 'connected_account') {
                return await resolveConnectedSnapshot(currentSource, currentSource.target.account, effectiveSignal);
              }
              if (currentSource.kind === 'provider_connection' && sourceMember.kind === 'provider_credential_slot') {
                return await params.resolveProviderSource(currentSource, effectiveSignal);
              }
              if (currentSource.kind !== 'connected_pool' || sourceMember.kind !== 'connected_account') return null;
              const group = await params.readGroup(currentSource, effectiveSignal);
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
              const listed = await params.listAccounts(account.service, effectiveSignal);
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
                  const currentGroup = await params.readGroup(currentSource, effectiveSignal);
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
    },
  });
}
