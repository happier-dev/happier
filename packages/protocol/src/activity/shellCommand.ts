type UnknownRecord = Record<string, unknown>;

function maybeParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const first = trimmed[0];
  if (first !== '{' && first !== '[' && first !== '"') return value;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string') {
      const nested = parsed.trim();
      if (!nested) return value;
      const nestedFirst = nested[0];
      if (nestedFirst !== '{' && nestedFirst !== '[') return value;
      try {
        return JSON.parse(nested) as unknown;
      } catch {
        return value;
      }
    }
    return parsed;
  } catch {
    return value;
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function extractCommandArrayLike(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    parts.push(item);
  }
  return parts;
}

function unwrapShellWrapper(argv: readonly string[]): string | null {
  if (
    argv.length >= 3 &&
    (argv[0] === 'bash' || argv[0] === '/bin/bash' || argv[0] === 'zsh' || argv[0] === '/bin/zsh') &&
    argv[1] === '-lc' &&
    typeof argv[2] === 'string'
  ) {
    return argv[2];
  }
  return null;
}

function stripLeadingEnvAssignments(input: string): string {
  const parts = input.trim().split(/\s+/);
  let i = 0;
  while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i] ?? '')) {
    i += 1;
  }
  return parts.slice(i).join(' ');
}

function stripLeadingUnsetPrelude(input: string): string {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('unset ')) return input;
  const match = trimmed.match(/^unset(?:\s+[A-Za-z_][A-Za-z0-9_]*)+\s*;\s*/);
  if (!match) return input;
  return trimmed.slice(match[0].length);
}

export function stripShellCommandPreludeForDisplay(command: string): string {
  let out = command.trim();
  for (let i = 0; i < 5; i += 1) {
    const next = stripLeadingUnsetPrelude(stripLeadingEnvAssignments(out)).trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

export function extractShellCommand(input: unknown): string | null {
  const parsed = maybeParseJson(input);

  const rawArgvArray = extractCommandArrayLike(parsed);
  if (rawArgvArray && rawArgvArray.length > 0) {
    return unwrapShellWrapper(rawArgvArray) ?? rawArgvArray.join(' ');
  }

  const obj = asRecord(parsed);
  if (!obj) return null;

  const command = obj.command;
  if (typeof command === 'string' && command.trim()) {
    return command.trim();
  }

  const commandArray = extractCommandArrayLike(command);
  if (commandArray && commandArray.length > 0) {
    return unwrapShellWrapper(commandArray) ?? commandArray.join(' ');
  }

  const cmd = obj.cmd;
  if (typeof cmd === 'string' && cmd.trim()) {
    return cmd.trim();
  }

  const cmdArray = extractCommandArrayLike(cmd);
  if (cmdArray && cmdArray.length > 0) {
    return extractShellCommand({ command: cmdArray });
  }

  const argvArray = extractCommandArrayLike(obj.argv);
  if (argvArray && argvArray.length > 0) {
    return extractShellCommand({ command: argvArray });
  }

  const itemsArray = extractCommandArrayLike(obj.items);
  if (itemsArray && itemsArray.length > 0) {
    return extractShellCommand({ command: itemsArray });
  }

  const toolCall = asRecord(obj.toolCall);
  const rawInput = toolCall ? asRecord(toolCall.rawInput) : null;
  if (rawInput) {
    return extractShellCommand(rawInput);
  }

  return null;
}
