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

/**
 * Row or list. A phone (a narrow column) always lists; otherwise the decisions share one line only when their
 * measured natural width fits the column. The row puts the primary at its end edge only when the primary is
 * the agent's first approval: otherwise it lists, since the agent's order is never rearranged. Before both
 * widths are known the row is the first paint, like every other page row.
 */
export function resolveOfferedChoiceLayout(
  input: Readonly<{
    narrow: boolean;
    primaryLeadsApprovals: boolean;
    rowNaturalWidthPx: number | null;
    containerWidthPx: number | null;
  }>,
): 'row' | 'list' {
  if (input.narrow || !input.primaryLeadsApprovals) return 'list';
  if (input.rowNaturalWidthPx === null || input.containerWidthPx === null)
    return 'row';
  return input.rowNaturalWidthPx > input.containerWidthPx ? 'list' : 'row';
}

/**
 * The row reads inward from its end edge in the agent's order (the first approval sits at the end edge), with
 * refusals at the start. The list keeps the agent's order exactly; refusals that all come after the approvals
 * sit after a hairline.
 */
export function arrangeOfferedChoices(
  choices: readonly OfferedPermissionChoice[],
): Readonly<{
  rowStart: readonly OfferedPermissionChoice[];
  rowEnd: readonly OfferedPermissionChoice[];
  refusalsTrail: boolean;
}> {
  const refusals = choices.filter(isRefusingPermissionChoice);
  const approvals = choices.filter(
    (choice) => !isRefusingPermissionChoice(choice),
  );
  const firstRefusal = choices.findIndex(isRefusingPermissionChoice);
  const refusalsTrail =
    refusals.length > 0 &&
    approvals.length > 0 &&
    choices.slice(firstRefusal).every(isRefusingPermissionChoice);
  return {
    rowStart: refusals,
    rowEnd: [...approvals].reverse(),
    refusalsTrail,
  };
}
