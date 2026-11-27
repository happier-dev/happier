import type { ActionActorV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { presentSharePrincipal, sharePrincipalKey } from '@/components/sharing/sharePrincipalPresentation';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

export function reviewRequesterPrincipal(actor: ActionActorV1 | undefined, serverId: string | null | undefined) {
  const accountId = actor?.actorKind === 'person' ? actor.accountId
    : actor?.onBehalfOf && areServerProfileIdentifiersEquivalent(actor.onBehalfOf.serverId, serverId)
      ? actor.onBehalfOf.accountId : null;
  return accountId ? { kind: 'account' as const, accountId } : null;
}

export function formatReviewRequesterByline(
  principal: ReturnType<typeof reviewRequesterPrincipal>,
  names: ReadonlyMap<string, string> | null | undefined,
  viewerAccountId: string | null | undefined,
): string | null {
  if (!principal) return null;
  const name = presentSharePrincipal({
    ref: principal,
    name: names?.get(sharePrincipalKey(principal)) ?? null,
    viewerAccountId: viewerAccountId ?? null,
  }).displayName;
  return `${t('detailPages.approval.contextTitle')} ${name}`;
}
