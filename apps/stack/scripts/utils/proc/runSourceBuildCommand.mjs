import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Run finite source preparation in the existing host memory-admission tree.
 * Admission classes and measured envelopes, queueing, reservations and pressure
 * cadence remain owned by hstack-exec. Web preparation/export keeps validation;
 * runtime bundle callers select source-bundle.
 */
export async function runSourceBuildCommand({ repoDir, scriptPath, command, cwd = repoDir, args = [], env = process.env,
  signal, captureStdout = true, admissionClass = 'validation' }) {
  const launcher = fileURLToPath(new URL('../../../bin/hstack-exec', import.meta.url));
  const payloadCommand = command ?? process.execPath;
  const payloadArgs = command ? args : [scriptPath, ...args];
  // The existing native admission owner is Linux-only and explicitly passes
  // non-Linux payloads through. Windows retains that policy without a POSIX spawn.
  const invocation = process.platform === 'win32'
    ? (await import('../process/resolveCommandInvocation.mjs')).resolveCommandInvocation({ command: payloadCommand, args: payloadArgs, env })
    : { command: '/bin/sh', args: [launcher,
    '--heavyweight-admission', `--class=${admissionClass}`,
    `--machine=${env.HAPPIER_DEV_TARGET_EXECUTION === '1' ? 'worker' : 'local'}`,
    '--', payloadCommand, ...payloadArgs] };
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd, env, signal,
      ...(invocation.windowsVerbatimArguments !== undefined
        ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments } : {}),
      stdio: ['ignore', captureStdout ? 'pipe' : 'inherit', 'inherit'] });
    let stdout = '';
    let spawnError;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (value) => { stdout += value; });
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, terminalSignal) => {
      if (spawnError) return reject(spawnError);
      if (code === 0) return resolve(stdout);
      const error = new Error(`Source preparation failed (${terminalSignal ? `signal ${terminalSignal}` : `exit ${code}`})`);
      error.code = code;
      error.signal = terminalSignal;
      reject(error);
    });
  });
}
