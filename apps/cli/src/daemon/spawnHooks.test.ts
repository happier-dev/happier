import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as daemonSpawnHooks from './spawnHooks';

function readSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('daemon spawn hook substrate', () => {
  it('keeps the daemon hook contract provider-neutral', () => {
    const source = readSource('./spawnHooks.ts');

    expect(source).not.toMatch(/\bCodex\b/);
    expect(source).not.toMatch(/\bcodexBackendMode\b/);
    expect(source).not.toMatch(/@happier-dev\/plugins-codex/);
    expect(source).not.toMatch(/@\/backends\/codex/);
    expect(source).not.toMatch(/@\/capabilities\/deps\/codexAcp/);
  });

  it('keeps child environment resolution free of Codex branches and env shaping', () => {
    const source = readSource('./spawn/resolveSpawnChildEnvironment.ts');

    expect(source).not.toMatch(/@happier-dev\/plugins-codex/);
    expect(source).not.toMatch(/agentId\s*={2,3}\s*['"]codex['"]/);
    expect(source).not.toMatch(/\bcodexBackendMode\b/);
    expect(source).not.toContain('HAPPIER_CODEX_BACKEND_MODE');
  });

  it('creates typed diagnostics for unavailable managed installables', async () => {
    const createContext = (daemonSpawnHooks as Readonly<Record<string, unknown>>).createDaemonSpawnToolResolutionContext;
    expect(createContext).toBeTypeOf('function');
    if (typeof createContext !== 'function') return;

    const context = createContext({
      processEnv: {},
      signal: new AbortController().signal,
      logInfo: () => {},
      logWarn: () => {},
    }) as {
      resolveManagedInstallable(input: {
        installableId: string;
        reason: string;
      }): Promise<unknown>;
    };

    await expect(context.resolveManagedInstallable({
      installableId: 'dep.not-real',
      reason: 'unit-test missing installable',
    })).resolves.toMatchObject({
      ok: false,
      reasonCode: 'installable_unavailable',
    });
  });

  it('resolves system tools from PATH without invoking package managers', async () => {
    const createContext = (daemonSpawnHooks as Readonly<Record<string, unknown>>).createDaemonSpawnToolResolutionContext;
    expect(createContext).toBeTypeOf('function');
    if (typeof createContext !== 'function') return;

    const root = await mkdtemp(join(tmpdir(), 'happier-daemon-spawn-tools-'));
    try {
      const binDir = join(root, 'bin');
      const command = process.platform === 'win32' ? 'sample-tool.cmd' : 'sample-tool';
      const binPath = join(binDir, command);
      await mkdir(binDir, { recursive: true });
      await writeFile(binPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
      if (process.platform !== 'win32') {
        await chmod(binPath, 0o755);
      }

      const context = createContext({
        processEnv: { PATH: binDir },
        signal: new AbortController().signal,
        logInfo: () => {},
        logWarn: () => {},
      }) as {
        resolveSystemTool(input: {
          toolId: string;
          lookupNames?: readonly string[];
          reason: string;
        }): Promise<unknown>;
      };

      const resolved = await context.resolveSystemTool({
        toolId: 'sample-tool',
        lookupNames: ['sample-tool'],
        reason: 'unit-test system tool resolution',
      });

      expect(resolved).toMatchObject({
        ok: true,
        source: 'system',
      });
      await expect(access(join(dirname(binPath), command))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
