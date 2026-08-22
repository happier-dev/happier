import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { handlePluginsCommand } from '@/cli/commands/plugins';

it('public plugins test --packed crosses authenticated daemon process, restart, and stale-incarnation boundaries', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-packed-command-source-'));
  const pluginId = 'acme.packed-command';
  const actionId = `${pluginId}/echo`;
  const envScope = createEnvKeyScope([
    'HAPPIER_STACK_TEST_AUTHORITY',
    'HAPPY_STACK_ALIAS',
    'TMUX',
    'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
    'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
    'HAPPIER_DAEMON_SERVICE_SERVER_URL',
  ]);
  envScope.patch({
    HAPPIER_STACK_TEST_AUTHORITY: 'must-not-leak',
    HAPPY_STACK_ALIAS: 'must-not-leak',
    TMUX: '/tmp/must-not-leak',
    HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'must-not-leak',
    HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'must-not-leak',
    HAPPIER_DAEMON_SERVICE_SERVER_URL: 'https://must-not-leak.invalid',
  });
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await mkdir(join(sourceRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(sourceRoot, 'daemon.mjs'), [
      'export async function activate(api) {',
      '  api.actions.register("echo", async (input, context) => ({',
      `    actionId: ${JSON.stringify(actionId)},`,
      '    surface: context.surface,',
      '    input,',
      '    runtimePid: process.pid,',
      '    inheritedAuthority: {',
      '      happierStack: process.env.HAPPIER_STACK_TEST_AUTHORITY ?? null,',
      '      happyStack: process.env.HAPPY_STACK_ALIAS ?? null,',
      '      tmux: process.env.TMUX ?? null,',
      '      lifecycleScope: process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID ?? null,',
      '      serviceInstance: process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID ?? null,',
      '      serviceServer: process.env.HAPPIER_DAEMON_SERVICE_SERVER_URL ?? null,',
      '    },',
      '  }));',
      '}',
      '',
    ].join('\n'), 'utf8');
    await writeFile(
      join(sourceRoot, '.happier-plugin', 'plugin.json'),
      JSON.stringify(createPluginManifestV2Fixture({
        id: pluginId,
        displayName: 'Acme Packed Command',
        activation: { events: [{ kind: 'startup' }] },
        contributes: {
          actions: [{
            id: 'echo',
            title: 'Echo Action',
            scopes: ['global'],
            surfaces: ['cli'],
            execution: { target: 'daemon' },
            placementBindings: ['commandPalette'],
            dangerLevel: 'safe',
          }],
        },
      }), null, 2),
      'utf8',
    );
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({
      name: 'acme-packed-command',
      version: '1.0.0',
      keywords: ['happier-plugin'],
      files: ['.happier-plugin', 'daemon.mjs'],
      happier: { manifest: '.happier-plugin/plugin.json' },
    }), 'utf8');

    const output = captureConsoleJsonOutput();
    try {
      await handlePluginsCommand(['test', sourceRoot, '--packed', '--json']);
    } finally {
      output.restore();
    }
    const result = output.json<{
      ok: boolean;
      kind: string;
      data?: {
        pluginId: string;
        invocation: {
          actionId: string;
          result: {
            actionId: string;
            surface: string;
            input: unknown;
            runtimePid: number;
            inheritedAuthority: Record<string, string | null>;
          };
        } | null;
        daemon: {
          authenticatedControl: boolean;
          initialPid: number;
          restartedPid: number;
          initialIncarnationId: string;
          restartedIncarnationId: string;
          staleIncarnationRejected: boolean;
        };
      };
      error?: unknown;
    }>();
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      kind: 'plugins_test',
      data: {
        pluginId,
        invocation: {
          actionId,
          result: {
            actionId,
            surface: 'cli',
            input: {},
            inheritedAuthority: {
              happierStack: null,
              happyStack: null,
              tmux: null,
              lifecycleScope: null,
              serviceInstance: null,
              serviceServer: null,
            },
          },
        },
        daemon: {
          authenticatedControl: true,
          staleIncarnationRejected: true,
        },
      },
    });
    expect(result.data).toBeDefined();
    expect(result.data?.invocation?.result.runtimePid).toBe(result.data?.daemon.restartedPid);
    expect(result.data?.daemon.initialPid).not.toBe(process.pid);
    expect(result.data?.daemon.restartedPid).not.toBe(process.pid);
    expect(result.data?.daemon.restartedPid).not.toBe(result.data?.daemon.initialPid);
    expect(result.data?.daemon.restartedIncarnationId).not.toBe(result.data?.daemon.initialIncarnationId);
    expect(process.exitCode).toBe(0);
  } finally {
    process.exitCode = previousExitCode;
    envScope.restore();
    await rm(sourceRoot, { recursive: true, force: true });
  }
}, 360_000);
