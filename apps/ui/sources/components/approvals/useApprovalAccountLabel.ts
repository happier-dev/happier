import type { TranscriptAccountActor } from '@happier-dev/session-core/messages';

import { useKnownAccountActor } from '@/components/account/useKnownAccountActor';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import { t } from '@/text';

/** One Account named as this viewer may see it: You, a known name, or null. Never guessed. */
export function useApprovalAccountLabel(
  serverId: string | null,
  accountId: string | undefined,
  /** The viewer named inside a sentence ("confirmed by you") instead of as a row value ("You"). */
  form: 'value' | 'sentence' = 'value',
  /** The resource owner's relationship-qualified actor wins over an unrelated profile-cache miss. */
  resourceAccountActor?: TranscriptAccountActor | null,
): string | null {
  const { viewerScope, actor } = useKnownAccountActor(serverId, accountId);
  if (!accountId) return null;
  if (viewerScope?.accountId === accountId) {
    return form === 'sentence' ? t('session.collaboration.discussion.attribution.you') : t('message.accountActorYou');
  }
  const resourceActor = resourceAccountActor?.accountId === accountId
    ? resourceAccountActor
    : null;
  const effectiveActor = resourceActor
    ? { ...resourceActor, profile: resourceActor.profile ?? actor?.profile ?? null }
    : actor;
  return effectiveActor
    ? resolveAccountActorPresentation(effectiveActor, viewerScope).name
    : null;
}
