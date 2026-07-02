import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';

import {
  cleanupHookPluginDir,
  cleanupHookSettingsFile,
  generateHookPluginDir,
  generateHookSettingsFile,
} from './generateHookSettings';

describe('generateHookSettingsFile', () => {
  const createdFiles: string[] = [];
  const createdDirs: string[] = [];
  const createdPluginDirs: string[] = [];
  const envKeys = [
    'CLAUDE_CONFIG_DIR',
    'HAPPIER_MANAGED_NODE_BIN',
    'HAPPIER_HOME_DIR',
    'HAPPIER_CLAUDE_HOOKS_DISABLED',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    for (const filePath of createdFiles.splice(0, createdFiles.length)) {
      cleanupHookSettingsFile(filePath);
    }
    for (const pluginDir of createdPluginDirs.splice(0, createdPluginDirs.length)) {
      cleanupHookPluginDir(pluginDir);
    }
    for (const dirPath of createdDirs.splice(0, createdDirs.length)) {
      rmSync(dirPath, { recursive: true, force: true });
    }
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
  });

  it('writes only the non-hook permissions.allow block to the settings file', () => {
    const filePath = generateHookSettingsFile(43123);
    createdFiles.push(filePath);

    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as any;
    expect(parsed.hooks).toBeUndefined();
    expect(parsed.permissions?.allow).toEqual(expect.arrayContaining([
      'mcp__happier__change_title',
      'mcp__happier__session_title_set',
    ]));
    expect(parsed.permissions?.allow).not.toEqual(expect.arrayContaining([
      'mcp__happier__execution_run_start',
      'mcp__happier__execution_run_get',
      'mcp__happier__execution_run_wait',
      'mcp__happier__subagents_delegate_start',
      'mcp__happier__review_start',
    ]));
  });

  it('does not read or copy arbitrary keys from Claude settings.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-claude-settings-'));
    createdDirs.push(dir);
    envScope.patch({ CLAUDE_CONFIG_DIR: dir });

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
    expect(parsed.hooks).toBeUndefined();
  });
});

