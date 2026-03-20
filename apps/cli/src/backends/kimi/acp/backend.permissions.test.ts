import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { PermissionMode } from '@/api/types';
import { createKimiBackend } from './backend';

type AcpBackendLike = {
  options: {
    args: string[];
  };
};

const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  HAPPIER_KIMI_PATH: process.env.HAPPIER_KIMI_PATH,
};

const TEMP_DIRS = new Set<string>();

function createFakeBin(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'happier-kimi-backend-'));
  TEMP_DIRS.add(dir);
  const isWindows = process.platform === 'win32';
  const binPath = join(dir, isWindows ? `${name}.cmd` : name);
  writeFileSync(binPath, isWindows ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n', 'utf8');
  if (!isWindows) chmodSync(binPath, 0o755);
  return binPath;
}

afterEach(() => {
  if (ORIGINAL_ENV.PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_ENV.PATH;
  if (ORIGINAL_ENV.HAPPIER_KIMI_PATH === undefined) delete process.env.HAPPIER_KIMI_PATH;
  else process.env.HAPPIER_KIMI_PATH = ORIGINAL_ENV.HAPPIER_KIMI_PATH;
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
  TEMP_DIRS.clear();
});

function getArgs(permissionMode: PermissionMode): string[] {
  process.env.PATH = '';
  process.env.HAPPIER_KIMI_PATH = createFakeBin('kimi');
  const backend = createKimiBackend({
    cwd: '/tmp',
    env: {},
    permissionMode,
  }) as unknown as AcpBackendLike;
  return backend.options.args;
}

function readAgentFilePath(args: string[]): string | null {
  const index = args.indexOf('--agent-file');
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

describe('Kimi ACP backend permissions', () => {
  it('fails closed when the Kimi CLI is unavailable', () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_KIMI_PATH;

    expect(() => createKimiBackend({ cwd: '/tmp', env: {} })).toThrow(/system install/i);
  });

  it.each([
    { mode: 'default', hasYolo: false, hasAgentFile: false },
    { mode: 'acceptEdits', hasYolo: false, hasAgentFile: false },
    { mode: 'safe-yolo', hasYolo: false, hasAgentFile: false },
    { mode: 'yolo', hasYolo: true, hasAgentFile: false },
    { mode: 'bypassPermissions', hasYolo: true, hasAgentFile: false },
    { mode: 'read-only', hasYolo: false, hasAgentFile: true },
    { mode: 'plan', hasYolo: false, hasAgentFile: true },
  ])('maps permissionMode="$mode" to expected Kimi CLI args', ({ mode, hasYolo, hasAgentFile }) => {
    const args = getArgs(mode as PermissionMode);

    expect(args.slice(0, 2)).toEqual(['--work-dir', '/tmp']);
    expect(args.includes('--yolo')).toBe(hasYolo);
    expect(args.includes('--agent-file')).toBe(hasAgentFile);
    expect(args[args.length - 1]).toBe('acp');

    const agentFilePath = readAgentFilePath(args);
    if (hasAgentFile) {
      expect(agentFilePath).toBeTruthy();
      expect(agentFilePath).toContain('readonly-agent.yaml');
    } else {
      expect(agentFilePath).toBeNull();
    }
  });

  it('resolves the CLI from options.env PATH when process PATH is empty', () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_KIMI_PATH;
    const binPath = createFakeBin('kimi');

    const backend = createKimiBackend({
      cwd: '/tmp',
      env: { PATH: dirname(binPath) },
      permissionMode: 'default',
    }) as unknown as { options: { command: string } };

    expect(backend.options.command).toBe(binPath);
  });

  it('does not attach MCP servers (Kimi ACP does not support MCP servers)', () => {
    const backend = createKimiBackend({
      cwd: '/tmp',
      env: {},
      permissionMode: 'default',
      mcpServers: {
        happier: { command: '/bin/echo', args: ['noop'] },
      },
    }) as unknown as { options: { mcpServers?: Record<string, unknown> } };

    expect(backend.options.mcpServers).toBeUndefined();
  });
});
