import { createReadStream, watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isPidAlive } from '../proc/pids.mjs';
import { waitForStackCredentialPath } from '../auth/wait_for_credentials.mjs';
import { formatDaemonReadinessLine, readDaemonReadiness } from './daemon_readiness.mjs';

export const SOURCE_SERVER_STARTING_LINE = 'HSTACK_SERVER_READINESS=starting';
export const SOURCE_SERVER_READY_LINE = 'HSTACK_SERVER_READINESS=running';

/** Observe, never own, a background Stack runner. Runtime publication and log
 * writes wake us; the existing owner-death watchdog still owns crash cleanup. */
export async function observeRemoteStackRuntime(runtimeStatePath, { output = process.stdout, env = process.env } = {}) {
  const watchers = [];
  const lifetime = new AbortController();
  let pending = Promise.resolve();
  let settle;
  const ended = new Promise((resolve, reject) => { settle = reject; });
  const enqueue = task => {
    pending = pending.then(task);
    void pending.catch(settle);
  };
  let owner;
  let logPath;
  let logIdentity;
  let position = 0;
  let daemonReadiness;
  let daemonStateWatched = false;
  let serverReadiness;
  let signIn;
  const drain = async () => {
    const info = await stat(logPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!info) return;
    const { size } = info;
    const identity = `${info.dev}:${info.ino}`;
    if ((logIdentity && identity !== logIdentity) || size < position) position = 0;
    logIdentity = identity;
    if (size === position) return;
    const stream = createReadStream(logPath, { start: position, end: size - 1 });
    for await (const chunk of stream) {
      if (!output.write(chunk)) await once(output, 'drain');
    }
    position = size;
  };
  const inspect = async () => {
    const state = JSON.parse(await readFile(runtimeStatePath, 'utf8'));
    if (!isPidAlive(state.ownerPid)) throw new Error('runtime owner exited');
    if (owner && (state.ownerPid !== owner.pid || state.startedAt !== owner.startedAt)) {
      throw new Error('runtime owner changed');
    }
    const serverIdentity = state.sourceRuntimeIdentities?.server;
    if (state.placement?.server === 'local' && serverIdentity) {
      // The native runner publishes loaded only after its authenticated HTTP
      // readiness succeeds. A separate HTTP probe can beat that publication.
      const readiness = serverIdentity.selected && serverIdentity.loaded === serverIdentity.selected
        ? SOURCE_SERVER_READY_LINE : SOURCE_SERVER_STARTING_LINE;
      if (readiness !== serverReadiness) {
        serverReadiness = readiness;
        if (!output.write(`${readiness}\n`)) await once(output, 'drain');
      }
    }
    const cliHomeDir = env.HAPPIER_HOME_DIR;
    const activeServerId = env.HAPPIER_ACTIVE_SERVER_ID;
    // Server-only workers have no local daemon enrollment to report on.
    if (cliHomeDir && activeServerId && (state.placement?.daemon ?? 'local') === 'local') {
      if (!daemonStateWatched) {
        const stateDir = join(cliHomeDir, 'servers', activeServerId);
        try {
          const watcher = watch(stateDir, (_event, file) => {
            if (!file || String(file) === 'daemon.state.json') enqueue(inspect);
          });
          watcher.on('error', settle);
          watchers.push(watcher);
          daemonStateWatched = true;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const readiness = await readDaemonReadiness({ cliHomeDir, activeServerId, env });
      if (readiness.state === 'sign-in-required' && !signIn) {
        // Login is an independent producer: a retained daemon may already be
        // alive, so no later runtime-state publication is required to wake us.
        signIn = waitForStackCredentialPath({ cliHomeDir, env, signal: lifetime.signal })
          .then(() => { signIn = null; enqueue(inspect); });
        void signIn.catch(error => { if (!lifetime.signal.aborted) settle(error); });
      }
      if (readiness.state !== daemonReadiness) {
        daemonReadiness = readiness.state;
        if (!output.write(formatDaemonReadinessLine(readiness))) await once(output, 'drain');
      }
    }
    if (owner) return;
    owner = { pid: state.ownerPid, startedAt: state.startedAt };
    logPath = state.logs?.runner;
    if (logPath) {
      // Log rotation and diagnostic I/O cannot turn a healthy runtime into a
      // worker failure. Runtime-state publication alone governs observation.
      const readLog = () => drain().catch(() => {});
      watchers.push(watch(dirname(logPath), (_event, file) => {
        if (!file || String(file) === basename(logPath)) enqueue(readLog);
      }).on('error', () => {}));
      // Background startup has already observed readiness. Historical phase
      // records are diagnostics, never new lifecycle transitions on attach.
      const info = await stat(logPath).catch(() => null);
      position = info?.size ?? 0;
      if (info) logIdentity = `${info.dev}:${info.ino}`;
      await readLog();
    }
    process.stderr.write(`[dev-targets] observing runtime owner pid=${owner.pid}\n`);
  };
  try {
    // Watch the directory so atomic runtime-state replacement cannot detach
    // the subscription from its current inode. Subscribe before the first read.
    watchers.push(watch(dirname(runtimeStatePath), (_event, file) => {
      if (!file || String(file) === basename(runtimeStatePath)) enqueue(inspect);
    }));
    for (const watcher of watchers) watcher.on('error', settle);
    enqueue(inspect);
    await ended;
  } finally {
    lifetime.abort();
    for (const watcher of watchers) watcher.close();
    await pending.catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await observeRemoteStackRuntime(process.argv[2]); }
  catch { process.stderr.write('[dev-targets] runtime observation ended\n'); process.exitCode = 1; }
}
