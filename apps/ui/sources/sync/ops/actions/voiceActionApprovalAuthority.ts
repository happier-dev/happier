import type { ActionRequiredAuthority } from '@happier-dev/protocol/actions/metadata';

/** A live Voice Run can speak for the person only within its admitted ceiling. */
export function mayVoiceApproveBySpokenConsent(
  currentlyAllowed: boolean,
  admittedAuthority: ActionRequiredAuthority | undefined,
): boolean {
  return currentlyAllowed && admittedAuthority === 'present_user';
}
