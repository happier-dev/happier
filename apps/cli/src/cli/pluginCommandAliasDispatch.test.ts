import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';

import { reloadConfiguration } from '@/configuration';
import * as daemonControl from '@/daemon/controlClient';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { handlePluginCommandCliCommand } from './pluginCommandContributions';

const envScope = createEnvKeyScope([
  'HAPPIER_HOME_DIR', 'HAPPIER_DAEMON_STARTUP_SOURCE', 'HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK',
]);
let home: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  envScope.restore();
  reloadConfiguration();
  if (home) await removeTempDir(home);
});

it('dispatches a newly admitted Action CLI alias through the real installed registry', async () => {
  home = await createTempDir('happier-action-cli-alias-');
  envScope.patch({
    HAPPIER_HOME_DIR: home,
    // A service-managed caller never starts a daemon. Its transport is the
    // only substituted boundary; ownership and command admission stay real.
    HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
    HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: '0',
  });
  reloadConfiguration();

  const pluginRoot = join(home, 'alias-plugin');
  const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
  const manifest = PluginManifestV2Schema.parse(createPluginManifestV2Fixture({
    id: 'acme.alias-dispatch',
    contributes: { actions: [{
      id: 'add', title: 'Add note', scopes: ['global'], surfaces: ['cli'],
      execution: { target: 'daemon' }, dangerLevel: 'safe',
      inputSchema: {
        type: 'object', properties: { value: { type: 'string' } },
        required: ['value'], additionalProperties: false,
      },
      cli: { path: ['notes', 'add'] },
    }] },
  }));
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(pluginRoot, 'daemon.mjs'), 'throw new Error("CLI discovery must not load plugin execution code");\nexport function activate() {}\n');
  await seedCurrentLocalPathPluginFixture({
    happyHomeDir: home, pluginRoot, pluginId: manifest.id, manifestVersion: manifest.version, devWatch: true,
  });

  // This facade is the daemon network boundary; the registry, parsers,
  // availability evaluator and daemon ownership path are not mocked.
  const execute = vi.spyOn(daemonControl, 'requestDaemonPluginActionExecution').mockResolvedValue({
    matched: true, result: { ok: true, result: { stored: 'hello' } },
  });
  const invokeAlias = async (args = ['memo', 'add', '--value', 'hello', '--json']) => {
    const output = captureStdoutJsonOutput<unknown>();
    const previousExitCode = process.exitCode;
    try {
      await handlePluginCommandCliCommand('memo', {
        args,
        rawArgv: ['happier', ...args],
        terminalRuntime: null,
      });
      return output.json();
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  };

  // Without the alias producer, the real command path refuses dispatch.
  expect(await invokeAlias()).toMatchObject({
    ok: false, kind: 'plugin_command', error: { code: 'plugin_command_unknown' },
  });
  expect(execute).not.toHaveBeenCalled();

  const aliasedManifest = PluginManifestV2Schema.parse({
    ...manifest,
    contributes: { ...manifest.contributes, actions: manifest.contributes.actions.map(action => ({
      ...action, cli: { path: ['notes', 'add'], aliases: [['memo', 'add']] },
    })) },
  });
  await writeFile(manifestPath, JSON.stringify(aliasedManifest));
  await seedCurrentLocalPathPluginFixture({
    happyHomeDir: home, pluginRoot, pluginId: manifest.id, manifestVersion: manifest.version,
    devWatch: true, replaceExisting: true,
  });

  expect(await invokeAlias()).toMatchObject({
    ok: true, kind: 'plugin_command',
    data: { commandId: 'acme.alias-dispatch/add', actionId: 'acme.alias-dispatch/add', result: { stored: 'hello' } },
  });
  expect(execute).toHaveBeenCalledExactlyOnceWith({
    actionId: 'acme.alias-dispatch/add', input: { value: 'hello' }, surface: 'cli',
  });
  expect(await invokeAlias(['memo', 'add', '--input', '{}', '--json'])).toMatchObject({
    ok: false, kind: 'plugin_command', error: { code: 'plugin_command_arguments_invalid' },
  });
  expect(execute).toHaveBeenCalledTimes(1);
});
