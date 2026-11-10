import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { daemonStartGate } from '../auth/daemon_gate.mjs';
import { isPidAlive } from '../proc/pids.mjs';

const readinessPrefix = 'HSTACK_DAEMON_READINESS=';
const readinessStates = new Set(['starting', 'sign-in-required', 'running', 'reload-required']);

export function formatDaemonReadinessLine(readiness) {
  if (!readinessStates.has(readiness?.state)) throw new Error('invalid daemon readiness state');
  return `${readinessPrefix}${JSON.stringify({ state: readiness.state })}\n`;
}

export function parseDaemonReadinessLine(line) {
  if (!line.startsWith(readinessPrefix)) return null;
  try {
    const value = JSON.parse(line.slice(readinessPrefix.length));
    return readinessStates.has(value?.state) ? { state: value.state } : null;
  } catch { return null; }
}

// The worker's auth gate and daemon state already own these facts. Both the
// stdout observer and the one-shot attach probe consume this same projection.
export async function readDaemonReadiness({ cliHomeDir, activeServerId, sourceRuntimeIdentity, env = process.env }) {
  if (!daemonStartGate({ cliHomeDir, env: { ...env, HAPPIER_ACTIVE_SERVER_ID: activeServerId } }).ok) {
    return { state: 'sign-in-required' };
  }
  let state;
  try { state = JSON.parse(await readFile(join(cliHomeDir, 'servers', activeServerId, 'daemon.state.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { state: 'starting' };
    throw error;
  }
  if (state.sourceRuntimeReloadRequired && isPidAlive(state.pid)) return { state: 'reload-required' };
  // A live PID can precede the native runner's loaded-identity publication.
  if (sourceRuntimeIdentity && (!sourceRuntimeIdentity.selected
    || sourceRuntimeIdentity.loaded !== sourceRuntimeIdentity.selected)) return { state: 'starting' };
  return { state: Number.isInteger(state.pid) && state.pid > 1 && isPidAlive(state.pid) ? 'running' : 'starting' };
}
