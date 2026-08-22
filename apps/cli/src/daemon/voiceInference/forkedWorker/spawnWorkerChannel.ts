/**
 * Binary-safe spawn of the forked voice-inference worker child (Lane L7.T7).
 *
 * Uses the canonical `spawnHappyCLI` primitive — the SAME mechanism the daemon and
 * session runners use to spawn child processes from the packaged binary. It re-invokes
 * the running Happier CLI (node / bun / self-contained binary) with the hidden
 * `daemon voice-inference-worker` subcommand, so this works from a packaged binary with
 * NO system `node`/`npm`/`npx` and never spawns a raw runtime.
 *
 * The worker speaks the length-prefixed IPC protocol over its stdio:
 *   - daemon → child request frames on the child's stdin,
 *   - child → daemon response frames on the child's stdout.
 * stderr is left attached to the daemon log stream for native crash diagnostics.
 */

import type { ChildProcess } from 'node:child_process';

import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { createManagedChildProcess } from '@/subprocess/supervision/managedChildProcess';

import type { VoiceInferenceWorkerChannel } from './forkedRuntimeClient';

const WORKER_SUBCOMMAND = ['daemon', 'voice-inference-worker'] as const;

export function spawnVoiceInferenceWorkerChannel(): VoiceInferenceWorkerChannel {
  const child: ChildProcess = spawnHappyCLI([...WORKER_SUBCOMMAND], {
    stdio: ['pipe', 'pipe', 'inherit'],
    // The worker must not keep the daemon alive on its own; the supervisor owns lifecycle.
    windowsHide: true,
    env: {
      ...process.env,
      // Mark the child so its own startup code knows it is the inference worker role and
      // never tries to attach to the relay / start a nested daemon.
      HAPPIER_VOICE_INFERENCE_WORKER_CHILD: '1',
    },
  });

  const managed = createManagedChildProcess(child);
  const dataListeners = new Set<(chunk: Buffer) => void>();
  child.stdin?.on('error', () => {
    // A native crash can close the pipe between the client's send() check and libuv's
    // asynchronous write completion. The managed child termination event is the canonical
    // failure signal that rejects in-flight work; keep the expected EPIPE from escaping as an
    // uncaught process exception while that termination is being observed.
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const listener of dataListeners) {
      listener(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  });

  return {
    pid: managed.pid,
    send: (frame: Buffer) => {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed) {
        throw new Error('voice_inference_worker_stdin_unavailable');
      }
      stdin.write(frame);
    },
    onData: (listener) => {
      dataListeners.add(listener);
    },
    waitForTermination: managed.waitForTermination,
    terminate: () => {
      try {
        child.stdin?.end();
      } catch {
        // best-effort
      }
      child.kill('SIGTERM');
    },
    forceTerminate: () => {
      child.kill('SIGKILL');
    },
  };
}
