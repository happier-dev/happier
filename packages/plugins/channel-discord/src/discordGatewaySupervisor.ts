import {
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  ConversationProviderConnectionStopInputV1Schema,
  ConversationProviderConnectionStopResultV1Schema,
  ConversationProviderConnectionsSnapshotV1Schema,
  ConversationTransportFactReportResultV1Schema,
  type ConversationProviderConnectionReconciliationSnapshotV1,
  type ConversationProviderConnectionStopResultV1,
  type ConversationTransportFactReportInputV1,
} from '@happier-dev/channels-protocol/v1';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';

import {
  assertDiscordChannelsCoreCaller,
  materializeExactDiscordBotToken,
  readDiscordConnectionConfiguration,
} from './discordActions.js';
import { createDiscordBotApi } from './discordApi.js';
import { createDiscordIdentifyConcurrency } from './discordGatewayIdentifyConcurrency.js';
import {
  startDiscordGatewayWorker,
  type DiscordGatewayRuntimeFacts,
  type DiscordGatewayWorker,
  type DiscordGatewayWorkerInput,
  type DiscordGatewayWorkerResult,
} from './discordGatewayWorker.js';
import { DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID } from './discordPluginConstants.js';

const CHANNELS_CORE_PLUGIN_ID = 'happier.channels';
const RECONCILIATION_INTERVAL_MS = 30_000;
const STOP_WAIT_MS = 2_000;
// Discord permits 1,000 Gateway session starts per 24-hour window. A
// connection reservation permits one Discord application key per Account, so
// this bounded recheck stays below that budget even if the Portal takes time
// to apply a repaired privileged intent.
const MESSAGE_CONTENT_RECHECK_DELAY_MS = 5 * 60_000;

type DiscordGatewayWorkerFactory = (input: DiscordGatewayWorkerInput) => DiscordGatewayWorker;

type DiscordGatewaySupervisorClock = Readonly<{
  now(): number;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}>;

type PendingTransportFact = ConversationTransportFactReportInputV1['fact'];

type WorkerStopIntent = 'reconcile' | 'explicit' | 'generationRetired';

type WorkerEntry = {
  snapshot: ConversationProviderConnectionReconciliationSnapshotV1;
  fingerprint: string;
  controller: AbortController;
  worker: DiscordGatewayWorker | null;
  stopIntent: WorkerStopIntent | null;
  explicitStopAuthorityEpoch: number | null;
  completion: Promise<void>;
};

/**
 * C7 consumes core's strict aggregate demand directly. It does not inspect a
 * binding, audience, provider configuration, or persisted provider state.
 */
export function requireDiscordGatewayRuntimeFactsFromCoreSnapshot(
  snapshot: ConversationProviderConnectionReconciliationSnapshotV1,
): DiscordGatewayRuntimeFacts {
  return { requiresFullSharedMessageContent: snapshot.requiresFullSharedMessageContent };
}

export type DiscordGatewaySupervisorOptions = Readonly<{
  resolveRuntimeFacts?: (snapshot: ConversationProviderConnectionReconciliationSnapshotV1) => DiscordGatewayRuntimeFacts;
  workerFactory?: DiscordGatewayWorkerFactory;
  clock?: DiscordGatewaySupervisorClock;
  reconciliationIntervalMs?: number;
  stopWaitMs?: number;
}>;

export type DiscordGatewaySupervisor = Readonly<{
  run(context: BackgroundServiceContext): Promise<void>;
  reconcile(context: BackgroundServiceContext): Promise<void>;
  /** One host target-Action owns each worker attempt's exact Account binding. */
  runWorkerAttempt(
    snapshot: ConversationProviderConnectionReconciliationSnapshotV1,
    context: PluginInvocationContext,
  ): Promise<void>;
  stop(input: unknown, context: PluginInvocationContext): Promise<ConversationProviderConnectionStopResultV1>;
  dispose(): Promise<void>;
}>;

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Discord Gateway supervisor was cancelled.'));
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      reject(signal.reason ?? new Error('Discord Gateway supervisor was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const DEFAULT_CLOCK: DiscordGatewaySupervisorClock = Object.freeze({
  now: () => Date.now(),
  sleep: defaultSleep,
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
});

function isEligibleSocketConnection(snapshot: ConversationProviderConnectionReconciliationSnapshotV1): boolean {
  return snapshot.enabled
    && snapshot.deletionState === 'none';
}

function connectionFactKey(snapshot: ConversationProviderConnectionReconciliationSnapshotV1): string {
  return JSON.stringify([snapshot.connectionId, snapshot.authorityEpoch]);
}

