import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDevTargetCommand } from '../../../dev_targets/executor.mjs';
import { prepareStackRelay, inspectHostRelay } from './runtime.mjs';

// Transport only: the server host's existing relay owner acquires its own
// tools, certificate, process lock and Serve route. No controller host paths
// or controller binary overrides are meaningful on that host.
async function runRelayOnTarget({ serverTarget, repoDir, stackBaseDir, env, signal, executorDependencies }, inspect) {
  const environment = { HAPPIER_STACK_HOME_DIR: serverTarget.cliHomeDir };
  for (const key of ['HAPPIER_STACK_STACK', 'HAPPIER_STACK_IROH_RELAY', 'HAPPIER_STACK_IROH_RELAY_FUNNEL', 'HAPPIER_IROH_RELAY_POLICY', 'HAPPIER_IROH_RELAY_URLS',
    'HAPPIER_IROH_RELAY_RX_BYTES_PER_SECOND', 'HAPPIER_IROH_RELAY_RX_MAX_BURST_BYTES',
    'HAPPIER_STACK_TAILSCALE_CMD_TIMEOUT_MS', 'HAPPIER_STACK_TAILSCALE_ENABLE_TIMEOUT_MS',
    'HAPPIER_STACK_SANDBOX_DIR', 'HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL']) {
    if (env[key] !== undefined) environment[key] = env[key];
  }
  let output = '';
  try {
    const result = await runDevTargetCommand({ target: serverTarget, sourceDir: repoDir, stackBaseDir,
      commandArgs: ['node', '--import=./apps/stack/bin/localSourceRuntimeBootstrap.mjs',
        './apps/stack/scripts/utils/server/infra/iroh/placement.mjs', inspect ? '--inspect-worker' : '--worker'],
      // Inspection reads host runtime state; only preparation consumes fresh source.
      environment, sourceAdmission: inspect ? 'skip' : 'auto', dependencyAdmission: 'skip', provenance: 'skip', signal,
      env: { ...env, HAPPIER_STACK_SYNC_SOURCE_DIR: repoDir }, silent: true, persistOutput: false,
      onLine: ({ stream, line }) => { if (stream === 'stdout') output += `${line}\n`; },
    }, executorDependencies);
    signal?.throwIfAborted();
    if (result.code !== 0) throw new Error('Relay target preparation failed');
    const relay = JSON.parse(output);
    if (!['ready', 'degraded', 'disabled', 'external', 'not_started'].includes(relay?.status)
      || (relay.status === 'ready' && new URL(relay.httpsUrl).protocol !== 'https:')) {
      throw new Error('Invalid relay target result');
    }
    return { ...relay, target: serverTarget.name };
  } catch {
    signal?.throwIfAborted();
    return { status: 'degraded', reason: 'relay_target_unavailable', httpsUrl: null, upstreamUrl: null,
      version: null, target: serverTarget.name,
      remediation: 'Restore the server target connection and source synchronization, then retry the stack start.' };
  }
}

export function prepareRelayOnTarget(options) {
  return runRelayOnTarget(options, false);
}

export function inspectRelayOnTarget(options) {
  return runRelayOnTarget(options, true);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  && (process.argv.includes('--worker') || process.argv.includes('--inspect-worker'))) {
  const relay = process.argv.includes('--inspect-worker')
    ? await inspectHostRelay({ env: process.env })
    : (await prepareStackRelay({ repoDir: process.cwd(), env: process.env })).relay;
  process.stdout.write(`${JSON.stringify(relay)}\n`);
}
