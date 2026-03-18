import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '@/cli/commandRegistry';

const { execFileSyncSpy, runtimeState } = vi.hoisted(() => ({
  execFileSyncSpy: vi.fn(() => 'claude help output'),
  runtimeState: { isBun: false },
}));
const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
const originalHome = process.env.HOME;
const originalPath = process.env.PATH;

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
  delete process.env.HAPPIER_CLAUDE_PATH;
  delete process.env.HAPPIER_JS_RUNTIME_PATH;
  delete process.env.HAPPIER_MANAGED_NODE_BIN;
  delete process.env.HAPPIER_NODE_PATH;
  if (originalHappyHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
  else process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

describe('happier (default claude) help output', () => {
  it('includes global server selection flags', async () => {
    const root = join(tmpdir(), `happier-claude-help-default-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const claudePath = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    mkdirSync(root, { recursive: true });
    writeFileSync(claudePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(claudePath, 0o755);
    process.env.HAPPIER_CLAUDE_PATH = claudePath;

    try {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
        throw new Error(`exit:${code ?? 0}`);
      });

      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.map((a) => String(a)).join(' '));
      });

      await expect(
        handleClaudeCliCommand(({
          args: ['-h'],
          rawArgv: [],
          terminalRuntime: null,
        }) satisfies CommandContext),
      ).rejects.toThrow('exit:0');

      exitSpy.mockRestore();
      logSpy.mockRestore();

      const stdout = logs.join('\n');
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
      rmSync(root, { recursive: true, force: true });
      delete process.env.HAPPIER_CLAUDE_PATH;
    }
  });

  it('forwards windowsVerbatimArguments when invoking a .cmd Claude CLI on win32', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!descriptor) throw new Error('Missing process.platform descriptor');
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });

    const root = join(tmpdir(), `happier-claude-help-win32-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const claudePath = join(root, 'claude.cmd');
    mkdirSync(root, { recursive: true });
    writeFileSync(claudePath, '@echo off\r\n', 'utf8');
    process.env.HAPPIER_CLAUDE_PATH = claudePath;

    try {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
        throw new Error(`exit:${code ?? 0}`);
      });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await expect(
        handleClaudeCliCommand(({
          args: ['-h'],
          rawArgv: [],
          terminalRuntime: null,
        }) satisfies CommandContext),
      ).rejects.toThrow('exit:0');

      expect(execFileSyncSpy).toHaveBeenCalledWith(
        expect.stringMatching(/cmd\.exe$/i),
        expect.arrayContaining(['/d', '/s', '/c']),
        expect.objectContaining({
          encoding: 'utf8',
          windowsHide: true,
          windowsVerbatimArguments: true,
        }),
      );

      exitSpy.mockRestore();
      logSpy.mockRestore();
    } finally {
      rmSync(root, { recursive: true, force: true });
      delete process.env.HAPPIER_CLAUDE_PATH;
      Object.defineProperty(process, 'platform', descriptor);
    }
  });

  it('forwards windowsVerbatimArguments when invoking a JS Claude CLI via a .cmd JS runtime on win32', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!descriptor) throw new Error('Missing process.platform descriptor');
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });

    const root = join(tmpdir(), `happier-claude-help-win32-js-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const runtimePath = join(root, 'node.cmd');
    const claudePath = join(root, 'claude.mjs');
    mkdirSync(root, { recursive: true });
    writeFileSync(runtimePath, '@echo off\r\n', 'utf8');
    writeFileSync(claudePath, '', 'utf8');
    process.env.HAPPIER_JS_RUNTIME_PATH = runtimePath;
    process.env.HAPPIER_CLAUDE_PATH = claudePath;
    runtimeState.isBun = true;

    try {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
        throw new Error(`exit:${code ?? 0}`);
      });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await expect(
        handleClaudeCliCommand(({
          args: ['-h'],
          rawArgv: [],
          terminalRuntime: null,
        }) satisfies CommandContext),
      ).rejects.toThrow('exit:0');

      expect(execFileSyncSpy).toHaveBeenCalledWith(
        expect.stringMatching(/cmd\.exe$/i),
        expect.arrayContaining(['/d', '/s', '/c']),
        expect.objectContaining({
          encoding: 'utf8',
          windowsHide: true,
          windowsVerbatimArguments: true,
        }),
      );

      exitSpy.mockRestore();
      logSpy.mockRestore();
    } finally {
      rmSync(root, { recursive: true, force: true });
      delete process.env.HAPPIER_CLAUDE_PATH;
      delete process.env.HAPPIER_JS_RUNTIME_PATH;
      Object.defineProperty(process, 'platform', descriptor);
    }
  });

  it('uses the resolved JS runtime override instead of process.execPath under bun', async () => {
    const root = join(tmpdir(), `happier-claude-help-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const runtimePath = join(root, process.platform === 'win32' ? 'node.cmd' : 'node');
    const claudePath = join(root, 'claude.mjs');
    mkdirSync(root, { recursive: true });
    writeFileSync(runtimePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    writeFileSync(claudePath, '', 'utf8');
    if (process.platform !== 'win32') chmodSync(runtimePath, 0o755);
    process.env.HAPPIER_JS_RUNTIME_PATH = runtimePath;
    process.env.HAPPIER_CLAUDE_PATH = claudePath;
    runtimeState.isBun = true;

    try {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
        throw new Error(`exit:${code ?? 0}`);
      });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await expect(
        handleClaudeCliCommand(({
          args: ['-h'],
          rawArgv: [],
          terminalRuntime: null,
        }) satisfies CommandContext),
      ).rejects.toThrow('exit:0');

      expect(execFileSyncSpy).toHaveBeenCalledWith(
        runtimePath,
        [claudePath, '--help'],
        expect.objectContaining({ encoding: 'utf8', windowsHide: true }),
      );

      exitSpy.mockRestore();
      logSpy.mockRestore();
    } finally {
      rmSync(root, { recursive: true, force: true });
      delete process.env.HAPPIER_CLAUDE_PATH;
    }
  });

  it('uses the resolved JS runtime override instead of process.execPath under node', async () => {
    const root = join(tmpdir(), `happier-claude-help-node-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const runtimePath = join(root, process.platform === 'win32' ? 'node.cmd' : 'node');
    const claudePath = join(root, 'claude.mjs');
    mkdirSync(root, { recursive: true });
    writeFileSync(runtimePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    writeFileSync(claudePath, '', 'utf8');
    if (process.platform !== 'win32') chmodSync(runtimePath, 0o755);
    process.env.HAPPIER_JS_RUNTIME_PATH = runtimePath;
    process.env.HAPPIER_CLAUDE_PATH = claudePath;
    runtimeState.isBun = false;

    try {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
        throw new Error(`exit:${code ?? 0}`);
      });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await expect(
        handleClaudeCliCommand(({
          args: ['-h'],
          rawArgv: [],
          terminalRuntime: null,
        }) satisfies CommandContext),
      ).rejects.toThrow('exit:0');

      expect(execFileSyncSpy).toHaveBeenCalledWith(
        runtimePath,
        [claudePath, '--help'],
        expect.objectContaining({ encoding: 'utf8', windowsHide: true }),
      );

      exitSpy.mockRestore();
      logSpy.mockRestore();
    } finally {
      rmSync(root, { recursive: true, force: true });
      delete process.env.HAPPIER_CLAUDE_PATH;
    }
  });

  it('fails closed when a JS Claude CLI override has no valid JS runtime under bun', async () => {
    runtimeState.isBun = true;
    const root = join(tmpdir(), `happier-claude-help-missing-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const claudePath = join(root, 'claude.mjs');
    mkdirSync(root, { recursive: true });
    writeFileSync(claudePath, '', 'utf8');
    process.env.HAPPIER_CLAUDE_PATH = claudePath;
    process.env.HAPPIER_JS_RUNTIME_PATH = join(
      root,
      'missing-node',
    );

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
      throw new Error(`exit:${code ?? 0}`);
    });
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map((value) => String(value)).join(' '));
    });

    await expect(
      handleClaudeCliCommand(({
        args: ['-h'],
        rawArgv: [],
        terminalRuntime: null,
      }) satisfies CommandContext),
    ).rejects.toThrow('exit:1');

    expect(execFileSyncSpy).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('HAPPIER_CLAUDE_PATH');

    exitSpy.mockRestore();
    logSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it('surfaces centralized missing-cli guidance without invoking legacy npm detection when Claude is unavailable', async () => {
    const root = join(tmpdir(), `happier-claude-help-missing-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const runtimePath = join(root, process.platform === 'win32' ? 'node.cmd' : 'node');
    mkdirSync(root, { recursive: true });
    writeFileSync(runtimePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(runtimePath, 0o755);
    process.env.HAPPIER_JS_RUNTIME_PATH = runtimePath;
    process.env.PATH = root;
    process.env.HOME = root;
    runtimeState.isBun = true;

    try {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
        throw new Error(`exit:${code ?? 0}`);
      });
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.map((value) => String(value)).join(' '));
      });

      await expect(
        handleClaudeCliCommand(({
          args: ['-h'],
          rawArgv: [],
          terminalRuntime: null,
        }) satisfies CommandContext),
      ).rejects.toThrow('exit:0');

      expect(execFileSyncSpy).not.toHaveBeenCalled();
      expect(logs.join('\n')).toContain('Claude CLI (claude) is not available from any configured source');
      expect(logs.join('\n')).not.toContain('npm: not found');

      exitSpy.mockRestore();
      logSpy.mockRestore();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed for an invalid explicit HAPPIER_CLAUDE_PATH override on --help', async () => {
    const root = join(tmpdir(), `happier-claude-help-invalid-override-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const runtimePath = join(root, process.platform === 'win32' ? 'node.cmd' : 'node');
    mkdirSync(root, { recursive: true });
    writeFileSync(runtimePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(runtimePath, 0o755);
    process.env.HAPPIER_JS_RUNTIME_PATH = runtimePath;
    process.env.HAPPIER_CLAUDE_PATH = join(root, 'missing-claude');
    process.env.PATH = root;
    process.env.HOME = root;
    runtimeState.isBun = true;

    try {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
        throw new Error(`exit:${code ?? 0}`);
      });
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.map((value) => String(value)).join(' '));
      });

      await expect(
        handleClaudeCliCommand(({
          args: ['-h'],
          rawArgv: [],
          terminalRuntime: null,
        }) satisfies CommandContext),
      ).rejects.toThrow('exit:1');

      expect(execFileSyncSpy).not.toHaveBeenCalled();
      expect(logs.join('\n')).toContain('HAPPIER_CLAUDE_PATH');

      exitSpy.mockRestore();
      logSpy.mockRestore();
    } finally {
      rmSync(root, { recursive: true, force: true });
      delete process.env.HAPPIER_CLAUDE_PATH;
    }
  });
});
