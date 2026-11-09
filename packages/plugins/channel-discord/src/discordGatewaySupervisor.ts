import {
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  ConversationProviderConnectionReadResultV1Schema,
  ConversationProviderConnectionsSnapshotV1Schema,
  ConversationTransportFactReportResultV1Schema,
  type ConversationProviderConnectionReconciliationSnapshotV1,
  type ConversationTransportFactReportInputV1,
} from '@happier-dev/channels-protocol/v1';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { isPluginError, type Disposable, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { projectPluginEventSourceConnectionStatusV1, type PluginEventSourceConnectionStatusV1 } from '@happier-dev/plugin-sdk/events';

import {
  materializeExactDiscordBotToken,
  readDiscordConnectionConfiguration,
} from './discordActions.js';
import { createDiscordBotApi } from './discordApi.js';
import { createDiscordIdentifyConcurrency } from './discordGatewayIdentifyConcurrency.js';
import {
  startDiscordGatewayWorker,
  type DiscordGatewayRuntimeFacts,
  type DiscordGatewayTerminalReason,
  type DiscordGatewayWorker,
  type DiscordGatewayWorkerInput,
  type DiscordGatewayWorkerResult,
} from './discordGatewayWorker.js';
import {
  DISCORD_BOT_CREDENTIAL_PURPOSE,
  DISCORD_GATEWAY_BACKGROUND_SERVICE_ID,
  DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID,
  DISCORD_PLUGIN_ID,
} from './discordPluginConstants.js';
import {
  DISCORD_AUTOMATION_MESSAGE_EVENT_ID,
  DISCORD_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
} from './discordAutomationEvent.js';

const CHANNELS_CORE_PLUGIN_ID = 'happier.channels';
const RECOVERY_INTERVAL_MS = 30_000;
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

type WorkerStopIntent = 'reconcile' | 'generationRetired';

/**
 * Generation retirement discards the worker's process-local resume coordinates.
 * A replacement can only Identify fresh and may miss dispatches in the interval,
 * so the pending fact owner retains that unproven continuity.
 */
const UNPROVEN_CONTINUITY_GAP_FACT = Object.freeze({
  kind: 'historyGap',
  reason: 'applicationAdmissionLost',
} as const);

const REPLACEMENT_CONTINUITY_GAP_FACT = Object.freeze({
  kind: 'historyGap',
  reason: 'providerHistoryUnavailable',
} as const);

type WorkerEntry = {
  snapshot: ConversationProviderConnectionReconciliationSnapshotV1;
  fingerprint: string;
  controller: AbortController;
  worker: DiscordGatewayWorker | null;
  stopIntent: WorkerStopIntent | null;
  replacementSnapshot: ConversationProviderConnectionReconciliationSnapshotV1 | null;
  completion: Promise<void>;
  supervisorLogger: BackgroundServiceContext['services']['logger'];
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
}>;

export type DiscordGatewaySupervisor = Readonly<{
  run(context: BackgroundServiceContext): Promise<void>;
  /** Content-free manifest event hint; the current run owns the census read. */
  invalidateConnections(): void;
  reconcile(context: BackgroundServiceContext): Promise<void>;
  /** One host target-Action owns each worker attempt's exact Account binding. */
  runWorkerAttempt(
    snapshot: ConversationProviderConnectionReconciliationSnapshotV1,
    context: PluginInvocationContext,
  ): Promise<void>;
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
    providerConnectionKey: snapshot.providerConnectionKey,
    providerConfigVersion: snapshot.providerConfigVersion,
    providerConfig: readDiscordConnectionConfiguration(snapshot),
    credentialRef: snapshot.credentialRef,
    enabled: snapshot.enabled,
    deletionState: snapshot.deletionState,
    requiresFullSharedMessageContent: snapshot.requiresFullSharedMessageContent,
  });
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
      : failure.reason === 'credentialInvalid'
        ? 'providerCredentialInvalid'
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
  if (result.kind === 'terminal') {
    // Each terminal reason names the repair that can actually retire it. Close
    // 4004 rejects the selected bot token, and only replacing or resyncing the
    // Connected Account credential releases the no-retry memo below, so it must
    // not be presented as a Gateway configuration problem.
    if (result.reason === 'authenticationFailed') {
      return {
        kind: 'providerReadiness',
        status: 'attention',
        code: 'providerCredentialInvalid',
        diagnostic: 'Discord rejected the selected bot token and stopped the connection. Replace or resynchronize the Connected Account credential.',
      };
    }
    const permissionFailure = result.reason === 'disallowedIntents';
    return {
      kind: 'providerReadiness',
      status: 'attention',
      code: permissionFailure ? 'providerPermissionMissing' : 'providerConfigurationInvalid',
      diagnostic: permissionFailure
        ? 'Discord refused the configured Gateway intents and stopped the connection.'
        : 'Discord rejected the Gateway connection configuration and stopped the connection.',
    };
  }
  if (result.kind === 'messageContentIntentRecoveryRequired') {
    return providerReadinessFactFromFailure(result.failure);
  }
  return result.kind === 'notReady'
    ? providerReadinessFactFromFailure(result.failure)
    : undefined;
}

