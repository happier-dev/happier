import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isDevStartupSourceDrift } from '../dev/devReloadCoordinator.mjs';
import { runWorkspaceBuildAdmission } from './workspace_build_admission.mjs';

/** Select the existing authored-tool authority before Node links any static
 * imports. Installed Stack layouts without a checkout keep their built graph. */
export function sourceBuildNodeArgs({ repoDir, scriptPath, args = [] }) {
  const bootstrap = join(repoDir, 'apps/stack/bin/localSourceRuntimeBootstrap.mjs');
  const sourceRuntime = join(repoDir, 'packages/cli-common/registerSourceRuntime.mjs');
  // Explicit finite tools can live outside their input checkout (for example
  // the Stack compiler consuming a captured UI). Inherited bootstrap scope
  // protects product children; it cannot establish this explicit tool intent.
  return [...(existsSync(bootstrap) ? ['--conditions=happier-source', `--import=${pathToFileURL(bootstrap).href}`] : []),
    ...(existsSync(sourceRuntime) ? [`--import=${pathToFileURL(sourceRuntime).href}`] : []), scriptPath, ...args];
}

/** Run finite source preparation in the existing host memory-admission tree.
 * Admission classes and measured envelopes, queueing, reservations and pressure
 * cadence remain owned by hstack-exec. Runtime and web export callers select
 * their measured class; preparation-only callers retain validation.
 */
export async function runSourceBuildCommand({ repoDir, scriptPath, command, cwd = repoDir, args = [], env = process.env,
  signal, captureStdout = true, captureStderr = false, admissionClass = 'validation', stdoutStream = process.stdout, devStartup = false }) {
  const launcher = fileURLToPath(new URL('../../../bin/hstack-exec', import.meta.url));
  const payloadCommand = command ?? process.execPath;
  const payloadArgs = command ? args : sourceBuildNodeArgs({ repoDir, scriptPath, args });
  let sourceDrift = false;
  const observe = () => {
    const decoder = new StringDecoder('utf8');
    let tail = '';
    return value => {
      const lines = (tail + decoder.write(value)).split('\n');
      tail = lines.pop();
      for (const message of lines) sourceDrift ||= isDevStartupSourceDrift({ code: 1, message }, 'expo');
      // Also recognize a final diagnostic without a trailing newline.
      sourceDrift ||= isDevStartupSourceDrift({ code: 1, message: tail }, 'expo');
    };
  };
  const observeStdout = observe(), observeStderr = observe();
  const result = await runWorkspaceBuildAdmission({ repoDir, launcherPath: launcher,
    command: payloadCommand, args: payloadArgs, cwd, env, signal,
    admissionClass, devStartup, stdio: ['ignore', 'pipe', 'pipe'], captureStdout, captureStderr,
    onStdout: value => { observeStdout(value); if (!captureStdout) stdoutStream.write(value); },
    onStderr: value => { observeStderr(value); process.stderr.write(value); } });
  if (result.error) throw result.error;
  if (result.status === 0) return captureStdout ? result.stdout : '';
  const stderr = captureStderr ? result.stderr : '';
  const error = new Error(`Source preparation failed (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`})${stderr.trim() ? `\n${stderr.trim()}` : ''}`);
  error.code = result.status;
  error.signal = result.signal;
  error.sourceDrift = sourceDrift;
  throw error;
}
