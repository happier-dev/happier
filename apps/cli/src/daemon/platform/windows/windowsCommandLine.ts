function requiresWindowsCommandLineQuoting(value: string): boolean {
  return value.length === 0 || /[\s"]/u.test(value);
}

export function quoteWindowsCommandLineArgument(value: string): string {
  if (!requiresWindowsCommandLineQuoting(value)) return value;

  let quoted = '"';
  let pendingBackslashes = 0;
  for (const character of value) {
    if (character === '\\') {
      pendingBackslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += '\\'.repeat(pendingBackslashes * 2 + 1);
      quoted += '"';
      pendingBackslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(pendingBackslashes);
    quoted += character;
    pendingBackslashes = 0;
  }
  quoted += '\\'.repeat(pendingBackslashes * 2);
  return `${quoted}"`;
}

export function serializeWindowsCommandLine(
  argv: readonly string[],
): string {
  return argv.map(quoteWindowsCommandLineArgument).join(' ');
}

export function parseWindowsCommandLine(
  commandLine: string,
): string[] {
  const argv: string[] = [];
  let cursor = 0;

  while (cursor < commandLine.length) {
    while (
      cursor < commandLine.length
      && (commandLine[cursor] === ' ' || commandLine[cursor] === '\t')
    ) {
      cursor += 1;
    }
    if (cursor >= commandLine.length) break;

    let value = '';
    let quoted = false;
    let started = false;
    while (cursor < commandLine.length) {
      const character = commandLine[cursor];
      if (!quoted && (character === ' ' || character === '\t')) break;

      if (character === '\\') {
        let backslashes = 0;
        while (
          cursor < commandLine.length
          && commandLine[cursor] === '\\'
        ) {
          backslashes += 1;
          cursor += 1;
        }
        if (
          cursor < commandLine.length
          && commandLine[cursor] === '"'
        ) {
          value += '\\'.repeat(Math.floor(backslashes / 2));
          if (backslashes % 2 === 1) {
            value += '"';
            cursor += 1;
          } else {
            quoted = !quoted;
            cursor += 1;
          }
        } else {
          value += '\\'.repeat(backslashes);
        }
        started = true;
        continue;
      }

      if (character === '"') {
        quoted = !quoted;
        cursor += 1;
        started = true;
        continue;
      }

      value += character;
      cursor += 1;
      started = true;
    }

    if (started) argv.push(value);
  }

  return argv;
}
