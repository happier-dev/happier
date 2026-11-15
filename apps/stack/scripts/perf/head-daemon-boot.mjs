import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeRuntimeImportFailure, isPublicRuntimeImportDiagnostic, probeRuntimeImport } from '../utils/proc/runtimeImportProbe.mjs';

const self = fileURLToPath(import.meta.url);
export const HEAD_DAEMON_BOOT_GRAPH = { id: 'head-daemon-boot', entry: 'apps/cli/src/index.ts' };
export const HEAD_DAEMON_BOOT_READY = 'HEAD daemon route wiring ready';

export async function launchHeadDaemon({ entrypoint, env, cwd }) {
  const child = spawn(process.execPath, [entrypoint, 'daemon', 'start-sync'], {
    env, cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  let stopping = false;
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const completion = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('HEAD daemon process could not start')));
    child.once('close', code => {
      if (stopping || code === 0) { resolve(); return; }
      const diagnostic = describeRuntimeImportFailure(stderr, entrypoint);
      const message = `${diagnostic.loadError.name}: ${diagnostic.loadError.message.split('\n')[0]}; file=${diagnostic.firstFailingModule}`;
      reject(new Error(isPublicRuntimeImportDiagnostic(message) ? message : `HEAD daemon boot failed (exit=${code}); private diagnostic withheld`));
    });
  });
  void completion.catch(() => {});
  if (!child.pid) { await completion; throw new Error('HEAD daemon has no process identity'); }
  const stop = () => { stopping = true; child.kill('SIGTERM'); };
  // Cancellation reaches only the native child this probe started and recorded.
  process.once('SIGTERM', stop);
  const removeSignalListener = () => process.removeListener('SIGTERM', stop);
  void completion.then(removeSignalListener, removeSignalListener);
  return { pid: child.pid, completion, stop };
}

// The worker is the process boundary: revision production stays with Stack and
// credential seeding/readiness stay with the installed-daemon testkit.
export async function loadHeadDaemonBoot({ repoDir, revision, env, signal, runCommand = probeRuntimeImport }) {
  const result = await runCommand({ entrypoint: self,
    args: ['--head-daemon-boot-worker', repoDir, revision], cwd: repoDir, env, signal });
  return { ...result, graph: HEAD_DAEMON_BOOT_GRAPH.id, revision };
}

async function bootRevision(repoDir, revision) {
  const { prepareSourceRuntimeProducer } = await import('../build/build_source_runtime.mjs');
  const { resolveRuntimeBuildAuthority } = await import('../runtime/shared/runtime_build_authority.mjs');
  const { runWorkspaceBuildAdmission } = await import('../utils/proc/workspace_build_admission.mjs');
  const { createTestTempDirectory } = await import('../../../../scripts/testing/process/temporaryDirectories.mjs');
  const { producerStackBaseDir } = resolveRuntimeBuildAuthority({ rootDir: repoDir,
    env: process.env, createRepoIdentityIfMissing: false });
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  process.once('SIGTERM', abort);
  const temporary = createTestTempDirectory('hstack-head-boot-');
  const home = temporary.root;
  try {
    const { daemon } = await prepareSourceRuntimeProducer({ repoDir, stackBaseDir: producerStackBaseDir,
      components: [{ component: 'daemon' }], sourceRevision: { rev: revision }, signal: cancellation.signal });
    // Do not forward stack, Account, requester, installation or provider state.
    // The fixture supplies its own loopback Home and credentials after import.
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'LANG']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home,
      HAPPIER_HOME_DIR: home, HAPPIER_STACK_CLI_HOME_DIR: home,
      HAPPIER_FIRST_PARTY_INSTALL_HOME: join(home, 'native'), HAPPIER_HEAD_DAEMON_ENTRY: daemon.entrypoint,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_HEAD_DAEMON_RUNTIME_ENV: JSON.stringify(daemon.env) });
    const require = createRequire(join(repoDir, 'apps/cli/package.json'));
    const result = await runWorkspaceBuildAdmission({ command: process.execPath,
      // Retention observes native command references, including queued work.
      // Keep this consumed capture visible there throughout fixture startup.
      args: [`--title=head-daemon-boot:${daemon.entrypoint}`, require.resolve('vitest/vitest.mjs'), 'run', '--config', 'vitest.source.integration.config.ts',
        'src/daemon/testkit/headDaemonBoot.integration.test.ts'],
      repoDir, cwd: join(repoDir, 'apps/cli'), env, signal: cancellation.signal,
      admissionClass: 'focused-validation', devStartup: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status !== 0 || result.error) {
      const diagnostic = describeRuntimeImportFailure(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, daemon.entrypoint);
      throw new Error(`${diagnostic.loadError.message.split('\n')[0]}; file=${diagnostic.firstFailingModule}; daemonEntry=${daemon.entrypoint}`);
    }
    if (!result.stdout?.includes(HEAD_DAEMON_BOOT_READY)) throw new Error('HEAD daemon fixture ended without route readiness');
    console.error(`[head-daemon-boot] revision=${revision} routes=ready stopped=true`);
  } finally {
    process.removeListener('SIGTERM', abort);
    temporary.cleanup();
  }
}

if (process.argv[1] === self && process.argv[2] === '--head-daemon-boot-worker') {
  // The producer reads sentinel history through this module's importer. Finish
  // module evaluation before importing it, rather than awaiting that cycle.
  bootRevision(process.argv[3], process.argv[4]).catch(error => {
    const firstLine = String(error.message).split('\n')[0];
    console.error(`Error: ${isPublicRuntimeImportDiagnostic(firstLine) ? firstLine : 'HEAD daemon boot failed; private diagnostic withheld'}`);
    process.exitCode = 1;
  });
}
