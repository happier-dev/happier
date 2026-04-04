import { extractShellCommand } from '@happier-dev/protocol';
import { isShellCommandAllowed } from './shellCommandAllowlist';

export { extractShellCommand } from '@happier-dev/protocol';

const SHELL_TOOL_NAMES = new Set(['bash', 'execute', 'shell']);

function isShellToolName(name: string): boolean {
  return SHELL_TOOL_NAMES.has(name.toLowerCase());
}

function parseParenIdentifier(value: string): { name: string; spec: string } | null {
  const match = value.match(/^([^(]+)\((.*)\)$/);
  if (!match) return null;
  return { name: match[1], spec: match[2] };
}

export function makeToolIdentifier(toolName: string, input: unknown): string {
  const command = extractShellCommand(input);
  if (command && isShellToolName(toolName)) {
    return `${toolName}(${command})`;
  }
  return toolName;
}

export function isToolAllowedForSession(
  allowedIdentifiers: Iterable<string>,
  toolName: string,
  input: unknown
): boolean {
  const command = extractShellCommand(input);
  const isShell = isShellToolName(toolName);
  const normalizedToolName = toolName.toLowerCase();

  // Fast path: exact match on canonical identifier.
  const exact = makeToolIdentifier(toolName, input);
  for (const item of allowedIdentifiers) {
    if (item === exact) return true;
  }

  // Tool-wide approvals: accept direct tool-name identifiers for both shell and non-shell tools.
  for (const item of allowedIdentifiers) {
    if (typeof item !== 'string') continue;
    if (isShell) {
      if (isShellToolName(item)) return true;
      continue;
    }
    if (item.toLowerCase() === normalizedToolName) return true;
  }

  // Shell tools: accept per-command identifiers across shell-tool synonyms and prefix patterns.
  if (isShell && command) {
    const patterns: Array<{ kind: 'exact'; value: string } | { kind: 'prefix'; value: string }> = [];
    for (const item of allowedIdentifiers) {
      if (typeof item !== 'string') continue;
      const parsed = parseParenIdentifier(item);
      if (!parsed) continue;
      if (!isShellToolName(parsed.name)) continue;

      const spec = parsed.spec;
      if (spec.endsWith(':*')) {
        const prefix = spec.slice(0, -2).trim();
        if (prefix) patterns.push({ kind: 'prefix', value: prefix });
      } else if (spec.trim().length > 0) {
        patterns.push({ kind: 'exact', value: spec.trim() });
      }
    }

    if (patterns.length > 0 && isShellCommandAllowed(command, patterns)) return true;
  }

  return false;
}
