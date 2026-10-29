import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { resolveExecutableCommand } from './resolveExecutableCommand.js';

describe('resolveExecutableCommand subprocess lookup fidelity', () => {
  it.runIf(process.platform !== 'win32').each(['PATH', 'relative', 'absolute'] as const)(
    'preserves physical symlink traversal for %s command lookup', async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'happier-executable-lookup-'));
      try {
        const cwd = join(root, 'workspace');
        const actual = join(root, 'actual');
        await mkdir(cwd);
        await mkdir(join(actual, 'deep'), { recursive: true });
        await mkdir(join(actual, 'bin'));
        await symlink(join(actual, 'deep'), join(cwd, 'link'), 'dir');
        const runner = join(actual, 'bin', 'npx');
        await writeFile(runner, '#!/bin/sh\nprintf actual\n');
        await chmod(runner, 0o755);
        await mkdir(join(cwd, 'bin'));
        const wrongRunner = join(cwd, 'bin', 'npx');
        await writeFile(wrongRunner, '#!/bin/sh\nprintf wrong-lexical-runner\n');
        await chmod(wrongRunner, 0o755);
        const relative = './link/../bin/npx';
        const command = kind === 'PATH' ? 'npx' : kind === 'relative' ? relative : `${cwd}/${relative}`;
        const env = { PATH: './link/../bin' };
        const original = spawnSync(command, [], { cwd, env, encoding: 'utf8' });
        expect(original.status).toBe(0);
        expect(original.stdout).toBe('actual');
        const resolved = resolveExecutableCommand(command, { cwd, env });
        expect(resolved).not.toBeNull();
        const selected = spawnSync(resolved!, [], { cwd, env, encoding: 'utf8' });
        expect(selected.status).toBe(0);
        expect(selected.stdout).toBe(original.stdout);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')('uses the subprocess platform default PATH when the environment omits PATH', () => {
    // Node v24.21.0 child_process contract: env without PATH searches /usr/bin:/bin on Unix.
    const env = {};
    const original = spawnSync('sh', ['-c', 'printf default-path'], { env, encoding: 'utf8' });
    expect(original.status).toBe(0);
    const resolved = resolveExecutableCommand('sh', { env });
    expect(resolved).not.toBeNull();
    const selected = spawnSync(resolved!, ['-c', 'printf default-path'], { env, encoding: 'utf8' });
    expect(selected.status).toBe(original.status);
    expect(selected.stdout).toBe('default-path');
  });
  it.runIf(process.platform !== 'win32')('keeps an explicitly empty PATH scoped to the child cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-empty-path-'));
    try {
      const command = 'happier-test-command';
      await writeFile(join(cwd, command), '#!/bin/sh\nprintf child-cwd\n');
      await chmod(join(cwd, command), 0o755);
      const env = { PATH: '' };
      expect(spawnSync(command, [], { cwd, env, encoding: 'utf8' }).stdout).toBe('child-cwd');
      const resolved = resolveExecutableCommand(command, { cwd, env });
      expect(resolved).not.toBeNull();
      expect(spawnSync(resolved!, [], { cwd, env, encoding: 'utf8' }).stdout).toBe('child-cwd');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses the current Windows process PATH when the supplied environment omits it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-windows-default-path-'));
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      const command = join(root, 'happier-test-command.cmd');
      await writeFile(command, '@echo off\r\n');
      vi.stubEnv('PATH', root);
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      expect(resolveExecutableCommand('happier-test-command', { env: {} })).toBe(command);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

});
