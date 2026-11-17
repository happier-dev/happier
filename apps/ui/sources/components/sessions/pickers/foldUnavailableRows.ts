/**
 * A session picker's one "Unavailable (n)" group (Runs through, the model popover): every row its owner marks
 * unusable leaves its section for one trailing section, in the order it appeared, so what can run reads first.
 * Sections left empty go. Rows keep their own actions (sign in, recovery); `present` may restate a row for the
 * group, where its old section heading no longer names its source.
 *
 * With `reason`, rows that share one reason ("Broker offline") get their own trailing group headed by that reason,
 * said once; `present` is told the reason is shared so the row can leave it out. A reason only one row has stays
 * on that row, in the counted "Unavailable (n)" group. A reason that is the group's own title says nothing more: those
 * rows join the counted group and `present` is told their reason is already said.
 */
export function foldUnavailableRows<
  O,
  S extends Readonly<{ options: ReadonlyArray<O> }>,
>(
  input: Readonly<{
    sections: readonly S[];
    isUnavailable: (option: O) => boolean;
    /** Builds a trailing section from its rows and its "Unavailable (n)" or "{reason} (n)" title. */
    group: (options: readonly O[], title: string, reason: string | null) => S;
    title: string;
    /** The short reason a row can't be used, compared across rows to say a shared one once. */
    reason?: (option: O) => string | null | undefined;
    present?: (option: O, section: S, sharedReason: boolean) => O;
  }>,
): S[] {
  const removed: Array<Readonly<{ option: O; section: S; reason: string | null; restatesTitle: boolean }>> = [];
  const usable = input.sections.flatMap((section): S[] => {
    const kept = section.options.filter((option) => {
      if (!input.isUnavailable(option)) return true;
      // A "reason" that is only the group's own word ("Unavailable") adds nothing: the heading says it.
      const reason = input.reason?.(option)?.trim() || null;
      removed.push({ option, section, reason: reason === input.title ? null : reason, restatesTitle: reason === input.title });
      return false;
    });
    if (kept.length === section.options.length) return [section];
    return kept.length > 0 ? [{ ...section, options: kept }] : [];
  });
  if (removed.length === 0) return usable;
  const counts = new Map<string, number>();
  for (const row of removed) if (row.reason) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
  const shared = new Map<string, O[]>();
  const rest: O[] = [];
  for (const row of removed) {
    const isShared = row.reason !== null && (counts.get(row.reason) ?? 0) > 1;
    const presented = input.present ? input.present(row.option, row.section, isShared || row.restatesTitle) : row.option;
    if (isShared) {
      const rows = shared.get(row.reason!) ?? [];
      rows.push(presented);
      shared.set(row.reason!, rows);
    } else rest.push(presented);
  }
  return [
    ...usable,
    ...[...shared].map(([reason, rows]) => input.group(rows, `${reason} (${rows.length})`, reason)),
    ...(rest.length > 0 ? [input.group(rest, `${input.title} (${rest.length})`, null)] : []),
  ];
}
