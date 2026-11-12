import type { LocalServiceProcessFact } from './local/services/inventory/provenance';
import { isPidPresent } from '@happier-dev/cli-common/process';
import { createProcessCensusReader, readProcessCensus, type ProcessCensusDependencies } from '@/processes/census/processCensus';

/**
 * Coarse process run state for daemon liveness decisions.
 *
 * A session runner must be ABLE TO SERVE (consume its pending queue, answer RPC) for the daemon
 * to refuse a resume as "already running". `process.kill(pid, 0)` alone lies for two classes:
 * - `stopped`: SIGSTOPped/traced — alive, holds its lock, serves nothing.
 * - `zombie`: defunct — signalable on some platforms, permanently dead.
 *
 * Incident class: daemon log 2026-06-12 "Resume requested ... but session is already running"
 * while the runner cannot serve; the user message is materialized into the pending queue and
 * never consumed.
 */
export type ProcessRunState = 'dead' | 'servable' | 'stopped' | 'zombie';

/**
 * Reads the run state of a process. Fail-closed: when the process is alive but its state cannot
 * be inspected (census failure, unsupported platform), it is reported `servable` so callers keep the
 * existing duplicate-spawn protection. Windows has no SIGSTOP/zombie semantics → alive = servable.
 */
export async function readProcessRunState(pid: number, deps?: Pick<ProcessCensusDependencies,
  'platform' | 'linuxBoundary' | 'execFile' | 'helperExecutablePath'> & Readonly<{
  isPidAlive?: (pid: number) => boolean;
  /** A containing identity/lifecycle verdict reuses its one census observation. */
  observedProcess?: LocalServiceProcessFact | null;
  platform?: NodeJS.Platform;
}>): Promise<ProcessRunState> {
  if (!Number.isFinite(pid) || pid <= 0) return 'dead';
  const isPidAlive = deps?.isPidAlive ?? isPidPresent;
  const platform = deps?.platform ?? process.platform;
  const alive = isPidAlive(pid);

  if (deps && 'observedProcess' in deps) {
    const state = deps.observedProcess?.censusRow?.state;
    if (state === 'stopped' || state === 'zombie') return state;
    if (state) return 'servable';
    return isPidAlive(pid) ? 'servable' : 'dead';
  }

  if (platform === 'win32') {
    return alive ? 'servable' : 'dead';
  }

  try {
    const read = deps ? createProcessCensusReader(deps) : readProcessCensus;
    const snapshot = await read({ freshness: 'fresh', pids: [Math.floor(pid)], scope: 'all', fields: [] });
    if (snapshot.status === 'ok') {
      const row = snapshot.rows.find(candidate => candidate.pid === Math.floor(pid));
      if (row?.state === 'stopped' || row?.state === 'zombie') return row.state;
      if (row?.state) return 'servable';
    }
  } catch {
    // Failed census observations preserve the signal-probe fallback.
  }
  // No census state: trust the signal probe (a pid can be unobservable but still signalable in
  // rare sandboxed setups — stay fail-closed and treat alive as servable).
  // The process may exit while the census is pending; refresh the pre-probe observation.
  return isPidAlive(pid) ? 'servable' : 'dead';
}
