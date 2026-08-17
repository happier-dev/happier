import { join } from 'node:path';

import { parseEnvToObject } from '../../utils/env/dotenv.mjs';
import { readTextOrEmpty } from '../../utils/fs/ops.mjs';
import { getComponentDir, resolveStackEnvPath } from '../../utils/paths/paths.mjs';
import { readStackRuntimeStateFile } from '../../utils/stack/runtime_state.mjs';
import { resolveVerifiedStackUiEndpoint } from '../../utils/stack/verified_endpoints.mjs';
import { looksLikeExpoMetro } from '../../utils/expo/expo.mjs';
import { resolveRuntimeRemoteServiceObservation } from '../../utils/tui/runtime_placement_summary.mjs';
import { resolveProcessTeeLogPath } from '../../utils/proc/proc.mjs';
import { assertCanonicalManagedStackName } from '../../utils/stack/names.mjs';

function toPort(value) {
  const port = Number(value);
  return Number.isFinite(port) && port > 0 ? Math.floor(port) : null;
}

export function isBorrowedExpoConsumer({ consumerStackName, producerStackName }) {
  const consumer = String(consumerStackName ?? '').trim();
  const producer = String(producerStackName ?? '').trim();
  if (producer) {
    assertCanonicalManagedStackName(producer, 'borrowed Expo producer');
  }
  return Boolean(consumer && producer && consumer !== producer);
}

export function buildBorrowedExpoUiUrl({ consumerHost, expoPort, serverPort }) {
  const host = String(consumerHost ?? '').trim();
  const normalizedExpoPort = toPort(expoPort);
  const normalizedServerPort = toPort(serverPort);
  if (!host || !normalizedExpoPort || !normalizedServerPort) return null;

  const url = new URL(`http://${host}:${normalizedExpoPort}/`);
  url.searchParams.set('server', `http://${host}:${normalizedServerPort}`);
  url.searchParams.set('happier_hmr', '0');
  return url.toString();
}

export function resolveBorrowedExpoLogPath({ producerStackBaseDir, remoteTarget }) {
  return resolveProcessTeeLogPath({
    label: remoteTarget ? `remote:${remoteTarget}` : 'expo',
    env: { HAPPIER_STACK_LOG_TEE_DIR: join(producerStackBaseDir, 'logs') },
  });
}

export function projectBorrowedExpoRuntime({
  producerStackName,
  runtimeState,
  localEndpoint,
  remoteEndpointRunning = false,
}) {
  const remote = resolveRuntimeRemoteServiceObservation(runtimeState, 'expo');
  const expo = runtimeState?.expo && typeof runtimeState.expo === 'object' ? runtimeState.expo : {};
  const runtimePort = toPort(expo.webPort ?? expo.port);
  const mobilePort = toPort(expo.mobilePort ?? runtimePort);
  const localRunning = localEndpoint?.running === true;
  const port = remote.target ? runtimePort : toPort(localEndpoint?.port ?? runtimePort);
  const remoteRunning = Boolean(remote.target && remote.running && port && remoteEndpointRunning === true);
  const running = remote.target ? remoteRunning : Boolean(localRunning && port);

  return {
    producerStackName: String(producerStackName ?? '').trim(),
    ownership: 'borrowed',
    running,
    status: running ? 'running' : 'degraded',
    port,
    mobilePort,
    devClientEnabled: expo.devClientEnabled === true,
    source: remote.target ? 'remote_target' : (localEndpoint?.source ?? 'local'),
    remoteTarget: remote.target,
  };
}

export async function resolveBorrowedExpoRuntime(
  { rootDir, producerStackName, env = process.env },
  { looksLikeExpoMetroImpl = looksLikeExpoMetro } = {},
) {
  const normalizedProducer = String(producerStackName ?? '').trim();
  if (!normalizedProducer) return null;
  assertCanonicalManagedStackName(normalizedProducer, 'borrowed Expo producer');

  const { baseDir, envPath } = resolveStackEnvPath(normalizedProducer, env);
  const envRaw = await readTextOrEmpty(envPath);
  const producerEnv = envRaw ? parseEnvToObject(envRaw) : {};
  const componentEnv = { ...env, ...producerEnv };
  const runtimeState = await readStackRuntimeStateFile(join(baseDir, 'stack.runtime.json'));
  if (!runtimeState) {
    return projectBorrowedExpoRuntime({
      producerStackName: normalizedProducer,
      runtimeState: null,
      localEndpoint: null,
    });
  }

  const uiDir = getComponentDir(rootDir, 'happier-ui', componentEnv);
  const localEndpoint = await resolveVerifiedStackUiEndpoint({
    stackName: normalizedProducer,
    baseDir,
    runtimeState,
    expectedProjectDir: uiDir,
    serveUiWanted: true,
    acceptExpoState: true,
    requireWeb: true,
    runtimeBackedStart: false,
  });
  const remote = resolveRuntimeRemoteServiceObservation(runtimeState, 'expo');
  const remotePort = toPort(runtimeState?.expo?.webPort ?? runtimeState?.expo?.port);
  let remoteEndpointRunning = false;
  if (remote.target && remote.running && remotePort) {
    try {
      remoteEndpointRunning = await looksLikeExpoMetroImpl({ port: remotePort });
    } catch {
      // A borrowed consumer must fail closed when its forwarded Metro endpoint cannot be verified.
    }
  }

  return projectBorrowedExpoRuntime({
    producerStackName: normalizedProducer,
    runtimeState,
    localEndpoint,
    remoteEndpointRunning,
  });
}
