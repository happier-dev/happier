/**
 * Forked voice-inference worker entry (Lane L7.T7).
 *
 * Invoked inside the child process by the hidden `daemon voice-inference-worker`
 * subcommand. Wires the child's real stdio to the runner dispatch loop, hosting the
 * sherpa engine with the SAME `loadDefaultVoiceInferenceRuntime` the in-process path uses.
 *
 * Reachable from the packaged binary: the daemon spawns this child via `spawnHappyCLI`
 * (node / bun / self-contained binary), which re-invokes the running CLI with this
 * subcommand — no raw `node` and no system runtime assumption.
 */

import { loadDefaultVoiceInferenceRuntime } from '../loadDefaultVoiceInferenceRuntime';
import {
  createVoiceInferenceWorkerRunner,
  type VoiceInferenceWorkerRunner,
  type VoiceInferenceWorkerTransport,
} from './workerRunner';

function createStdioTransport(): VoiceInferenceWorkerTransport {
  return {
    onData: (listener) => {
      process.stdin.on('data', (chunk: Buffer) => listener(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    },
    write: (frame) => {
      process.stdout.write(frame);
    },
    onClose: (listener) => {
      // The daemon closing our stdin (or the pipe breaking) is our signal to shut down.
      process.stdin.on('end', listener);
      process.stdin.on('close', listener);
    },
  };
}

export async function runVoiceInferenceWorkerChild(): Promise<void> {
  // Pre-load the engine so a fundamentally unavailable runtime fails fast and is visible in
  // daemon logs, but do not crash the child — request handlers map it to runtime_unavailable.
  const runner: VoiceInferenceWorkerRunner = createVoiceInferenceWorkerRunner({
    transport: createStdioTransport(),
    loadRuntime: loadDefaultVoiceInferenceRuntime,
    onError: (message, payload) => {
      process.stderr.write(`${message} ${payload instanceof Error ? payload.message : ''}\n`);
    },
  });

  // Keep the process alive until stdin closes; the runner disposes on close.
  await new Promise<void>((resolve) => {
    const finish = () => {
      runner.dispose();
      resolve();
    };
    process.stdin.on('end', finish);
    process.stdin.on('close', finish);
    process.once('SIGTERM', finish);
    process.once('SIGINT', finish);
    process.stdin.resume();
  });
}
