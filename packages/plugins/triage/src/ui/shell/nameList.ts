/**
 * A list of names as a reader says it in their locale ("A, B and C").
 *
 * Not every JavaScript engine the host runs ships `Intl.ListFormat`; a comma
 * list says the same thing there.
 */
export function createTriageNameListFormatter(locale: string | undefined): (names: readonly string[]) => string {
  if (typeof Intl.ListFormat !== 'function') return (names) => names.join(', ');
  const listFormat = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });
  return (names) => listFormat.format(names);
}
