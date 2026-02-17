import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupHookSettingsFile, generateHookSettingsFile } from './generateHookSettings';

describe('generateHookSettingsFile', () => {
  const createdFiles: string[] = [];
  const createdDirs: string[] = [];
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

  afterEach(() => {
    for (const filePath of createdFiles.splice(0, createdFiles.length)) {
      cleanupHookSettingsFile(filePath);
    }
    for (const dirPath of createdDirs.splice(0, createdDirs.length)) {
      rmSync(dirPath, { recursive: true, force: true });
    }
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  });

  it('creates SessionStart hook settings by default', () => {
    const filePath = generateHookSettingsFile(43123);
    createdFiles.push(filePath);

    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as any;
    const command = parsed.hooks?.SessionStart?.[0]?.hooks?.[0]?.command as string;
    expect(command).toContain('session_hook_forwarder.cjs');
    // Prefer execPath over `node` so hooks still work when PATH is minimal (common on Windows/GUI contexts).
    expect(command).toContain(process.execPath);
    expect(parsed.hooks?.PermissionRequest).toBeUndefined();
  });

  it('adds PermissionRequest hook when local permission bridge is enabled', () => {
    const filePath = generateHookSettingsFile(43124, {
      enableLocalPermissionBridge: true,
      permissionHookSecret: 'test-secret-123',
    });
    createdFiles.push(filePath);

    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as any;
    const permissionCommand = parsed.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.command as string;
    expect(permissionCommand).toContain('permission_hook_forwarder.cjs');
    expect(permissionCommand).toContain('test-secret-123');
  });

  it('merges hook settings with the user Claude settings file instead of replacing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-claude-settings-'));
    createdDirs.push(dir);
    process.env.CLAUDE_CONFIG_DIR = dir;

    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      includeCoAuthoredBy: true,
      customKey: 'custom-value',
      hooks: {
        SessionStart: [
          { matcher: '*', hooks: [{ type: 'command', command: 'echo user-session-start' }] },
        ],
      },
    }, null, 2));

    const filePath = generateHookSettingsFile(43125);
    createdFiles.push(filePath);

    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as any;
    expect(parsed.includeCoAuthoredBy).toBe(true);
    expect(parsed.customKey).toBe('custom-value');

    const sessionStartCommands = (parsed.hooks?.SessionStart ?? [])
      .flatMap((entry: any) => entry?.hooks ?? [])
      .map((hook: any) => hook?.command)
      .filter((command: any) => typeof command === 'string');

    expect(sessionStartCommands).toEqual(expect.arrayContaining([
      'echo user-session-start',
      expect.stringContaining('session_hook_forwarder.cjs'),
    ]));
  });

  it('reads Claude settings from explicit claudeConfigDir option (does not require process.env.CLAUDE_CONFIG_DIR)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-claude-settings-explicit-'));
    createdDirs.push(dir);

    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify(
        {
          includeCoAuthoredBy: true,
          customKey: 'custom-value',
          hooks: {
            SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo user-session-start' }] }],
          },
        },
        null,
        2,
      ),
    );

    const filePath = generateHookSettingsFile(43126, { claudeConfigDir: dir });
    createdFiles.push(filePath);

    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as any;
    expect(parsed.includeCoAuthoredBy).toBe(true);
    expect(parsed.customKey).toBe('custom-value');
  });
});
