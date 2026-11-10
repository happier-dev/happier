import { join } from 'node:path';

import { parseEnvToObject } from '../../utils/env/dotenv.mjs';
import { readTextOrEmpty } from '../../utils/fs/ops.mjs';
import { getComponentDir, resolveStackEnvPath } from '../../utils/paths/paths.mjs';
import { readStackRuntimeStateFile } from '../../utils/stack/runtime_state.mjs';
import { resolveVerifiedStackUiEndpoint } from '../../utils/stack/verified_endpoints.mjs';
import { resolveRuntimeRemoteServiceObservation } from '../../utils/tui/runtime_placement_summary.mjs';
import { resolveProcessTeeLogPath } from '../../utils/proc/proc.mjs';
import { assertCanonicalManagedStackName } from '../../utils/stack/names.mjs';
import { normalizeStackRuntimeOwnerStartedAt } from '../../utils/stack/runtime_owner_incarnation.mjs';
import { preferStackLocalhostUrl } from '../../utils/paths/localhost_host.mjs';
import { buildBorrowedExpoWebappUrl, toPort } from './borrowed_expo_urls.mjs';
export { buildBorrowedExpoUiUrl, buildBorrowedExpoWebappUrl } from './borrowed_expo_urls.mjs';

export function isBorrowedExpoConsumer({ consumerStackName, producerStackName }) {
  const consumer = String(consumerStackName ?? '').trim();
  const producer = String(producerStackName ?? '').trim();
  if (producer) {
    assertCanonicalManagedStackName(producer, 'borrowed Expo producer');
  }
  return Boolean(consumer && producer && consumer !== producer);
}

/** Source QA borrows dev Expo; frozen exports are an explicit acceptance mode. */
export function resolveSourceQaUiMode({ uiMode, noUi = false, consumerStackName, producerStackName }) {
  const mode = uiMode ?? 'borrowed';
  if (mode !== 'export' && mode !== 'borrowed') {
    throw new Error('[start] source QA --ui must be export or borrowed');
  }
  if (noUi) return 'disabled';
  // Missing Expo is a UI prerequisite, never a server/daemon admission gate.
  if (mode === 'borrowed') isBorrowedExpoConsumer({ consumerStackName, producerStackName });
  return mode;
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
  const runtimeStartedAt = normalizeStackRuntimeOwnerStartedAt(runtimeState?.startedAt);
  const expo = runtimeState?.expo && typeof runtimeState.expo === 'object' ? runtimeState.expo : {};
  const runtimePort = toPort(expo.webPort ?? expo.port);
  const mobilePort = toPort(expo.mobilePort ?? runtimePort);
  const localRunning = localEndpoint?.running === true;
  const port = remote.target ? runtimePort : toPort(localEndpoint?.port ?? runtimePort);
  const remoteRunning = Boolean(remote.target && port && remoteEndpointRunning === true);
  const running = remote.target ? remoteRunning : Boolean(localRunning && port);

  return {
    producerStackName: String(producerStackName ?? '').trim(),
    ownership: 'borrowed',
    running,
    status: running ? (localEndpoint?.metroStatus === 'busy' ? 'busy' : 'running') : 'degraded',
    port,
    mobilePort,
    devClientEnabled: expo.devClientEnabled === true,
    source: remote.target ? 'remote_target' : (localEndpoint?.source ?? 'local'),
    remoteTarget: remote.target,
    ...(runtimeStartedAt ? { runtimeStartedAt } : {}),
  };
}

export async function resolveBorrowedExpoRuntime(
  { rootDir, producerStackName, env = process.env },
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
    requireExpoOwnership: false,
  });

  return projectBorrowedExpoRuntime({
    producerStackName: normalizedProducer,
    runtimeState,
    localEndpoint,
    remoteEndpointRunning: localEndpoint.running,
  });
}

export async function projectBorrowedExpoWebappEnv({
  rootDir,
  consumerStackName,
  producerStackName,
  env = process.env,
}) {
  if (String(env.HAPPIER_WEBAPP_URL ?? '').trim()) return env;
  if (!isBorrowedExpoConsumer({ consumerStackName, producerStackName })) return env;

  const borrowedExpo = await resolveBorrowedExpoRuntime({
    rootDir,
    producerStackName,
    env,
  });
  // The producer's recorded port is the selected runtime fact. Endpoint
  // liveness remains diagnostic and recoverable; one busy Metro probe must not
  // erase the consumer origin for the lifetime of this Stack controller.
  if (!toPort(borrowedExpo?.port)) return env;

  const webappUrl = await preferStackLocalhostUrl(buildBorrowedExpoWebappUrl({ consumerHost: 'localhost', expoPort: borrowedExpo.port }), {
    stackName: consumerStackName,
    env,
  });
  return { ...env, HAPPIER_WEBAPP_URL: webappUrl };
}
