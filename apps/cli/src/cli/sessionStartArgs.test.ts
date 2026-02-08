import { describe, expect, it } from 'vitest';

import { applyDeprecatedSessionStartAliasesForAgent, parseSessionStartArgs } from './sessionStartArgs';

type ParseSessionStartArgsResult = ReturnType<typeof parseSessionStartArgs>;

function withProcessTrap<T>(fn: () => T): {
  value: T | null;
  error: unknown | null;
  stderr: string[];
} {
  const originalExit = process.exit;
  const originalConsoleError = console.error;
  const stderr: string[] = [];

  try {
    console.error = (...args: unknown[]) => {
      stderr.push(args.map((value) => String(value)).join(' '));
    };
    process.exit = ((code?: number) => {
      throw new Error(`process.exit:${typeof code === 'number' ? code : 'unknown'}`);
    }) as typeof process.exit;
    return { value: fn(), error: null, stderr };
  } catch (error) {
    return { value: null, error, stderr };
  } finally {
    process.exit = originalExit;
    console.error = originalConsoleError;
  }
}

function parseWithTrap(args: string[]): ParseSessionStartArgsResult {
  const trapped = withProcessTrap(() => parseSessionStartArgs(args));
  expect(trapped.error).toBeNull();
  if (trapped.error) {
    throw trapped.error;
  }
  return trapped.value as ParseSessionStartArgsResult;
}

describe('parseSessionStartArgs', () => {
  it('accepts permission mode aliases for read-only', () => {
    const parsed = parseWithTrap(['happier', '--permission-mode', 'readonly']);
    expect(parsed.permissionMode).toBe('read-only');
  });

  it('accepts permission mode aliases for yolo', () => {
    const parsed = parseWithTrap(['happier', '--permission-mode', 'full-access']);
    expect(parsed.permissionMode).toBe('yolo');
  });

  it('accepts bypass-permissions as bypassPermissions', () => {
    const parsed = parseWithTrap(['happier', '--permission-mode', 'bypass-permissions']);
    expect(parsed.permissionMode).toBe('yolo');
  });

  it('accepts accept-edits as acceptEdits', () => {
    const parsed = parseWithTrap(['happier', '--permission-mode', 'accept-edits']);
    expect(parsed.permissionMode).toBe('safe-yolo');
  });

  it('accepts ask as default', () => {
    const parsed = parseWithTrap(['happier', '--permission-mode', 'ask']);
    expect(parsed.permissionMode).toBe('default');
  });

  it('prints examples when an unknown --permission-mode value is provided', () => {
    const trapped = withProcessTrap(() => parseSessionStartArgs(['happier', '--permission-mode', 'nope']));
    expect(String(trapped.error)).toMatch(/process\.exit:1/);
    expect(trapped.stderr.join('\n')).toContain('Examples:');
  });

  it('parses --agent-mode as a raw ACP session mode id', () => {
    const parsed = parseWithTrap(['happier', '--agent-mode', 'plan']);
    expect(parsed.agentModeId).toBe('plan');
  });

  it('parses --agent-mode-updated-at as unix ms', () => {
    const parsed = parseWithTrap(['happier', '--agent-mode', 'plan', '--agent-mode-updated-at', '123']);
    expect(parsed.agentModeUpdatedAt).toBe(123);
  });

  it('parses --model as a raw model id', () => {
    const parsed = parseWithTrap(['happier', '--model', 'gpt-5-codex-high']);
    expect(parsed.modelId).toBe('gpt-5-codex-high');
  });

  it('parses --model-updated-at as unix ms', () => {
    const parsed = parseWithTrap(['happier', '--model', 'gpt-5-codex-high', '--model-updated-at', '123']);
    expect(parsed.modelUpdatedAt).toBe(123);
  });

  it('treats --permission-mode plan as a deprecated alias for --agent-mode plan on OpenCode', () => {
    const parsed = parseSessionStartArgs(['happier', '--permission-mode', 'plan']);
    const resolved = applyDeprecatedSessionStartAliasesForAgent({
      agentId: 'opencode',
      ...parsed,
    });

    expect(resolved.agentModeId).toBe('plan');
    expect(resolved.permissionMode).toBe('default');
    expect(resolved.warnings.join(' ')).toMatch(/deprecated/i);
  });

  it('treats --permission-mode plan as a deprecated alias for --agent-mode plan on Kilo', () => {
    const parsed = parseSessionStartArgs(['happier', '--permission-mode', 'plan']);
    const resolved = applyDeprecatedSessionStartAliasesForAgent({
      agentId: 'kilo',
      ...parsed,
    });

    expect(resolved.agentModeId).toBe('plan');
    expect(resolved.permissionMode).toBe('default');
    expect(resolved.warnings.join(' ')).toMatch(/deprecated/i);
  });
});