function connectionFingerprint(snapshot: ConversationProviderConnectionReconciliationSnapshotV1): string {
  return JSON.stringify({
    connectionId: snapshot.connectionId,
    authorityEpoch: snapshot.authorityEpoch,
    providerConnectionKey: snapshot.providerConnectionKey,
    providerConfigVersion: snapshot.providerConfigVersion,
    providerConfig: snapshot.providerConfig,
    credentialRef: snapshot.credentialRef,
    enabled: snapshot.enabled,
    deletionState: snapshot.deletionState,
    requiresFullSharedMessageContent: snapshot.requiresFullSharedMessageContent,
  });
}

function isJsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => sameJsonValue(entry, right[index]));
  }
  if (!isJsonRecord(left) || !isJsonRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameJsonValue(left[key], right[key]));
}

function isExactFrozenOldWorker(input: Readonly<{
  snapshot: ConversationProviderConnectionReconciliationSnapshotV1;
  request: ReturnType<typeof ConversationProviderConnectionStopInputV1Schema.parse>;
}>): boolean {
  const { snapshot, request } = input;
  return request.authorityEpoch > 1
    && snapshot.connectionId === request.connectionId
    && snapshot.authorityEpoch === request.authorityEpoch - 1
    && snapshot.providerConnectionKey === request.providerConnectionKey
    && snapshot.providerConfigVersion === request.providerConfigVersion
    && sameJsonValue(snapshot.providerConfig, request.providerConfig)
    && sameJsonValue(snapshot.credentialRef, request.credentialRef);
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || error === signal.reason;
}

function sameFact(left: PendingTransportFact, right: PendingTransportFact): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'providerReadiness') {
    if (right.kind !== 'providerReadiness' || left.status !== right.status) return false;
    if (left.status === 'ready') return true;
    return right.status === 'attention'
      && left.code === right.code
      && left.diagnostic === right.diagnostic;
  }
  return right.kind === left.kind && left.reason === right.reason;
}

function providerReadinessFactFromFailure(
  failure: Extract<DiscordGatewayWorkerResult, Readonly<{ kind: 'notReady' }>>['failure'],
): PendingTransportFact | undefined {
  const code = failure.reason === 'permissionMissing'
    ? 'providerPermissionMissing'
    : failure.reason === 'invalidConfiguration'
      ? 'providerConfigurationInvalid'
      : undefined;
  if (code === undefined) return undefined;
  return {
    kind: 'providerReadiness',
    status: 'attention',
    code,
    ...(failure.diagnostic === undefined ? {} : { diagnostic: failure.diagnostic }),
  };
}

function providerReadinessFactFromWorkerResult(
  result: DiscordGatewayWorkerResult,
): PendingTransportFact | undefined {
  if (result.kind === 'messageContentIntentRecoveryRequired') {
    return providerReadinessFactFromFailure(result.failure);
  }
  return result.kind === 'notReady'
    ? providerReadinessFactFromFailure(result.failure)
    : undefined;
}

function waitForCompletion(
  completion: Promise<void>,
  signal: AbortSignal,
  clock: DiscordGatewaySupervisorClock,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      clock.clearTimeout(timer);
      resolve(value);
    };
    const timer = clock.setTimeout(() => finish(false), timeoutMs);
    const onAbort = (): void => finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    void completion.then(() => finish(true), () => finish(true));
  });
}

