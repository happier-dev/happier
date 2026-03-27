import { describe, expect, it, vi } from 'vitest';

describe('mobileMaestroRunner', () => {
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
      },
    );

    expect(startServerLight).not.toHaveBeenCalled();
    expect(runMaestro).toHaveBeenCalledTimes(1);
    expect(result.server?.baseUrl).toBe('http://127.0.0.1:26050');
  });

  it('starts server-light when serverUrl is missing and stops it after the run', async () => {
    const { runMobileMaestro } = await import('./mobileMaestroRunner');

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

    const adbReversePorts = vi.fn(() => ({ enabled: true, reversedPorts: [43210, 8085] }));

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
        adbReversePorts,
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
    expect(stopMetro).toHaveBeenCalledTimes(1);
    expect(result.server?.baseUrl).toBe('http://127.0.0.1:43210');
  });

  it('passes the device metro url to maestro and reverses metro+server ports on android', async () => {
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

    const adbReversePorts = vi.fn(() => ({ enabled: true, reversedPorts: [26050, 8081] }));

    const runMaestro = vi.fn(async (params: { args: string[] }) => {
      const joined = params.args.join(' ');
      expect(joined).toContain('HAPPIER_E2E_SERVER_URL=http://10.0.2.2:26050');
      expect(joined).toContain('HAPPIER_E2E_DEV_CLIENT_METRO_URL=http://10.0.2.2:8081');
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
        },
      },
      {
        startServerLight,
        startDevClientMetro,
        adbReversePorts,
        runMaestro,
      },
    );

    expect(adbReversePorts).toHaveBeenCalledTimes(1);
    expect(adbReversePorts).toHaveBeenCalledWith(
      expect.objectContaining({
        urls: expect.arrayContaining(['http://127.0.0.1:26050', 'http://127.0.0.1:8081']),
      }),
    );
  });
});
