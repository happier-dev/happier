import { resolve as resolvePath } from 'node:path';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { createRunDirs } from '../runDir';
import { parseMaestroArgs as defaultParseMaestroArgs } from '../../../scripts/runMaestroWithHeartbeat.shared.mjs';

export type StartedServerLike = Readonly<{
  baseUrl: string;
  port?: number;
  dataDir?: string;
  stop?: () => Promise<void>;
}>;

export type MobileMaestroRunResult = Readonly<{
  exitCode: number;
  runDir: string;
  manifestPath: string;
  debugOutputDir: string;
  server: StartedServerLike | null;
}>;

export type MobileMaestroDeps = Readonly<{
  startServerLight: (params: { testDir: string; extraEnv?: NodeJS.ProcessEnv }) => Promise<StartedServerLike>;
  runMaestro: (params: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    maestroBin: string;
    args: string[];
  }) => Promise<{ exitCode: number }>;
  resolveMaestroBin: (env: NodeJS.ProcessEnv) => string;
  parseMaestroArgs: (argv: string[]) => {
    flows: string | null;
    appId: string | null;
    platform: string | null;
    serverUrl: string | null;
    passThrough: string[];
  };
}>;

function maestroCommand(env: NodeJS.ProcessEnv): string {
  return (String(env.HAPPIER_E2E_MAESTRO_BIN ?? '').trim() || 'maestro');
}

function adbCommand(env: NodeJS.ProcessEnv): string {
  return (String(env.HAPPIER_E2E_ADB_BIN ?? '').trim() || 'adb');
}

function isTruthyEnv(value: unknown): boolean {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function resolveDeviceVisibleBaseUrl(params: Readonly<{
  env: NodeJS.ProcessEnv;
  platform: string;
  baseUrl: string;
  androidAdbReverse: boolean;
}>): string {
  const override = String(params.env.HAPPIER_E2E_MOBILE_DEVICE_HOST ?? '').trim();
  const url = new URL(params.baseUrl);

  if (override) {
    url.hostname = override;
    return url.toString().replace(/\/$/, '');
  }

  if (params.platform === 'android') {
    if (params.androidAdbReverse === true) {
      return url.toString().replace(/\/$/, '');
    }
    const host = url.hostname.trim().toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') {
      url.hostname = '10.0.2.2';
    }
  }

  return url.toString().replace(/\/$/, '');
}

function runAdbReverseIfEnabled(params: Readonly<{
  env: NodeJS.ProcessEnv;
  platform: string;
  hostMetroUrl: string;
  hostServerUrl: string;
}>): Readonly<{ enabled: boolean }> {
  if (params.platform !== 'android') return { enabled: false };

  const deviceHostOverride = String(params.env.HAPPIER_E2E_MOBILE_DEVICE_HOST ?? '').trim();
  if (deviceHostOverride) return { enabled: false };

  if (!isTruthyEnv(params.env.HAPPIER_E2E_ANDROID_ADB_REVERSE ?? '')) return { enabled: false };

  const serial = String(params.env.HAPPIER_E2E_ANDROID_SERIAL ?? params.env.ANDROID_SERIAL ?? '').trim();
  const baseArgs = serial ? ['-s', serial] : [];

  const ports = new Set<number>();
  for (const url of [params.hostMetroUrl, params.hostServerUrl]) {
    if (!url) continue;
    try {
      const parsed = new URL(url);
      const port = Number(parsed.port);
      if (Number.isFinite(port) && port > 0) ports.add(port);
    } catch {
      // Ignore invalid URLs; Maestro will fail later in a more actionable way.
    }
  }

  for (const port of ports) {
    try {
      spawnSync(adbCommand(params.env), [...baseArgs, 'reverse', `tcp:${port}`, `tcp:${port}`], {
        stdio: 'ignore',
        timeout: 5000,
        env: params.env,
      });
    } catch {
      // Best-effort: keep going and fall back to non-reverse networking.
    }
  }

  return { enabled: true };
}

const defaultDeps: Pick<MobileMaestroDeps, 'resolveMaestroBin' | 'parseMaestroArgs'> = {
  resolveMaestroBin: (env) => (String(env.HAPPIER_E2E_MAESTRO_BIN ?? '').trim() || 'maestro'),
  parseMaestroArgs: (argv) => defaultParseMaestroArgs(argv),
};

