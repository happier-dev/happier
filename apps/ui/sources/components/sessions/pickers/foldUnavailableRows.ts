/**
 * A session picker's one "Unavailable (n)" group (Runs through, the model popover): every row its owner marks
 * unusable leaves its section for one trailing section, in the order it appeared, so what can run reads first.
 * Sections left empty go. Rows keep their own actions (sign in, recovery); `present` may restate a row for the
 * group, where its old section heading no longer names its source.
 */
export function foldUnavailableRows<
  O,
  S extends Readonly<{ options: ReadonlyArray<O> }>,
>(
  input: Readonly<{
    sections: readonly S[];
    isUnavailable: (option: O) => boolean;
    /** Builds the trailing section from its rows and its "Unavailable (n)" title. */
    group: (options: readonly O[], title: string) => S;
    title: string;
    present?: (option: O, section: S) => O;
  }>,
): S[] {
  const unavailable: O[] = [];
  const usable = input.sections.flatMap((section): S[] => {
    const kept = section.options.filter((option) => {
      if (!input.isUnavailable(option)) return true;
      unavailable.push(input.present ? input.present(option, section) : option);
      return false;
    });
    if (kept.length === section.options.length) return [section];
    return kept.length > 0 ? [{ ...section, options: kept }] : [];
  });
  return unavailable.length === 0
    ? usable
    : [
        ...usable,
        input.group(unavailable, `${input.title} (${unavailable.length})`),
      ];
}
