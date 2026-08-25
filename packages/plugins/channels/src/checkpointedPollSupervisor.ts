import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from '@happier-dev/plugin-sdk/collections';
import {
  MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT,
  MIN_CONVERSATION_OBSERVATION_AGE_MS,
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
  runConversationCheckpointedPollForInvocation,
  runConversationIngressDueWorkForInvocation,
  runConversationIngressRetentionForInvocation,
  type ConversationCheckpointedPollRunResult,
} from './ingress.js';
import type { ConversationPairingManager } from './management.js';

const RECONCILIATION_INTERVAL_MS = 1_000;

/**
 * Retention deletes a retained ingress body once its frozen replay horizon has
 * passed, and the shortest horizon an operator can configure is
 * `MIN_CONVERSATION_OBSERVATION_AGE_MS`. Sweeping once per that floor therefore
 * bounds an eligible body's extra lifetime by the tightest window the retention
 * contract itself protects, without re-scanning the whole census collection on
 * the one-second reconciliation wake that exists for polling, not for horizons
 * measured in minutes and days.
 */
const RETENTION_SWEEP_INTERVAL_MS = MIN_CONVERSATION_OBSERVATION_AGE_MS;

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
  runRetention?: (
    input: Readonly<{ now: number; limit: number; cursor?: string }>,
    context: BackgroundServiceContext,
  ) => Promise<Readonly<{ nextCursor?: string }>>;
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
  boundary: 'due-work' | 'retention' | 'connection-discovery' | 'poll',
  error: unknown,
): void {
  if (isInactiveSupervisorCollectionFailure(error)) return;
  context.services.logger.warn('[Channels] ingress supervisor work failed', {
    boundary,
    ...(classifySupervisorFailure(error) ?? {}),
  });
}

async function readCurrentConnectionIds(context: BackgroundServiceContext): Promise<readonly string[]> {
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const result: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await collection.query({
      index: CHANNEL_STATE_INDEX_ID.byKind,
      prefix: [CHANNEL_STATE_RECORD_KIND.connection],
      order: 'asc',
      limit: Math.min(MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT - result.length, PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1),
      ...(cursor === undefined ? {} : { cursor }),
    }, { signal: context.signal });
    for (const row of page.rows) {
      const connectionId = connectionIdFromRow(row.value);
      if (connectionId !== undefined) result.push(connectionId);
    }
    if (result.length >= MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT) return result;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return result;
}

/**
 * One core-owned background service reconstructs only persisted connection
 * rows on each wake. It has no retained connection cache, queue, or poll
 * cursor: the ingress owner rereads and fences every actual poll effect. Its
 * only transient state is the existing Collection keyset cursor for bounded
 * retention fairness plus the generation-local deadline that paces the sweep;
 * neither is a durable queue, a timer registry, or a second owner.
 */
