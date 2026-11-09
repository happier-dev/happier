import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { resolveAgentCliManagedCommandPathForRuntime } from '@happier-dev/cli-common/agents';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';

import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';

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
  it('resolves every declared Agent CLI tool through its canonical runtime without PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-preflight-managed-tools-'));
    try {
      const snapshot = readAgentCatalogSnapshot();
      const agents = [...snapshot.agentDefinitionsById.values()].filter((agent) => (
        agent.runtimeSpec && agent.catalogEntry?.agentCliSystemTool
      ));
      expect(agents.some((agent) => agent.id === 'ohMyPi')).toBe(true);
      for (const agent of agents) {
        const runtimeSpec = agent.runtimeSpec!;
        const managed = Boolean(runtimeSpec.managedInstall);
        const command = managed
          ? resolveAgentCliManagedCommandPathForRuntime(runtimeSpec, { happyHomeDir: root })
          : join(root, 'overrides', agent.id.replaceAll('/', '_'), process.platform === 'win32' ? 'fixture.cmd' : 'fixture');
        await mkdir(dirname(command), { recursive: true });
        await writeFile(command, '#!/bin/sh\nexit 0\n');
        await chmod(command, 0o755);
        const context = daemonSpawnHooks.createDaemonSpawnToolResolutionContext({
          processEnv: { PATH: '', HAPPIER_HOME_DIR: root, HAPPIER_JS_RUNTIME_PATH: process.execPath,
            ...(managed ? {} : { [resolveAgentCliOverrideEnvKey(runtimeSpec.id)]: command }) },
        });
        const toolId = agent.catalogEntry!.agentCliSystemTool!.toolId;
        for (const lookupId of [toolId, `${agent.pluginId}/${toolId}`]) {
          const resolved = await context.resolveSystemTool({
            toolId: lookupId, reason: 'Declared managed Agent prerequisite',
          });
          expect(resolved, `${agent.id}: ${lookupId}`).toMatchObject({ ok: true, source: managed ? 'managed' : 'user_config' });
          if (resolved.ok) expect([resolved.command, ...resolved.args]).toContain(command);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves a declared absolute system tool without PATH', async () => {
    const context = daemonSpawnHooks.createDaemonSpawnToolResolutionContext({ processEnv: { PATH: '' } });
    await expect(context.resolveSystemTool({
      toolId: 'fixture/native', lookupNames: [process.execPath], reason: 'Declared native executable',
    })).resolves.toMatchObject({ ok: true, command: process.execPath, source: 'system' });
  });

  it('runs a JavaScript Agent override without system Node on PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-preflight-js-'));
    try {
      const script = join(root, 'claude.cjs');
      await writeFile(script, '#!/usr/bin/env node\nprocess.stdout.write("selected-agent");\n');
      await chmod(script, 0o755);
      const context = daemonSpawnHooks.createDaemonSpawnToolResolutionContext({
        processEnv: { PATH: '', HAPPIER_CLAUDE_PATH: script, HAPPIER_JS_RUNTIME_PATH: process.execPath },
      });
      await expect(context.runSystemTool({ toolId: 'claude', reason: 'Agent prerequisite', timeoutMs: 2_000 }))
        .resolves.toMatchObject({ ok: true, exitCode: 0, stdout: 'selected-agent' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('selects the Agent executable from the supplied environment before running it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-preflight-env-'));
    try {
      const script = join(root, 'claude.cjs');
      await writeFile(script, '#!/usr/bin/env node\nprocess.stdout.write("profile-agent");\n');
      await chmod(script, 0o755);
      const context = daemonSpawnHooks.createDaemonSpawnToolResolutionContext({ processEnv: { PATH: '' } });
      await expect(context.runSystemTool({
        toolId: 'claude', reason: 'Selected Agent prerequisite', timeoutMs: 2_000,
        env: { HAPPIER_CLAUDE_PATH: script, HAPPIER_JS_RUNTIME_PATH: process.execPath },
      })).resolves.toMatchObject({ ok: true, exitCode: 0, stdout: 'profile-agent' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
      const laterBinDir = join(root, 'later-bin');
      await mkdir(binDir, { recursive: true });
      await mkdir(laterBinDir, { recursive: true });
      await writeFile(binPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
      await writeFile(join(laterBinDir, command), process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
      if (process.platform !== 'win32') {
        await chmod(binPath, 0o755);
      }

      const context = createContext({
        processEnv: { PATH: `${binDir}${delimiter}${laterBinDir}` },
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
        command: binPath,
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

  it('keeps bounded system-tool output on a UTF-8 character boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-daemon-spawn-utf8-output-'));
    const maximumBytes = 2_000;
    const head = 'a'.repeat(maximumBytes - 1);
    try {
      const outputScript = join(root, 'emit-utf8-output.cjs');
      await writeFile(
        outputScript,
        `process.stdout.write(${JSON.stringify(`${head}🙂`)}); process.stderr.write(${JSON.stringify(`${head}🙂`)});`,
        'utf8',
      );

      const command = basename(process.execPath);
      const context = daemonSpawnHooks.createDaemonSpawnToolResolutionContext({
        processEnv: { PATH: dirname(process.execPath) },
        signal: new AbortController().signal,
        logInfo: () => {},
        logWarn: () => {},
      });
      const result = await context.runSystemTool({
        toolId: command,
        lookupNames: [command],
        args: [outputScript],
        reason: 'unit-test UTF-8 output bound',
        timeoutMs: 2_000,
        maxStdoutBytes: maximumBytes,
        maxStderrBytes: maximumBytes,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (const text of [result.stdout, result.stderr]) {
        expect(text).toBe(head);
        expect(text).not.toContain('\uFFFD');
        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(maximumBytes);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
