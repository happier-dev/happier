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

export type ForkedVoiceInferenceWorkerProcessObservation = Pick<
  Awaited<ReturnType<VoiceInferenceWorkerChannelFactory>>,
  'pid' | 'waitForTermination'
>;

export type CreateForkedVoiceInferenceRuntimeHandleParams = Readonly<{
  /** Injectable for tests; defaults to the binary-safe spawnHappyCLI-backed channel. */
  channelFactory?: VoiceInferenceWorkerChannelFactory;
  onSnapshot?: (snapshot: ForkedVoiceInferenceRuntimeSnapshot) => void;
  loggerDebug?: (message: string, payload?: unknown) => void;
  /** Observe only the exact child owned by this runtime; intended for process-lifecycle tests. */
  onWorkerProcess?: (process: ForkedVoiceInferenceWorkerProcessObservation) => void;
}>;

export function createForkedVoiceInferenceRuntimeHandle(
  params?: CreateForkedVoiceInferenceRuntimeHandleParams,
): ForkedVoiceInferenceRuntimeHandle {
  const createChannel: VoiceInferenceWorkerChannelFactory =
    params?.channelFactory ?? (async () => spawnVoiceInferenceWorkerChannel());
  const channelFactory: VoiceInferenceWorkerChannelFactory = async () => {
    const channel = await createChannel();
    try {
      params?.onWorkerProcess?.({
        pid: channel.pid,
        waitForTermination: channel.waitForTermination,
      });
    } catch (error) {
      // The observer is outside the supervised client, so it must not strand a successfully
      // spawned child before the client can assume ownership. Retire this exact channel first;
      // the client remains the sole supervisor for every channel it successfully receives.
      try {
        channel.forceTerminate();
      } finally {
        await channel.waitForTermination().catch(() => undefined);
      }
      throw error;
    }
    return channel;
  };

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
