import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  InstallableDependencyDescriptorSchema,
  resolveInstallablesRegistry,
  type InstallablesRegistry,
} from '@happier-dev/protocol/installables';

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

  it('resolves plugin-contributed installables from the spawn hook registry context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-daemon-spawn-plugin-installable-'));
    try {
      const binDir = join(root, 'bin');
      const command = process.platform === 'win32' ? 'acme-tool.cmd' : 'acme-tool';
      const binPath = join(binDir, command);
      await mkdir(binDir, { recursive: true });
      await writeFile(binPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
      if (process.platform !== 'win32') {
        await chmod(binPath, 0o755);
      }

      const descriptor = InstallableDependencyDescriptorSchema.parse({
        id: 'dep.acme-tool',
        key: 'dep.acme-tool',
        kind: 'dep',
        version: '1',
        capabilityId: 'dep.acme-tool',
        display: {
          name: 'Acme Tool',
        },
        description: 'Fixture installable contributed by a plugin',
        source: {
          kind: 'github_release_binary',
          repo: 'acme/tool',
        },
        binary: {
          commands: ['acme-tool'],
          systemFirst: true,
          managedFallback: false,
        },
        defaultPolicy: {
          autoInstallWhenNeeded: false,
          autoUpdateMode: 'notify',
        },
        consent: {
          install: 'required',
          update: 'required',
        },
      });
      const installablesRegistry = resolveInstallablesRegistry({
        bundledFirstPartyPlugins: [{
          owner: {
            provenance: 'bundled_first_party_plugin',
            ownerId: 'acme.plugin',
            pluginId: 'acme.plugin',
          },
          descriptor,
        }],
      });

      const contextParams = {
        processEnv: { PATH: binDir },
        signal: new AbortController().signal,
        installablesRegistry,
        logInfo: () => {},
        logWarn: () => {},
      } satisfies Parameters<typeof daemonSpawnHooks.createDaemonSpawnToolResolutionContext>[0] & {
        installablesRegistry: InstallablesRegistry;
      };
      const context = daemonSpawnHooks.createDaemonSpawnToolResolutionContext(contextParams);

      await expect(context.resolveManagedInstallable({
        installableId: 'dep.acme-tool',
        reason: 'unit-test plugin installable resolution',
      })).resolves.toMatchObject({
        ok: true,
        command: binPath,
        source: 'system',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it('resolves provider CLI overrides through the system-tool hook context', async () => {
    const createContext = (daemonSpawnHooks as Readonly<Record<string, unknown>>).createDaemonSpawnToolResolutionContext;
    expect(createContext).toBeTypeOf('function');
    if (typeof createContext !== 'function') return;

    const root = await mkdtemp(join(tmpdir(), 'happier-daemon-spawn-provider-tools-'));
    try {
      const claudePath = join(root, 'claude');
      await writeFile(claudePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
      if (process.platform !== 'win32') {
        await chmod(claudePath, 0o755);
      }

      const context = createContext({
        processEnv: { HAPPIER_CLAUDE_PATH: claudePath, PATH: '' },
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

      await expect(context.resolveSystemTool({
        toolId: 'claude',
        lookupNames: ['claude'],
        reason: 'unit-test provider CLI override resolution',
      })).resolves.toMatchObject({
        ok: true,
        command: claudePath,
        source: 'user_config',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs resolved system tools with bounded output for provider preflight hooks', async () => {
    const createContext = (daemonSpawnHooks as Readonly<Record<string, unknown>>).createDaemonSpawnToolResolutionContext;
    expect(createContext).toBeTypeOf('function');
    if (typeof createContext !== 'function') return;

    const root = await mkdtemp(join(tmpdir(), 'happier-daemon-spawn-run-tools-'));
    try {
      const binDir = join(root, 'bin');
      const command = process.platform === 'win32' ? 'models.cmd' : 'models';
      const binPath = join(binDir, command);
      await mkdir(binDir, { recursive: true });
      await writeFile(
        binPath,
        process.platform === 'win32'
          ? '@echo off\r\necho provider model\r\necho warning 1>&2\r\n'
          : '#!/bin/sh\necho "provider model"\necho "warning" 1>&2\n',
        'utf8',
      );
      if (process.platform !== 'win32') {
        await chmod(binPath, 0o755);
      }

      const context = createContext({
        processEnv: { PATH: binDir },
        signal: new AbortController().signal,
        logInfo: () => {},
        logWarn: () => {},
      }) as {
        runSystemTool(input: {
          toolId: string;
          lookupNames?: readonly string[];
          reason: string;
          timeoutMs?: number;
          maxStdoutBytes?: number;
          maxStderrBytes?: number;
        }): Promise<unknown>;
      };

      await expect(context.runSystemTool({
        toolId: 'models',
        lookupNames: ['models'],
        reason: 'unit-test provider preflight command',
        timeoutMs: 2_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
      })).resolves.toMatchObject({
        ok: true,
        exitCode: 0,
        stdout: expect.stringContaining('provider model'),
        stderr: expect.stringContaining('warning'),
        source: 'system',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