describe('generateHookPluginDir', () => {
  const createdFiles: string[] = [];
  const createdDirs: string[] = [];
  const createdPluginDirs: string[] = [];
  const envKeys = [
    'CLAUDE_CONFIG_DIR',
    'HAPPIER_MANAGED_NODE_BIN',
    'HAPPIER_HOME_DIR',
    'HAPPIER_CLAUDE_HOOKS_DISABLED',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    for (const filePath of createdFiles.splice(0, createdFiles.length)) {
      cleanupHookSettingsFile(filePath);
    }
    for (const pluginDir of createdPluginDirs.splice(0, createdPluginDirs.length)) {
      cleanupHookPluginDir(pluginDir);
    }
    for (const dirPath of createdDirs.splice(0, createdDirs.length)) {
      rmSync(dirPath, { recursive: true, force: true });
    }
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
  });

  it('writes a session-scoped hooks/hooks.json containing Claude lifecycle hooks by default', () => {
    const pluginDir = generateHookPluginDir(43123);
    expect(pluginDir).toBeTruthy();
    createdPluginDirs.push(pluginDir!);

    const hooksPath = join(pluginDir!, 'hooks', 'hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf8')) as any;
    const lifecycleHookNames = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd', 'PostToolUse'];
    for (const hookName of lifecycleHookNames) {
      const command = parsed.hooks?.[hookName]?.[0]?.hooks?.[0]?.command as string;
      expect(command).toContain('session_hook_forwarder.cjs');
      expect(command).toContain(hookName);
    }
    const command = parsed.hooks?.SessionStart?.[0]?.hooks?.[0]?.command as string;
    expect(command).toContain('session_hook_forwarder.cjs');
    // Prefer execPath over `node` so hooks still work when PATH is minimal (common on Windows/GUI contexts).
    expect(command).toContain(process.execPath);
    expect(parsed.hooks?.PermissionRequest).toBeUndefined();
  });

  it('writes the Claude plugin manifest required for --plugin-dir loading', () => {
    const pluginDir = generateHookPluginDir(43132);
    expect(pluginDir).toBeTruthy();
    createdPluginDirs.push(pluginDir!);

    const manifestPath = join(pluginDir!, '.claude-plugin', 'plugin.json');
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as any;
    expect(parsed.name).toMatch(/^happier-session-hooks-\d+$/);
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.description).toContain('Happier');
    expect(parsed.author?.name).toBe('Happier');
  });

  it('adds PermissionRequest hook when local permission bridge is enabled', () => {
    const pluginDir = generateHookPluginDir(43124, {
      enableLocalPermissionBridge: true,
      permissionHookSecret: 'test-secret-123',
    });
    expect(pluginDir).toBeTruthy();
    createdPluginDirs.push(pluginDir!);

    const hooksPath = join(pluginDir!, 'hooks', 'hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf8')) as any;
    const permissionCommand = parsed.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.command as string;
    expect(permissionCommand).toContain('permission_hook_forwarder.cjs');
    expect(permissionCommand).toContain('--secret-file');
    expect(permissionCommand).not.toContain('test-secret-123');
    const secretFile = permissionCommand.match(/--secret-file "([^"]+)"/)?.[1];
    expect(secretFile).toBeTruthy();
    expect(readFileSync(secretFile!, 'utf8')).toBe('test-secret-123');
    if (process.platform !== 'win32') {
      expect(statSync(secretFile!).mode & 0o777).toBe(0o600);
    }
  });

  it('adds an AskUserQuestion PreToolUse hook when local permission bridge is enabled', () => {
    const pluginDir = generateHookPluginDir(43131, {
      enableLocalPermissionBridge: true,
      permissionHookSecret: 'test-secret-ask',
    });
    expect(pluginDir).toBeTruthy();
    createdPluginDirs.push(pluginDir!);

    const hooksPath = join(pluginDir!, 'hooks', 'hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf8')) as any;
    const preToolUseHook = parsed.hooks?.PreToolUse?.[0];
    expect(preToolUseHook?.matcher).toBe('AskUserQuestion');
    const preToolUseCommand = preToolUseHook?.hooks?.[0]?.command as string;
    expect(preToolUseCommand).toContain('permission_hook_forwarder.cjs');
    expect(preToolUseCommand).toContain('PreToolUse');
    expect(preToolUseCommand).toContain('--secret-file');
    expect(preToolUseCommand).not.toContain('test-secret-ask');
    const secretFile = preToolUseCommand.match(/--secret-file "([^"]+)"/)?.[1];
    expect(secretFile).toBeTruthy();
    expect(readFileSync(secretFile!, 'utf8')).toBe('test-secret-ask');
    if (process.platform !== 'win32') {
      expect(statSync(secretFile!).mode & 0o777).toBe(0o600);
    }
  });

  it('returns null when HAPPIER_CLAUDE_HOOKS_DISABLED is set (debug escape hatch)', () => {
    envScope.patch({ HAPPIER_CLAUDE_HOOKS_DISABLED: '1' });
    const pluginDir = generateHookPluginDir(43128);
    expect(pluginDir).toBeNull();
  });

  it('treats "true" and "yes" as enabled values for HAPPIER_CLAUDE_HOOKS_DISABLED', () => {
    envScope.patch({ HAPPIER_CLAUDE_HOOKS_DISABLED: 'true' });
    expect(generateHookPluginDir(43129)).toBeNull();
    envScope.patch({ HAPPIER_CLAUDE_HOOKS_DISABLED: 'YES' });
    expect(generateHookPluginDir(43130)).toBeNull();
  });

  it('uses the managed node override for hook forwarders when configured', () => {
    const overrideDir = mkdtempSync(join(tmpdir(), 'happier-hook-plugin-managed-node-'));
    createdDirs.push(overrideDir);
    const overridePath = writeExecutableShimSync({
      dir: overrideDir,
      fileName: process.platform === 'win32' ? 'managed-node.cmd' : 'managed-node',
      contents: process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n',
    });
    envScope.patch({ HAPPIER_MANAGED_NODE_BIN: overridePath });

    const pluginDir = generateHookPluginDir(43126);
    expect(pluginDir).toBeTruthy();
    createdPluginDirs.push(pluginDir!);

    const hooksPath = join(pluginDir!, 'hooks', 'hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf8')) as any;
    const command = parsed.hooks?.SessionStart?.[0]?.hooks?.[0]?.command as string;
    expect(command).toContain(overridePath);
  });

  it('fails closed when no JavaScript runtime is available for hook forwarders', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-hook-plugin-no-runtime-'));
    createdDirs.push(happyHomeDir);
    envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir });

    vi.resetModules();
    vi.doMock('@/packagedRuntime/js/resolveJavaScriptRuntimeExecutable', () => ({
      resolveJavaScriptRuntimeExecutable: () => null,
    }));
    vi.doMock('@/utils/runtime', () => ({
      isBun: () => true,
    }));

    try {
      const { generateHookPluginDir: runtimeResolvedGenerateHookPluginDir } =
        (await import('./generateHookSettings')) as typeof import('./generateHookSettings');

      expect(() => runtimeResolvedGenerateHookPluginDir(43127)).toThrow(
        /No JavaScript runtime available to execute claude session hook plugin/,
      );
    } finally {
      vi.doUnmock('@/packagedRuntime/js/resolveJavaScriptRuntimeExecutable');
      vi.doUnmock('@/utils/runtime');
      vi.resetModules();
    }
  });
});
