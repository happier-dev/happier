import type { DeploymentActivityItemV1 } from '@happier-dev/deployments';
import type { ActionActorV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';

import type { useDiscussionParticipantProfiles } from '@/components/discussions/useDiscussionParticipantProfiles';
import {
  deploymentActorLabel,
  deploymentReceiptTitle,
} from '@/components/projects/deployments/deploymentPresentation';
import type { DeploymentActorPresentation } from '@/components/projects/deployments/useDeploymentActorPresentations';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

/** Who a row names: null when the record captured no actor, or while its name is still being read. Never guessed. */
export type ActivityActorView = Readonly<{
  kind: 'person' | 'agent' | 'workflow' | null;
  name: string | null;
  avatar: ReturnType<typeof resolveAccountActorPresentation>['avatar'] | null;
}>;

/** The captured actor of a deploy receipt or an Action; null when the historical record has none. */
export function activityItemActor(
  item: DeploymentActivityItemV1,
): ActionActorV1 | null {
  return (
    (item.kind === 'receipt' ? item.receipt.actor : item.operation.actor) ??
    null
  );
}

/**
 * A row's actor through the one actor display owner (useDeploymentActorPresentations + deploymentActorLabel, owner
 * ruling 11-15 05:14Z). An unknown actor stays unknown: the row says what happened without naming anyone, never
 * "another person".
 */
export function activityActorView(
  actor: ActionActorV1 | null,
  presentation: DeploymentActorPresentation | undefined,
  lifetime: ServerAccountScopeLifetime | null,
  accounts: ReturnType<typeof useDiscussionParticipantProfiles>['accounts'],
): ActivityActorView {
  const name =
    presentation && lifetime
      ? deploymentActorLabel(presentation, actor, lifetime.scope.accountId)
      : null;
  if (!actor || !presentation?.actorKind)
    return { kind: null, name: null, avatar: null };
  if (actor.actorKind !== 'person')
    return { kind: actor.actorKind, name, avatar: null };
  const profile = accounts.get(actor.accountId);
  const avatar =
    profile && lifetime
      ? resolveAccountActorPresentation(profile, lifetime.scope).avatar
      : null;
  return {
    kind: 'person',
    name,
    avatar: avatar ?? { id: actor.accountId, imageUrl: null },
  };
}

/** What happened, said without an actor: the receipt's own title and its Environment, or the Action's title. */
export function activityHeadingWithoutActor(
  row:
    | Readonly<{
        kind: 'receipt';
        receipt: Parameters<typeof deploymentReceiptTitle>[0];
        revision: string | null;
        environmentTitle: string;
      }>
    | Readonly<{ kind: 'operation'; title: string }>,
): string {
  if (row.kind === 'operation') return row.title;
  const toward = t(
    row.receipt.operation === 'teardown'
      ? 'machineFleetActivity.from'
      : 'machineFleetActivity.to',
  );
  return `${deploymentReceiptTitle(row.receipt, row.revision)} ${toward} ${row.environmentTitle}`;
}
