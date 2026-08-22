import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BackgroundServiceSetupGuidance } from '@happier-dev/cli-common/systemTasks';
import type { SyncInstalledFirstPartyShimsResult } from '@happier-dev/cli-common/firstPartyRuntime';
import type { ActiveServerStoredTokenValidationResult } from '@/auth/validateStoredAuthTokenAgainstActiveServer';
import { captureConsoleLogAndMuteStdout, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

const { getAgentCliSetupRecommendedIdsMock } = vi.hoisted(() => ({
  getAgentCliSetupRecommendedIdsMock: vi.fn(() => ['alpha', 'beta']),
}));

const { validateStoredAuthTokenAgainstActiveServerMock } = vi.hoisted(() => ({
  validateStoredAuthTokenAgainstActiveServerMock: vi.fn<
    (token: string) => Promise<ActiveServerStoredTokenValidationResult>
  >(async () => ({ state: 'valid', httpStatus: 200 })),
}));

vi.mock('@happier-dev/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/agents')>();
  return {
    ...actual,
    getAgentCliSetupRecommendedIds: getAgentCliSetupRecommendedIdsMock,
  };
});

vi.mock('@/auth/validateStoredAuthTokenAgainstActiveServer', () => ({
  validateStoredAuthTokenAgainstActiveServer: (token: string) => validateStoredAuthTokenAgainstActiveServerMock(token),
}));

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, '');
}

function createBackgroundServiceSetupGuidance(
  overrides: Partial<BackgroundServiceSetupGuidance> = {},
): BackgroundServiceSetupGuidance {
  return {
    targetReleaseChannel: 'stable',
    targetServerUrl: 'https://relay.example.test',
    currentHappierHomeDir: null,
    currentDefaultReleaseChannel: 'stable',
    managedReleaseChannels: [],
    manualRelayOwner: null,
    exactDefaultServiceExists: false,
    conflictingServices: [],
    foreignHomeConflictingServices: [],
    shouldOfferDefaultReleaseChannelSwitch: false,
    shouldPromptForManualRelayTakeover: false,
    shouldPromptForServiceReplacement: false,
    ...overrides,
  };
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
    'PATH',
    'HOME',
  ] as const;

/**
 * Agent CLI resolution honours a `HAPPIER_<AGENT>_PATH` override, and this
 * machine may have one exported. Clearing every override is what makes "no agent
 * is installed here" a property of the temp home rather than of the developer.
 */
