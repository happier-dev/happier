import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';

import {
  DEFAULT_PERMISSION_HOOK_TIMEOUT_SECONDS,
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
      if (existsSync(pluginDir)) {
        rmSync(pluginDir, { recursive: true, force: true });
      }
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
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
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
    'HAPPIER_CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    for (const filePath of createdFiles.splice(0, createdFiles.length)) {
      cleanupHookSettingsFile(filePath);
    }
    for (const pluginDir of createdPluginDirs.splice(0, createdPluginDirs.length)) {
      cleanupHookPluginDir(pluginDir);
      if (existsSync(pluginDir)) {
        rmSync(pluginDir, { recursive: true, force: true });
      }
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
    const lifecycleHookNames = [
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'StopFailure',
      'SessionEnd',
      'PostToolUse',
      'SubagentStart',
      'SubagentStop',
    ];
    for (const hookName of lifecycleHookNames) {
      const command = parsed.hooks?.[hookName]?.[0]?.hooks?.[0]?.command as string;
      expect(command).toContain('session_hook_forwarder.cjs');
      expect(command).toContain(pluginDir!);
      expect(command).toContain(hookName);
    }
    expect(existsSync(join(pluginDir!, 'runtime-assets'))).toBe(true);
    const permissionForwarderPaths = readFileSync(hooksPath, 'utf8').match(/[^"\s]*permission_hook_forwarder\.cjs/g) ?? [];
    expect(permissionForwarderPaths).toHaveLength(0);
    const runtimeAssetDirs = readdirSync(join(pluginDir!, 'runtime-assets'));
    expect(runtimeAssetDirs).toHaveLength(1);
    expect(existsSync(join(pluginDir!, 'runtime-assets', runtimeAssetDirs[0]!, 'session_hook_forwarder.cjs'))).toBe(true);
    expect(existsSync(join(pluginDir!, 'runtime-assets', runtimeAssetDirs[0]!, 'permission_hook_forwarder.cjs'))).toBe(true);
    const command = parsed.hooks?.SessionStart?.[0]?.hooks?.[0]?.command as string;
    // Prefer execPath over `node` so hooks still work when PATH is minimal (common on Windows/GUI contexts).
    expect(command).toContain(process.execPath);
    expect(parsed.hooks?.PermissionRequest).toBeUndefined();
    expect(parsed.hooks?.PermissionDenied).toBeUndefined();
  });

  it('builds Windows lifecycle and permission hook commands as PowerShell invocations', () => {
    const pluginDir = generateHookPluginDir(43123, {
      enableLocalPermissionBridge: true,
      permissionHookSecret: 'windows-hook-secret',
      platform: 'win32',
    });

    expect(pluginDir).toBeTruthy();
    createdPluginDirs.push(pluginDir!);
    const parsed = JSON.parse(readFileSync(join(pluginDir!, 'hooks', 'hooks.json'), 'utf8')) as any;
    for (const hookName of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PermissionRequest', 'PreToolUse']) {
      const command = parsed.hooks?.[hookName]?.[0]?.hooks?.[0]?.command as string;
      expect(command).toMatch(/^&\s+'[^']+'\s+'[^']+'\s+'43123'/);
      expect(command).toContain(`'${hookName}'`);
      expect(command).toContain("'--secret-file'");
    }
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

  it('uses a stable session-scoped plugin dir when a session hook plugin id is provided', () => {
    const sessionHookPluginId = 'cmr3dpuka06zhtmtpaa1af5gh';
    const firstPluginDir = generateHookPluginDir(43132, {
      sessionHookPluginId,
      permissionHookSecret: 'first-secret',
    });
    expect(firstPluginDir).toBeTruthy();
    createdPluginDirs.push(firstPluginDir!);

    const secondPluginDir = generateHookPluginDir(53132, {
      sessionHookPluginId,
      permissionHookSecret: 'second-secret',
    });
    expect(secondPluginDir).toBe(firstPluginDir);

    expect(secondPluginDir).toContain(`session-${sessionHookPluginId}`);
    expect(secondPluginDir).not.toContain(`session-${process.pid}`);

    const manifest = JSON.parse(readFileSync(join(secondPluginDir!, '.claude-plugin', 'plugin.json'), 'utf8')) as any;
    expect(manifest.name).toBe(`happier-session-hooks-${sessionHookPluginId}`);

    const hooksPath = join(secondPluginDir!, 'hooks', 'hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf8')) as any;
    const command = parsed.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command as string;
    expect(command).toContain('53132');
    expect(command).not.toContain('43132');
    const secretPath = command.match(/--secret-file\s+"([^"]+)"/)?.[1];
    expect(secretPath).toBeTruthy();
    expect(readFileSync(secretPath!, 'utf8')).toBe('second-secret');
  });

  it('keeps stable session-scoped plugin dirs during runner cleanup', () => {
    const pluginDir = generateHookPluginDir(43132, {
      sessionHookPluginId: 'cmr3dpuka06zhtmtpaa1af5gh',
      permissionHookSecret: 'cleanup-secret',
    });
    expect(pluginDir).toBeTruthy();
    createdPluginDirs.push(pluginDir!);

    try {
      cleanupHookPluginDir(pluginDir);

      expect(existsSync(pluginDir!)).toBe(true);
      expect(readFileSync(join(pluginDir!, 'permission-hook-secret'), 'utf8')).toBe('cleanup-secret');
    } finally {
      rmSync(pluginDir!, { recursive: true, force: true });
    }
  });

  it('force-removes stable session-scoped plugin dirs at final session end', () => {
    const pluginDir = generateHookPluginDir(43132, {
      sessionHookPluginId: 'cmr3dpuka06zhtmtpaa1af5gh',
      permissionHookSecret: 'cleanup-secret',
    });
    expect(pluginDir).toBeTruthy();
    createdPluginDirs.push(pluginDir!);

    cleanupHookPluginDir(pluginDir, { force: true });

    expect(existsSync(pluginDir!)).toBe(false);
  });

  it('adds PermissionRequest hook using a private secret file instead of command argv', () => {
    const secret = 'test-secret-123';
    const pluginDir = generateHookPluginDir(43124, {
      enableLocalPermissionBridge: true,
      permissionHookSecret: secret,
    });
    expect(pluginDir).toBeTruthy();
    createdPluginDirs.push(pluginDir!);

    const hooksPath = join(pluginDir!, 'hooks', 'hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf8')) as any;
    const permissionCommand = parsed.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.command as string;
    expect(permissionCommand).toContain('permission_hook_forwarder.cjs');
    expect(permissionCommand).toContain(pluginDir!);
    expect(permissionCommand).toContain('--secret-file');
    expect(permissionCommand).not.toContain(secret);
    const secretPath = permissionCommand.match(/--secret-file\s+"([^"]+)"/)?.[1];
    expect(secretPath).toBeTruthy();
    expect(readFileSync(secretPath!, 'utf8')).toBe(secret);
    expect(statSync(secretPath!).mode & 0o777).toBe(0o600);
  });

  it('adds the same private secret file to ALL session lifecycle hook commands (A5-MED-2)', () => {
    const secret = 'test-secret-456';
    const pluginDir = generateHookPluginDir(43124, {
      enableLocalPermissionBridge: false,
      permissionHookSecret: secret,
    });
    expect(pluginDir).toBeTruthy();
    createdPluginDirs.push(pluginDir!);

    const hooksPath = join(pluginDir!, 'hooks', 'hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf8')) as any;
    for (const hookName of [
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'StopFailure',
      'SessionEnd',
      'PostToolUse',
      'SubagentStart',
      'SubagentStop',
    ]) {
      const command = parsed.hooks?.[hookName]?.[0]?.hooks?.[0]?.command as string;
      expect(command).toContain('session_hook_forwarder.cjs');
      expect(command).toContain('--secret-file');
      expect(command).not.toContain(secret);
    }
    const command = parsed.hooks?.SessionStart?.[0]?.hooks?.[0]?.command as string;
    const secretPath = command.match(/--secret-file\s+"([^"]+)"/)?.[1];
    expect(secretPath).toBeTruthy();
    expect(readFileSync(secretPath!, 'utf8')).toBe(secret);
    expect(statSync(secretPath!).mode & 0o777).toBe(0o600);
  });

  it('restricts the secret-bearing plugin dirs and files to the owner even with permissive umask', () => {
    if (process.platform === 'win32') return;
    const originalUmask = process.umask(0);
    try {
      const pluginDir = generateHookPluginDir(43150, {
        enableLocalPermissionBridge: true,
        permissionHookSecret: 'perm-secret-perms',
      });
      expect(pluginDir).toBeTruthy();
      createdPluginDirs.push(pluginDir!);

      const manifestDir = join(pluginDir!, '.claude-plugin');
      const hooksDir = join(pluginDir!, 'hooks');
      const dirMode = statSync(pluginDir!).mode & 0o777;
      const manifestDirMode = statSync(manifestDir).mode & 0o777;
      const hooksDirMode = statSync(hooksDir).mode & 0o777;
      const manifestFileMode = statSync(join(manifestDir, 'plugin.json')).mode & 0o777;
      const hooksFileMode = statSync(join(hooksDir, 'hooks.json')).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(manifestDirMode).toBe(0o700);
      expect(hooksDirMode).toBe(0o700);
      expect(manifestFileMode).toBe(0o600);
      expect(hooksFileMode).toBe(0o600);
    } finally {
      process.umask(originalUmask);
    }
  });

  it('installs an effectively-unlimited (7-day) default timeout on the permission hooks', () => {
    const pluginDir = generateHookPluginDir(43140, {
      enableLocalPermissionBridge: true,
      permissionHookSecret: 'test-secret-timeout',
    });
    expect(pluginDir).toBeTruthy();
    createdPluginDirs.push(pluginDir!);

    const hooksPath = join(pluginDir!, 'hooks', 'hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf8')) as any;
    // 7 days in seconds — large enough that a user can answer a permission request after sleeping,
    // while still finite so the bridge can honestly expire a genuinely-dead forwarder.
    expect(parsed.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.timeout).toBe(604800);
    expect(parsed.hooks?.PreToolUse?.[0]?.hooks?.[0]?.timeout).toBe(604800);
    expect(parsed.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.timeout).toBe(DEFAULT_PERMISSION_HOOK_TIMEOUT_SECONDS);
    // Lifecycle hooks keep Claude's default timeout (no explicit override).
    expect(parsed.hooks?.SessionStart?.[0]?.hooks?.[0]?.timeout).toBeUndefined();
  });

  it('reads HAPPIER_CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS as the default when no explicit option is given', () => {
    envScope.patch({ HAPPIER_CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS: '120' });
    const pluginDir = generateHookPluginDir(43142, {
      enableLocalPermissionBridge: true,
      permissionHookSecret: 'test-secret-env',
    });
    expect(pluginDir).toBeTruthy();
    createdPluginDirs.push(pluginDir!);

    const hooksPath = join(pluginDir!, 'hooks', 'hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf8')) as any;
    expect(parsed.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.timeout).toBe(120);
    expect(parsed.hooks?.PreToolUse?.[0]?.hooks?.[0]?.timeout).toBe(120);
  });

  it('prefers an explicit permissionHookTimeoutSeconds over the env override', () => {
    envScope.patch({ HAPPIER_CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS: '120' });
    const pluginDir = generateHookPluginDir(43143, {
      enableLocalPermissionBridge: true,
      permissionHookSecret: 'test-secret-env-explicit',
      permissionHookTimeoutSeconds: 45,
    });
    expect(pluginDir).toBeTruthy();
    createdPluginDirs.push(pluginDir!);

    const hooksPath = join(pluginDir!, 'hooks', 'hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf8')) as any;
    expect(parsed.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.timeout).toBe(45);
  });

  it('ignores a non-positive or non-numeric env override and falls back to the default', () => {
    envScope.patch({ HAPPIER_CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS: 'not-a-number' });
    const pluginDir = generateHookPluginDir(43144, {
      enableLocalPermissionBridge: true,
      permissionHookSecret: 'test-secret-env-bad',
    });
    expect(pluginDir).toBeTruthy();
    createdPluginDirs.push(pluginDir!);

    const hooksPath = join(pluginDir!, 'hooks', 'hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf8')) as any;
    expect(parsed.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.timeout).toBe(DEFAULT_PERMISSION_HOOK_TIMEOUT_SECONDS);
  });

  it('honors a configured permissionHookTimeoutSeconds override on both permission hooks', () => {
    const pluginDir = generateHookPluginDir(43141, {
      enableLocalPermissionBridge: true,
      permissionHookSecret: 'test-secret-timeout-override',
      permissionHookTimeoutSeconds: 30,
    });
    expect(pluginDir).toBeTruthy();
    createdPluginDirs.push(pluginDir!);

    const hooksPath = join(pluginDir!, 'hooks', 'hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf8')) as any;
    expect(parsed.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.timeout).toBe(30);
    expect(parsed.hooks?.PreToolUse?.[0]?.hooks?.[0]?.timeout).toBe(30);
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
    vi.doMock('@/runtime/js/resolveJavaScriptRuntimeExecutable', () => ({
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
      vi.doUnmock('@/runtime/js/resolveJavaScriptRuntimeExecutable');
      vi.doUnmock('@/utils/runtime');
      vi.resetModules();
    }
  });
});


describe('cleanupHookSettingsFile overlay sibling', () => {
  it('also removes the 0600 .overlay.json sibling written for merged --settings overlays', async () => {
    const { mkdtemp, writeFile, access } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'happier-hook-cleanup-'));
    const settingsPath = join(dir, 'session-hook-123.json');
    const overlayPath = join(dir, 'session-hook-123.overlay.json');
    await writeFile(settingsPath, '{}');
    await writeFile(overlayPath, '{}', { mode: 0o600 });

    cleanupHookSettingsFile(settingsPath);

    await expect(access(settingsPath)).rejects.toThrow();
    await expect(access(overlayPath)).rejects.toThrow();
  });
});
