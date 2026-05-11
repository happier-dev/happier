import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '@/cli/commandRegistry';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { writeTextFileSync } from '@/testkit/fs/fileHelpers';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout, captureConsoleText } from '@/testkit/logger/captureOutput';

const { execFileSyncSpy, runtimeState } = vi.hoisted(() => ({
  execFileSyncSpy: vi.fn(() => 'claude help output'),
  runtimeState: { isBun: false },
}));

const envKeys = [
  'HOME',
  'PATH',
  'HAPPIER_HOME_DIR',
  'HAPPIER_CLAUDE_PATH',
  'HAPPIER_JS_RUNTIME_PATH',
  'HAPPIER_MANAGED_NODE_BIN',
  'HAPPIER_NODE_PATH',
] as const;
const TEMP_DIRS = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: execFileSyncSpy };
});

vi.mock('@/utils/runtime', () => ({
  isBun: () => runtimeState.isBun,
}));

import { handleClaudeCliCommand } from './command';

afterEach(() => {
  vi.restoreAllMocks();
  execFileSyncSpy.mockClear();
  runtimeState.isBun = false;
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  for (const dir of TEMP_DIRS) removeTempDirSync(dir);
  TEMP_DIRS.clear();
});

function createTempRoot(prefix: string): string {
  const root = createTempDirSync(prefix);
  TEMP_DIRS.add(root);
  return root;
}

function createExecutable(root: string, fileName: string, contents: string): string {
  return writeExecutableShimSync({
    dir: root,
    fileName,
    contents,
  });
}

function createRuntimeExecutable(root: string): string {
  return createExecutable(
    root,
    process.platform === 'win32' ? 'node.cmd' : 'node',
    process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n',
  );
}

function createClaudeJsEntry(root: string): string {
  const claudePath = join(root, 'claude.mjs');
  writeTextFileSync(claudePath, '');
  return claudePath;
}

function createExitSpy() {
  return vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
    throw new Error(`exit:${code ?? 0}`);
  });
}

function createHelpContext(): CommandContext {
  return {
    args: ['-h'],
    rawArgv: [],
    terminalRuntime: null,
  } satisfies CommandContext;
}

function createClaudeSubcommandHelpContext(): CommandContext {
  return {
    args: ['claude', 'agents', '--help'],
    rawArgv: [],
    terminalRuntime: null,
  } satisfies CommandContext;
}

