/** Decode literal POSIX shell words; refuse expansions and outer shell operations. */
export function tokenizeShellWords(command: string, options?: Readonly<{ allowQuotedNewlines?: boolean }>): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let inSingle = false;
  let inDouble = false;

  for (let index = 0; index < command.length; index++) {
    const ch = command[index] ?? '';
    const next = command[index + 1] ?? '';

    if (ch === '\0' || ((ch === '\n' || ch === '\r')
      && (!options?.allowQuotedNewlines || (!inSingle && !inDouble)))) return null;

    if (ch === '\\' && !inSingle) {
      if (!next || next === '\n' || next === '\r') return null;
      // Inside double quotes, backslash only escapes $, `, ", and backslash.
      if (!inDouble || next === '$' || next === '`' || next === '"' || next === '\\') {
        current += next;
        index++;
      } else {
        current += ch;
      }
      started = true;
      continue;
    }

    if (ch === '\'' && !inDouble) {
      inSingle = !inSingle;
      started = true;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      started = true;
      continue;
    }

    if (!inSingle && (ch === '`' || ch === '$')) return null;
    if (!inSingle && !inDouble) {
      if (';&|<>(){}*?[]~#'.includes(ch)) return null;
      if (ch === ' ' || ch === '\t') {
        if (started) tokens.push(current);
        current = '';
        started = false;
        continue;
      }
    }

    current += ch;
    started = true;
  }

  if (inSingle || inDouble) return null;
  if (started) tokens.push(current);
  return tokens;
}
