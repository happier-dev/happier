import { isRefusingPermissionChoice, type SessionPermissionChoice } from '@/sync/ops/sessionPermissionChoices';

/** An offered native choice as the shared resolver projects it: the producer's decision and scope travel with it. */
export type OfferedPermissionChoice = SessionPermissionChoice &
  Required<Pick<SessionPermissionChoice, 'decision' | 'scope'>>;

const SCOPE_BREADTH: Readonly<
  Record<OfferedPermissionChoice['scope'], number>
> = { once: 0, session: 1, localPersistent: 2 };

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

/**
 * The one primary: the narrowest-scope allow the viewer can choose (once before session before always).
 * Ties keep the agent's order. A refusal is never primary.
 */
export function selectPrimaryOfferedChoice(
  choices: readonly OfferedPermissionChoice[],
): string | null {
  let primary: OfferedPermissionChoice | null = null;
  for (const choice of choices) {
    if (
      isRefusingPermissionChoice(choice) ||
      !isOfferedPermissionChoiceAvailable(choice)
    )
      continue;
    if (
      primary === null ||
      SCOPE_BREADTH[choice.scope] < SCOPE_BREADTH[primary.scope]
    )
      primary = choice;
  }
  return primary?.id ?? null;
}
