/** Presentation facts; decision meaning, scope and eligibility are resolved by the caller. */
export type OfferedChoice = Readonly<{
  id: string;
  label: string;
  refusal: boolean;
  available: boolean;
  description?: string | null;
  allowsFeedback?: boolean;
}>;

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
  choices: readonly OfferedChoice[],
): Readonly<{
  rowStart: readonly OfferedChoice[];
  rowEnd: readonly OfferedChoice[];
  refusalsTrail: boolean;
}> {
  const refusals = choices.filter(choice => choice.refusal);
  const approvals = choices.filter(
    (choice) => !choice.refusal,
  );
  const firstRefusal = choices.findIndex(choice => choice.refusal);
  const refusalsTrail =
    refusals.length > 0 &&
    approvals.length > 0 &&
    choices.slice(firstRefusal).every(choice => choice.refusal);
  return {
    rowStart: refusals,
    rowEnd: [...approvals].reverse(),
    refusalsTrail,
  };
}
