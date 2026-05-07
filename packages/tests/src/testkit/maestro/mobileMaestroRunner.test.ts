import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('mobileMaestroRunner', () => {
  it('fails fast when the app is not installed on the target device', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const startServerLight = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:26050',
      port: 26050,
      stop: vi.fn(async () => {}),
    }));
    const startDevClientMetro = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:8081',
      port: 8081,
      stop: vi.fn(async () => {}),
    }));
    const runMaestro = vi.fn(async () => {
      throw new Error('runMaestro should not be called');
    });

    await expect(
      runMobileMaestro(
        {
          argv: [
            'node',
            'script',
            '--platform',
            'ios',
            '--flows',
            'suites/mobile-e2e/flows',
            '--appId',
            'dev.happier.app.dev.internal',
            '--serverUrl',
            'http://127.0.0.1:26050',
          ],
          cwd: process.cwd(),
          env: {
            ...process.env,
            MAESTRO_CLI_NO_ANALYTICS: '1',
            HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
          },
        },
        {
          startServerLight,
          startDevClientMetro,
          runMaestro,
          adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
          isAppInstalled: vi.fn(async () => false),
        },
      ),
    ).rejects.toThrow(/not installed/i);

    expect(runMaestro).not.toHaveBeenCalled();
    expect(startServerLight).not.toHaveBeenCalled();
    expect(startDevClientMetro).not.toHaveBeenCalled();
  });

  it('retries the install probe once before failing fast', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const runMaestro = vi.fn(async () => ({ exitCode: 0 }));
    const isAppInstalled = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'android',
          '--flows',
          'suites/mobile-e2e/flows',
          '--appId',
          'dev.happier.app.internaldev',
          '--serverUrl',
          'http://127.0.0.1:26050',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
        },
      },
      {
        runMaestro,
        isAppInstalled,
        adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
        primeAppLaunch: vi.fn(async () => {}),
      },
    );

    expect(isAppInstalled).toHaveBeenCalledTimes(2);
    expect(runMaestro).toHaveBeenCalledTimes(1);
  });

  it('uses the configured install probe attempt budget before failing fast', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const runMaestro = vi.fn(async () => ({ exitCode: 0 }));
    const isAppInstalled = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'android',
          '--flows',
          'suites/mobile-e2e/flows',
          '--appId',
          'dev.happier.app.internaldev',
          '--serverUrl',
          'http://127.0.0.1:26050',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
          HAPPIER_E2E_MOBILE_APP_INSTALL_CHECK_ATTEMPTS: '3',
          HAPPIER_E2E_MOBILE_APP_INSTALL_CHECK_RETRY_DELAY_MS: '1',
        },
      },
      {
        runMaestro,
        isAppInstalled,
        adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
        primeAppLaunch: vi.fn(async () => {}),
      },
    );

    expect(isAppInstalled).toHaveBeenCalledTimes(3);
    expect(runMaestro).toHaveBeenCalledTimes(1);
  });

  it('can bypass the install probe for unit-test-only runs', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const startServerLight = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:26050',
      port: 26050,
      stop: vi.fn(async () => {}),
    }));
    const startDevClientMetro = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:8081',
      port: 8081,
      stop: vi.fn(async () => {}),
    }));
    const isAppInstalled = vi.fn(async () => false);
    const runMaestro = vi.fn(async () => ({ exitCode: 0 }));

    await runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'android',
          '--flows',
          'suites/mobile-e2e/flows',
          '--appId',
          'dev.happier.app.internaldev',
          '--serverUrl',
          'http://127.0.0.1:26050',
          '--skip-app-install-check',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
        },
      },
      {
        startServerLight,
        startDevClientMetro,
        runMaestro,
        isAppInstalled,
        adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
        primeAppLaunch: vi.fn(async () => {}),
      },
    );

    expect(isAppInstalled).not.toHaveBeenCalled();
    expect(startServerLight).not.toHaveBeenCalled();
    expect(startDevClientMetro).toHaveBeenCalledTimes(0);
    expect(runMaestro).toHaveBeenCalledTimes(1);
  });

  it('passes full restore secret chunks to Maestro and redacts them from debug artifacts', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const restoreKey = 'RESTORE-KEY-THAT-MUST-NOT-REMAIN-IN-ARTIFACTS-1234567890-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let debugOutputDir = '';
    const runMaestro = vi.fn(async (params: { args: string[]; env: NodeJS.ProcessEnv }) => {
      const joinedArgs = params.args.join('\n');
      expect(joinedArgs).not.toContain(`HAPPIER_E2E_RESTORE_KEY=${restoreKey}`);
      expect(joinedArgs).toContain(`HAPPIER_E2E_RESTORE_KEY_CHUNK_01=${restoreKey.slice(0, 8)}`);
      expect(joinedArgs).toContain(`HAPPIER_E2E_RESTORE_KEY_CHUNK_09=${restoreKey.slice(64, 72)}`);
      expect(params.env.HAPPIER_E2E_RESTORE_KEY).toBeUndefined();
      expect(params.env.HAPPIER_E2E_RESTORE_KEY_CHUNK_01).toBe(restoreKey.slice(0, 8));
      expect(params.env.HAPPIER_E2E_RESTORE_KEY_CHUNK_09).toBe(restoreKey.slice(64, 72));

      const debugOutputIndex = params.args.indexOf('--debug-output');
      debugOutputDir = params.args[debugOutputIndex + 1] ?? '';
      mkdirSync(debugOutputDir, { recursive: true });
      writeFileSync(
        join(debugOutputDir, 'maestro.log'),
        `SetClipboardCommand(text=${restoreKey})\nInputTextCommand(text=${restoreKey.slice(0, 8)})\nInputTextCommand(text=${restoreKey.slice(64, 72)})\n`,
        'utf8',
      );

      const flowPath = params.args[params.args.indexOf('test') + 1] ?? '';
      const resolvedFlowPath = existsSync(resolve(process.cwd(), flowPath))
        ? resolve(process.cwd(), flowPath)
        : resolve(process.cwd(), 'packages/tests', flowPath);
      expect(readFileSync(resolvedFlowPath, 'utf8')).toContain('inputText: ${HAPPIER_E2E_RESTORE_KEY_CHUNK_09}');
      return { exitCode: 0 };
    });

    await runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'android',
          '--flows',
          'suites/mobile-e2e/flows/F13.populatedRelayRestoreAndOpenSessionPerformance.yaml',
          '--appId',
          'dev.happier.app.internaldev',
          '--serverUrl',
          'http://127.0.0.1:26050',
          '--skip-app-install-check',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
          HAPPIER_E2E_RESTORE_KEY: restoreKey,
        },
      },
      {
        runMaestro,
        isAppInstalled: vi.fn(async () => true),
        adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
        primeAppLaunch: vi.fn(async () => {}),
      },
    );

    expect(debugOutputDir).not.toBe('');
    const redactedLog = readFileSync(join(debugOutputDir, 'maestro.log'), 'utf8');
    expect(redactedLog).not.toContain(restoreKey);
    expect(redactedLog).not.toContain(restoreKey.slice(0, 8));
    expect(redactedLog).not.toContain(restoreKey.slice(64, 72));
    expect(redactedLog).toContain('[redacted:HAPPIER_E2E_RESTORE_KEY]');
    expect(redactedLog).toContain('[redacted:HAPPIER_E2E_RESTORE_KEY_CHUNK_01]');
    expect(redactedLog).toContain('[redacted:HAPPIER_E2E_RESTORE_KEY_CHUNK_09]');
  });

  it('redacts terminal connect deep links from logged Maestro command arguments', async () => {
    const { redactSensitiveMaestroCommandArgsForLog } = await import('./mobileMaestroRunner');
    const terminalConnectDeepLink = 'happier://terminal?key=terminal-secret&server=http%3A%2F%2F10.0.2.2%3A43210';

    const loggedArgs = redactSensitiveMaestroCommandArgsForLog(
      [
        'test',
        'flow.yaml',
        '-e',
        `HAPPIER_E2E_TERMINAL_CONNECT_DEEP_LINK=${terminalConnectDeepLink}`,
      ],
      { HAPPIER_E2E_TERMINAL_CONNECT_DEEP_LINK: terminalConnectDeepLink },
    );

    expect(loggedArgs.join(' ')).not.toContain(terminalConnectDeepLink);
    expect(loggedArgs.join(' ')).toContain(
      'HAPPIER_E2E_TERMINAL_CONNECT_DEEP_LINK=[redacted:HAPPIER_E2E_TERMINAL_CONNECT_DEEP_LINK]',
    );
  });

  it('redacts restore secret values from logged Maestro command arguments', async () => {
    const { redactSensitiveMaestroCommandArgsForLog } = await import('./mobileMaestroRunner');
    const restoreKey = 'RESTORE-KEY-THAT-MUST-NOT-BE-LOGGED';

    const loggedArgs = redactSensitiveMaestroCommandArgsForLog(
      [
        'test',
        'flow.yaml',
        '-e',
        `HAPPIER_E2E_RESTORE_KEY=${restoreKey}`,
        '-e',
        `HAPPIER_E2E_RESTORE_KEY_CHUNK_01=${restoreKey.slice(0, 8)}`,
      ],
      { HAPPIER_E2E_RESTORE_KEY: restoreKey },
    );

    expect(loggedArgs.join(' ')).not.toContain(restoreKey);
    expect(loggedArgs.join(' ')).not.toContain(restoreKey.slice(0, 8));
    expect(loggedArgs.join(' ')).toContain('HAPPIER_E2E_RESTORE_KEY=[redacted:HAPPIER_E2E_RESTORE_KEY]');
    expect(loggedArgs.join(' ')).toContain('HAPPIER_E2E_RESTORE_KEY_CHUNK_01=[redacted:HAPPIER_E2E_RESTORE_KEY_CHUNK_01]');
  });

  it('uses explicit serverUrl and does not start server-light', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const startServerLight = vi.fn(async () => {
      throw new Error('startServerLight should not be called');
    });

    const runMaestro = vi.fn(async () => ({ exitCode: 0 }));

    const result = await runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'android',
          '--flows',
          'suites/mobile-e2e/flows',
          '--appId',
          'dev.happier.app.internaldev',
          '--serverUrl',
          'http://127.0.0.1:26050',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
        },
      },
      {
        startServerLight,
        runMaestro,
        isAppInstalled: vi.fn(async () => true),
        adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
        primeAppLaunch: vi.fn(async () => {}),
      },
    );

    expect(startServerLight).not.toHaveBeenCalled();
    expect(runMaestro).toHaveBeenCalledTimes(1);
    expect(result.server?.baseUrl).toBe('http://127.0.0.1:26050');
  });

  it('clears Expo Metro cache by default for managed native dev-client metro', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const startDevClientMetro = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:8081',
      port: 8081,
      stop: vi.fn(async () => {}),
    }));
    const runMaestro = vi.fn(async () => ({ exitCode: 0 }));

    await runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'ios',
          '--flows',
          'suites/mobile-e2e/flows/F1.bootAndCreateAccount.yaml',
          '--appId',
          'dev.happier.app.internaldev',
          '--serverUrl',
          'http://127.0.0.1:26050',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '1',
          HAPPIER_E2E_MOBILE_WARM_DEV_CLIENT_BUNDLE: '0',
        },
      },
      {
        startDevClientMetro,
        runMaestro,
        isAppInstalled: vi.fn(async () => true),
        adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
      },
    );

    expect(startDevClientMetro).toHaveBeenCalledWith(
      expect.objectContaining({
        extraEnv: expect.objectContaining({
          HAPPIER_E2E_EXPO_CLEAR: '1',
        }),
      }),
    );
  });

  it('preserves an explicit Expo Metro cache-clear override for managed native dev-client metro', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const startDevClientMetro = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:8081',
      port: 8081,
      stop: vi.fn(async () => {}),
    }));

    await runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'ios',
          '--flows',
          'suites/mobile-e2e/flows/F1.bootAndCreateAccount.yaml',
          '--appId',
          'dev.happier.app.internaldev',
          '--serverUrl',
          'http://127.0.0.1:26050',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '1',
          HAPPIER_E2E_MOBILE_WARM_DEV_CLIENT_BUNDLE: '0',
          HAPPIER_E2E_EXPO_CLEAR: '0',
        },
      },
      {
        startDevClientMetro,
        runMaestro: vi.fn(async () => ({ exitCode: 0 })),
        isAppInstalled: vi.fn(async () => true),
        adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
      },
    );

    expect(startDevClientMetro).toHaveBeenCalledWith(
      expect.objectContaining({
        extraEnv: expect.objectContaining({
          HAPPIER_E2E_EXPO_CLEAR: '0',
        }),
      }),
    );
  });

  it('primes the android app once before invoking maestro', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const events: string[] = [];
    const runMaestro = vi.fn(async () => {
      events.push('maestro');
      return { exitCode: 0 };
    });
    const primeAppLaunch = vi.fn(async () => {
      events.push('prime');
    });

    const deps = {
      runMaestro,
      primeAppLaunch,
      isAppInstalled: vi.fn(async () => true),
      adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
    };

    await runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'android',
          '--flows',
          'suites/mobile-e2e/flows',
          '--appId',
          'dev.happier.app.internaldev',
          '--serverUrl',
          'http://127.0.0.1:26050',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
        },
      },
      deps,
    );

    expect(primeAppLaunch).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['prime', 'maestro']);
  });

  it('can disable android app priming explicitly', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const runMaestro = vi.fn(async () => ({ exitCode: 0 }));
    const primeAppLaunch = vi.fn(async () => {});

    const deps = {
      runMaestro,
      primeAppLaunch,
      isAppInstalled: vi.fn(async () => true),
      adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
    };

    await runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'android',
          '--flows',
          'suites/mobile-e2e/flows',
          '--appId',
          'dev.happier.app.internaldev',
          '--serverUrl',
          'http://127.0.0.1:26050',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
          HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH: '0',
        },
      },
      deps,
    );

    expect(primeAppLaunch).not.toHaveBeenCalled();
    expect(runMaestro).toHaveBeenCalledTimes(1);
  });

  it('starts server-light when serverUrl is missing, warms android metro by default, and stops it after the run', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const cancelBundleBody = vi.fn(async () => {});
    const arrayBufferSpy = vi.fn(async () => new ArrayBuffer(1));
    const fetchSpy = vi.fn(async (url: string) => {
      if (url === 'http://127.0.0.1:8085/?platform=android') {
        return {
          ok: true,
          json: async () => ({
            launchAsset: {
              url: 'http://10.0.2.2:8085/apps/ui/index.ts.bundle?platform=android&dev=true',
            },
          }),
        } as any;
      }
      if (url === 'http://127.0.0.1:8085/apps/ui/index.ts.bundle?platform=android&dev=true') {
        return {
          ok: true,
          body: {
            cancel: cancelBundleBody,
          },
          arrayBuffer: arrayBufferSpy,
        } as any;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    (globalThis as any).fetch = fetchSpy;

    const stop = vi.fn(async () => {});
    const startServerLight = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:43210',
      port: 43210,
      dataDir: '/tmp/server-light',
      stop,
    }));

    const runMaestro = vi.fn(async (params: { env: NodeJS.ProcessEnv }) => {
      expect(params.env.HAPPIER_E2E_SERVER_URL).toBe('http://10.0.2.2:43210');
      expect(params.env.HAPPIER_E2E_SERVER_VISIBLE_HOST_PATTERN).toBe('10\\.0\\.2\\.2:43210');
      return { exitCode: 0 };
    });

    const stopMetro = vi.fn(async () => {});
    const startDevClientMetro = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:8085',
      port: 8085,
      stop: stopMetro,
    }));

    const result = await runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'android',
          '--flows',
          'suites/mobile-e2e/flows',
          '--appId',
          'dev.happier.app.internaldev',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_ANDROID_PIN_DEV_CLIENT_RUNTIME: '0',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '1',
        },
      },
      {
        startServerLight,
        runMaestro,
        startDevClientMetro,
        adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
        isAppInstalled: vi.fn(async () => true),
        primeAppLaunch: vi.fn(async () => {}),
      },
    );

    expect(startServerLight).toHaveBeenCalledTimes(1);
    expect(startServerLight).toHaveBeenCalledWith(
      expect.objectContaining({
        extraEnv: expect.objectContaining({
          HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
        }),
      }),
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(startDevClientMetro).toHaveBeenCalledTimes(1);
    expect(startDevClientMetro).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'lan',
      }),
    );
    expect(stopMetro).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:8085/?platform=android', expect.any(Object));
    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:8085/apps/ui/index.ts.bundle?platform=android&dev=true', expect.any(Object));
    expect(cancelBundleBody).toHaveBeenCalledTimes(1);
    expect(arrayBufferSpy).not.toHaveBeenCalled();
    expect(result.server?.baseUrl).toBe('http://127.0.0.1:43210');
  }, 15_000);

  it('pins managed android Metro to the installed dev-client runtime version before start', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const startServerLight = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:43210',
      port: 43210,
      stop: vi.fn(async () => {}),
    }));

    const startDevClientMetro = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:8085',
      port: 8085,
      stop: vi.fn(async () => {}),
    }));

    const runMaestro = vi.fn(async () => ({ exitCode: 0 }));
    const resolveAndroidDevClientRuntimeVersion = vi.fn(() => 'native-runtime-fingerprint');

    const deps = {
      startServerLight,
      startDevClientMetro,
      runMaestro,
      adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
      isAppInstalled: vi.fn(async () => true),
      primeAppLaunch: vi.fn(async () => {}),
      resolveAndroidDevClientRuntimeVersion,
    };

    await runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'android',
          '--flows',
          'suites/mobile-e2e/flows',
          '--appId',
          'dev.happier.app.internaldev',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '1',
        },
      },
      deps,
    );

    expect(resolveAndroidDevClientRuntimeVersion).toHaveBeenCalledWith({
      appId: 'dev.happier.app.internaldev',
      env: expect.any(Object),
      outputDir: expect.stringContaining('android-dev-client-runtime'),
    });
    expect(startDevClientMetro).toHaveBeenCalledWith(
      expect.objectContaining({
        extraEnv: expect.objectContaining({
          HAPPIER_EXPO_RUNTIME_VERSION: 'native-runtime-fingerprint',
        }),
      }),
    );
  }, 15_000);

  it('waits for the managed android Metro bundle log before invoking maestro', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const events: string[] = [];
    const metroStdoutPath = join(mkdtempSync(join(tmpdir(), 'happier-metro-warm-')), 'metro.stdout.log');
    writeFileSync(metroStdoutPath, 'Starting Metro Bundler\n', 'utf8');

    const fetchSpy = vi.fn(async (url: string) => {
      if (url === 'http://127.0.0.1:8085/?platform=android') {
        return {
          ok: true,
          json: async () => ({
            launchAsset: {
              url: 'http://10.0.2.2:8085/apps/ui/index.ts.bundle?platform=android&dev=true',
            },
          }),
        } as any;
      }
      if (url === 'http://127.0.0.1:8085/apps/ui/index.ts.bundle?platform=android&dev=true') {
        return {
          ok: true,
          body: {
            cancel: vi.fn(async () => {
              events.push('bundle-cancelled');
            }),
          },
          arrayBuffer: vi.fn(async () => {
            events.push('bundle-drained');
            return new ArrayBuffer(1);
          }),
        } as any;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    (globalThis as any).fetch = fetchSpy;

    const startServerLight = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:43210',
      port: 43210,
      stop: vi.fn(async () => {}),
    }));

    const startDevClientMetro = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:8085',
      port: 8085,
      stdoutPath: metroStdoutPath,
      stop: vi.fn(async () => {}),
    }));

    const runMaestro = vi.fn(async () => {
      events.push('maestro');
      return { exitCode: 0 };
    });

    const runPromise = runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'android',
          '--flows',
          'suites/mobile-e2e/flows',
          '--appId',
          'dev.happier.app.internaldev',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_ANDROID_PIN_DEV_CLIENT_RUNTIME: '0',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '1',
          HAPPIER_E2E_MOBILE_WARM_DEV_CLIENT_BUNDLE_TIMEOUT_MS: '2000',
        },
      },
      {
        startServerLight,
        startDevClientMetro,
        runMaestro,
        adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
        isAppInstalled: vi.fn(async () => true),
        primeAppLaunch: vi.fn(async () => {}),
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toEqual([]);

    writeFileSync(metroStdoutPath, 'Starting Metro Bundler\nAndroid Bundled 2780ms apps/ui/index.ts\n', 'utf8');
    await runPromise;

    expect(events).toEqual(['bundle-cancelled', 'maestro']);
  }, 15_000);

  it('uses the bundle-id Dev Client launcher scheme for iOS F10 flows', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const startServerLight = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:43210',
      port: 43210,
      stop: vi.fn(async () => {}),
    }));

    const startDevClientMetro = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:8085',
      port: 8085,
      stop: vi.fn(async () => {}),
    }));

    const runMaestro = vi.fn(async (params: { args: string[] }) => {
      expect(params.args.join(' ')).toContain(
        `HAPPIER_E2E_DEV_CLIENT_LAUNCH_URL=${`dev.happier.app.publicdev.devclient://expo-development-client/?url=${encodeURIComponent('http://127.0.0.1:8085')}&disableOnboarding=1`}`,
      );
      return { exitCode: 0 };
    });

    await runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'ios',
          '--flows',
          'suites/mobile-e2e/flows/F10.nativeCryptoWorkerProbe.yaml',
          '--appId',
          'dev.happier.app.publicdev.devclient',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '1',
          HAPPIER_E2E_MOBILE_WARM_DEV_CLIENT_BUNDLE: '0',
        },
      },
      {
        startServerLight,
        startDevClientMetro,
        runMaestro,
        adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
        isAppInstalled: vi.fn(async () => true),
        primeAppLaunch: vi.fn(async () => {}),
      },
    );

    expect(startDevClientMetro).toHaveBeenCalledWith(
      expect.objectContaining({
        extraEnv: expect.not.objectContaining({
          EXPO_PUBLIC_HAPPIER_E2E_NATIVE_CRYPTO_WORKER_PROBE: '1',
        }),
      }),
    );
  });

  it('can provision an opt-in connected machine bootstrap for mobile flows', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const events: string[] = [];
    const stopServer = vi.fn(async () => {});
    const startServerLight = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:43210',
      port: 43210,
      stop: stopServer,
    }));

    const cliLoginStop = vi.fn(async () => {});
    const cliLoginWaitForSuccess = vi.fn(async () => {
      events.push('cli-login-success');
    });
    const startCliTerminalConnect = vi.fn(async () => ({
      connectUrl: 'https://example.test/terminal/connect#key=test-key&server=http%3A%2F%2F127.0.0.1%3A43210',
      waitForSuccess: cliLoginWaitForSuccess,
      stop: cliLoginStop,
    }));

    const daemonStop = vi.fn(async () => {});
    const startTestDaemon = vi.fn(async () => {
      events.push('daemon-start');
      return {
        stop: daemonStop,
      };
    });

    const runMaestro = vi.fn(async (params: { env: NodeJS.ProcessEnv; args: string[] }) => {
      const flowsArgIndex = params.args.findIndex((arg) => arg === 'test') + 1;
      events.push(`maestro:${params.args[flowsArgIndex] ?? 'unknown'}`);
      expect(params.env.HAPPIER_E2E_TERMINAL_CONNECT_DEEP_LINK).toBe(
        'happier://terminal?key=test-key&server=http%3A%2F%2F10.0.2.2%3A43210',
      );
      expect(
        params.args.filter((arg) => arg.startsWith('HAPPIER_E2E_TERMINAL_CONNECT_DEEP_LINK=')),
      ).toHaveLength(1);
      return { exitCode: 0 };
    });

    await runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'android',
          '--flows',
          'suites/mobile-e2e/flows/F4.connectedMachineComposerSmoke.yaml',
          '--appId',
          'dev.happier.app.internaldev',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
          HAPPIER_E2E_MOBILE_CONNECTED_MACHINE_MODE: 'cli-terminal-daemon',
        },
      },
      {
        startServerLight,
        startCliTerminalConnect,
        startTestDaemon,
        runMaestro,
        isAppInstalled: vi.fn(async () => true),
        adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
        primeAppLaunch: vi.fn(async () => {}),
      },
    );

    expect(startCliTerminalConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: 'http://127.0.0.1:43210',
        webappUrl: 'http://127.0.0.1:43210',
      }),
    );
    expect(runMaestro).toHaveBeenCalledTimes(2);
    expect(cliLoginWaitForSuccess).toHaveBeenCalledTimes(1);
    expect(startTestDaemon).toHaveBeenCalledTimes(1);
    expect(startTestDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          HAPPIER_SERVER_URL: 'http://127.0.0.1:43210',
          HAPPIER_WEBAPP_URL: 'http://127.0.0.1:43210',
        }),
      }),
    );
    expect(cliLoginStop).toHaveBeenCalledTimes(1);
    expect(daemonStop).toHaveBeenCalledTimes(1);
    expect(stopServer).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      'maestro:suites/mobile-e2e/flows/_bootstrap/connectedMachineTerminalAuth.yaml',
      'cli-login-success',
      'daemon-start',
      'maestro:suites/mobile-e2e/flows/F4.connectedMachineComposerSmoke.yaml',
    ]);
  });

  it('does not include terminal connect secret material when deep-link creation fails', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const leakyKey = 'terminal-key-that-must-not-be-reported';
    const connectUrl = `https://example.test/not-terminal-connect#key=${leakyKey}&server=http%3A%2F%2F127.0.0.1%3A43210`;
    const runMaestro = vi.fn(async () => ({ exitCode: 0 }));

    let thrown: unknown = null;
    try {
      await runMobileMaestro(
        {
          argv: [
            'node',
            'script',
            '--platform',
            'android',
            '--flows',
            'suites/mobile-e2e/flows/F4.connectedMachineComposerSmoke.yaml',
            '--appId',
            'dev.happier.app.internaldev',
          ],
          cwd: process.cwd(),
          env: {
            ...process.env,
            MAESTRO_CLI_NO_ANALYTICS: '1',
            HAPPIER_E2E_ANDROID_LOGCAT_CAPTURE: '0',
            HAPPIER_E2E_ANDROID_PRIME_APP_LAUNCH: '0',
            HAPPIER_E2E_MOBILE_MANAGE_METRO: '0',
            HAPPIER_E2E_MOBILE_CONNECTED_MACHINE_MODE: 'cli-terminal-daemon',
          },
        },
        {
          startServerLight: vi.fn(async () => ({
            baseUrl: 'http://127.0.0.1:43210',
            port: 43210,
            stop: vi.fn(async () => {}),
          })),
          startCliTerminalConnect: vi.fn(async () => ({
            connectUrl,
            waitForSuccess: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
          })),
          startTestDaemon: vi.fn(async () => ({
            stop: vi.fn(async () => {}),
          })),
          runMaestro,
          adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
          isAppInstalled: vi.fn(async () => true),
          primeAppLaunch: vi.fn(async () => {}),
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toContain(leakyKey);
    expect(message).not.toContain(connectUrl);
    expect(runMaestro).not.toHaveBeenCalled();
  });

  it('can disable the default android dev-client bundle warmup explicitly', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const fetchSpy = vi.fn(async () => {
      throw new Error('warm fetch should not run when explicitly disabled');
    });
    (globalThis as any).fetch = fetchSpy;

    const stopMetro = vi.fn(async () => {});
    const startDevClientMetro = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:8087',
      port: 8087,
      stop: stopMetro,
    }));

    const runMaestro = vi.fn(async () => ({ exitCode: 0 }));

    await runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'android',
          '--flows',
          'suites/mobile-e2e/flows',
          '--appId',
          'dev.happier.app.internaldev',
          '--serverUrl',
          'http://127.0.0.1:26050',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_ANDROID_PIN_DEV_CLIENT_RUNTIME: '0',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '1',
          HAPPIER_E2E_MOBILE_WARM_DEV_CLIENT_BUNDLE: '0',
        },
      },
      {
        startDevClientMetro,
        runMaestro,
        isAppInstalled: vi.fn(async () => true),
        adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
        primeAppLaunch: vi.fn(async () => {}),
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(startDevClientMetro).toHaveBeenCalledTimes(1);
    expect(runMaestro).toHaveBeenCalledTimes(1);
    expect(stopMetro).toHaveBeenCalledTimes(1);
  });

  it('passes the device metro url to maestro and reverses metro+server ports on android', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const cancelBundleBody = vi.fn(async () => {});
    const arrayBufferSpy = vi.fn(async () => new ArrayBuffer(1));
    const fetchSpy = vi.fn(async (url: string) => {
      if (url === 'http://127.0.0.1:8081/?platform=android') {
        return {
          ok: true,
          json: async () => ({
            launchAsset: {
              url: 'http://10.0.2.2:8081/apps/ui/index.ts.bundle?platform=android&dev=true',
            },
          }),
        } as any;
      }
      if (url === 'http://127.0.0.1:8081/apps/ui/index.ts.bundle?platform=android&dev=true') {
        return {
          ok: true,
          body: {
            cancel: cancelBundleBody,
          },
          arrayBuffer: arrayBufferSpy,
        } as any;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    (globalThis as any).fetch = fetchSpy;

    const startServerLight = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:26050',
      port: 26050,
      stop: vi.fn(async () => {}),
    }));

    const startDevClientMetro = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:8081',
      port: 8081,
      stop: vi.fn(async () => {}),
    }));

    const adbReversePorts = vi.fn(() => ({ enabled: true, reversedPorts: [26050, 8081] }));

    const runMaestro = vi.fn(async (params: { args: string[] }) => {
      const joined = params.args.join(' ');
      expect(joined).toContain('HAPPIER_E2E_SERVER_URL=http://127.0.0.1:26050');
      expect(joined).toContain('HAPPIER_E2E_SERVER_VISIBLE_HOST_PATTERN=127\\.0\\.0\\.1:26050');
      expect(joined).toContain('HAPPIER_E2E_DEV_CLIENT_METRO_URL=http://127.0.0.1:8081');
      expect(joined).toContain('HAPPIER_E2E_MOBILE_APP_SCHEME=happier-internaldev');
      expect(joined).toContain(
        `HAPPIER_E2E_DEV_CLIENT_LAUNCH_URL=${`happier-internaldev://expo-development-client/?url=${encodeURIComponent('http://127.0.0.1:8081')}&disableOnboarding=1`}`,
      );
      expect(joined).not.toContain('HAPPIER_E2E_DEV_CLIENT_NATIVE_CRYPTO_WORKER_LAUNCH_URL');
      expect(joined).not.toContain('HAPPIER_E2E_DEV_CLIENT_METRO_URL=http://127.0.0.1:8081/');
      return { exitCode: 0 };
    });

    await runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'android',
          '--flows',
          'suites/mobile-e2e/flows',
          '--appId',
          'dev.happier.app.internaldev',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_ANDROID_PIN_DEV_CLIENT_RUNTIME: '0',
          HAPPIER_E2E_MOBILE_APP_SCHEME: 'happier-internaldev',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '1',
          HAPPIER_E2E_MOBILE_WARM_DEV_CLIENT_BUNDLE: '1',
        },
      },
      {
        startServerLight,
        startDevClientMetro,
        adbReversePorts,
        runMaestro,
        isAppInstalled: vi.fn(async () => true),
        primeAppLaunch: vi.fn(async () => {}),
      },
    );

    expect(adbReversePorts).toHaveBeenCalledTimes(1);
    expect(adbReversePorts).toHaveBeenCalledWith(
      expect.objectContaining({
        urls: expect.arrayContaining(['http://127.0.0.1:26050', 'http://127.0.0.1:8081']),
      }),
    );
    expect(startDevClientMetro).toHaveBeenCalledTimes(1);
    expect(startDevClientMetro).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'lan',
      }),
    );
    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:8081/?platform=android', expect.any(Object));
    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:8081/apps/ui/index.ts.bundle?platform=android&dev=true', expect.any(Object));
    expect(cancelBundleBody).toHaveBeenCalledTimes(1);
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it('infers the Android public dev-client route scheme from the app id', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const cancelBundleBody = vi.fn(async () => {});
    const fetchSpy = vi.fn(async (url: string) => {
      if (url === 'http://127.0.0.1:8081/?platform=android') {
        return {
          ok: true,
          json: async () => ({
            launchAsset: {
              url: 'http://10.0.2.2:8081/apps/ui/index.ts.bundle?platform=android&dev=true',
            },
          }),
        } as any;
      }
      if (url === 'http://127.0.0.1:8081/apps/ui/index.ts.bundle?platform=android&dev=true') {
        return {
          ok: true,
          body: {
            cancel: cancelBundleBody,
          },
        } as any;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    (globalThis as any).fetch = fetchSpy;

    const startServerLight = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:26050',
      port: 26050,
      stop: vi.fn(async () => {}),
    }));

    const startDevClientMetro = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:8081',
      port: 8081,
      stop: vi.fn(async () => {}),
    }));

    const runMaestro = vi.fn(async (params: { args: string[] }) => {
      const joined = params.args.join(' ');
      expect(joined).toContain('HAPPIER_E2E_MOBILE_APP_SCHEME=happier-dev-devclient');
      expect(joined).toContain(
        `HAPPIER_E2E_DEV_CLIENT_LAUNCH_URL=${`happier-dev-devclient://expo-development-client/?url=${encodeURIComponent('http://127.0.0.1:8081')}&disableOnboarding=1`}`,
      );
      return { exitCode: 0 };
    });

    await runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'android',
          '--flows',
          'suites/mobile-e2e/flows/F13.populatedRelayRestoreAndOpenSessionPerformance.yaml',
          '--appId',
          'dev.happier.app.publicdev.devclient',
          '--serverUrl',
          'http://127.0.0.1:26050',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_ANDROID_PIN_DEV_CLIENT_RUNTIME: '0',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '1',
          HAPPIER_E2E_MOBILE_WARM_DEV_CLIENT_BUNDLE: '1',
        },
      },
      {
        startServerLight,
        startDevClientMetro,
        adbReversePorts: vi.fn(() => ({ enabled: true, reversedPorts: [26050, 8081] })),
        runMaestro,
        isAppInstalled: vi.fn(async () => true),
        primeAppLaunch: vi.fn(async () => {}),
      },
    );
  });

  it('does not fail the run when warming the dev client bundle fails', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    const fetchSpy = vi.fn(async () => {
      throw new Error('warm failed');
    });
    (globalThis as any).fetch = fetchSpy;

    const startServerLight = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:26050',
      port: 26050,
      stop: vi.fn(async () => {}),
    }));

    const startDevClientMetro = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:8081',
      port: 8081,
      stop: vi.fn(async () => {}),
    }));

    const runMaestro = vi.fn(async () => ({ exitCode: 0 }));

    const result = await runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'android',
          '--flows',
          'suites/mobile-e2e/flows',
          '--appId',
          'dev.happier.app.internaldev',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_ANDROID_PIN_DEV_CLIENT_RUNTIME: '0',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '1',
          HAPPIER_E2E_MOBILE_WARM_DEV_CLIENT_BUNDLE: '1',
        },
      },
      {
        startServerLight,
        startDevClientMetro,
        runMaestro,
        isAppInstalled: vi.fn(async () => true),
        adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
        primeAppLaunch: vi.fn(async () => {}),
      },
    );

    expect(startDevClientMetro).toHaveBeenCalledTimes(1);
    expect(runMaestro).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
  });

  it('does not hang when warming the dev client bundle never resolves', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;

    const startServerLight = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:26050',
      port: 26050,
      stop: vi.fn(async () => {}),
    }));

    const startDevClientMetro = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:8081',
      port: 8081,
      stop: vi.fn(async () => {}),
    }));

    const runMaestro = vi.fn(async () => ({ exitCode: 0 }));

    const runPromise = runMobileMaestro(
      {
        argv: [
          'node',
          'script',
          '--platform',
          'android',
          '--flows',
          'suites/mobile-e2e/flows',
          '--appId',
          'dev.happier.app.internaldev',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          HAPPIER_E2E_ANDROID_PIN_DEV_CLIENT_RUNTIME: '0',
          HAPPIER_E2E_MOBILE_MANAGE_METRO: '1',
          HAPPIER_E2E_MOBILE_WARM_DEV_CLIENT_BUNDLE: '1',
          HAPPIER_E2E_MOBILE_WARM_DEV_CLIENT_BUNDLE_TIMEOUT_MS: '10',
        },
      },
      {
        startServerLight,
        startDevClientMetro,
        runMaestro,
        isAppInstalled: vi.fn(async () => true),
        adbReversePorts: vi.fn(() => ({ enabled: false, reversedPorts: [] })),
        primeAppLaunch: vi.fn(async () => {}),
      },
    );

    const delay = (ms: number): Promise<'timeout'> =>
      new Promise((resolve) => {
        setTimeout(() => resolve('timeout'), ms);
      });

    await expect(Promise.race([runPromise, delay(4000)])).resolves.not.toBe('timeout');
    expect(runMaestro).toHaveBeenCalledTimes(1);
  });
});
