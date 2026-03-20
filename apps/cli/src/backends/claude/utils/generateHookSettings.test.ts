import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanupHookSettingsFile, generateHookSettingsFile } from './generateHookSettings';

describe('generateHookSettingsFile', () => {
  const createdFiles: string[] = [];
  const createdDirs: string[] = [];
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalManagedNode = process.env.HAPPIER_MANAGED_NODE_BIN;

  afterEach(() => {
    for (const filePath of createdFiles.splice(0, createdFiles.length)) {
      cleanupHookSettingsFile(filePath);
    }
    for (const dirPath of createdDirs.splice(0, createdDirs.length)) {
      rmSync(dirPath, { recursive: true, force: true });
    }
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    if (originalManagedNode === undefined) delete process.env.HAPPIER_MANAGED_NODE_BIN;
    else process.env.HAPPIER_MANAGED_NODE_BIN = originalManagedNode;
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

  it('uses the managed node override for hook forwarders when configured', () => {
    const overrideDir = mkdtempSync(join(tmpdir(), 'happier-hook-settings-managed-node-'));
    createdDirs.push(overrideDir);
    const overridePath = join(overrideDir, process.platform === 'win32' ? 'managed-node.cmd' : 'managed-node');
    writeFileSync(overridePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(overridePath, 0o755);
    process.env.HAPPIER_MANAGED_NODE_BIN = overridePath;

    const filePath = generateHookSettingsFile(43126);
    createdFiles.push(filePath);

    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as any;
    const command = parsed.hooks?.SessionStart?.[0]?.hooks?.[0]?.command as string;
    expect(command).toContain(overridePath);
  });

  it('fails closed when no JavaScript runtime is available for hook forwarders', async () => {
    const previousHappyHomeDir = process.env.HAPPIER_HOME_DIR;
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-hook-settings-no-runtime-'));
    createdDirs.push(happyHomeDir);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;

    vi.resetModules();
    vi.doMock('@/runtime/js/resolveJavaScriptRuntimeExecutable', () => ({
      resolveJavaScriptRuntimeExecutable: () => null,
    }));
    vi.doMock('@/utils/runtime', () => ({
      isBun: () => true,
    }));

    try {
      const { generateHookSettingsFile: runtimeResolvedGenerateHookSettingsFile } =
        (await import('./generateHookSettings')) as typeof import('./generateHookSettings');

      expect(() => runtimeResolvedGenerateHookSettingsFile(43127)).toThrow(
        /No JavaScript runtime available to execute session hook forwarder/,
      );
    } finally {
      vi.doUnmock('@/runtime/js/resolveJavaScriptRuntimeExecutable');
      vi.doUnmock('@/utils/runtime');
      vi.resetModules();
      if (typeof previousHappyHomeDir === 'string') process.env.HAPPIER_HOME_DIR = previousHappyHomeDir;
      else delete process.env.HAPPIER_HOME_DIR;
    }
  });

  it('does not read or copy arbitrary keys from Claude settings.json', () => {
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
    expect(parsed.includeCoAuthoredBy).toBeUndefined();
    expect(parsed.customKey).toBeUndefined();

    const hookCommands = (parsed.hooks?.SessionStart ?? [])
      .flatMap((entry: any) => entry?.hooks ?? [])
      .map((hook: any) => hook?.command)
      .filter((command: any) => typeof command === 'string');
    expect(hookCommands).toEqual(expect.arrayContaining([expect.stringContaining('session_hook_forwarder.cjs')]));
  });
});
