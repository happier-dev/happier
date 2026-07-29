/**
 * Selection seam for the FORKED voice-inference runtime (Lane L7.T7).
 *
 * Produces a `RuntimeLoader` (the exact shape the in-process path already implements) that
 * returns a forked-worker-backed `VoiceInferenceRuntime`. The daemon-side manager
 * (warmup / LRU / readiness / concurrency / abort) is unchanged and never learns whether
 * it is talking to an in-process engine or a forked child — there is ONE interface.
 *
 * `disposeForkedRuntime` lets the worker lifecycle terminate the child cleanly on stop so
 * no inference child process is leaked when the daemon shuts down.
 */

import type { RuntimeLoader } from '../voiceInferenceWorker.shared';
import {
  createForkedVoiceInferenceRuntimeClient,
  type ForkedVoiceInferenceRuntimeClient,
  type ForkedVoiceInferenceRuntimeSnapshot,
  type VoiceInferenceWorkerChannelFactory,
} from './forkedRuntimeClient';
import { spawnVoiceInferenceWorkerChannel } from './spawnWorkerChannel';

export type ForkedVoiceInferenceRuntimeHandle = Readonly<{
  /** The RuntimeLoader the worker lifecycle consumes (same shape as the in-process loader). */
  runtimeLoader: RuntimeLoader;
  /** Terminate the child and reject in-flight requests. Idempotent. */
  dispose: () => Promise<void>;
}>;

export type CreateForkedVoiceInferenceRuntimeHandleParams = Readonly<{
  /** Injectable for tests; defaults to the binary-safe spawnHappyCLI-backed channel. */
  channelFactory?: VoiceInferenceWorkerChannelFactory;
  onSnapshot?: (snapshot: ForkedVoiceInferenceRuntimeSnapshot) => void;
  loggerDebug?: (message: string, payload?: unknown) => void;
}>;

export function createForkedVoiceInferenceRuntimeHandle(
  params?: CreateForkedVoiceInferenceRuntimeHandleParams,
): ForkedVoiceInferenceRuntimeHandle {
  const channelFactory: VoiceInferenceWorkerChannelFactory =
    params?.channelFactory ?? (async () => spawnVoiceInferenceWorkerChannel());

  let client: ForkedVoiceInferenceRuntimeClient | null = null;

  function ensureClient(): ForkedVoiceInferenceRuntimeClient {
    if (!client) {
      client = createForkedVoiceInferenceRuntimeClient({
        channelFactory,
        onSnapshot: params?.onSnapshot,
        loggerDebug: params?.loggerDebug,
      });
    }
    return client;
  }

  return {
    // The loader always returns the same supervised client; the manager treats it as the
    // engine. Lazy spawn happens on first engine call inside the client.
    runtimeLoader: async () => ensureClient(),
    dispose: async () => {
      const current = client;
      client = null;
      if (current) {
        await current.stop();
      }
    },
  };
}
