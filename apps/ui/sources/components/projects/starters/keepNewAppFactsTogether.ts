// Each fact is a wrapping unit. The middle-dot separators remain break opportunities.
export function keepNewAppFactsTogether(line: string): string {
  return line.split(' · ').map((fact) =>
    fact.replace(/ /g, '\u00a0').replace(/-/g, '\u2011').replace(/\//g, '\u2060/\u2060'),
  ).join(' · ');
}