export function createDiscordGatewaySupervisor(options: DiscordGatewaySupervisorOptions = {}): DiscordGatewaySupervisor {
  const clock = options.clock ?? DEFAULT_CLOCK;
  const workerFactory = options.workerFactory ?? startDiscordGatewayWorker;
  const identifyConcurrency = createDiscordIdentifyConcurrency();
  const resolveRuntimeFacts = options.resolveRuntimeFacts ?? requireDiscordGatewayRuntimeFactsFromCoreSnapshot;
  const reconciliationIntervalMs = options.reconciliationIntervalMs ?? RECONCILIATION_INTERVAL_MS;
  const stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS;
  if (!Number.isSafeInteger(reconciliationIntervalMs) || reconciliationIntervalMs <= 0) {
    throw new Error('Discord Gateway reconciliation interval must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(stopWaitMs) || stopWaitMs <= 0) {
    throw new Error('Discord Gateway stop wait must be a positive safe integer.');
  }

  const workers = new Map<string, WorkerEntry>();
  const pendingFacts = new Map<string, PendingTransportFact[]>();
  const terminalFingerprints = new Set<string>();
  const blockedUntilByFingerprint = new Map<string, number>();
  const reportedNotRunning = new Set<string>();
  let supervisorAbort: AbortController | null = null;
  let runPromise: Promise<void> | null = null;
  let disposed = false;

  const addFact = (snapshot: ConversationProviderConnectionReconciliationSnapshotV1, fact: PendingTransportFact): void => {
    const key = connectionFactKey(snapshot);
    const facts = pendingFacts.get(key) ?? [];
    if (!facts.some((candidate) => sameFact(candidate, fact))) {
      pendingFacts.set(key, [...facts, fact]);
    }
  };

  const stopWorker = (entry: WorkerEntry, intent: WorkerStopIntent): void => {
    if (entry.stopIntent === null || intent === 'explicit') entry.stopIntent = intent;
    if (!entry.controller.signal.aborted) entry.controller.abort(new Error(`Discord Gateway worker stopped for ${intent}.`));
    entry.worker?.stop();
  };

  const stopAllWorkers = (intent: WorkerStopIntent): void => {
    for (const entry of workers.values()) stopWorker(entry, intent);
  };

  const recordWorkerResult = (entry: WorkerEntry, result: DiscordGatewayWorkerResult): void => {
    const transportFact = result.kind === 'historyGap'
      ? result
      : result.kind === 'notReady'
        ? result.transportFact
        : undefined;
    if (transportFact !== undefined) addFact(entry.snapshot, transportFact);
    const providerReadinessFact = providerReadinessFactFromWorkerResult(result);
    if (providerReadinessFact !== undefined) addFact(entry.snapshot, providerReadinessFact);
    if (entry.stopIntent === 'explicit') {
      addFact({
        ...entry.snapshot,
        authorityEpoch: entry.explicitStopAuthorityEpoch ?? entry.snapshot.authorityEpoch,
      }, { kind: 'stopConfirmed', reason: 'explicitStop' });
    }
    if (result.kind === 'terminal') {
      terminalFingerprints.add(entry.fingerprint);
    }
    if (result.kind === 'blocked') blockedUntilByFingerprint.set(entry.fingerprint, result.retryAtMs);
    if (result.kind === 'messageContentIntentRecoveryRequired' && result.source === 'gateway4014') {
      blockedUntilByFingerprint.set(
        entry.fingerprint,
        clock.now() + MESSAGE_CONTENT_RECHECK_DELAY_MS,
      );
    }
  };

  const runWorkerAttempt = async (
    snapshot: ConversationProviderConnectionReconciliationSnapshotV1,
    context: PluginInvocationContext,
  ): Promise<void> => {
    const entry = workers.get(snapshot.connectionId);
    if (
      !entry
      || entry.fingerprint !== connectionFingerprint(snapshot)
      || entry.controller.signal.aborted
      || context.signal.aborted
    ) return;
    const runtime = resolveRuntimeFacts(snapshot);
    let result: DiscordGatewayWorkerResult = { kind: 'stopped' };
    try {
      const configuration = readDiscordConnectionConfiguration(snapshot);
      if ('kind' in configuration) {
        result = { kind: 'notReady', failure: configuration };
        return;
      }
      if (!snapshot.credentialRef) {
        result = {
          kind: 'notReady',
          failure: {
            kind: 'notReady',
            reason: 'credentialInvalid',
            diagnostic: 'The Discord bot credential is unavailable.',
          },
        };
        return;
      }
      const token = await materializeExactDiscordBotToken(context, snapshot.credentialRef);
      if (typeof token !== 'string') {
        result = { kind: 'notReady', failure: token };
        return;
      }
      if (context.signal.aborted || entry.controller.signal.aborted) return;
      const api = createDiscordBotApi({ token, http: context.services.http });
      const identity = await api.getIdentity({ signal: context.signal });
      if ('kind' in identity) {
        result = { kind: 'notReady', failure: identity };
        return;
      }
      if (
        identity.applicationId !== configuration.applicationId
        || identity.botUserId !== configuration.botUserId
      ) {
        result = {
          kind: 'notReady',
          failure: {
            kind: 'notReady',
            reason: 'invalidConfiguration',
            diagnostic: 'The selected Discord bot no longer matches this Channel connection.',
          },
        };
        return;
      }
      if (context.signal.aborted || entry.controller.signal.aborted) return;
      const worker = workerFactory({
        connection: {
          connectionId: snapshot.connectionId,
          authorityEpoch: snapshot.authorityEpoch,
          applicationId: configuration.applicationId,
          botUserId: configuration.botUserId,
          token,
          runtime,
          applicationMessageContentIntentPermission: identity.applicationMessageContentIntentPermission,
        },
        api,
        webSockets: context.services.http,
        admitObservation: async (admission, admissionOptions) => {
          await context.services.actions.execute(
            {
              pluginId: CHANNELS_CORE_PLUGIN_ID,
              localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.observationIngest,
            },
            admission,
            admissionOptions,
          );
        },
        reportReadiness: () => {
          // The worker never writes status. It can only queue a fact through
          // the current supervisor entry; the core transport-fact Action is
          // still the single persistence and projection owner.
          if (
            workers.get(snapshot.connectionId) !== entry
            || entry.controller.signal.aborted
            || context.signal.aborted
          ) return;
          blockedUntilByFingerprint.delete(entry.fingerprint);
          addFact(snapshot, { kind: 'providerReadiness', status: 'ready' });
        },
        signal: context.signal,
        identifyConcurrency,
      });
      entry.worker = worker;
      result = await worker.result;
    } catch (error) {
      if (!isAbort(error, context.signal) && !entry.controller.signal.aborted) {
        result = {
          kind: 'notReady',
          failure: { kind: 'notReady', reason: 'network', diagnostic: 'Discord Gateway worker could not be initialized.' },
        };
      }
    } finally {
      recordWorkerResult(entry, result);
      if (workers.get(snapshot.connectionId) === entry) workers.delete(snapshot.connectionId);
    }
  };

  const startWorker = (snapshot: ConversationProviderConnectionReconciliationSnapshotV1, _runtime: DiscordGatewayRuntimeFacts, context: BackgroundServiceContext): void => {
    const fingerprint = connectionFingerprint(snapshot);
    const controller = new AbortController();
    const entry: WorkerEntry = {
      snapshot,
      fingerprint,
      controller,
      worker: null,
      stopIntent: null,
      explicitStopAuthorityEpoch: null,
      completion: Promise.resolve(),
    };
    workers.set(snapshot.connectionId, entry);
    entry.completion = (async () => {
      try {
        await context.services.actions.execute(
          {
            pluginId: context.plugin.id,
            localId: DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID,
          },
          snapshot,
          { signal: controller.signal },
        );
      } catch (error) {
        if (!isAbort(error, controller.signal) && workers.get(snapshot.connectionId) === entry) {
          recordWorkerResult(entry, {
            kind: 'notReady',
            failure: { kind: 'notReady', reason: 'network', diagnostic: 'Discord Gateway worker could not be initialized.' },
          });
        }
      } finally {
        if (workers.get(snapshot.connectionId) === entry) workers.delete(snapshot.connectionId);
      }
    })();
  };

  const reportPendingFacts = async (snapshot: ConversationProviderConnectionReconciliationSnapshotV1, context: BackgroundServiceContext): Promise<boolean> => {
    const key = connectionFactKey(snapshot);
    const facts = pendingFacts.get(key);
    if (!facts || facts.length === 0) return true;
    for (const fact of facts) {
      let result: unknown;
      try {
        result = await context.services.actions.execute(
          {
            pluginId: CHANNELS_CORE_PLUGIN_ID,
            localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport,
          },
          { connectionId: snapshot.connectionId, authorityEpoch: snapshot.authorityEpoch, fact },
          { signal: context.signal },
        );
      } catch {
        return false;
      }
      const parsed = ConversationTransportFactReportResultV1Schema.safeParse(result);
      if (!parsed.success) return false;
      if (parsed.data.kind === 'staleAuthority') {
        pendingFacts.delete(key);
        return false;
      }
    }
    pendingFacts.delete(key);
    return true;
  };

  const reconcile = async (context: BackgroundServiceContext): Promise<void> => {
    let source: unknown;
    try {
      source = await context.services.actions.execute(
        {
          pluginId: CHANNELS_CORE_PLUGIN_ID,
          localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList,
        },
        {},
        { signal: context.signal },
      );
    } catch {
      stopAllWorkers('reconcile');
      return;
    }
    const parsed = ConversationProviderConnectionsSnapshotV1Schema.safeParse(source);
    if (!parsed.success) {
      stopAllWorkers('reconcile');
      return;
    }

    const currentIds = new Set<string>();
    for (const snapshot of Object.values(parsed.data)) {
      currentIds.add(snapshot.connectionId);
      const factKey = connectionFactKey(snapshot);
      const fingerprint = connectionFingerprint(snapshot);
      const existing = workers.get(snapshot.connectionId);
      if (existing && existing.fingerprint !== fingerprint) {
        // Discord Resume cannot change Identify intents. Wait for the worker
        // owning the old strict demand to finish, then the next authoritative
        // reconciliation starts a fresh IDENTIFY under the new demand.
        stopWorker(existing, 'reconcile');
        continue;
      }

      if (snapshot.deletionState === 'pendingStopReconciliation') {
        const hasPendingStopConfirmation = (pendingFacts.get(factKey) ?? []).some(
          (fact) => fact.kind === 'stopConfirmed',
        );
        if (!workers.has(snapshot.connectionId) && !reportedNotRunning.has(factKey) && !hasPendingStopConfirmation) {
          addFact(snapshot, { kind: 'stopConfirmed', reason: 'notRunningOnReconcile' });
          reportedNotRunning.add(factKey);
        }
        await reportPendingFacts(snapshot, context);
        continue;
      }
      if (!isEligibleSocketConnection(snapshot)) continue;
      if (!await reportPendingFacts(snapshot, context)) {
        const active = workers.get(snapshot.connectionId);
        if (active) stopWorker(active, 'reconcile');
        continue;
      }
      if (workers.get(snapshot.connectionId)?.fingerprint === fingerprint) continue;
      if (terminalFingerprints.has(fingerprint)) continue;
      const blockedUntil = blockedUntilByFingerprint.get(fingerprint);
      if (blockedUntil !== undefined && clock.now() < blockedUntil) continue;
      const runtime = resolveRuntimeFacts(snapshot);
      startWorker(snapshot, runtime, context);
    }

    for (const [connectionId, entry] of workers) {
      if (!currentIds.has(connectionId)) stopWorker(entry, 'reconcile');
    }
  };

  const run = async (context: BackgroundServiceContext): Promise<void> => {
    if (disposed) throw new Error('Discord Gateway supervisor is disposed.');
    if (runPromise) throw new Error('Discord Gateway supervisor is already running.');
    const controller = new AbortController();
    supervisorAbort = controller;
    const abortFromContext = (): void => controller.abort(context.signal.reason);
    if (context.signal.aborted) abortFromContext();
    else context.signal.addEventListener('abort', abortFromContext, { once: true });
    runPromise = (async () => {
      try {
        while (!controller.signal.aborted) {
          await reconcile({ ...context, signal: controller.signal });
          if (controller.signal.aborted) break;
          try {
            await clock.sleep(reconciliationIntervalMs, controller.signal);
          } catch {
            if (!controller.signal.aborted) throw new Error('Discord Gateway reconciliation wait failed.');
          }
        }
      } finally {
        context.signal.removeEventListener('abort', abortFromContext);
        stopAllWorkers('generationRetired');
        await Promise.allSettled([...workers.values()].map((entry) => entry.completion));
        await identifyConcurrency.waitForCommittedWindows();
        supervisorAbort = null;
      }
    })();
    try {
      await runPromise;
    } finally {
      runPromise = null;
    }
  };

  const stop = async (input: unknown, context: PluginInvocationContext): Promise<ConversationProviderConnectionStopResultV1> => {
    assertDiscordChannelsCoreCaller(context);
    const request = ConversationProviderConnectionStopInputV1Schema.parse(input);
    const entry = workers.get(request.connectionId);
    if (!entry) {
      return ConversationProviderConnectionStopResultV1Schema.parse({ kind: 'notRunning' });
    }
    if (!isExactFrozenOldWorker({ snapshot: entry.snapshot, request })) {
      return ConversationProviderConnectionStopResultV1Schema.parse({
        kind: 'notReady',
        reason: 'invalidConfiguration',
        diagnostic: 'Discord Gateway worker does not match the frozen old connection stop request.',
      });
    }
    entry.explicitStopAuthorityEpoch = request.authorityEpoch;
    stopWorker(entry, 'explicit');
    const stopped = await waitForCompletion(entry.completion, context.signal, clock, stopWaitMs);
    return ConversationProviderConnectionStopResultV1Schema.parse({ kind: stopped ? 'stopped' : 'pending' });
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    supervisorAbort?.abort(new Error('Discord Gateway supervisor was disposed.'));
    stopAllWorkers('generationRetired');
    await Promise.allSettled([...workers.values()].map((entry) => entry.completion));
    await identifyConcurrency.waitForCommittedWindows();
  };

  return Object.freeze({ run, reconcile, runWorkerAttempt, stop, dispose });
}
