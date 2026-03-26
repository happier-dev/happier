import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

import { createRunDirs } from '../src/testkit/runDir';
import { resolveDeviceVisibleBaseUrl } from '../src/testkit/mobile/resolveDeviceHost';
import {
  createMaestroSpawnOptions,
  parseMaestroArgs,
  runHeartbeatWrappedCommand,
  resolveSignalExitCode,
} from './runMaestroWithHeartbeat.shared.mjs';

function maestroCommand() {
  return (process.env.HAPPIER_E2E_MAESTRO_BIN ?? '').trim() || 'maestro';
}

const { flows, appId, platform, serverUrl, passThrough } = parseMaestroArgs(process.argv);
const resolvedFlows = flows ? flows.trim() : 'suites/mobile-e2e/flows';
const resolvedAppId =
  (appId ? String(appId).trim() : '') ||
  (process.env.HAPPIER_E2E_MOBILE_APP_ID ?? '').trim() ||
  // Default to the development Android package id (common local setup).
  // Callers should set this explicitly for iOS or other variants.
  'dev.happier.app.dev';

const resolvedHostServerUrl =
  (serverUrl ? String(serverUrl).trim() : '') ||
  (process.env.HAPPIER_E2E_SERVER_URL ?? '').trim() ||
  '';

const resolvedPlatform =
  (platform ? String(platform).trim() : '') ||
  (process.env.HAPPIER_E2E_MOBILE_PLATFORM ?? '').trim() ||
  '';

const resolvedDeviceServerUrl =
  resolvedHostServerUrl && (resolvedPlatform === 'android' || resolvedPlatform === 'ios')
    ? resolveDeviceVisibleBaseUrl({
        platform: resolvedPlatform,
        baseUrl: resolvedHostServerUrl,
      })
    : resolvedHostServerUrl;

const run = createRunDirs({
  runLabel: 'mobile-maestro',
  logsDir: resolve(process.cwd(), '.project', 'logs', 'e2e', 'mobile-maestro'),
});

const debugOutputDir = resolve(run.runDir, 'maestro-debug');
const manifestPath = resolve(run.runDir, 'manifest.json');

writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      tool: 'maestro',
      runId: run.runId,
      startedAt: new Date().toISOString(),
      flows: resolvedFlows,
      appId: resolvedAppId,
      platform: resolvedPlatform || null,
      serverUrlHost: resolvedHostServerUrl || null,
      serverUrlDevice: resolvedDeviceServerUrl || null,
      passThrough,
      env: {
        APP_ENV: process.env.APP_ENV ?? null,
      },
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

const childArgs = [
  'test',
  resolvedFlows,
  '--debug-output',
  debugOutputDir,
  // Pass `appId` as a Maestro parameter so flows can use `${HAPPIER_E2E_MOBILE_APP_ID}`.
  '-e',
  `HAPPIER_E2E_MOBILE_APP_ID=${resolvedAppId}`,
  ...(resolvedDeviceServerUrl
    ? ['-e', `HAPPIER_E2E_SERVER_URL=${resolvedDeviceServerUrl}`]
    : []),
  ...(resolvedHostServerUrl
    ? ['-e', `HAPPIER_E2E_SERVER_URL_HOST=${resolvedHostServerUrl}`]
    : []),
  ...(resolvedPlatform
    ? ['-e', `HAPPIER_E2E_MOBILE_PLATFORM=${resolvedPlatform}`]
    : []),
  ...passThrough,
];

await runHeartbeatWrappedCommand({
  toolName: 'maestro',
  config: resolvedFlows,
  command: maestroCommand(),
  args: childArgs,
  spawnOptions: createMaestroSpawnOptions(process.env),
  resolveExitCode(result) {
    return typeof result.code === 'number' ? result.code : resolveSignalExitCode(result.signal);
  },
});
