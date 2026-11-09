import { PublicProfileMutationResultV1Schema, type PublicProfileOwnerRecordV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { PublicProfilePreparationUnavailableReasonV1Schema } from '@happier-dev/protocol/account/publicProfileIntents';

import { t } from '@/text';

export type PublicProfileOperation =
  | 'refresh'
  | 'pause'
  | 'resume'
  | 'unpublish'
  | 'update';

/**
 * One line for an acknowledged answer that did not do what was asked: the typed reason, never a code.
 * A completed change says nothing; the acknowledged edition shows it.
 */
export function publicProfileMutationNotice(result: unknown): string | null {
  return settlePublicProfileMutation(result);
}

/** Settle a confirmed write through the existing read owner, without another invalidation. */
export function settlePublicProfileMutation(result: unknown,
  onAcknowledged?: (record: PublicProfileOwnerRecordV1 | null) => void): string | null {
  // Settled host outcomes may also carry credential-use annotations; read the
  // failure cause without reparsing them as a strict public wire envelope.
  if (result !== null && typeof result === 'object' && 'ok' in result && result.ok === false) {
    const details = 'details' in result ? result.details : null;
    const reason = 'errorCode' in result && result.errorCode === 'public_profile_preparation_unavailable'
      && details !== null && typeof details === 'object' && 'reason' in details
      ? PublicProfilePreparationUnavailableReasonV1Schema.safeParse(details.reason) : null;
    return reason?.success ? t(`publicIdentity.profile.reasons.${reason.data}`) : t('publicIdentity.profile.actionFailed');
  }
  const mutation = PublicProfileMutationResultV1Schema.safeParse(result);
  if (!mutation.success) return t('publicIdentity.profile.actionFailed');
  if (mutation.data.kind === 'unavailable') return t(`publicIdentity.profile.reasons.${mutation.data.reason}`);
  onAcknowledged?.(mutation.data.record);
  return null;
}
