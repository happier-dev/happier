import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncInstalledFirstPartyShimsResult } from '@happier-dev/cli-common/firstPartyRuntime';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, '');
}

describe('happier setup', () => {
  let output = captureConsoleLogAndMuteStdout();
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_ACTIVE_SERVER_ID',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);

  beforeEach(() => {
    output.restore();
    output = captureConsoleLogAndMuteStdout();
  });

  afterEach(() => {
    output.restore();
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.resetModules();
  });

  async function importHandleSetupCommand(): Promise<typeof import('./setup')> {
    return await import('./setup');
  }

  it('prints a setup_plan JSON envelope', async () => {
    await withTempDir('happier-setup-plan-json-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://api.happier.dev', HAPPIER_ACTIVE_SERVER_ID: undefined });
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();
      await handleSetupCommand(['plan', '--relay-url', 'https://relay.example.test', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('setup_plan');
      expect(parsed.data?.relayUrl).toBe('https://relay.example.test');
      expect(Array.isArray(parsed.data?.steps)).toBe(true);
      expect(parsed.data.steps.length).toBeGreaterThan(0);
    });
  });

  it('renders --help output as a structured help page', async () => {
    await withTempDir('happier-setup-help-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://api.happier.dev', HAPPIER_ACTIVE_SERVER_ID: undefined });
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();
      await handleSetupCommand(['--help']);
      const text = stripAnsi(output.logs.join('\n'));
      expect(text).toContain('setup');
      expect(text).toContain('Guided setup');
      expect(text).toContain('Usage:');
      expect(text).toContain('happier setup plan');
      expect(text).toContain('Examples:');
      expect(text).toContain('Notes:');
      expect(text).toContain('Sets up this computer for a server');
      expect(text).not.toContain('Sets up this computer for a Relay');
      expect(text).not.toContain('Description:');
    });
  });

  it('prints a numbered setup plan in non-JSON plan mode', async () => {
    await withTempDir('happier-setup-plan-text-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://api.happier.dev', HAPPIER_ACTIVE_SERVER_ID: undefined });
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();
      await handleSetupCommand(['plan', '--relay-url', 'https://relay.example.test']);
      const text = stripAnsi(output.logs.join('\n'));
      expect(output.logs[0]?.startsWith('\n')).toBe(false);
      expect(text).toContain('Setup plan');
      expect(text).toContain('Server:');
      expect(text).toContain('https://relay.example.test');
      expect(text).toContain('1. happier auth login');
    });
  });

  it('executes the setup steps (server selection → auth → daemon → providers) in non-interactive mode when --yes is provided', async () => {
    await withTempDir('happier-setup-run-noninteractive-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://api.happier.dev', HAPPIER_ACTIVE_SERVER_ID: undefined });
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();

      const calls: string[][] = [];
      const applyServerSelectionFromArgs = async (args: string[]) => {
        expect(args).toEqual([
          '--server-url',
          'https://relay.example.test',
          '--persist',
          '--yes',
        ]);
        return ['--yes'];
      };

      await handleSetupCommand(
        ['--relay-url', 'https://relay.example.test', '--yes'],
        {
          applyServerSelectionFromArgs,
          readCredentialsFn: async () => null,
          isInteractiveTerminalFn: () => false,
          promptInputFn: async () => {
            throw new Error('prompt should not be used');
          },
          runHappyCliStepFn: async (argv) => {
            calls.push([...argv]);
            return 0;
          },
        },
      );

      expect(calls).toEqual([
        ['auth', 'login'],
        ['service', 'install'],
        ['providers', 'setup', '--yes'],
      ]);
    });
  });

  it('skips auth when credentials already exist', async () => {
    await withTempDir('happier-setup-skip-auth-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://api.happier.dev', HAPPIER_ACTIVE_SERVER_ID: undefined });
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();

      const calls: string[][] = [];
      await handleSetupCommand(
        ['--relay-url', 'https://relay.example.test', '--yes', '--skip-daemon'],
        {
          applyServerSelectionFromArgs: async (args) => args,
          readCredentialsFn: async () => ({ encryption: { type: 'legacy', secret: new Uint8Array([1]) }, token: 't' } as any),
          readSettingsFn: async () => ({ machineId: 'mid_123' } as any),
          isInteractiveTerminalFn: () => false,
          promptInputFn: async () => {
            throw new Error('prompt should not be used');
          },
          runHappyCliStepFn: async (argv) => {
            calls.push([...argv]);
            return 0;
          },
        },
      );

      expect(calls).toEqual([
        ['providers', 'setup', '--yes'],
      ]);
    });
  });

  it('runs auth when credentials exist but machine is not registered', async () => {
    await withTempDir('happier-setup-auth-when-machine-missing-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://api.happier.dev', HAPPIER_ACTIVE_SERVER_ID: undefined });
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();

      const calls: string[][] = [];
      await handleSetupCommand(
        ['--relay-url', 'https://relay.example.test', '--yes', '--skip-daemon'],
        {
          applyServerSelectionFromArgs: async (args) => args,
          readCredentialsFn: async () => ({ encryption: { type: 'legacy', secret: new Uint8Array([1]) }, token: 't' } as any),
          readSettingsFn: async () => ({ machineId: null } as any),
          isInteractiveTerminalFn: () => false,
          promptInputFn: async () => {
            throw new Error('prompt should not be used');
          },
          runHappyCliStepFn: async (argv) => {
            calls.push([...argv]);
            return 0;
          },
        },
      );

      expect(calls).toEqual([
        ['auth', 'login'],
        ['providers', 'setup', '--yes'],
      ]);
    });
  });

  it('does not force persistence when relay-url already matches the active server selection', async () => {
    await withTempDir('happier-setup-no-persist-when-already-selected-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://relay.example.test', HAPPIER_ACTIVE_SERVER_ID: undefined });
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();

      const calls: string[][] = [];
      const applyServerSelectionFromArgs = async (args: string[]) => {
        expect(args).toEqual([
          '--server-url',
          'https://relay.example.test',
          '--yes',
          '--skip-daemon',
        ]);
        return ['--yes', '--skip-daemon'];
      };

      await handleSetupCommand(
        ['--relay-url', 'https://relay.example.test', '--yes', '--skip-daemon'],
        {
          applyServerSelectionFromArgs,
          readCredentialsFn: async () => ({ encryption: { type: 'legacy', secret: new Uint8Array([1]) }, token: 't' } as any),
          readSettingsFn: async () => ({ machineId: 'mid_123' } as any),
          isInteractiveTerminalFn: () => false,
          promptInputFn: async () => {
            throw new Error('prompt should not be used');
          },
          runHappyCliStepFn: async (argv) => {
            calls.push([...argv]);
            return 0;
          },
        },
      );

      expect(calls).toEqual([
        ['providers', 'setup', '--yes'],
      ]);
    });
  });

  it('does not reselect the relay or re-prompt auth when relay-url already matches the active server selection', async () => {
    await withTempDir('happier-setup-no-reselect-current-relay-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://relay.example.test', HAPPIER_ACTIVE_SERVER_ID: undefined });
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();

      const calls: string[][] = [];
      await handleSetupCommand(
        ['--relay-url', 'https://relay.example.test', '--yes', '--skip-daemon'],
        {
          applyServerSelectionFromArgs: async () => {
            throw new Error('relay selection should not be re-applied when the relay URL already matches the active server');
          },
          readCredentialsFn: async () => ({ encryption: { type: 'legacy', secret: new Uint8Array([1]) }, token: 't' } as any),
          readSettingsFn: async () => ({ machineId: 'mid_123' } as any),
          isInteractiveTerminalFn: () => false,
          promptInputFn: async () => {
            throw new Error('prompt should not be used');
          },
          runHappyCliStepFn: async (argv) => {
            calls.push([...argv]);
            return 0;
          },
        },
      );

      expect(calls).toEqual([
        ['providers', 'setup', '--yes'],
      ]);
    });
  });

  it('guides default release-channel switching and background-service replacement before daemon setup', async () => {
    await withTempDir('happier-setup-guided-daemon-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://relay.example.test', HAPPIER_ACTIVE_SERVER_ID: undefined });
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();

      const calls: string[][] = [];
      const writeDefaultManagedReleaseChannelFn: typeof import('@happier-dev/cli-common/firstPartyRuntime').writeDefaultManagedReleaseChannel = vi.fn(async () => ({
        releaseChannel: 'preview' as const,
        statePath: `${homeDir}/default-cli-release-channel.json`,
      }));
      const syncInstalledFirstPartyShimsFn = vi.fn(async (): Promise<SyncInstalledFirstPartyShimsResult> => ({
        shimPaths: [`${homeDir}/bin/happier`],
      }));
      const promptInputFn = vi.fn<(prompt: string) => Promise<string>>()
        .mockResolvedValueOnce('y')
        .mockResolvedValueOnce('y');

      await handleSetupCommand(
        ['--relay-url', 'https://relay.example.test', '--yes'],
        {
          applyServerSelectionFromArgs: async (args) => args,
          readCredentialsFn: async () => ({ encryption: { type: 'legacy', secret: new Uint8Array([1]) }, token: 't' } as any),
          readSettingsFn: async () => ({ machineId: 'mid_123' } as any),
          isInteractiveTerminalFn: () => true,
          promptInputFn,
          readBackgroundServiceSetupGuidanceFn: async () => ({
            targetReleaseChannel: 'preview',
            targetServerUrl: 'https://relay.example.test',
            currentDefaultReleaseChannel: 'stable',
            managedReleaseChannels: [
              {
                releaseChannel: 'stable',
                label: 'stable',
                version: '1.0.0',
                installationId: 'stable-install',
                installationPath: '/managed/stable',
                invokerName: 'happier',
                isDefault: true,
                onPath: true,
              },
              {
                releaseChannel: 'preview',
                label: 'preview',
                version: '2.0.0',
                installationId: 'preview-install',
                installationPath: '/managed/preview',
                invokerName: 'hprev',
                isDefault: false,
                onPath: true,
              },
            ],
            exactDefaultServiceExists: false,
            conflictingServices: [
              {
                label: 'com.happier.cli.daemon.stable.default',
                releaseChannel: 'stable',
                targetMode: 'pinned',
                running: true,
                serverUrl: 'https://relay.example.test',
              },
            ],
            shouldOfferDefaultReleaseChannelSwitch: true,
            shouldPromptForServiceReplacement: true,
          }),
          writeDefaultManagedReleaseChannelFn,
          syncInstalledFirstPartyShimsFn,
          runHappyCliStepFn: async (argv) => {
            calls.push([...argv]);
            return 0;
          },
        },
      );

      expect(promptInputFn).toHaveBeenNthCalledWith(
        1,
        'Make preview the default release-channel before installing the default background service targeting https://relay.example.test? [Y/n] ',
      );
      expect(promptInputFn).toHaveBeenNthCalledWith(
        2,
        'This computer already has conflicting Happier background services. Replace them before installing the default background service targeting https://relay.example.test? [Y/n] ',
      );
      expect(writeDefaultManagedReleaseChannelFn).toHaveBeenCalledWith({
        processEnv: process.env,
        releaseChannel: 'preview',
      });
      expect(syncInstalledFirstPartyShimsFn).toHaveBeenCalledWith({
        componentId: 'happier-cli',
        channel: 'preview',
        processEnv: process.env,
      });
      expect(calls).toEqual([
        ['service', 'uninstall', '--all', '--yes'],
        ['service', 'install'],
        ['providers', 'setup', '--yes'],
      ]);
    });
  });

  it('reuses an exact default background service instead of reinstalling it during setup', async () => {
    await withTempDir('happier-setup-reuse-default-background-service-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://relay.example.test', HAPPIER_ACTIVE_SERVER_ID: undefined });
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();

      const calls: string[][] = [];
      await handleSetupCommand(
        ['--relay-url', 'https://relay.example.test', '--yes'],
        {
          applyServerSelectionFromArgs: async (args) => args,
          readCredentialsFn: async () => ({ encryption: { type: 'legacy', secret: new Uint8Array([1]) }, token: 't' } as any),
          readSettingsFn: async () => ({ machineId: 'mid_123' } as any),
          isInteractiveTerminalFn: () => false,
          promptInputFn: async () => {
            throw new Error('prompt should not be used');
          },
          readBackgroundServiceSetupGuidanceFn: async () => ({
            targetReleaseChannel: 'stable',
            targetServerUrl: 'https://relay.example.test',
            currentDefaultReleaseChannel: 'stable',
            managedReleaseChannels: [
              {
                releaseChannel: 'stable',
                label: 'stable',
                version: '1.0.0',
                installationId: 'stable-install',
                installationPath: '/managed/stable',
                invokerName: 'happier',
                isDefault: true,
                onPath: true,
              },
            ],
            exactDefaultServiceExists: true,
            conflictingServices: [],
            shouldOfferDefaultReleaseChannelSwitch: false,
            shouldPromptForServiceReplacement: false,
          }),
          runHappyCliStepFn: async (argv) => {
            calls.push([...argv]);
            return 0;
          },
        },
      );

      expect(calls).toEqual([
        ['providers', 'setup', '--yes'],
      ]);
    });
  });

  it('fails closed in non-interactive mode when guided daemon setup needs release-channel or service decisions', async () => {
    await withTempDir('happier-setup-guided-noninteractive-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://relay.example.test', HAPPIER_ACTIVE_SERVER_ID: undefined });
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();

      await expect(handleSetupCommand(
        ['--relay-url', 'https://relay.example.test', '--yes'],
        {
          applyServerSelectionFromArgs: async (args) => args,
          readCredentialsFn: async () => ({ encryption: { type: 'legacy', secret: new Uint8Array([1]) }, token: 't' } as any),
          readSettingsFn: async () => ({ machineId: 'mid_123' } as any),
          isInteractiveTerminalFn: () => false,
          promptInputFn: async () => {
            throw new Error('prompt should not be used');
          },
          readBackgroundServiceSetupGuidanceFn: async () => ({
            targetReleaseChannel: 'preview',
            targetServerUrl: 'https://relay.example.test',
            currentDefaultReleaseChannel: 'stable',
            managedReleaseChannels: [
              {
                releaseChannel: 'preview',
                label: 'preview',
                version: '2.0.0',
                installationId: 'preview-install',
                installationPath: '/managed/preview',
                invokerName: 'hprev',
                isDefault: false,
                onPath: true,
              },
            ],
            exactDefaultServiceExists: false,
            conflictingServices: [],
            shouldOfferDefaultReleaseChannelSwitch: true,
            shouldPromptForServiceReplacement: false,
          }),
          runHappyCliStepFn: async () => 0,
        },
      )).rejects.toThrow(/requires interactive guidance/i);
    });
  });
});
