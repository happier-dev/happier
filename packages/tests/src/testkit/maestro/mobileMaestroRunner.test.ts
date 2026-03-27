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

  it('starts server-light when serverUrl is missing and stops it after the run', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

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
          arrayBuffer: async () => new ArrayBuffer(1),
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
          HAPPIER_E2E_MOBILE_WARM_DEV_CLIENT_BUNDLE: '1',
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
        extraEnv: expect.objectContaining({
          EXPO_PACKAGER_HOSTNAME: '127.0.0.1',
          REACT_NATIVE_PACKAGER_HOSTNAME: '127.0.0.1',
        }),
      }),
    );
    expect(startDevClientMetro.mock.calls[0]?.[0].port).toBeUndefined();
    expect(stopMetro).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:8085/?platform=android', expect.any(Object));
    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:8085/apps/ui/index.ts.bundle?platform=android&dev=true', expect.any(Object));
    expect(result.server?.baseUrl).toBe('http://127.0.0.1:43210');
  });

  it('passes the device metro url to maestro and reverses metro+server ports on android', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

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
          arrayBuffer: async () => new ArrayBuffer(1),
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
        extraEnv: expect.objectContaining({
          EXPO_PACKAGER_HOSTNAME: '127.0.0.1',
          REACT_NATIVE_PACKAGER_HOSTNAME: '127.0.0.1',
        }),
      }),
    );
    expect(startDevClientMetro.mock.calls[0]?.[0].port).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:8081/?platform=android', expect.any(Object));
    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:8081/apps/ui/index.ts.bundle?platform=android&dev=true', expect.any(Object));
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

    await expect(Promise.race([runPromise, delay(500)])).resolves.not.toBe('timeout');
    expect(runMaestro).toHaveBeenCalledTimes(1);
  });
});