export async function runMobileMaestro(
  params: Readonly<{
    argv: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }>,
  deps: Partial<MobileMaestroDeps>,
): Promise<MobileMaestroRunResult> {
  const parseMaestroArgs = deps.parseMaestroArgs ?? defaultDeps.parseMaestroArgs;
  const parsed = parseMaestroArgs(params.argv);

  const flows = parsed.flows ? parsed.flows.trim() : 'suites/mobile-e2e/flows';
  const appId =
    (parsed.appId ? parsed.appId.trim() : '') ||
    (String(params.env.HAPPIER_E2E_MOBILE_APP_ID ?? '').trim()) ||
    'dev.happier.app.dev';
  const platform = parsed.platform ? parsed.platform.trim() : '';

  const run = createRunDirs({
    runLabel: 'mobile-maestro',
    logsDir: resolvePath(params.cwd, '.project', 'logs', 'e2e', 'mobile-maestro'),
  });

  const manifestPath = resolvePath(run.runDir, 'manifest.json');
  const debugOutputDir = resolvePath(run.runDir, 'maestro-debug');

  const hostMetroUrl = String(params.env.HAPPIER_E2E_DEV_CLIENT_METRO_URL ?? '').trim() || 'http://127.0.0.1:8081';

  const explicitServerUrl =
    (parsed.serverUrl ? parsed.serverUrl.trim() : '') ||
    (String(params.env.HAPPIER_E2E_SERVER_URL ?? '').trim()) ||
    '';

  let server: StartedServerLike | null = null;
  if (explicitServerUrl) {
    server = { baseUrl: explicitServerUrl };
  } else {
    if (!deps.startServerLight) {
      throw new Error('Missing startServerLight dependency (required when serverUrl is not provided).');
    }
    const extraEnv: NodeJS.ProcessEnv = {
      ...params.env,
    };
    // Prefer the Node `--import` start path to avoid relying on workspace-local `node_modules/.bin` layout.
    extraEnv.HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT ??= '1';
    extraEnv.HAPPY_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT ??= '1';
    server = await deps.startServerLight({
      testDir: run.testDir('server-light'),
      extraEnv,
    });
  }

  const adbReverse = runAdbReverseIfEnabled({
    env: params.env,
    platform,
    hostMetroUrl,
    hostServerUrl: server.baseUrl,
  });

  const deviceServerUrl =
    server.baseUrl && (platform === 'android' || platform === 'ios')
      ? resolveDeviceVisibleBaseUrl({
          env: params.env,
          platform,
          baseUrl: server.baseUrl,
          androidAdbReverse: adbReverse.enabled,
        })
      : server.baseUrl;

  const deviceMetroUrl =
    hostMetroUrl && (platform === 'android' || platform === 'ios')
      ? resolveDeviceVisibleBaseUrl({
          env: params.env,
          platform,
          baseUrl: hostMetroUrl,
          androidAdbReverse: adbReverse.enabled,
        })
      : hostMetroUrl;

  const maestroBin = deps.resolveMaestroBin
    ? deps.resolveMaestroBin(params.env)
    : defaultDeps.resolveMaestroBin(params.env);

  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        tool: 'maestro',
        runId: run.runId,
        startedAt: new Date().toISOString(),
        flows,
        appId,
        platform: platform || null,
        serverUrlHost: server?.baseUrl ?? null,
        serverUrlDevice: deviceServerUrl ?? null,
        metroUrlHost: hostMetroUrl ?? null,
        metroUrlDevice: deviceMetroUrl ?? null,
        passThrough: parsed.passThrough ?? [],
        env: {
          APP_ENV: params.env.APP_ENV ?? null,
          androidAdbReverse: adbReverse.enabled,
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  if (!deps.runMaestro) {
    throw new Error('Missing runMaestro dependency.');
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...params.env,
    // Disable analytics prompts for deterministic local runs.
    MAESTRO_CLI_NO_ANALYTICS: String(params.env.MAESTRO_CLI_NO_ANALYTICS ?? '1'),
    ...(deviceServerUrl ? { HAPPIER_E2E_SERVER_URL: deviceServerUrl } : {}),
    ...(server?.baseUrl ? { HAPPIER_E2E_SERVER_URL_HOST: server.baseUrl } : {}),
    ...(platform ? { HAPPIER_E2E_MOBILE_PLATFORM: platform } : {}),
    HAPPIER_E2E_MOBILE_APP_ID: appId,
  };

  const childArgs = [
    'test',
    flows,
    '--debug-output',
    debugOutputDir,
    // Pass values both via `-e` and env, so flows are explicit and runner logs are easy to inspect.
    '-e',
    `HAPPIER_E2E_MOBILE_APP_ID=${appId}`,
    ...(deviceServerUrl ? ['-e', `HAPPIER_E2E_SERVER_URL=${deviceServerUrl}`] : []),
    ...(server?.baseUrl ? ['-e', `HAPPIER_E2E_SERVER_URL_HOST=${server.baseUrl}`] : []),
    ...(platform ? ['-e', `HAPPIER_E2E_MOBILE_PLATFORM=${platform}`] : []),
    ...(deviceMetroUrl ? ['-e', `HAPPIER_E2E_DEV_CLIENT_METRO_URL=${deviceMetroUrl}`] : []),
    ...(parsed.passThrough ?? []),
  ];

  let exitCode = 1;
  try {
    const result = await deps.runMaestro({
      cwd: params.cwd,
      env: childEnv,
      maestroBin: maestroBin || maestroCommand(params.env),
      args: childArgs,
    });
    exitCode = result.exitCode;
  } finally {
    if (server?.stop) {
      await server.stop();
    }
  }

  return {
    exitCode,
    runDir: run.runDir,
    manifestPath,
    debugOutputDir,
    server,
  };
}
