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
            'dev.happier.app.development',
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
          'dev.happier.app.dev',
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
          'dev.happier.app.dev',
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
          'dev.happier.app.dev',
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
          'dev.happier.app.development',
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
        runMaestro: vi.fn(async () => ({ exitCode: 0 })),
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
          'dev.happier.app.development',
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
          'dev.happier.app.dev',
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
          'dev.happier.app.dev',
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
          'dev.happier.app.dev',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
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
          'dev.happier.app.dev',
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
          'dev.happier.app.dev',
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
      expect(joined).toContain('HAPPIER_E2E_DEV_CLIENT_METRO_URL=http://localhost:8081');
      expect(joined).toContain(
        `HAPPIER_E2E_DEV_CLIENT_LAUNCH_URL=${`happier://expo-development-client/?url=${encodeURIComponent('http://localhost:8081')}&disableOnboarding=1`}`,
      );
      expect(joined).not.toContain('HAPPIER_E2E_DEV_CLIENT_METRO_URL=http://localhost:8081/');
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
          'dev.happier.app.dev',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
          EXPO_APP_SCHEME: 'happier',
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
          'dev.happier.app.dev',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
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

    const fetchSpy = vi.fn(async () => {
      return await new Promise(() => {});
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
          'dev.happier.app.dev',
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAESTRO_CLI_NO_ANALYTICS: '1',
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
