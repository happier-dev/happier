import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import {
  MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT,
  MIN_CONVERSATION_OBSERVATION_AGE_MS,
} from '@happier-dev/channels-protocol/v1';

import {
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import { MAX_CHANNEL_ACCOUNT_COLLECTION_QUERY_PAGE_SIZE } from './requiredAccountStorage.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
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
): void {
  context.services.logger.warn('[Channels] ingress supervisor work failed', { boundary });
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
      limit: Math.min(MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT - result.length, MAX_CHANNEL_ACCOUNT_COLLECTION_QUERY_PAGE_SIZE),
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
    running = (async () => {
      try {
        while (!supervisorController.signal.aborted) {
          const workerContext = {
            ...context,
            signal: supervisorController.signal,
          } satisfies BackgroundServiceContext;
          const now = clock.now();
          if (now >= nextRetentionSweepAt) {
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
            } catch {
              if (supervisorController.signal.aborted) break;
              logIngressSupervisorFailure(workerContext, 'retention');
              // A failed page keeps its cursor but loses its urgency: retrying
              // it on the next wake would re-fail and re-log once a second for
              // the whole generation.
              nextRetentionSweepAt = now + RETENTION_SWEEP_INTERVAL_MS;
            }
          }
          try {
            await runDueWork({ now, limit: MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT }, workerContext);
          } catch {
            if (supervisorController.signal.aborted) break;
            logIngressSupervisorFailure(workerContext, 'due-work');
          }
          let connectionIds: readonly string[];
          try {
            connectionIds = await readCurrentConnectionIds(workerContext);
          } catch {
            if (supervisorController.signal.aborted) break;
            logIngressSupervisorFailure(workerContext, 'connection-discovery');
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
            try {
              await runPoll({ connectionId, waitMs: reconciliationIntervalMs }, workerContext);
            } catch {
              if (supervisorController.signal.aborted) break;
              logIngressSupervisorFailure(workerContext, 'poll');
            }
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
