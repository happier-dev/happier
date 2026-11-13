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

import { INSTALLABLE_KEYS } from '@happier-dev/protocol/installables/keys';
import type { HappierProcessRootSource } from '@/daemon/processes/roots/listHappierProcessRoots';

import { ensureOptionalRuntime } from '@/packagedRuntime/installables/optionalRuntimes';

import type { RuntimeLoader } from '../voiceInferenceWorker.shared';
import type { VoiceInferenceRuntime } from '../voiceInferenceRuntimeTypes';
import { readVoiceInferenceRuntimeModuleOverride } from '../voiceInferenceWorkerConfig';
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
  readProcessRoots: (stopWorker?: () => Promise<void>) => readonly HappierProcessRootSource[];
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
  /** Test seam around the managed-installable boundary; production resolves the canonical Voice runtime. */
  prepareRuntime?: () => Promise<unknown>;
  /** Observe only the exact child owned by this runtime; intended for process-lifecycle tests. */
  onWorkerProcess?: (process: ForkedVoiceInferenceWorkerProcessObservation) => void;
}>;

export function createForkedVoiceInferenceRuntimeHandle(
  params?: CreateForkedVoiceInferenceRuntimeHandleParams,
): ForkedVoiceInferenceRuntimeHandle {
  const createChannel: VoiceInferenceWorkerChannelFactory =
    params?.channelFactory ?? (async () => spawnVoiceInferenceWorkerChannel());
  const prepareRuntime = params?.prepareRuntime
    ?? (async () => {
      if (!readVoiceInferenceRuntimeModuleOverride()) {
        await ensureOptionalRuntime(INSTALLABLE_KEYS.LOCAL_VOICE_RUNTIME);
      }
    });
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

  let recognitionClient: ForkedVoiceInferenceRuntimeClient | null = null;
  let synthesisClient: ForkedVoiceInferenceRuntimeClient | null = null;
  let runtimePrepared = false;
  let preparation: Promise<void> | null = null;

  async function ensureRuntimePrepared(): Promise<void> {
    if (runtimePrepared) return;
    if (!preparation) {
      preparation = (async () => {
        await prepareRuntime();
        runtimePrepared = true;
      })().finally(() => {
        preparation = null;
      });
    }
    await preparation;
  }

  function ensureClient(kind: 'recognition' | 'synthesis'): ForkedVoiceInferenceRuntimeClient {
    const current = kind === 'recognition' ? recognitionClient : synthesisClient;
    if (current) return current;
    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory,
      onSnapshot: params?.onSnapshot,
      loggerDebug: params?.loggerDebug,
    });
    if (kind === 'recognition') recognitionClient = client;
    else synthesisClient = client;
    return client;
  }

  // Synchronous synthesis is cancelled by terminating its worker. Recognition
  // sessions must stay in a different child so that readout/barge-in cannot
  // destroy their native state. Both children use the existing supervisor.
  const modelClient = (input: Parameters<NonNullable<VoiceInferenceRuntime['warmModel']>>[0]) =>
    ensureClient(input.manifest.kind === 'stt_sherpa' ? 'recognition' : 'synthesis');
  const runtime: VoiceInferenceRuntime = {
    warmModel: input => modelClient(input).warmModel!(input),
    primeModel: input => modelClient(input).primeModel!(input),
    releaseModel: input => modelClient(input).releaseModel!(input),
    synthesizeTts: input => ensureClient('synthesis').synthesizeTts(input),
    transcribeAudio: input => ensureClient('recognition').transcribeAudio(input),
    createStreamingTranscriptionSession: input => ensureClient('recognition').createStreamingTranscriptionSession!(input),
  };

  return {
    readProcessRoots: (stopWorker) => [recognitionClient, synthesisClient]
      .flatMap(client => client?.readProcessRoots(stopWorker) ?? []),
    // One runtime facade; children spawn lazily on their first engine call.
    runtimeLoader: async () => {
      await ensureRuntimePrepared();
      return runtime;
    },
    dispose: async () => {
      const current = [recognitionClient, synthesisClient];
      recognitionClient = null;
      synthesisClient = null;
      await Promise.all(current.map(client => client?.stop()));
    },
  };
}
