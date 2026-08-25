export function tokenizeObservedProcessCommand(command: string): readonly string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const character of command) {
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? null : character;
      continue;
    }
    if (!quote && /\s/u.test(character)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }

  if (current) tokens.push(current);
  return tokens;
}

export function resolveObservedProcessExecutablePath(command: string): string | null {
  return tokenizeObservedProcessCommand(command)[0] ?? null;
}
