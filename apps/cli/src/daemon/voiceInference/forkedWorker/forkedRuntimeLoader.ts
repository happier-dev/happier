/**
 * Selection seam for the FORKED voice-inference runtime (Lane L7.T7).
 *
 * Produces a `RuntimeLoader` (the exact shape the in-process path already implements) that
 * returns a forked-worker-backed `VoiceInferenceRuntime`. The daemon-side manager
 * (warmup / LRU / readiness / concurrency / abort) is unchanged and never learns whether
 * it is talking to an in-process engine or a forked child — there is ONE interface.
 *
 * The model lifecycle can retire a child after releasing its final model. The next
 * request starts a fresh child through the same supervised channel factory.
 */

import type { ModelPackManifest } from '@happier-dev/protocol';
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
  /** Retire the child for a model kind whose final resident model was released. */
  retire: (kind: ModelPackManifest['kind']) => Promise<void>;
  /** Terminate the children and reject in-flight requests. Idempotent. */
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

  type WorkerSlot = {
    client: ForkedVoiceInferenceRuntimeClient | null;
    retirement: Promise<void> | null;
  };
  const recognition: WorkerSlot = { client: null, retirement: null };
  const synthesis: WorkerSlot = { client: null, retirement: null };
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

  async function withClient<T>(
    worker: WorkerSlot,
    use: (client: ForkedVoiceInferenceRuntimeClient) => Promise<T>,
  ): Promise<T> {
    if (worker.retirement) await worker.retirement;
    worker.client ??= createForkedVoiceInferenceRuntimeClient({
      channelFactory,
      onSnapshot: params?.onSnapshot,
      loggerDebug: params?.loggerDebug,
    });
    return await use(worker.client);
  }

  function retire(worker: WorkerSlot): Promise<void> | undefined {
    if (!worker.retirement && worker.client) {
      // Keep the slot closed to admission until its previous child has exited.
      worker.retirement = worker.client.stop().finally(() => {
        worker.client = null;
        worker.retirement = null;
      });
    }
    return worker.retirement ?? undefined;
  }

  // Synchronous synthesis is cancelled by terminating its worker. Recognition
  // sessions must stay in a different child so that readout/barge-in cannot
  // destroy their native state. Both children use the existing supervisor.
  const workerForKind = (kind: ModelPackManifest['kind']) => kind === 'stt_sherpa' ? recognition : synthesis;
  const runtime: VoiceInferenceRuntime = {
    warmModel: input => withClient(workerForKind(input.manifest.kind), client => client.warmModel!(input)),
    primeModel: input => withClient(workerForKind(input.manifest.kind), client => client.primeModel!(input)),
    releaseModel: input => withClient(workerForKind(input.manifest.kind), client => client.releaseModel!(input)),
    synthesizeTts: input => withClient(synthesis, client => client.synthesizeTts(input)),
    transcribeAudio: input => withClient(recognition, client => client.transcribeAudio(input)),
    createStreamingTranscriptionSession: input => withClient(recognition, client => client.createStreamingTranscriptionSession!(input)),
  };

  return {
    readProcessRoots: (stopWorker) => [recognition, synthesis]
      .flatMap(worker => worker.client?.readProcessRoots(stopWorker) ?? []),
    retire: async (kind) => { await retire(workerForKind(kind)); },
    // One runtime facade; children spawn lazily on their first engine call.
    runtimeLoader: async () => {
      await ensureRuntimePrepared();
      return runtime;
    },
    dispose: async () => {
      await Promise.all([retire(recognition), retire(synthesis)]);
    },
  };
}
