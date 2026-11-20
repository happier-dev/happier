import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { isDevStartupSourceDrift } from '../dev/devReloadCoordinator.mjs';
import { runWorkspaceBuildAdmission } from './workspace_build_admission.mjs';
import { sourceBuildNodeArgs } from './sourceBuildNodeArgs.mjs';

export { sourceBuildNodeArgs };

/** Run finite source preparation in the existing host memory-admission tree.
 * Admission classes and measured envelopes, queueing, reservations and pressure
 * cadence remain owned by hstack-exec. Runtime and web export callers select
 * their measured class; preparation-only callers retain validation.
 */
export async function runSourceBuildCommand({ repoDir, scriptPath, command, cwd = repoDir, args = [], env = process.env,
  signal, captureStdout = true, captureStderr = false, admissionClass = 'validation', stdoutStream = process.stdout,
  stderrStream = process.stderr, devStartup = false }) {
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
    onStderr: value => { observeStderr(value); stderrStream.write(value); } });
  if (result.error) throw result.error;
  if (result.status === 0) return captureStdout ? result.stdout : '';
  const stderr = captureStderr ? result.stderr : '';
  const error = new Error(`Source preparation failed (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`})${stderr.trim() ? `\n${stderr.trim()}` : ''}`);
  error.code = result.status;
  error.signal = result.signal;
  error.sourceDrift = sourceDrift;
  throw error;
}