/**
 * The Gateway supervisor owns this transport fact. The SDK helper only
 * projects it through the current Automation source catalog; it never owns a
 * connection-health row or a second status store.
 */
async function projectDiscordAutomationSourceConnectionStatus(
  snapshot: ConversationProviderConnectionReconciliationSnapshotV1,
  status: PluginEventSourceConnectionStatusV1,
  context: PluginInvocationContext,
): Promise<void> {
  const configuration = readDiscordConnectionConfiguration(snapshot);
  if ('kind' in configuration) return;
  await projectPluginEventSourceConnectionStatusV1({
    eventRef: { pluginId: DISCORD_PLUGIN_ID, localId: DISCORD_AUTOMATION_MESSAGE_EVENT_ID },
    sourceContractVersion: DISCORD_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
    sourceInstanceIdPrefix: `discord:application:${configuration.applicationId}:channel:`,
    scope: { kind: 'socket' },
    status,
  }, context);
}

function automationSourceStatusFromWorkerResult(
  result: DiscordGatewayWorkerResult,
): PluginEventSourceConnectionStatusV1 | null {
  if (result.kind === 'historyGap') return 'historyGap';
  if (
    result.kind === 'notReady'
    || result.kind === 'blocked'
    || result.kind === 'terminal'
    || result.kind === 'messageContentIntentRecoveryRequired'
  ) return 'reconnecting';
  return null;
}

