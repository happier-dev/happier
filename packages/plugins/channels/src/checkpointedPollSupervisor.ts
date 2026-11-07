import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from '@happier-dev/plugin-sdk/collections';
import {
  MAX_CONVERSATION_RECEIVE_WAIT_MS,
} from '@happier-dev/channels-protocol/v1';

import {
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import {
  classifySupervisorFailure,
  isInactiveSupervisorCollectionFailure,
} from './supervisorFailure.js';
import {
  readNextConversationIngressDueAtForInvocation,
  runConversationCheckpointedPollForInvocation,
  runConversationIngressDueWorkForInvocation,
  settleConversationIngressAttemptsForInvocation,
  type ConversationCheckpointedPollRunResult,
} from './ingress.js';
import { convergeConversationConnectionEndpointForInvocation, type ConversationPairingManager } from './management.js';
import { createSupervisorWake } from './supervisorWake.js';
import { createChannelsCollectionAccess } from './collectionUpdateRequired.js';
import { conversationRetryDelayMs } from './retryBackoff.js';

const RECOVERY_INTERVAL_MS = 1_000;

type Clock = Readonly<{
  now(): number;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}>;

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type IngressSupervisorOptions = Readonly<{
  clock?: Clock;
  pairing?: ConversationPairingManager;
  reconciliationIntervalMs?: number;
  runPoll?: (
    input: Readonly<{ connectionId: string; waitMs: number }>,
    context: BackgroundServiceContext,
  ) => Promise<ConversationCheckpointedPollRunResult>;
  runDueWork?: (
    input: Readonly<{ now: number; limit: number }>,
    context: BackgroundServiceContext,
  ) => Promise<number>;
}>;

export type IngressSupervisor = Readonly<{
  run(context: BackgroundServiceContext): Promise<void>;
  dispose(): Promise<void>;
}>;

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Checkpointed poll supervisor was cancelled.'));
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      reject(signal.reason ?? new Error('Checkpointed poll supervisor was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const DEFAULT_CLOCK: Clock = Object.freeze({
  now: () => Date.now(),
  sleep: defaultSleep,
});

function positiveDelay(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return resolved;
}

function isJsonRecord(value: JsonValue): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function connectionIdFromRow(value: JsonValue): string | undefined {
  if (!isJsonRecord(value)) return undefined;
  if (value['record-kind'] !== CHANNEL_STATE_RECORD_KIND.connection) return undefined;
  return typeof value['connection-id'] === 'string' ? value['connection-id'] : undefined;
}

function logIngressSupervisorFailure(
  context: BackgroundServiceContext,
  boundary: 'due-work' | 'connection-discovery' | 'poll',
  error: unknown,
  connectionId?: string,
): void {
  if (isInactiveSupervisorCollectionFailure(error)) return;
  context.services.logger.warn('[Channels] ingress supervisor work failed', {
    boundary,
    ...(connectionId === undefined ? {} : { connectionId, collectionId: CHANNEL_STATE_COLLECTION.id }),
    ...(classifySupervisorFailure(error) ?? {}),
  });
}

async function readCurrentConnections(context: BackgroundServiceContext): Promise<readonly Readonly<{
  connectionId: string;
  revision: number;
  retryAt?: number;
  durablePush?: true;
  desiredKey?: string;
}>[]> {
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const result: Array<{ connectionId: string; revision: number; retryAt?: number; durablePush?: true; desiredKey?: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await collection.query({
      index: CHANNEL_STATE_INDEX_ID.byKind,
      prefix: [CHANNEL_STATE_RECORD_KIND.connection],
      order: 'asc',
      limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
      ...(cursor === undefined ? {} : { cursor }),
    }, { signal: context.signal });
    for (const row of page.rows) {
      const connectionId = connectionIdFromRow(row.value);
      if (connectionId === undefined) continue;
      const payload = isJsonRecord(row.value) ? row.value.payload : undefined;
      const failure = payload !== undefined && isJsonRecord(payload) ? payload.pollFailure : undefined;
      const transport = payload !== undefined && isJsonRecord(payload) ? payload.transport : undefined;
      const origin = payload !== undefined && isJsonRecord(payload) ? payload.transportOrigin : undefined;
      const retryAt = failure !== undefined && isJsonRecord(failure) && failure.phase === 'retryDue'
        && typeof failure.retryNotBeforeMs === 'number' && Number.isSafeInteger(failure.retryNotBeforeMs)
        ? failure.retryNotBeforeMs : undefined;
      result.push({ connectionId, revision: row.revision, ...(retryAt === undefined ? {} : { retryAt }),
        ...(transport !== undefined && isJsonRecord(transport) && transport.kind === 'durablePush' ? {
          durablePush: true as const,
          // Scheduling input only: the endpoint owner reads and admits current
          // authority at the actual invocation.
          desiredKey: JSON.stringify([
            payload !== undefined && isJsonRecord(payload) ? payload.authorityEpoch : null,
            origin !== undefined && isJsonRecord(origin) ? origin.serverIdentityId : null,
            origin !== undefined && isJsonRecord(origin) ? origin.machineId : null,
            transport,
            failure !== undefined && isJsonRecord(failure) && failure.phase === 'blocked',
            retryAt,
          ]),
        } : {}),
      });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return result;
}

/**
 * One core-owned background service reconstructs only persisted connection
 * rows on connection/binding invalidation. It has no retained connection authority, queue, or poll
 * cursor: the ingress owner rereads and fences every actual poll effect. Its
 * transient state tracks in-flight polls, owner-derived next deadlines and
 * Collection keyset position. None is a durable queue, checkpoint, retained
 * connection authority, or second owner of ingress effects.
 */
export function createIngressSupervisor(
  options: IngressSupervisorOptions = {},
): IngressSupervisor {
  const clock = options.clock ?? DEFAULT_CLOCK;
  const reconciliationIntervalMs = positiveDelay(
    options.reconciliationIntervalMs,
    RECOVERY_INTERVAL_MS,
    'Checkpointed poll reconciliation interval',
  );
  let controller: AbortController | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;
  let updateRequired = false;

  const run = async (context: BackgroundServiceContext): Promise<void> => {
    if (disposed) throw new Error('Checkpointed poll supervisor is disposed.');
    if (running !== null) throw new Error('Checkpointed poll supervisor is already running.');
    if (updateRequired) return;
    const supervisorController = new AbortController();
    controller = supervisorController;
    const abortFromContext = (): void => supervisorController.abort(context.signal.reason);
    if (context.signal.aborted) abortFromContext();
    else context.signal.addEventListener('abort', abortFromContext, { once: true });
    const wake = createSupervisorWake(supervisorController.signal);
    // null parks a permanent boundary failure until stored input changes;
    // Infinity remains an ordinary ineligible connection awaiting its watch.
    const pollDeadlines = new Map<string, { revision: number; deadline: number | null; retryAt?: number; durablePush?: true; desiredKey?: string; thrownFailures?: number; observations: readonly { dispose(): void }[];
      inputs: Map<'binding' | 'checkpoint', { revision?: string; invalidated: boolean }> }>();
    let discoverConnections = true;
    const observations: Array<{ dispose(): void }> = [];
    // The polls this generation started and has not yet seen settle, keyed by
    // connection. It is the whole of the concurrency contract: a key that is
    // still present is a connection whose provider round trip is outstanding,
    // so this wake does not start a second one for it and per-connection order
    // survives without serializing the sweep. It is generation-local — no
    // durable queue, no retained connection cache, no second scheduler — and
    // the generation is not retired until every entry has drained.
    const inFlightPollsByConnectionId = new Map<string, Promise<void>>();
    // Collection pushes may wake maintenance during recovery; they do not
    // bring a failed due-work attempt forward from the owner's retry time.
    let dueWorkRetryAt = 0;
    const retainDiscussionAttempt = (attempt: Promise<unknown>): void => {
      // Dispatch releases row custody before notifying us. A Collection wake
      // alone can run earlier, skip the busy row and park its next due attempt.
      void attempt.then(() => wake.wake(), error => {
        if (supervisorController.signal.aborted) return;
        logIngressSupervisorFailure(context, 'due-work', error);
        dueWorkRetryAt = clock.now() + reconciliationIntervalMs;
        wake.wake();
      });
    };
    const runPoll = options.runPoll ?? (async (input, workerContext) => await runConversationCheckpointedPollForInvocation(
      input, workerContext, options.pairing, { retainDiscussionAttempt },
    ));
    const runDueWork = options.runDueWork ?? (async (input, workerContext) => await runConversationIngressDueWorkForInvocation(
      input, workerContext, { retainDiscussionAttempt },
    ));
    running = (async () => {
      try {
        const access = createChannelsCollectionAccess(requireChannelsAccountStorage(context), (status, error) => {
          updateRequired = true;
          context.services.logger.warn('[Channels] Account Collection requires an update', status);
          supervisorController.abort(error);
        });
        context = { ...context, services: { ...context.services, storage: {
          ...context.services.storage, account: access.storage,
        } } };
        const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
        // Obligation changes wake their existing due-work owner, without
        // changing a provider's schedule or permanent-failure parking.
        observations.push(collection.watch({ index: CHANNEL_STATE_INDEX_ID.byKind,
          prefix: [CHANNEL_STATE_RECORD_KIND.ingressObligation], order: 'asc' }, () => wake.wake()));
        const invalidateProviderConnections = () => {
          context.services.logger.info('[Channels] Provider connections invalidated', { phase: 'connectionsInvalidated' });
          void context.services.events.plugin.emit('connections-invalidated-v1', {}, { signal: supervisorController.signal })
            .then(result => context.services.logger.info('[Channels] Provider invalidation admitted', {
              phase: 'connectionsInvalidationAdmitted', subscriberCount: result.subscriberCount,
            }))
            .catch(error => logIngressSupervisorFailure(context, 'connection-discovery', error));
        };
        if (options.pairing !== undefined) observations.push(options.pairing.subscribe(invalidateProviderConnections));
        observations.push(collection.watch({ index: CHANNEL_STATE_INDEX_ID.byKind,
          prefix: [CHANNEL_STATE_RECORD_KIND.connection], order: 'asc' }, () => {
          discoverConnections = true;
          wake.wake();
          invalidateProviderConnections();
        }));
        while (!supervisorController.signal.aborted) {
          wake.reset();
          const workerContext = {
            ...context,
            signal: supervisorController.signal,
          } satisfies BackgroundServiceContext;
          const now = clock.now();
          if (now >= dueWorkRetryAt) {
            try {
              await runDueWork({ now, limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 }, workerContext);
            } catch (error) {
              if (supervisorController.signal.aborted) break;
              logIngressSupervisorFailure(workerContext, 'due-work', error);
              dueWorkRetryAt = clock.now() + reconciliationIntervalMs;
            }
          }
          try {
            if (discoverConnections) {
              discoverConnections = false;
              const connections = await readCurrentConnections(workerContext);
              const currentIds = new Set(connections.map(connection => connection.connectionId));
              for (const [id, schedule] of pollDeadlines) if (!currentIds.has(id)) {
                pollDeadlines.delete(id);
                for (const observation of schedule.observations) observation.dispose();
              }
              for (const { connectionId, ...schedule } of connections) {
                const current = pollDeadlines.get(connectionId);
                // An unchanged connection keeps its deadline and failure
                // progress. Endpoints follow only their desired target.
                const unchanged = current !== undefined && (schedule.durablePush
                  ? current.desiredKey === schedule.desiredKey
                  : current.revision === schedule.revision);
                const inputs = current?.inputs ?? new Map<'binding' | 'checkpoint', { revision?: string; invalidated: boolean }>([
                  ['binding', { invalidated: true }], ['checkpoint', { invalidated: true }],
                ]);
                const connectionObservations = current?.observations ?? [...inputs].map(([kind, input]) =>
                  collection.watch({ index: CHANNEL_STATE_INDEX_ID.byConnectionKindV1,
                    prefix: [connectionId, kind], order: 'asc' }, () => {
                    input.invalidated = true;
                    wake.wake();
                  }));
                const next = unchanged ? current : { ...schedule, inputs, observations: connectionObservations, deadline: 0 };
                pollDeadlines.set(connectionId, next);
              }
            }
            for (const [connectionId, schedule] of pollDeadlines) {
              let next = schedule;
              for (const [kind, input] of next.inputs) {
                if (!input.invalidated) continue;
                input.invalidated = false;
                const revisions: Array<readonly [string, number]> = [];
                let cursor: string | undefined;
                try {
                  do {
                    const page = await collection.query({ index: CHANNEL_STATE_INDEX_ID.byConnectionKindV1,
                      prefix: [connectionId, kind], order: 'asc', limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
                      ...(cursor === undefined ? {} : { cursor }),
                    }, { signal: supervisorController.signal });
                    for (const row of page.rows) revisions.push([row.rowId, row.revision]);
                    cursor = page.nextCursor;
                  } while (cursor !== undefined);
                } catch (error) {
                  input.invalidated = true;
                  throw error;
                }
                const revision = JSON.stringify(revisions);
                // Watch resets describe delivery continuity, not an input
                // edit. Only changed stored rows release this connection.
                if (input.revision !== undefined && input.revision !== revision) {
                  if (kind === 'binding') invalidateProviderConnections();
                  if (kind === 'binding' ? !next.durablePush : next.deadline === null) {
                    next = { ...next, deadline: 0, thrownFailures: 0 };
                    pollDeadlines.set(connectionId, next);
                  }
                }
                input.revision = revision;
              }
            }
          } catch (error) {
            if (supervisorController.signal.aborted) break;
            discoverConnections = true;
            logIngressSupervisorFailure(workerContext, 'connection-discovery', error);
            try {
              await wake.wait(clock, now + reconciliationIntervalMs);
            } catch {
              if (!supervisorController.signal.aborted) {
                throw new Error('Checkpointed poll supervisor retry wait failed.');
              }
            }
            continue;
          }
          for (const [connectionId, schedule] of pollDeadlines) {
            if (supervisorController.signal.aborted) break;
            // A provider long poll blocks for its own wait, not for the other
            // connections': awaiting each one in turn made connections share a
            // serial sweep, so the last connection waited for every earlier round trip before it was
            // polled again, and due work waited with it.
            if (inFlightPollsByConnectionId.has(connectionId)) continue;
            if (schedule.deadline === null) continue;
            const deadline = Math.max(schedule.deadline, schedule.retryAt ?? 0);
            if (deadline > now) {
              schedule.deadline = deadline;
              continue;
            }
            if (deadline === Number.POSITIVE_INFINITY) continue;
            // Replacing this scheduling projection on a connection change
            // prevents a retired job from overwriting its successor's wake.
            schedule.deadline = Number.POSITIVE_INFINITY;
            const poll = (async () => {
              try {
                if (schedule.durablePush && await convergeConversationConnectionEndpointForInvocation({ connectionId }, workerContext)) return;
                const result = await runPoll({ connectionId, waitMs: MAX_CONVERSATION_RECEIVE_WAIT_MS }, workerContext);
                if (pollDeadlines.get(connectionId) === schedule) {
                  schedule.thrownFailures = 0;
                  schedule.deadline = result.kind === 'retry' || result.kind === 'committed'
                    ? Math.min(Number.MAX_SAFE_INTEGER, clock.now() + (result.retryAfterMs ?? reconciliationIntervalMs))
                    : Number.POSITIVE_INFINITY;
                }
              } catch (error) {
                if (supervisorController.signal.aborted) return;
                logIngressSupervisorFailure(workerContext, 'poll', error, connectionId);
                if (pollDeadlines.get(connectionId) === schedule) {
                  // Storage/host failures can precede the durable poll-failure
                  // owner. Keep only this generation's scheduling progress here;
                  // returned retries still supply their own delay unchanged.
                  schedule.thrownFailures = (schedule.thrownFailures ?? 0) + 1;
                  schedule.deadline = classifySupervisorFailure(error)?.retryable === false
                    ? null : clock.now() + conversationRetryDelayMs(schedule.thrownFailures);
                }
              }
            })();
            inFlightPollsByConnectionId.set(connectionId, poll);
            // Released through `finally` on the settled promise rather than
            // inside the body: a poll that fails before its first suspension
            // point would otherwise release the key before it was recorded,
            // and the record written afterwards would mark that connection
            // permanently in flight for the rest of the generation.
            void poll.finally(() => {
              inFlightPollsByConnectionId.delete(connectionId);
              // Releasing poll custody also releases retained due work, even
              // when the provider itself is now ineligible or parked.
              wake.wake();
            });
          }
          if (supervisorController.signal.aborted) break;
          let dueAt: number | undefined;
          try {
            dueAt = await readNextConversationIngressDueAtForInvocation(workerContext);
          } catch (error) {
            if (supervisorController.signal.aborted) break;
            logIngressSupervisorFailure(workerContext, 'due-work', error);
            dueWorkRetryAt = clock.now() + reconciliationIntervalMs;
          }
          // An in-flight predecessor already wakes its successor on completion.
          const deadlines = [...pollDeadlines]
            .filter(([connectionId]) => !inFlightPollsByConnectionId.has(connectionId))
            .map(([, schedule]) => schedule.deadline)
            .filter((value): value is number => value !== null && Number.isFinite(value));
          if (dueAt !== undefined) deadlines.push(Math.max(dueAt, dueWorkRetryAt));
          else if (dueWorkRetryAt > now) deadlines.push(dueWorkRetryAt);
          try {
            await wake.wait(clock, deadlines.length === 0 ? undefined : Math.min(...deadlines));
          } catch {
            if (!supervisorController.signal.aborted) {
              throw new Error('Checkpointed poll supervisor wait failed.');
            }
          }
        }
      } finally {
        for (const observation of observations) observation.dispose();
        for (const schedule of pollDeadlines.values()) for (const observation of schedule.observations) observation.dispose();
        wake.dispose();
        // Provider I/O this generation started still belongs to it. Resolving
        // while a poll is outstanding would let the replacement generation
        // admitted by `run` poll the same connection concurrently, and would
        // let `dispose` report a stopped service that is still calling out.
        await Promise.allSettled(inFlightPollsByConnectionId.values());
        await settleConversationIngressAttemptsForInvocation({ signal: supervisorController.signal });
        context.signal.removeEventListener('abort', abortFromContext);
        controller = null;
      }
    })();
    try {
      await running;
    } finally {
      running = null;
    }
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    controller?.abort(new Error('Checkpointed poll supervisor was disposed.'));
    await running;
  };

  return Object.freeze({ run, dispose });
}