function withoutAgentCliPathOverrides(): () => void {
  const cleared = Object.keys(process.env).filter((key) => /^HAPPIER_[A-Z0-9_]+_PATH$/u.test(key));
  const previous = cleared.map((key) => [key, process.env[key]] as const);
  for (const key of cleared) delete process.env[key];
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
  let envScope = createEnvKeyScope(envKeys);

  beforeEach(() => {
    output.restore();
    output = captureConsoleLogAndMuteStdout();
    validateStoredAuthTokenAgainstActiveServerMock.mockReset();
    validateStoredAuthTokenAgainstActiveServerMock.mockResolvedValue({ state: 'valid', httpStatus: 200 });
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
      output.restore();
      const jsonOutput = captureStdoutJsonOutput();
      try {
        await handleSetupCommand(['plan', '--relay-url', 'https://relay.example.test', '--json']);
        const parsed = jsonOutput.json<any>();
        expect(parsed.v).toBe(1);
        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('setup_plan');
        expect(parsed.data?.relayUrl).toBe('https://relay.example.test');
        expect(Array.isArray(parsed.data?.steps)).toBe(true);
        expect(parsed.data.steps.length).toBeGreaterThan(0);
      } finally {
        jsonOutput.restore();
        output = captureConsoleLogAndMuteStdout();
      }
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
      expect(text).toContain('happier setup --relay-url https://relay.example.test --provider alpha --provider beta');
      expect(text).not.toContain('happier setup --relay-url https://relay.example.test --provider codex --provider claude');
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

  it('applies an explicit relay with --yes, then stops before the human-approved auth step', async () => {
    await withTempDir('happier-setup-run-noninteractive-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://api.happier.dev', HAPPIER_ACTIVE_SERVER_ID: undefined });
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();

      const calls: string[][] = [];
      const previousExitCode = process.exitCode;
      const applyServerSelectionFromArgs = async (args: string[]) => {
        expect(args).toEqual([
          '--server-url',
          'https://relay.example.test',
          '--persist',
          '--yes',
        ]);
        return ['--yes'];
      };

      try {
        await handleSetupCommand(
          ['--relay-url', 'https://relay.example.test', '--yes'],
          {
            applyServerSelectionFromArgs,
            readCredentialsFn: async () => null,
            readBackgroundServiceSetupGuidanceFn: async () => createBackgroundServiceSetupGuidance(),
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

        expect(calls).toEqual([]);
        expect(stripAnsi(output.logs.join('\n'))).toContain('happier auth login');
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = previousExitCode;
      }
    });
  });

  it('writes nothing when --yes does not name a relay', async () => {
    await withTempDir('happier-setup-run-yes-needs-relay-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://api.happier.dev', HAPPIER_ACTIVE_SERVER_ID: undefined });
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();

      const applyServerSelectionFromArgs = vi.fn(async (args: string[]) => args);
      const runHappyCliStepFn = vi.fn(async () => 0);
      const previousExitCode = process.exitCode;
      try {
        await handleSetupCommand(['--yes'], {
          applyServerSelectionFromArgs,
          readCredentialsFn: async () => null,
          readSettingsFn: async () => ({ machineId: null } as any),
          isInteractiveTerminalFn: () => false,
          promptInputFn: async () => {
            throw new Error('prompt should not be used');
          },
          runHappyCliStepFn,
        });

        expect(applyServerSelectionFromArgs).not.toHaveBeenCalled();
        expect(runHappyCliStepFn).not.toHaveBeenCalled();
        expect(stripAnsi(output.logs.join('\n'))).toContain('choose a relay');
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = previousExitCode;
      }
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
        ['agents', 'setup', '--yes'],
      ]);
    });
  });

  it('stops --yes before auth when credentials exist but the machine is not registered', async () => {
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

      expect(calls).toEqual([]);
      expect(stripAnsi(output.logs.join('\n'))).toContain('happier auth login');
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
        ['agents', 'setup', '--yes'],
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
        ['agents', 'setup', '--yes'],
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
          readBackgroundServiceSetupGuidanceFn: async () => createBackgroundServiceSetupGuidance({
            targetReleaseChannel: 'preview',
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
            manualRelayOwner: {
              currentReleaseChannel: 'stable',
              currentCliVersion: '0.2.0',
            },
            exactDefaultServiceExists: false,
            conflictingServices: [
              {
                label: 'com.happier.cli.daemon.stable.default',
                releaseChannel: 'stable',
                targetMode: 'pinned',
                running: true,
                serverUrl: 'https://relay.example.test',
                happierHomeDir: homeDir,
              },
            ],
            shouldOfferDefaultReleaseChannelSwitch: true,
            shouldPromptForManualRelayTakeover: true,
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
        'This computer is currently using a temporary relay process for https://relay.example.test. Continue to stop that process and switch this computer to the background service? [Y/n] ',
      );
      expect(promptInputFn).toHaveBeenNthCalledWith(
        3,
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
        ['service', 'install', '--takeover'],
        ['service', 'start', '--takeover'],
        ['agents', 'setup', '--yes'],
      ]);
    });
  });

  it('starts the existing default background service with takeover instead of reinstalling it', async () => {
    await withTempDir('happier-setup-takeover-existing-default-background-service-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://relay.example.test', HAPPIER_ACTIVE_SERVER_ID: undefined });
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();

      const calls: string[][] = [];
      const promptInputFn = vi.fn<(prompt: string) => Promise<string>>()
        .mockResolvedValueOnce('y');

      await handleSetupCommand(
        ['--relay-url', 'https://relay.example.test', '--yes'],
        {
          applyServerSelectionFromArgs: async (args) => args,
          readCredentialsFn: async () => ({ encryption: { type: 'legacy', secret: new Uint8Array([1]) }, token: 't' } as any),
          readSettingsFn: async () => ({ machineId: 'mid_123' } as any),
          isInteractiveTerminalFn: () => true,
          promptInputFn,
          readBackgroundServiceSetupGuidanceFn: async () => createBackgroundServiceSetupGuidance({
            exactDefaultServiceExists: true,
            manualRelayOwner: {
              currentReleaseChannel: 'stable',
              currentCliVersion: '0.2.0',
            },
            shouldPromptForManualRelayTakeover: true,
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
          }),
          runHappyCliStepFn: async (argv) => {
            calls.push([...argv]);
            return 0;
          },
        },
      );

      expect(promptInputFn).toHaveBeenCalledWith(
        'This computer is currently using a temporary relay process for https://relay.example.test. Continue to stop that process and switch this computer to the background service? [Y/n] ',
      );
      expect(calls).toEqual([
        ['service', 'start', '--takeover'],
        ['agents', 'setup', '--yes'],
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
          readBackgroundServiceSetupGuidanceFn: async () => createBackgroundServiceSetupGuidance({
            exactDefaultServiceExists: true,
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
          }),
          runHappyCliStepFn: async (argv) => {
            calls.push([...argv]);
            return 0;
          },
        },
      );

      expect(calls).toEqual([
        ['agents', 'setup', '--yes'],
      ]);
    });
  });

  it('restarts the reused default background service when setup switched this computer to another relay', async () => {
    await withTempDir('happier-setup-reuse-default-background-service-new-relay-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://old-relay.example.test', HAPPIER_ACTIVE_SERVER_ID: undefined });
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();

      const calls: string[][] = [];
      await handleSetupCommand(
        ['--relay-url', 'https://new-relay.example.test', '--yes'],
        {
          applyServerSelectionFromArgs: async (args) => args,
          readCredentialsFn: async () => ({ encryption: { type: 'legacy', secret: new Uint8Array([1]) }, token: 't' } as any),
          readSettingsFn: async () => ({ machineId: 'mid_123' } as any),
          isInteractiveTerminalFn: () => false,
          promptInputFn: async () => {
            throw new Error('prompt should not be used');
          },
          readBackgroundServiceSetupGuidanceFn: async () => createBackgroundServiceSetupGuidance({
            targetServerUrl: 'https://new-relay.example.test',
            exactDefaultServiceExists: true,
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
          }),
          runHappyCliStepFn: async (argv) => {
            calls.push([...argv]);
            return 0;
          },
        },
      );

      // The service resolved its relay when it started, which was before this
      // run switched the machine. Reusing it as-is leaves it on the old relay.
      expect(calls).toEqual([
        ['service', 'restart'],
        ['agents', 'setup', '--yes'],
      ]);
    });
  });

  it('does not switch the default release-channel when setup is later cancelled by keeping conflicting services', async () => {
    await withTempDir('happier-setup-guided-decline-after-switch-', async (homeDir) => {
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
        .mockResolvedValueOnce('n');

      await handleSetupCommand(
        ['--relay-url', 'https://relay.example.test', '--yes'],
        {
          applyServerSelectionFromArgs: async (args) => args,
          readCredentialsFn: async () => ({ encryption: { type: 'legacy', secret: new Uint8Array([1]) }, token: 't' } as any),
          readSettingsFn: async () => ({ machineId: 'mid_123' } as any),
          isInteractiveTerminalFn: () => true,
          promptInputFn,
          readBackgroundServiceSetupGuidanceFn: async () => createBackgroundServiceSetupGuidance({
            targetReleaseChannel: 'preview',
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
                happierHomeDir: homeDir,
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
      expect(writeDefaultManagedReleaseChannelFn).not.toHaveBeenCalled();
      expect(syncInstalledFirstPartyShimsFn).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
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
          readBackgroundServiceSetupGuidanceFn: async () => createBackgroundServiceSetupGuidance({
            targetReleaseChannel: 'preview',
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
            shouldOfferDefaultReleaseChannelSwitch: true,
          }),
          runHappyCliStepFn: async () => 0,
        },
      )).rejects.toThrow(/requires interactive guidance/i);
    });
  });

  it('warns that no coding agent is installed when setup finishes and none resolve', async () => {
    await withTempDir('happier-setup-no-agent-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'https://relay.example.test',
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        // Agent CLI resolution reads PATH, HOME and HAPPIER_HOME_DIR; pointing all
        // three at an empty temp tree is what makes "nothing installed" real here.
        PATH: '',
        HOME: homeDir,
      });
      const restoreOverrides = withoutAgentCliPathOverrides();
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();

      try {
        await handleSetupCommand(
          ['--relay-url', 'https://relay.example.test', '--yes', '--skip-daemon', '--skip-providers'],
          {
            applyServerSelectionFromArgs: async (args) => args,
            readCredentialsFn: async () => ({ encryption: { type: 'legacy', secret: new Uint8Array([1]) }, token: 't' } as any),
            readSettingsFn: async () => ({ machineId: 'mid_123' } as any),
            isInteractiveTerminalFn: () => false,
            promptInputFn: async () => {
              throw new Error('prompt should not be used');
            },
            runHappyCliStepFn: async () => 0,
          },
        );
      } finally {
        restoreOverrides();
      }

      const text = stripAnsi(output.logs.join('\n'));
      expect(text).toContain('No coding agent found on this computer.');
      expect(text).toContain('happier agents install alpha');
      expect(text).toContain('happier agents install beta');
      expect(text).toContain('Setup complete.');
    });
  }, 180_000);

  it('does not warn about a missing coding agent when one resolves', async () => {
    await withTempDir('happier-setup-agent-present-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://relay.example.test', HAPPIER_ACTIVE_SERVER_ID: undefined });
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();

      await handleSetupCommand(
        ['--relay-url', 'https://relay.example.test', '--yes', '--skip-daemon', '--skip-providers'],
        {
          applyServerSelectionFromArgs: async (args) => args,
          readCredentialsFn: async () => ({ encryption: { type: 'legacy', secret: new Uint8Array([1]) }, token: 't' } as any),
          readSettingsFn: async () => ({ machineId: 'mid_123' } as any),
          isInteractiveTerminalFn: () => false,
          promptInputFn: async () => {
            throw new Error('prompt should not be used');
          },
          runHappyCliStepFn: async () => 0,
          listInstalledAgentIdsFn: async () => ['alpha'],
        },
      );

      const text = stripAnsi(output.logs.join('\n'));
      expect(text).not.toContain('No coding agent found');
      expect(text).toContain('Setup complete.');
    });
  });

  it('does not warn about a missing coding agent when setup ran the agent install step itself', async () => {
    await withTempDir('happier-setup-agent-installed-by-setup-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://relay.example.test', HAPPIER_ACTIVE_SERVER_ID: undefined });
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();

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
          runHappyCliStepFn: async () => 0,
          listInstalledAgentIdsFn: async () => [],
        },
      );

      expect(stripAnsi(output.logs.join('\n'))).not.toContain('No coding agent found');
    });
  });

  it('delegates the five-minute bound to the auth command that owns polling', async () => {
    await withTempDir('happier-setup-auth-timeout-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://relay.example.test', HAPPIER_ACTIVE_SERVER_ID: undefined });
      vi.resetModules();
      const { handleSetupCommand } = await importHandleSetupCommand();

      const previousExitCode = process.exitCode;
      const calls: string[][] = [];
      try {
        await handleSetupCommand(
          ['--relay-url', 'https://relay.example.test', '--skip-daemon', '--skip-providers'],
          {
            applyServerSelectionFromArgs: async (args) => args,
            readCredentialsFn: async () => null,
            isInteractiveTerminalFn: () => true,
            promptInputFn: async () => '',
            readBackgroundServiceSetupGuidanceFn: async () => createBackgroundServiceSetupGuidance(),
            runHappyCliStepFn: async (argv) => {
              calls.push([...argv]);
              return argv[0] === 'auth' ? 1 : 0;
            },
          },
        );

        expect(calls).toEqual([['auth', 'login', '--wait-timeout', '300']]);
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = previousExitCode;
      }
    });
  });


  /**
   * Credentials are stored per relay profile, so the relay has to be settled
   * before `happier auth login` runs: a self-hoster who signs in first and points
   * at their own relay afterwards ends up with two accounts, not a moved one.
   */
  describe('where the relay lives', () => {
    it('does not install or select the chosen relay when the user declines the run confirmation', async () => {
      await withTempDir('happier-setup-relay-confirm-before-write-', async (homeDir) => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://api.happier.dev', HAPPIER_ACTIVE_SERVER_ID: undefined });
        vi.resetModules();
        const { handleSetupCommand } = await importHandleSetupCommand();

        const calls: string[][] = [];
        await handleSetupCommand(['--skip-daemon', '--skip-providers'], {
          applyServerSelectionFromArgs: async (args) => args,
          readCredentialsFn: async () => null,
          readSettingsFn: async () => ({ machineId: null } as any),
          isInteractiveTerminalFn: () => true,
          promptInputFn: async (prompt: string) => {
            if (prompt.includes('Where does your relay live?')) return 't';
            if (prompt.includes('Run setup now?')) return 'n';
            return '';
          },
          runHappyCliStepFn: async (argv) => {
            calls.push([...argv]);
            return 0;
          },
        });

        expect(calls).toEqual([]);
      });
    });

    it('asks again when stored credentials are rejected by the active relay', async () => {
      await withTempDir('happier-setup-relay-question-rejected-credentials-', async (homeDir) => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://relay.example.test', HAPPIER_ACTIVE_SERVER_ID: undefined });
        validateStoredAuthTokenAgainstActiveServerMock.mockResolvedValue({ state: 'invalid', httpStatus: 401, reasonCode: 'not_authenticated' });
        vi.resetModules();
        const { handleSetupCommand } = await importHandleSetupCommand();

        const prompts: string[] = [];
        const calls: string[][] = [];
        await handleSetupCommand(['--skip-daemon', '--skip-providers'], {
          applyServerSelectionFromArgs: async (args) => args.filter((arg) => arg !== '--server' && arg !== 'cloud'),
          readCredentialsFn: async () => ({ encryption: { type: 'legacy', secret: new Uint8Array([1]) }, token: 'rejected' } as any),
          readSettingsFn: async () => ({ machineId: 'mid_123' } as any),
          isInteractiveTerminalFn: () => true,
          promptInputFn: async (prompt: string) => {
            prompts.push(prompt);
            return prompt.includes('Where does your relay live?') ? 'c' : '';
          },
          runHappyCliStepFn: async (argv) => {
            calls.push([...argv]);
            return 0;
          },
        });

        expect(stripAnsi(prompts.join('\n'))).toContain('Where does your relay live?');
        expect(calls).toEqual([['auth', 'login', '--wait-timeout', '300']]);
      });
    });

    it('asks where the relay lives and installs a relay on this computer before signing in', async () => {
      await withTempDir('happier-setup-relay-question-this-computer-', async (homeDir) => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'http://127.0.0.1:3005', HAPPIER_ACTIVE_SERVER_ID: undefined });
        vi.resetModules();
        const { handleSetupCommand } = await importHandleSetupCommand();

        const calls: string[][] = [];
        const childEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
        const prompts: string[] = [];
        await handleSetupCommand(
          ['--skip-daemon', '--skip-providers'],
          {
            applyServerSelectionFromArgs: async (args) => args,
            readCredentialsFn: async () => null,
            readSettingsFn: async () => ({ machineId: null } as any),
            isInteractiveTerminalFn: () => true,
            promptInputFn: async (prompt: string) => {
              prompts.push(prompt);
              return prompt.includes('Where does your relay live?') ? 't' : '';
            },
            runHappyCliStepFn: async (argv, options) => {
              calls.push([...argv]);
              childEnvs.push(options?.env);
              return 0;
            },
          },
        );

        const asked = stripAnsi(prompts.join('\n'));
        expect(asked).toContain('Where does your relay live?');
        expect(asked).toContain('Happier Cloud');
        expect(asked).toContain('On this computer');
        expect(calls).toEqual([
          ['relay', 'host', 'install'],
          ['auth', 'login', '--wait-timeout', '300', '--method', 'web'],
        ]);
        expect(childEnvs[0]?.HAPPIER_DEFER_SERVER_SELECTION_FOLLOW_UP).toBe('1');
      });
    });

    it('selects Happier Cloud as a real step when another relay is already active', async () => {
      await withTempDir('happier-setup-relay-question-cloud-', async (homeDir) => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://relay.example.test', HAPPIER_ACTIVE_SERVER_ID: undefined });
        vi.resetModules();
        const { handleSetupCommand } = await importHandleSetupCommand();

        const selectionArgs: string[][] = [];
        const calls: string[][] = [];
        await handleSetupCommand(
          ['--skip-daemon', '--skip-providers'],
          {
            applyServerSelectionFromArgs: async (args) => {
              selectionArgs.push([...args]);
              return args.filter((arg) => arg !== '--server' && arg !== 'cloud');
            },
            readCredentialsFn: async () => null,
            readSettingsFn: async () => ({ machineId: null } as any),
            isInteractiveTerminalFn: () => true,
            promptInputFn: async (prompt: string) => (prompt.includes('Where does your relay live?') ? 'c' : ''),
            runHappyCliStepFn: async (argv) => {
              calls.push([...argv]);
              return 0;
            },
          },
        );

        expect(selectionArgs[0]).toEqual(['--server', 'cloud', '--skip-daemon', '--skip-providers']);
        expect(calls).toEqual([['auth', 'login', '--wait-timeout', '300']]);
      });
    });

    it('points this computer at a relay the user already runs', async () => {
      await withTempDir('happier-setup-relay-question-existing-', async (homeDir) => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://api.happier.dev', HAPPIER_ACTIVE_SERVER_ID: undefined });
        vi.resetModules();
        const { handleSetupCommand } = await importHandleSetupCommand();

        const applyServerSelectionFromArgs = vi.fn(async (args: string[]) => args);
        const calls: string[][] = [];
        const childEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
        await handleSetupCommand(
          ['--skip-daemon', '--skip-providers'],
          {
            applyServerSelectionFromArgs,
            readCredentialsFn: async () => null,
            readSettingsFn: async () => ({ machineId: null } as any),
            isInteractiveTerminalFn: () => true,
            promptInputFn: async (prompt: string) => {
              if (prompt.includes('Where does your relay live?')) return 'r';
              if (stripAnsi(prompt).includes('Relay URL')) return 'https://relay.example.test';
              return '';
            },
            runHappyCliStepFn: async (argv, options) => {
              calls.push([...argv]);
              childEnvs.push(options?.env);
              return 0;
            },
          },
        );

        expect(applyServerSelectionFromArgs).not.toHaveBeenCalled();
        expect(calls).toEqual([
          ['server', 'add', '--server-url', 'https://relay.example.test', '--name', 'relay.example.test', '--use'],
          ['auth', 'login', '--wait-timeout', '300'],
        ]);
        expect(childEnvs[0]?.HAPPIER_DEFER_SERVER_SELECTION_FOLLOW_UP).toBe('1');
      });
    });

    it('does not ask when the relay was named on the command line', async () => {
      await withTempDir('happier-setup-relay-question-skipped-', async (homeDir) => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://api.happier.dev', HAPPIER_ACTIVE_SERVER_ID: undefined });
        vi.resetModules();
        const { handleSetupCommand } = await importHandleSetupCommand();

        const prompts: string[] = [];
        const calls: string[][] = [];
        await handleSetupCommand(
          ['--relay-url', 'https://relay.example.test', '--skip-daemon', '--skip-providers'],
          {
            applyServerSelectionFromArgs: async () => ['--skip-daemon', '--skip-providers'],
            readCredentialsFn: async () => null,
            readSettingsFn: async () => ({ machineId: null } as any),
            isInteractiveTerminalFn: () => true,
            promptInputFn: async (prompt: string) => {
              prompts.push(prompt);
              return '';
            },
            runHappyCliStepFn: async (argv) => {
              calls.push([...argv]);
              return 0;
            },
          },
        );

        expect(stripAnsi(prompts.join('\n'))).not.toContain('Where does your relay live?');
        expect(calls).toEqual([['auth', 'login', '--wait-timeout', '300']]);
      });
    });

    it('does not ask when this computer already has an account on its active relay', async () => {
      await withTempDir('happier-setup-relay-question-already-signed-in-', async (homeDir) => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://relay.example.test', HAPPIER_ACTIVE_SERVER_ID: undefined });
        vi.resetModules();
        const { handleSetupCommand } = await importHandleSetupCommand();

        const prompts: string[] = [];
        await handleSetupCommand(
          ['--skip-daemon', '--skip-providers'],
          {
            applyServerSelectionFromArgs: async (args) => args,
            readCredentialsFn: async () => ({ encryption: { type: 'legacy', secret: new Uint8Array([1]) }, token: 't' } as any),
            readSettingsFn: async () => ({ machineId: 'mid_123' } as any),
            isInteractiveTerminalFn: () => true,
            promptInputFn: async (prompt: string) => {
              prompts.push(prompt);
              return '';
            },
            runHappyCliStepFn: async () => 0,
          },
        );

        expect(stripAnsi(prompts.join('\n'))).not.toContain('Where does your relay live?');
      });
    });

    it('keeps the authenticated relay when only this machine still needs registration', async () => {
      await withTempDir('happier-setup-relay-question-machine-registration-', async (homeDir) => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'https://relay.example.test', HAPPIER_ACTIVE_SERVER_ID: undefined });
        vi.resetModules();
        const { handleSetupCommand } = await importHandleSetupCommand();

        const prompts: string[] = [];
        const calls: string[][] = [];
        await handleSetupCommand(
          ['--skip-daemon', '--skip-providers'],
          {
            applyServerSelectionFromArgs: async (selectionArgs) => {
              throw new Error(`relay selection should not run: ${selectionArgs.join(' ')}`);
            },
            readCredentialsFn: async () => ({ encryption: { type: 'legacy', secret: new Uint8Array([1]) }, token: 't' } as any),
            readSettingsFn: async () => ({ machineId: null } as any),
            isInteractiveTerminalFn: () => true,
            promptInputFn: async (prompt: string) => {
              prompts.push(prompt);
              return '';
            },
            runHappyCliStepFn: async (argv) => {
              calls.push([...argv]);
              return 0;
            },
          },
        );

        expect(stripAnsi(prompts.join('\n'))).not.toContain('Where does your relay live?');
        expect(calls).toEqual([['auth', 'login', '--wait-timeout', '300']]);
      });
    });

    it('offers the relay-access providers when the installed relay is reachable from this computer only', async () => {
      await withTempDir('happier-setup-relay-access-offer-', async (homeDir) => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
        vi.resetModules();
        const { handleSetupCommand } = await importHandleSetupCommand();

        const calls: string[][] = [];
        const prompts: string[] = [];
        await handleSetupCommand(
          ['--skip-daemon', '--skip-providers'],
          {
            applyServerSelectionFromArgs: async (args) => args,
            readCredentialsFn: async () => null,
            readSettingsFn: async () => ({ machineId: null } as any),
            isInteractiveTerminalFn: () => true,
            promptInputFn: async (prompt: string) => {
              prompts.push(prompt);
              if (prompt.includes('Where does your relay live?')) return 't';
              if (prompt.includes('How should your phone reach this relay?')) return 'tailscaleServe';
              return '';
            },
            runHappyCliStepFn: async (argv) => {
              calls.push([...argv]);
              if (argv.join(' ') === 'relay host install') {
                const { upsertServerProfileByUrl } = await import('@/server/serverProfiles');
                await upsertServerProfileByUrl({
                  name: 'local relay',
                  serverUrl: 'http://127.0.0.1:3005',
                  webappUrl: 'http://127.0.0.1:3005',
                  use: true,
                });
              }
              if (argv.join(' ') === 'relay access configure --provider tailscaleServe') {
                const { upsertServerProfileByUrl } = await import('@/server/serverProfiles');
                await upsertServerProfileByUrl({
                  name: 'local relay',
                  serverUrl: 'https://machine.tailnet.ts.net',
                  localServerUrl: 'http://127.0.0.1:3005',
                  webappUrl: 'https://machine.tailnet.ts.net',
                  use: true,
                });
              }
              return 0;
            },
          },
        );

        expect(stripAnsi(prompts.join('\n'))).toContain('How should your phone reach this relay?');
        expect(stripAnsi(prompts.join('\n'))).not.toContain('Tailscale Funnel');
        expect(calls).toEqual([
          ['relay', 'host', 'install'],
          ['relay', 'access', 'configure', '--provider', 'tailscaleServe'],
          ['auth', 'login', '--wait-timeout', '300'],
        ]);
      });
    });
  });

  /**
   * `happier setup plan` is a dry run: it prints what setup WOULD do. Resolving the
   * requested relay must therefore stay read-only — no settings write, no
   * process-wide env write — while still reporting the relay the real run would use.
   */
  describe('plan mode is side-effect free', () => {
    async function seedServerProfile(params: Readonly<{ name: string; serverUrl: string; use: boolean }>): Promise<void> {
      const { upsertServerProfileByUrl } = await import('@/server/serverProfiles');
      await upsertServerProfileByUrl({
        name: params.name,
        serverUrl: params.serverUrl,
        webappUrl: params.serverUrl,
        use: params.use,
      });
    }

    it('does not persist a relay switch when planning with --relay-url', async () => {
      await withTempDir('happier-setup-plan-no-persist-', async (homeDir) => {
        envScope.patch({
          HAPPIER_HOME_DIR: homeDir,
          HAPPIER_SERVER_URL: undefined,
          HAPPIER_LOCAL_SERVER_URL: undefined,
          HAPPIER_PUBLIC_SERVER_URL: undefined,
          HAPPIER_WEBAPP_URL: undefined,
          HAPPIER_ACTIVE_SERVER_ID: undefined,
        });
        vi.resetModules();
        await seedServerProfile({ name: 'company', serverUrl: 'https://company.example.test', use: true });

        const settingsFile = join(homeDir, 'settings.json');
        const settingsBefore = await readFile(settingsFile, 'utf8');

        vi.resetModules();
        const { handleSetupCommand } = await importHandleSetupCommand();
        await handleSetupCommand(['plan', '--relay-url', 'https://relay.example.test']);

        expect(await readFile(settingsFile, 'utf8')).toBe(settingsBefore);
        expect(process.env.HAPPIER_SERVER_URL).toBeUndefined();
        expect(process.env.HAPPIER_ACTIVE_SERVER_ID).toBeUndefined();
        expect(process.env.HAPPIER_WEBAPP_URL).toBeUndefined();

        const text = stripAnsi(output.logs.join('\n'));
        expect(text).toContain('https://relay.example.test');
      });
    });

    it('does not switch the active server profile when planning with --server', async () => {
      await withTempDir('happier-setup-plan-no-profile-switch-', async (homeDir) => {
        envScope.patch({
          HAPPIER_HOME_DIR: homeDir,
          HAPPIER_SERVER_URL: undefined,
          HAPPIER_LOCAL_SERVER_URL: undefined,
          HAPPIER_PUBLIC_SERVER_URL: undefined,
          HAPPIER_WEBAPP_URL: undefined,
          HAPPIER_ACTIVE_SERVER_ID: undefined,
        });
        vi.resetModules();
        await seedServerProfile({ name: 'company', serverUrl: 'https://company.example.test', use: true });
        await seedServerProfile({ name: 'staging', serverUrl: 'https://staging.example.test', use: false });

        const settingsFile = join(homeDir, 'settings.json');
        const settingsBefore = await readFile(settingsFile, 'utf8');

        vi.resetModules();
        const { handleSetupCommand } = await importHandleSetupCommand();
        await handleSetupCommand(['plan', '--server', 'staging']);

        expect(await readFile(settingsFile, 'utf8')).toBe(settingsBefore);
        expect(JSON.parse(settingsBefore).activeServerId).not.toBe('staging');

        // Resolution still happened: the plan reports the profile that a real run would select.
        const text = stripAnsi(output.logs.join('\n'));
        expect(text).toContain('https://staging.example.test');
      });
    });

    it('does not rewrite server environment variables when planning with --no-persist', async () => {
      await withTempDir('happier-setup-plan-no-env-write-', async (homeDir) => {
        envScope.patch({
          HAPPIER_HOME_DIR: homeDir,
          HAPPIER_SERVER_URL: undefined,
          HAPPIER_LOCAL_SERVER_URL: undefined,
          HAPPIER_PUBLIC_SERVER_URL: undefined,
          HAPPIER_WEBAPP_URL: undefined,
          HAPPIER_ACTIVE_SERVER_ID: undefined,
        });
        vi.resetModules();
        await seedServerProfile({ name: 'company', serverUrl: 'https://company.example.test', use: true });

        const settingsFile = join(homeDir, 'settings.json');
        const settingsBefore = await readFile(settingsFile, 'utf8');

        vi.resetModules();
        const { handleSetupCommand } = await importHandleSetupCommand();
        await handleSetupCommand(['plan', '--relay-url', 'https://relay.example.test', '--no-persist']);

        expect(process.env.HAPPIER_SERVER_URL).toBeUndefined();
        expect(process.env.HAPPIER_ACTIVE_SERVER_ID).toBeUndefined();
        expect(process.env.HAPPIER_WEBAPP_URL).toBeUndefined();
        expect(await readFile(settingsFile, 'utf8')).toBe(settingsBefore);

        const text = stripAnsi(output.logs.join('\n'));
        expect(text).toContain('https://relay.example.test');
      });
    });
  });
});