export function createDiscordGatewaySupervisor(options: DiscordGatewaySupervisorOptions = {}): DiscordGatewaySupervisor {
  const clock = options.clock ?? DEFAULT_CLOCK;
  const workerFactory = options.workerFactory ?? startDiscordGatewayWorker;
  const identifyConcurrency = createDiscordIdentifyConcurrency();
  const resolveRuntimeFacts = options.resolveRuntimeFacts ?? requireDiscordGatewayRuntimeFactsFromCoreSnapshot;
  const reconciliationIntervalMs = options.reconciliationIntervalMs ?? RECOVERY_INTERVAL_MS;
  if (!Number.isSafeInteger(reconciliationIntervalMs) || reconciliationIntervalMs <= 0) {
    throw new Error('Discord Gateway reconciliation interval must be a positive safe integer.');
  }

  // Gateway reconciliation owns only workers and transport facts. Event
  // candidates pass to Channels through observation ingress; this loop never
  // scans or admits Automation sources directly.
  const workers = new Map<string, WorkerEntry>();
  const pendingFacts = new Map<string, PendingTransportFact[]>();
  // A connection fingerprint is built from the core reconciliation snapshot,
  // which identifies the selected Connected Account but carries no revision of
  // the credential material inside it. Repairing a wrong bot token therefore
  // produces a byte-identical fingerprint, so the terminal reason is retained
  // and the host's credential resync — not the fingerprint — retires the one
  // reason that repair can fix.
  const terminalReasonByFingerprint = new Map<string, DiscordGatewayTerminalReason>();
  const blockedUntilByFingerprint = new Map<string, number>();
  let supervisorAbort: AbortController | null = null;
  let runPromise: Promise<void> | null = null;
  let disposed = false;
  let invalidateSupervisor = (): void => {};
  let recoveryAt: number | undefined;
  let updateRequired = false;

  const stopOnCollectionUpdateRequired = (error: unknown, context: PluginInvocationContext): boolean => {
    if (!isPluginError(error) || error.code !== 'collection_update_required') return false;
    if (!updateRequired) {
      updateRequired = true;
      supervisorAbort?.abort(error);
      stopAllWorkers('generationRetired');
      context.services.logger.warn('[Channels] Account Collection requires an update', {
        code: 'collection_update_required', retryable: false, recovery: 'updateHappierOnThisMachine',
      });
    }
    return true;
  };

  const retryReconciliation = (): void => {
    recoveryAt = clock.now() + reconciliationIntervalMs;
  };

  const addFact = (snapshot: ConversationProviderConnectionReconciliationSnapshotV1, fact: PendingTransportFact): void => {
    const key = connectionFactKey(snapshot);
    const facts = pendingFacts.get(key) ?? [];
    if (!facts.some((candidate) => sameFact(candidate, fact))) {
      pendingFacts.set(key, [...facts, fact]);
      invalidateSupervisor();
    }
  };

  const stopWorker = (entry: WorkerEntry, intent: WorkerStopIntent): void => {
    if (entry.stopIntent === null) entry.stopIntent = intent;
    if (!entry.controller.signal.aborted) entry.controller.abort(new Error(`Discord Gateway worker stopped for ${intent}.`));
    entry.worker?.stop();
    entry.supervisorLogger.info('[Discord Gateway] Worker stop requested', {
      phase: 'workerStopRequested', connectionId: entry.snapshot.connectionId,
      intent: entry.stopIntent, settleOutcome: 'stillPending', workerPresent: entry.worker !== null,
      oldRequiresFullSharedMessageContent: entry.snapshot.requiresFullSharedMessageContent,
      requiresFullSharedMessageContent: entry.replacementSnapshot?.requiresFullSharedMessageContent ?? null,
    });
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
    // Generation retirement attributes the gap to the old authority.
    // A material reconciliation replacement instead attributes its
    // distinct provider-history gap to the successor below.
    if (
      entry.stopIntent === 'generationRetired'
      && result.kind === 'stopped'
      && result.unprovenContinuity === true
    ) {
      addFact(entry.snapshot, UNPROVEN_CONTINUITY_GAP_FACT);
    }
    if (
      entry.stopIntent === 'reconcile'
      && entry.replacementSnapshot !== null
      && result.kind === 'stopped'
      && result.unprovenContinuity === true
    ) {
      // The old Gateway cannot prove it resumed through the material
      // configuration change. Attribute the existing provider-history gap to
      // the successor authority so core retains the notice before starting
      // that replacement; the retired snapshot is no longer current.
      addFact(entry.replacementSnapshot, REPLACEMENT_CONTINUITY_GAP_FACT);
    }
    const providerReadinessFact = providerReadinessFactFromWorkerResult(result);
    if (providerReadinessFact !== undefined) addFact(entry.snapshot, providerReadinessFact);
    // Queue truthful current attention before retaining the no-retry memo. The
    // next reconciliation publishes the fact through core's existing owner,
    // then the unchanged fingerprint remains terminal.
    if (result.kind === 'terminal') terminalReasonByFingerprint.set(entry.fingerprint, result.reason);
    if (result.kind === 'blocked') blockedUntilByFingerprint.set(entry.fingerprint, result.retryAtMs);
    if (result.kind === 'notReady') {
      blockedUntilByFingerprint.set(entry.fingerprint, clock.now() + reconciliationIntervalMs);
    }
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
    const caller = context.caller;
    if (
      caller?.kind !== 'plugin'
      || caller.pluginId !== DISCORD_PLUGIN_ID
      || caller.contribution.id !== DISCORD_GATEWAY_BACKGROUND_SERVICE_ID
      || caller.contribution.qualifiedId
        !== `${DISCORD_PLUGIN_ID}/backgroundServices/${DISCORD_GATEWAY_BACKGROUND_SERVICE_ID}`
      || caller.originSurface !== 'background'
    ) {
      throw new Error('Discord Gateway worker attempts may only be started by the Gateway supervisor.');
    }
    const entry = workers.get(snapshot.connectionId);
    if (
      !entry
      || entry.fingerprint !== connectionFingerprint(snapshot)
      || entry.controller.signal.aborted
      || context.signal.aborted
    ) return;
    const runtime = resolveRuntimeFacts(snapshot);
    let result: DiscordGatewayWorkerResult = { kind: 'stopped' };
    context.services.logger.info('[Discord Gateway] Worker attempt', {
      phase: 'workerAttempt', connectionId: snapshot.connectionId,
      requiresFullSharedMessageContent: runtime.requiresFullSharedMessageContent,
    });
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
          get authorityEpoch() { return entry.snapshot.authorityEpoch; },
          applicationId: configuration.applicationId,
          botUserId: configuration.botUserId,
          token,
          runtime,
          applicationMessageContentIntentPermission: identity.applicationMessageContentIntentPermission,
        },
        api,
        webSockets: context.services.http,
        admitObservation: async (admission, admissionOptions) => {
          try { await context.services.actions.execute(
            {
              pluginId: CHANNELS_CORE_PLUGIN_ID,
              localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.observationIngest,
            },
            admission,
            admissionOptions,
          ); } catch (error) {
            stopOnCollectionUpdateRequired(error, context);
            throw error;
          }
        },
        reportConnectionStatus: async (status) => {
          // The worker never writes status. It can only queue a fact through
          // the current supervisor entry; the core transport-fact Action is
          // still the single persistence and projection owner.
          if (
            workers.get(snapshot.connectionId) !== entry
            || entry.controller.signal.aborted
            || context.signal.aborted
          ) return;
          if (status === 'ready') {
            blockedUntilByFingerprint.delete(entry.fingerprint);
            addFact(entry.snapshot, { kind: 'providerReadiness', status: 'ready' });
          }
          await projectDiscordAutomationSourceConnectionStatus(entry.snapshot, status, context);
        },
        signal: context.signal,
        identifyConcurrency,
        logger: context.services.logger,
      });
      entry.worker = worker;
      result = await worker.result;
    } catch (error) {
      if (!stopOnCollectionUpdateRequired(error, context) && !isAbort(error, context.signal) && !entry.controller.signal.aborted) {
        result = {
          kind: 'notReady',
          failure: { kind: 'notReady', reason: 'network', diagnostic: 'Discord Gateway worker could not be initialized.' },
        };
      }
    } finally {
      // The host retires the worker Action's logger when stop aborts it. The
      // still-current supervisor owns the observation of that worker's result.
      entry.supervisorLogger.info('[Discord Gateway] Worker settled', {
        phase: 'workerSettled', connectionId: snapshot.connectionId, resultKind: result.kind,
        settleOutcome: 'settled', intent: entry.stopIntent,
        ...('reason' in result ? { reason: result.reason } : {}),
        ...(result.kind === 'notReady' ? { reason: result.failure.reason } : {}),
        ...(result.kind === 'blocked' ? { retryAtMs: result.retryAtMs } : {}),
      });
      recordWorkerResult(entry, result);
      const sourceStatus = automationSourceStatusFromWorkerResult(result);
      if (
        sourceStatus !== null
        && workers.get(snapshot.connectionId) === entry
        && !entry.controller.signal.aborted
        && !context.signal.aborted
      ) {
        await projectDiscordAutomationSourceConnectionStatus(snapshot, sourceStatus, context);
      }
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
      replacementSnapshot: null,
      completion: Promise.resolve(),
      supervisorLogger: context.services.logger,
    };
    workers.set(snapshot.connectionId, entry);
    context.services.logger.info('[Discord Gateway] Worker starting', {
      phase: 'workerStart', connectionId: snapshot.connectionId,
      requiresFullSharedMessageContent: snapshot.requiresFullSharedMessageContent,
    });
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
          context.services.logger.info('[Discord Gateway] Worker admission failed', {
            phase: 'workerAdmissionFailed', connectionId: snapshot.connectionId,
            errorCode: isPluginError(error) ? error.code : 'unknown',
          });
          recordWorkerResult(entry, {
            kind: 'notReady',
            failure: { kind: 'notReady', reason: 'network', diagnostic: 'Discord Gateway worker could not be initialized.' },
          });
        }
      } finally {
        context.services.logger.info('[Discord Gateway] Worker attempt settled', {
          phase: 'workerAttemptSettled', connectionId: snapshot.connectionId,
          settleOutcome: 'settled', intent: entry.stopIntent,
          oldRequiresFullSharedMessageContent: snapshot.requiresFullSharedMessageContent,
          requiresFullSharedMessageContent: entry.replacementSnapshot?.requiresFullSharedMessageContent ?? null,
        });
        if (workers.get(snapshot.connectionId) === entry) workers.delete(snapshot.connectionId);
        // A worker that stops unexpectedly is no longer healthy. Reuse the
        // existing recovery interval, without shortening an explicit provider
        // retry deadline or retiring a terminal authentication memo.
        if (!entry.controller.signal.aborted && entry.stopIntent === null
          && !terminalReasonByFingerprint.has(fingerprint)
          && !blockedUntilByFingerprint.has(fingerprint)) {
          blockedUntilByFingerprint.set(fingerprint, clock.now() + reconciliationIntervalMs);
        }
        invalidateSupervisor();
      }
    })();
  };

  const skipWorker = (
    snapshot: ConversationProviderConnectionReconciliationSnapshotV1,
    context: BackgroundServiceContext,
    reason: string,
    details: Readonly<Record<string, string | number | boolean | null>> = {},
  ): false => {
    context.services.logger.info('[Discord Gateway] Worker reconciliation decision', {
      phase: 'workerDecision', connectionId: snapshot.connectionId, decision: 'skip', reason,
      requiresFullSharedMessageContent: snapshot.requiresFullSharedMessageContent, ...details,
    });
    return false;
  };

  const reportPendingFacts = async (snapshot: ConversationProviderConnectionReconciliationSnapshotV1, context: BackgroundServiceContext): Promise<boolean> => {
    if (updateRequired || context.signal.aborted) return skipWorker(snapshot, context, updateRequired ? 'collectionUpdateRequired' : 'invocationAborted');
    const key = connectionFactKey(snapshot);
    const facts = pendingFacts.get(key);
    if (!facts || facts.length === 0) return true;
    for (const fact of facts) {
      if (updateRequired || context.signal.aborted) return skipWorker(snapshot, context, updateRequired ? 'collectionUpdateRequired' : 'invocationAborted');
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
      } catch (error) {
        if (!stopOnCollectionUpdateRequired(error, context)) retryReconciliation();
        return skipWorker(snapshot, context, 'transportFactReportFailed', {
          factKind: fact.kind, errorCode: isPluginError(error) ? error.code : 'unknown',
        });
      }
      const parsed = ConversationTransportFactReportResultV1Schema.safeParse(result);
      if (!parsed.success) {
        retryReconciliation();
        return skipWorker(snapshot, context, 'transportFactReportInvalidResult', { factKind: fact.kind });
      }
      if (parsed.data.kind === 'staleAuthority') {
        pendingFacts.delete(key);
        return skipWorker(snapshot, context, 'transportFactStaleAuthority', { factKind: fact.kind });
      }
      if (fact.kind === 'historyGap') {
        await projectDiscordAutomationSourceConnectionStatus(
          snapshot,
          'historyGap',
          context,
        );
      }
    }
    pendingFacts.delete(key);
    return true;
  };

  /**
   * A list is discovery only: before a Gateway worker or a transport fact can
   * act on a connection, re-read that exact caller-filtered id from Channels'
   * Account authority. The empty or malformed result is intentionally treated
   * as no current connection, never as permission to use the list snapshot.
   * A failed read cannot start a worker or prove an existing one was revoked.
   * Core still revalidates authority for every observation and transport fact.
   */
  const readCurrentConnection = async (
    listed: ConversationProviderConnectionReconciliationSnapshotV1,
    context: BackgroundServiceContext,
  ): Promise<
    | Readonly<{ kind: 'snapshot'; snapshot: ConversationProviderConnectionReconciliationSnapshotV1 }>
    | Readonly<{ kind: 'readFailed' }>
  > => {
    let result: unknown;
    try {
      result = await context.services.actions.execute(
        {
          pluginId: CHANNELS_CORE_PLUGIN_ID,
          localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead,
        },
        { connectionId: listed.connectionId },
        { signal: context.signal },
      );
    } catch (error) {
      stopOnCollectionUpdateRequired(error, context);
      skipWorker(listed, context, 'authorityReadFailed', { errorCode: isPluginError(error) ? error.code : 'unknown' });
      return { kind: 'readFailed' };
    }
    const parsed = ConversationProviderConnectionReadResultV1Schema.safeParse(result);
    if (!parsed.success) {
      skipWorker(listed, context, 'authorityReadInvalidResult');
      return { kind: 'readFailed' };
    }
    const entries = Object.entries(parsed.data);
    if (entries.length !== 1) {
      skipWorker(listed, context, entries.length === 0 ? 'authorityReadNotCurrent' : 'authorityReadInvalidCardinality');
      return { kind: 'readFailed' };
    }
    const [connectionId, snapshot] = entries[0]!;
    if (connectionId !== listed.connectionId || snapshot.connectionId !== listed.connectionId) {
      skipWorker(listed, context, 'authorityReadIdentityMismatch');
      return { kind: 'readFailed' };
    }
    return { kind: 'snapshot', snapshot };
  };

  const reconcile = async (context: BackgroundServiceContext): Promise<void> => {
    if (updateRequired) return;
    recoveryAt = undefined;
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
    } catch (error) {
      if (stopOnCollectionUpdateRequired(error, context)) return;
      context.services.logger.info('[Discord Gateway] Connection discovery failed', {
        phase: 'reconciliationFailed', errorCode: isPluginError(error) ? error.code : 'unknown',
      });
      retryReconciliation();
      return;
    }
    const parsed = ConversationProviderConnectionsSnapshotV1Schema.safeParse(source);
    if (!parsed.success) {
      retryReconciliation();
      return;
    }
    context.services.logger.info('[Discord Gateway] Connections reconciled', {
      phase: 'reconciliation', connectionCount: Object.keys(parsed.data).length,
    });

    const snapshots: ConversationProviderConnectionReconciliationSnapshotV1[] = [];
    const currentIds = new Set<string>();
    const unreadFactKeys = new Set<string>();
    for (const listed of Object.values(parsed.data)) {
      const read = await readCurrentConnection(listed, context);
      if (updateRequired || context.signal.aborted) return;
      if (read.kind === 'readFailed') {
        retryReconciliation();
        // Preserve the listed worker and any pending facts until a successful
        // read establishes current authority or a later list proves removal.
        currentIds.add(listed.connectionId);
        unreadFactKeys.add(connectionFactKey(listed));
        const entry = workers.get(listed.connectionId);
        if (entry !== undefined) {
          unreadFactKeys.add(connectionFactKey(entry.snapshot));
        }
        continue;
      }
      snapshots.push(read.snapshot);
      context.services.logger.info('[Discord Gateway] Current connection', {
        phase: 'connectionRead', connectionId: read.snapshot.connectionId,
        enabled: read.snapshot.enabled, deletionState: read.snapshot.deletionState,
        requiresFullSharedMessageContent: read.snapshot.requiresFullSharedMessageContent,
      });
    }
    const retainedFingerprints = new Set(snapshots.map(connectionFingerprint));
    for (const entry of workers.values()) retainedFingerprints.add(entry.fingerprint);
    for (const fingerprint of terminalReasonByFingerprint.keys()) {
      if (!retainedFingerprints.has(fingerprint)) terminalReasonByFingerprint.delete(fingerprint);
    }
    for (const fingerprint of blockedUntilByFingerprint.keys()) {
      if (!retainedFingerprints.has(fingerprint)) blockedUntilByFingerprint.delete(fingerprint);
    }
    const retainedFactKeys = new Set(snapshots.map(connectionFactKey));
    for (const entry of workers.values()) retainedFactKeys.add(connectionFactKey(entry.snapshot));
    for (const factKey of unreadFactKeys) retainedFactKeys.add(factKey);
    // A queued fact is only ever published against a reconciled connection and
    // authority epoch. Once that pair leaves reconciliation nothing can select
    // it again, so retaining the payload for the rest of the daemon generation
    // only accumulates unreachable evidence under connection churn.
    for (const factKey of pendingFacts.keys()) {
      if (!retainedFactKeys.has(factKey)) pendingFacts.delete(factKey);
    }

    for (const snapshot of snapshots) {
      currentIds.add(snapshot.connectionId);
      const fingerprint = connectionFingerprint(snapshot);
      const existing = workers.get(snapshot.connectionId);
      const comparison = {
        connectionId: snapshot.connectionId,
        fingerprintMatches: existing === undefined ? null : existing.fingerprint === fingerprint,
        oldRequiresFullSharedMessageContent: existing?.snapshot.requiresFullSharedMessageContent ?? null,
        requiresFullSharedMessageContent: snapshot.requiresFullSharedMessageContent,
      };
      context.services.logger.info('[Discord Gateway] Worker fingerprint compared', {
        phase: 'workerComparison', ...comparison,
      });
      if (existing && existing.fingerprint !== fingerprint) {
        // Discord Resume cannot change Identify intents. Wait for the worker
        // owning the old strict demand to finish, then the next authoritative
        // reconciliation starts a fresh IDENTIFY under the new demand.
        context.services.logger.info('[Discord Gateway] Worker reconciliation decision', {
          phase: 'workerDecision', ...comparison, decision: 'stop-and-replace',
        });
        existing.replacementSnapshot = snapshot;
        stopWorker(existing, 'reconcile');
        continue;
      }
      if (existing) existing.snapshot = snapshot;

      if (!isEligibleSocketConnection(snapshot)) {
        skipWorker(snapshot, context, 'connectionIneligible', { enabled: snapshot.enabled, deletionState: snapshot.deletionState });
        continue;
      }
      if (!await reportPendingFacts(snapshot, context)) {
        continue;
      }
      if (workers.get(snapshot.connectionId)?.fingerprint === fingerprint) {
        context.services.logger.info('[Discord Gateway] Worker reconciliation decision', {
          phase: 'workerDecision', ...comparison, decision: 'keep',
        });
        continue;
      }
      const terminalReason = terminalReasonByFingerprint.get(fingerprint);
      if (terminalReason !== undefined) {
        skipWorker(snapshot, context, 'terminalFailure', { terminalReason });
        continue;
      }
      const blockedUntil = blockedUntilByFingerprint.get(fingerprint);
      if (blockedUntil !== undefined && clock.now() < blockedUntil) {
        skipWorker(snapshot, context, 'providerRetryDeadline', { retryAtMs: blockedUntil });
        continue;
      }
      blockedUntilByFingerprint.delete(fingerprint);
      const runtime = resolveRuntimeFacts(snapshot);
      context.services.logger.info('[Discord Gateway] Worker reconciliation decision', {
        phase: 'workerDecision', ...comparison, decision: 'start',
      });
      startWorker(snapshot, runtime, context);
    }

    for (const [connectionId, entry] of workers) {
      if (!currentIds.has(connectionId)) stopWorker(entry, 'reconcile');
    }
  };

  const run = async (context: BackgroundServiceContext): Promise<void> => {
    if (disposed) throw new Error('Discord Gateway supervisor is disposed.');
    if (runPromise) throw new Error('Discord Gateway supervisor is already running.');
    if (updateRequired) return;
    const controller = new AbortController();
    supervisorAbort = controller;
    const abortFromContext = (): void => controller.abort(context.signal.reason);
    if (context.signal.aborted) abortFromContext();
    else context.signal.addEventListener('abort', abortFromContext, { once: true });
    let invalidated = true;
    let resumeWait: (() => void) | undefined;
    const wake = (): void => {
      invalidated = true;
      resumeWait?.();
    };
    invalidateSupervisor = wake;
    controller.signal.addEventListener('abort', wake, { once: true });
    // The manifest handler forwards content-free hints to this run's wake.
    // Initial admission reads unconditionally, and invalidations during a read
    // remain set until the next census, including at the read-to-wait boundary.
    // The selected Connected Account is a separate authority whose credential
    // material can change without changing any fact in the core reconciliation
    // snapshot. This resync is the only signal that tells the supervisor a
    // Gateway authentication failure is worth another attempt.
    const credentialResync: Disposable = context.services.connectedAccounts.watch(
      DISCORD_BOT_CREDENTIAL_PURPOSE,
      () => {
        for (const [fingerprint, reason] of terminalReasonByFingerprint) {
          if (reason === 'authenticationFailed') terminalReasonByFingerprint.delete(fingerprint);
        }
        wake();
      },
    );
    runPromise = (async () => {
      try {
        while (!controller.signal.aborted) {
          invalidated = false;
          await reconcile({ ...context, signal: controller.signal });
          if (controller.signal.aborted) break;
          if (invalidated) continue;
          const deadlines = [...blockedUntilByFingerprint.values()].filter(at => at > clock.now());
          if (recoveryAt !== undefined) deadlines.push(recoveryAt);
          const deadline = deadlines.length === 0 ? undefined : Math.min(...deadlines);
          const waitController = new AbortController();
          try {
            const changed = new Promise<void>(resolve => { resumeWait = resolve; });
            if (invalidated || controller.signal.aborted) resumeWait?.();
            if (deadline === undefined) await changed;
            else await Promise.race([
              changed,
              clock.sleep(Math.max(0, deadline - clock.now()), waitController.signal),
            ]);
          } catch {
            if (!controller.signal.aborted) throw new Error('Discord Gateway reconciliation wait failed.');
          } finally {
            resumeWait = undefined;
            waitController.abort();
          }
        }
      } finally {
        invalidateSupervisor = () => {};
        controller.signal.removeEventListener('abort', wake);
        await credentialResync.dispose();
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

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    supervisorAbort?.abort(new Error('Discord Gateway supervisor was disposed.'));
    stopAllWorkers('generationRetired');
    await Promise.allSettled([...workers.values()].map((entry) => entry.completion));
    await identifyConcurrency.waitForCommittedWindows();
  };

  return Object.freeze({
    run, reconcile, runWorkerAttempt, dispose,
    invalidateConnections() { invalidateSupervisor(); },
  });
}
