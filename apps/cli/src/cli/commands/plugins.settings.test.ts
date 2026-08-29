import { describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

import { handlePluginsCommand } from './plugins';

describe('plugin Settings administration CLI', () => {
  it('advertises scope-selected Settings administration', async () => {
    // Help labels name the invoking invoker; pin the documented default lane
    // instead of inheriting the test runner's argv-derived invoker.
    const envScope = createEnvKeyScope(['HAPPIER_CLI_INVOKER_NAME']);
    envScope.patch({ HAPPIER_CLI_INVOKER_NAME: 'happier' });
    const output = captureConsoleText();
    try {
      await handlePluginsCommand(['help']);

      expect(output.text()).toContain(
        'happier plugins settings list <pluginId> --scope <account|daemon> [--machine <id>] [--json]',
      );
      expect(output.text()).toContain(
        'happier plugins settings secret status|bind|unbind|delete <pluginId> <localId> [--scope <account|daemon>] [--machine <id>]',
      );
    } finally {
      output.restore();
      envScope.restore();
    }
  });

  it('parses a non-secret compare-and-set mutation into the canonical Settings administration action', async () => {
    const executeSettingsAdministrationAction = vi.fn(async () => ({
      ok: true,
      kind: 'plugins.settings.set',
      data: { revision: '8' },
    }));
    const output = captureConsoleText();
    try {
      await handlePluginsCommand([
        'settings',
        'set',
        'acme.settings',
        'theme',
        '--scope',
        'account',
        '--value',
        '"dark"',
        '--expected-revision',
        '7',
        '--json',
      ], {
        executeSettingsAdministrationAction,
      } as never);

      expect(executeSettingsAdministrationAction).toHaveBeenCalledWith({
        actionId: 'plugins.settings.set',
        input: {
          pluginId: 'acme.settings',
          scope: { kind: 'account' },
          target: { kind: 'account' },
          localId: 'theme',
          value: 'dark',
          expectedRevision: '7',
        },
        signal: undefined,
      });
    } finally {
      output.restore();
    }
  });

  it('parses list, get, and reset through the same scope-selected action family', async () => {
    const executeSettingsAdministrationAction = vi.fn(async ({ actionId }: { actionId: string }) => ({
      ok: true,
      kind: actionId,
      data: {},
    }));
    const output = captureConsoleText();
    try {
      await handlePluginsCommand([
        'settings', 'list', 'acme.settings', '--scope', 'account', '--json',
      ], { executeSettingsAdministrationAction } as never);
      await handlePluginsCommand([
        'settings', 'get', 'acme.settings', 'theme', '--scope', 'account', '--json',
      ], { executeSettingsAdministrationAction } as never);
      await handlePluginsCommand([
        'settings', 'reset', 'acme.settings', 'theme', '--scope', 'account', '--expected-revision', '8', '--json',
      ], { executeSettingsAdministrationAction } as never);

      expect(executeSettingsAdministrationAction.mock.calls.map(([request]) => request)).toEqual([
        {
          actionId: 'plugins.settings.list',
          input: { pluginId: 'acme.settings', scope: { kind: 'account' }, target: { kind: 'account' } },
          signal: undefined,
        },
        {
          actionId: 'plugins.settings.get',
          input: {
            pluginId: 'acme.settings', scope: { kind: 'account' }, target: { kind: 'account' }, localId: 'theme',
          },
          signal: undefined,
        },
        {
          actionId: 'plugins.settings.reset',
          input: {
            pluginId: 'acme.settings', scope: { kind: 'account' }, target: { kind: 'account' }, localId: 'theme', expectedRevision: '8',
          },
          signal: undefined,
        },
      ]);
    } finally {
      output.restore();
    }
  });

  it('routes a daemon-custodied secret through one exact target without assigning it a Settings scope', async () => {
    const executeSettingsAdministrationAction = vi.fn(async () => ({
      ok: true,
      kind: 'plugins.settings.secret.status',
      data: { state: 'missing' },
    }));
    const resolvePluginInvocationLogTarget = vi.fn(async () => ({
      kind: 'selected' as const,
      target: { serverIdentityId: 'srv_settings_1', machineId: 'machine-1' },
    }));
    const output = captureConsoleText();
    try {
      await handlePluginsCommand([
        'settings', 'secret', 'status', 'acme.settings', 'daemon-token', '--machine', 'machine-1', '--json',
      ], {
        executeSettingsAdministrationAction,
        resolvePluginInvocationLogTarget,
      } as never);

      expect(executeSettingsAdministrationAction).toHaveBeenCalledWith({
        actionId: 'plugins.settings.secret.status',
        input: {
          pluginId: 'acme.settings',
          localId: 'daemon-token',
          secretDaemonTarget: { kind: 'daemon', serverIdentityId: 'srv_settings_1', machineId: 'machine-1' },
        },
        signal: undefined,
      });
    } finally {
      output.restore();
    }
  });

  it('rejects raw secret material and exits silently when its invocation is cancelled', async () => {
    const executeSettingsAdministrationAction = vi.fn();
    const output = captureConsoleText();
    try {
      await handlePluginsCommand([
        'settings', 'secret', 'status', 'acme.settings', 'token', '--value', '"raw"', '--json',
      ], { executeSettingsAdministrationAction } as never);
      expect(executeSettingsAdministrationAction).not.toHaveBeenCalled();
      expect(output.text()).toContain('secret_material_not_accepted');

      const controller = new AbortController();
      controller.abort(new Error('cancelled'));
      await handlePluginsCommand([
        'settings', 'list', 'acme.settings', '--scope', 'account', '--json',
      ], { executeSettingsAdministrationAction } as never, { signal: controller.signal });
      expect(executeSettingsAdministrationAction).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });
});
