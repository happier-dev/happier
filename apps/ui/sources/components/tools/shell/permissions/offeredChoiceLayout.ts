import type { SessionPermissionChoice } from '@/sync/ops/sessionPermissionChoices';

/** An offered native choice as the shared resolver projects it: the producer's decision and scope travel with it. */
export type OfferedPermissionChoice = SessionPermissionChoice &
  Required<Pick<SessionPermissionChoice, 'decision' | 'scope'>>;

export function isOfferedPermissionChoice(
  choice: SessionPermissionChoice,
): choice is OfferedPermissionChoice {
  return choice.decision !== undefined && choice.scope !== undefined;
}

export function isOfferedPermissionChoiceAvailable(
  choice: OfferedPermissionChoice,
): boolean {
  return choice.availability?.allowed !== false;
}