export function createIngressSupervisor(
  options: IngressSupervisorOptions = {},
): IngressSupervisor {
  const clock = options.clock ?? DEFAULT_CLOCK;
  const reconciliationIntervalMs = positiveDelay(
    options.reconciliationIntervalMs,
    RECONCILIATION_INTERVAL_MS,
    'Checkpointed poll reconciliation interval',
  );
  const runPoll = options.runPoll ?? (async (input, context) => await runConversationCheckpointedPollForInvocation(
    input,
    context,
    options.pairing,
  ));
  const runDueWork = options.runDueWork ?? (async (input, context) => await runConversationIngressDueWorkForInvocation(
    input,
    context,
  ));
  const runRetention = options.runRetention ?? (async (input, context) => await runConversationIngressRetentionForInvocation(
    input,
    context,
  ));
  let controller: AbortController | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;

  const run = async (context: BackgroundServiceContext): Promise<void> => {
    if (disposed) throw new Error('Checkpointed poll supervisor is disposed.');
    if (running !== null) throw new Error('Checkpointed poll supervisor is already running.');
    const supervisorController = new AbortController();
    controller = supervisorController;
    const abortFromContext = (): void => supervisorController.abort(context.signal.reason);
    if (context.signal.aborted) abortFromContext();
    else context.signal.addEventListener('abort', abortFromContext, { once: true });
    let retentionCursor: string | undefined;
    // The first wake owns the startup pass: there is no earlier sweep to pace.
    let nextRetentionSweepAt = 0;
    // The polls this generation started and has not yet seen settle, keyed by
    // connection. It is the whole of the concurrency contract: a key that is
    // still present is a connection whose provider round trip is outstanding,
    // so this wake does not start a second one for it and per-connection order
    // survives without serializing the sweep. It is generation-local — no
    // durable queue, no retained connection cache, no second scheduler — and
    // the generation is not retired until every entry has drained.
    const inFlightPollsByConnectionId = new Map<string, Promise<void>>();
    // The single outstanding retention pass, for exactly the same reason and
    // with exactly the same lifetime as the poll map above.
    let retentionPass: Promise<void> | null = null;
    running = (async () => {
      try {
        while (!supervisorController.signal.aborted) {
          const workerContext = {
            ...context,
            signal: supervisorController.signal,
          } satisfies BackgroundServiceContext;
          const now = clock.now();
          // Retention is coarse maintenance and one page of it walks a whole
          // census unit per row — up to a connection read plus one read per
          // matched binding. Awaiting it inline put thousands of serial storage
          // round trips in front of every connection poll on the sweeping
          // wakes, so live ingress stalled behind cleanup of rows that are
          // already past a horizon measured in minutes. The pass runs as this
          // generation's own work instead, and the wake that finds one still
          // outstanding simply does not start a second pass over the cursor it
          // is already advancing.
          if (retentionPass === null && now >= nextRetentionSweepAt) {
            const pass = (async () => {
              try {
                const retention = await runRetention({
                  now,
                  limit: MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT,
                  ...(retentionCursor === undefined ? {} : { cursor: retentionCursor }),
                }, workerContext);
                retentionCursor = retention.nextCursor;
                // A live cursor means this sweep is still mid-collection, so the
                // next wake takes its next page. A finished sweep has nothing to
                // do until the next coarse deadline.
                nextRetentionSweepAt = retentionCursor === undefined
                  ? now + RETENTION_SWEEP_INTERVAL_MS
                  : now;
              } catch (error) {
                if (supervisorController.signal.aborted) return;
                logIngressSupervisorFailure(workerContext, 'retention', error);
                // A failed page keeps its cursor but loses its urgency: retrying
                // it on the next wake would re-fail and re-log once a second for
                // the whole generation.
                nextRetentionSweepAt = now + RETENTION_SWEEP_INTERVAL_MS;
              }
            })();
            retentionPass = pass;
            // Cleared the same way, and for the same reason, as a poll key.
            void pass.finally(() => { retentionPass = null; });
          }
          try {
            await runDueWork({ now, limit: MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT }, workerContext);
          } catch (error) {
            if (supervisorController.signal.aborted) break;
            logIngressSupervisorFailure(workerContext, 'due-work', error);
          }
          let connectionIds: readonly string[];
          try {
            connectionIds = await readCurrentConnectionIds(workerContext);
          } catch (error) {
            if (supervisorController.signal.aborted) break;
            logIngressSupervisorFailure(workerContext, 'connection-discovery', error);
            try {
              await clock.sleep(reconciliationIntervalMs, supervisorController.signal);
            } catch {
              if (!supervisorController.signal.aborted) {
                throw new Error('Checkpointed poll supervisor retry wait failed.');
              }
            }
            continue;
          }
          for (const connectionId of connectionIds) {
            if (supervisorController.signal.aborted) break;
            // A provider long poll blocks for its own wait, not for the other
            // connections': awaiting each one in turn made the supported 32
            // connections share a single serial sweep, so the last connection
            // waited for all 31 provider round trips ahead of it before it was
            // polled again, and due work and retention below waited with it.
            if (inFlightPollsByConnectionId.has(connectionId)) continue;
            const poll = (async () => {
              try {
                await runPoll({ connectionId, waitMs: reconciliationIntervalMs }, workerContext);
              } catch (error) {
                if (supervisorController.signal.aborted) return;
                logIngressSupervisorFailure(workerContext, 'poll', error);
              }
            })();
            inFlightPollsByConnectionId.set(connectionId, poll);
            // Released through `finally` on the settled promise rather than
            // inside the body: a poll that fails before its first suspension
            // point would otherwise release the key before it was recorded,
            // and the record written afterwards would mark that connection
            // permanently in flight for the rest of the generation.
            void poll.finally(() => { inFlightPollsByConnectionId.delete(connectionId); });
          }
          if (supervisorController.signal.aborted) break;
          try {
            await clock.sleep(reconciliationIntervalMs, supervisorController.signal);
          } catch {
            if (!supervisorController.signal.aborted) {
              throw new Error('Checkpointed poll supervisor wait failed.');
            }
          }
        }
      } finally {
        // Provider I/O this generation started still belongs to it. Resolving
        // while a poll is outstanding would let the replacement generation
        // admitted by `run` poll the same connection concurrently, and would
        // let `dispose` report a stopped service that is still calling out.
        await Promise.allSettled([
          ...inFlightPollsByConnectionId.values(),
          ...(retentionPass === null ? [] : [retentionPass]),
        ]);
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