describe('happier (default claude) help output', () => {
  it('includes global server selection flags', async () => {
    const root = createTempRoot('happier-claude-help-default-');
    const claudePath = createExecutable(
      root,
      process.platform === 'win32' ? 'claude.cmd' : 'claude',
      process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n',
    );
    process.env.HAPPIER_CLAUDE_PATH = claudePath;

    const exitSpy = createExitSpy();
    const output = captureConsoleLogAndMuteStdout();

    try {
      await expect(handleClaudeCliCommand(createHelpContext())).rejects.toThrow('exit:0');

      const stdout = output.logs.join('\n');
      expect(stdout).toContain('--server-url');
      expect(stdout).toContain('--webapp-url');
      expect(stdout).toContain('--public-server-url');
      expect(stdout).toContain('--server ');
      expect(stdout).toContain('--profile');
      expect(stdout).toContain('happier profiles list');
      expect(stdout).not.toContain('--claude-env');

      expect(execFileSyncSpy).toHaveBeenCalledWith(
        claudePath,
        ['--help'],
        expect.objectContaining({
          encoding: 'utf8',
          windowsHide: true,
        }),
      );
    } finally {
      output.restore();
      exitSpy.mockRestore();
    }
  });

  it('forwards Claude subcommand context when displaying combined help', async () => {
    const root = createTempRoot('happier-claude-subcommand-help-');
    const claudePath = createExecutable(
      root,
      process.platform === 'win32' ? 'claude.cmd' : 'claude',
      process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n',
    );
    process.env.HAPPIER_CLAUDE_PATH = claudePath;

    const exitSpy = createExitSpy();
    const output = captureConsoleLogAndMuteStdout();

    try {
      await expect(handleClaudeCliCommand(createClaudeSubcommandHelpContext())).rejects.toThrow('exit:0');

      expect(output.logs.join('\n')).toContain('Claude Code Options');
      expect(output.logs.join('\n')).toContain('claude agents --help');
      expect(execFileSyncSpy).toHaveBeenCalledWith(
        claudePath,
        ['agents', '--help'],
        expect.objectContaining({
          encoding: 'utf8',
          windowsHide: true,
        }),
      );
    } finally {
      output.restore();
      exitSpy.mockRestore();
    }
  });

  it('forwards windowsVerbatimArguments when invoking a .cmd Claude CLI on win32', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!descriptor) throw new Error('Missing process.platform descriptor');
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });

    const root = createTempRoot('happier-claude-help-win32-');
    process.env.HAPPIER_CLAUDE_PATH = createExecutable(root, 'claude.cmd', '@echo off\r\n');

    const exitSpy = createExitSpy();
    const output = captureConsoleLogAndMuteStdout();

    try {
      await expect(handleClaudeCliCommand(createHelpContext())).rejects.toThrow('exit:0');

      expect(execFileSyncSpy).toHaveBeenCalledWith(
        expect.stringMatching(/cmd\.exe$/i),
        expect.arrayContaining(['/d', '/s', '/c']),
        expect.objectContaining({
          encoding: 'utf8',
          windowsHide: true,
          windowsVerbatimArguments: true,
        }),
      );
    } finally {
      output.restore();
      exitSpy.mockRestore();
      Object.defineProperty(process, 'platform', descriptor);
    }
  });

  it('forwards windowsVerbatimArguments when invoking a JS Claude CLI via a .cmd JS runtime on win32', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!descriptor) throw new Error('Missing process.platform descriptor');
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });

    const root = createTempRoot('happier-claude-help-win32-js-runtime-');
    process.env.HAPPIER_JS_RUNTIME_PATH = createExecutable(root, 'node.cmd', '@echo off\r\n');
    process.env.HAPPIER_CLAUDE_PATH = createClaudeJsEntry(root);
    runtimeState.isBun = true;

    const exitSpy = createExitSpy();
    const output = captureConsoleLogAndMuteStdout();

    try {
      await expect(handleClaudeCliCommand(createHelpContext())).rejects.toThrow('exit:0');

      expect(execFileSyncSpy).toHaveBeenCalledWith(
        expect.stringMatching(/cmd\.exe$/i),
        expect.arrayContaining(['/d', '/s', '/c']),
        expect.objectContaining({
          encoding: 'utf8',
          windowsHide: true,
          windowsVerbatimArguments: true,
        }),
      );
    } finally {
      output.restore();
      exitSpy.mockRestore();
      Object.defineProperty(process, 'platform', descriptor);
    }
  });

  it('uses the resolved JS runtime override instead of process.execPath under bun', async () => {
    const root = createTempRoot('happier-claude-help-runtime-');
    const runtimePath = createRuntimeExecutable(root);
    const claudePath = createClaudeJsEntry(root);
    process.env.HAPPIER_JS_RUNTIME_PATH = runtimePath;
    process.env.HAPPIER_CLAUDE_PATH = claudePath;
    runtimeState.isBun = true;

    const exitSpy = createExitSpy();
    const output = captureConsoleLogAndMuteStdout();

    try {
      await expect(handleClaudeCliCommand(createHelpContext())).rejects.toThrow('exit:0');

      expect(execFileSyncSpy).toHaveBeenCalledWith(
        runtimePath,
        [claudePath, '--help'],
        expect.objectContaining({ encoding: 'utf8', windowsHide: true }),
      );
    } finally {
      output.restore();
      exitSpy.mockRestore();
    }
  });

  it('uses the resolved JS runtime override instead of process.execPath under node', async () => {
    const root = createTempRoot('happier-claude-help-node-runtime-');
    const runtimePath = createRuntimeExecutable(root);
    const claudePath = createClaudeJsEntry(root);
    process.env.HAPPIER_JS_RUNTIME_PATH = runtimePath;
    process.env.HAPPIER_CLAUDE_PATH = claudePath;
    runtimeState.isBun = false;

    const exitSpy = createExitSpy();
    const output = captureConsoleLogAndMuteStdout();

    try {
      await expect(handleClaudeCliCommand(createHelpContext())).rejects.toThrow('exit:0');

      expect(execFileSyncSpy).toHaveBeenCalledWith(
        runtimePath,
        [claudePath, '--help'],
        expect.objectContaining({ encoding: 'utf8', windowsHide: true }),
      );
    } finally {
      output.restore();
      exitSpy.mockRestore();
    }
  });

  it('fails closed when a JS Claude CLI override has no valid JS runtime under bun', async () => {
    runtimeState.isBun = true;
    const root = createTempRoot('happier-claude-help-missing-runtime-');
    process.env.HAPPIER_CLAUDE_PATH = createClaudeJsEntry(root);
    process.env.HAPPIER_JS_RUNTIME_PATH = join(root, 'missing-node');

    const exitSpy = createExitSpy();
    const output = captureConsoleLogAndMuteStdout();

    try {
      await expect(handleClaudeCliCommand(createHelpContext())).rejects.toThrow('exit:1');

      expect(execFileSyncSpy).not.toHaveBeenCalled();
      expect(output.logs.join('\n')).toContain('HAPPIER_CLAUDE_PATH');
    } finally {
      output.restore();
      exitSpy.mockRestore();
    }
  });

  it('surfaces centralized missing-cli guidance without invoking legacy npm detection when Claude is unavailable', async () => {
    const root = createTempRoot('happier-claude-help-missing-cli-');
    process.env.HAPPIER_JS_RUNTIME_PATH = createRuntimeExecutable(root);
    process.env.PATH = root;
    process.env.HOME = root;
    runtimeState.isBun = true;

    const exitSpy = createExitSpy();
    const output = captureConsoleLogAndMuteStdout();

    try {
      await expect(handleClaudeCliCommand(createHelpContext())).rejects.toThrow('exit:0');

      expect(execFileSyncSpy).not.toHaveBeenCalled();
      expect(output.logs.join('\n')).toContain('Claude CLI (claude) is not available from any configured source');
      expect(output.logs.join('\n')).not.toContain('npm: not found');
    } finally {
      output.restore();
      exitSpy.mockRestore();
    }
  });

  it('fails closed for an invalid explicit HAPPIER_CLAUDE_PATH override on --help', async () => {
    const root = createTempRoot('happier-claude-help-invalid-override-');
    process.env.HAPPIER_JS_RUNTIME_PATH = createRuntimeExecutable(root);
    process.env.HAPPIER_CLAUDE_PATH = join(root, 'missing-claude');
    process.env.PATH = root;
    process.env.HOME = root;
    runtimeState.isBun = true;

    const exitSpy = createExitSpy();
    const output = captureConsoleLogAndMuteStdout();

    try {
      await expect(handleClaudeCliCommand(createHelpContext())).rejects.toThrow('exit:1');

      expect(execFileSyncSpy).not.toHaveBeenCalled();
      expect(output.logs.join('\n')).toContain('HAPPIER_CLAUDE_PATH');
    } finally {
      output.restore();
      exitSpy.mockRestore();
    }
  });

  it('treats an option after --js-runtime as a missing runtime value', async () => {
    const exitSpy = createExitSpy();
    const output = captureConsoleText();

    try {
      await expect(handleClaudeCliCommand({
        args: ['claude', '--js-runtime', '--permission-mode', 'default'],
        rawArgv: [],
        terminalRuntime: null,
      })).rejects.toThrow('exit:1');

      expect(output.text()).toContain('Missing value for --js-runtime');
      expect(execFileSyncSpy).not.toHaveBeenCalled();
    } finally {
      output.restore();
      exitSpy.mockRestore();
    }
  });
});
