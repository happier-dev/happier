import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { isPluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { projectPluginEventSourceConnectionStatusV1, type PluginEventSourceConnectionStatusV1 } from '@happier-dev/plugin-sdk/events';
import {
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  ConversationProviderConnectionReadResultV1Schema,
  ConversationProviderConnectionsSnapshotV1Schema,
  ConversationTransportFactReportResultV1Schema,
  type ConversationProviderConnectionReconciliationSnapshotV1,
  type ConversationTransportFactReportInputV1,
} from '@happier-dev/channels-protocol/v1';
import { materializeExactSlackCredentials, readSlackConnectionConfiguration } from './slackActions.js';
import { createSlackApi } from './slackApi.js';
import { SLACK_CREDENTIAL_PURPOSE, SLACK_PLUGIN_ID, SLACK_SOCKET_BACKGROUND_SERVICE_ID, SLACK_SOCKET_WORKER_ATTEMPT_ACTION_ID,
  SLACK_AUTOMATION_MESSAGE_EVENT_ID, SLACK_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION, createSlackConnectionKey } from './slackPluginConstants.js';
import { startSlackSocketWorker, type SlackSocketWorker, type SlackSocketWorkerResult } from './slackSocketWorker.js';

// Repair failed authority/fact reads at the existing CHAN-28 cadence. Settled
// workers wait for invalidation; failed attempts retain provider Retry-After.
const RECOVERY_INTERVAL_MS = 30_000;
type Snapshot = ConversationProviderConnectionReconciliationSnapshotV1;
type Fact = ConversationTransportFactReportInputV1['fact'];
type WorkerEntry = {
  snapshot: Snapshot;
  controller: AbortController;
  worker: SlackSocketWorker | null;
  completion: Promise<void>;
  stopIntent: 'reconcile' | 'generationRetired' | null;
  replacement: Snapshot | null;
};

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameJson(value, right[index]));
  }
  const first = Object.entries(left);
  const second = Object.entries(right);
  return first.length === second.length && first.every(([key, value]) => Object.hasOwn(right, key)
    && sameJson(value, Reflect.get(right, key)));
}

function factKey(snapshot: Snapshot): string { return JSON.stringify([snapshot.connectionId, snapshot.authorityEpoch]); }
function eligible(snapshot: Snapshot): boolean { return snapshot.enabled && snapshot.deletionState === 'none'; }
function connectionFingerprint(snapshot: Snapshot): string {
  const configuration = readSlackConnectionConfiguration(snapshot);
  return JSON.stringify({ connectionId: snapshot.connectionId, providerConnectionKey: snapshot.providerConnectionKey,
    providerConfigVersion: snapshot.providerConfigVersion, credentialRef: snapshot.credentialRef,
    enabled: snapshot.enabled, deletionState: snapshot.deletionState,
    configuration: 'kind' in configuration ? configuration
      : [configuration.teamId, configuration.appId, configuration.botUserId, configuration.botId],
  });
}

/** Socket health stays with this supervisor; the SDK projects current Workflow sources. */
async function projectSourceConnectionStatus(snapshot: Snapshot, status: PluginEventSourceConnectionStatusV1, context: PluginInvocationContext): Promise<void> {
  const configuration = readSlackConnectionConfiguration(snapshot);
  if ('kind' in configuration) return;
  await projectPluginEventSourceConnectionStatusV1({
    eventRef: { pluginId: SLACK_PLUGIN_ID, localId: SLACK_AUTOMATION_MESSAGE_EVENT_ID },
    sourceContractVersion: SLACK_AUTOMATION_MESSAGE_SOURCE_CONTRACT_VERSION,
    sourceInstanceIdPrefix: `${createSlackConnectionKey(configuration)}:channel:`,
    scope: { kind: 'socket' }, status,
  }, context);
}

/** Process-local socket custody only. Core Actions remain the Account authority. */
export function createSlackSocketSupervisor() {
  const workers = new Map<string, WorkerEntry>();
  const pendingFacts = new Map<string, Fact[]>();
  const retryAt = new Map<string, number>();
  let wake = (): void => {};
  let running: Promise<void> | null = null;
  let abortRun: AbortController | null = null;
  let disposed = false;
  let recoveryAt: number | undefined;
  let updateRequired = false;

  const stopOnCollectionUpdateRequired = (error: unknown, context: PluginInvocationContext): boolean => {
    if (!isPluginError(error) || error.code !== 'collection_update_required') return false;
    if (!updateRequired) {
      updateRequired = true;
      abortRun?.abort(error);
      for (const entry of workers.values()) stopEntry(entry, 'generationRetired');
      wake();
      context.services.logger.warn('[Channels] Account Collection requires an update', {
        code: 'collection_update_required', retryable: false, recovery: 'updateHappierOnThisMachine',
      });
    }
    return true;
  };

  const retryReconciliation = (): void => {
    recoveryAt = Date.now() + RECOVERY_INTERVAL_MS;
  };

  const addFact = (snapshot: Snapshot, fact: Fact): void => {
    const key = factKey(snapshot);
    const facts = pendingFacts.get(key) ?? [];
    if (!facts.some(value => sameJson(value, fact))) pendingFacts.set(key, [...facts, fact]);
    wake();
  };
  const stopEntry = (entry: WorkerEntry, intent: NonNullable<WorkerEntry['stopIntent']>): void => {
    if (entry.stopIntent === null) entry.stopIntent = intent;
    entry.controller.abort();
    entry.worker?.stop();
  };
  const stopAll = async (intent: NonNullable<WorkerEntry['stopIntent']>): Promise<void> => {
    const entries = [...workers.values()];
    for (const entry of entries) stopEntry(entry, intent);
    await Promise.allSettled(entries.map(entry => entry.completion));
  };
  const recordResult = (entry: WorkerEntry, result: SlackSocketWorkerResult): void => {
    if (result.kind === 'stopped' && !result.unprovenContinuity && entry.stopIntent === null) {
      // Routine Socket Mode refresh is ready for immediate reconciliation.
      retryAt.set(entry.snapshot.connectionId, Date.now());
    }
    if (result.kind === 'historyGap') addFact(entry.snapshot, result);
    if (result.kind === 'notReady') {
      if (result.transportFact) addFact(entry.snapshot, result.transportFact);
      const failure = result.failure;
      const code = failure.reason === 'credentialInvalid' ? 'providerCredentialInvalid'
        : failure.reason === 'permissionMissing' ? 'providerPermissionMissing'
          : failure.reason === 'invalidConfiguration' ? 'providerConfigurationInvalid' : null;
      if (code !== null) addFact(entry.snapshot, { kind: 'providerReadiness', status: 'attention', code,
        ...(failure.diagnostic === undefined ? {} : { diagnostic: failure.diagnostic }) });
      retryAt.set(entry.snapshot.connectionId, Date.now() + (failure.retryAfterMs ?? RECOVERY_INTERVAL_MS));
    }
    if (result.kind === 'stopped' && result.unprovenContinuity) {
      if (entry.stopIntent === 'reconcile' && entry.replacement) addFact(entry.replacement, { kind: 'historyGap', reason: 'providerHistoryUnavailable' });
      if (entry.stopIntent === 'generationRetired') {
        addFact(entry.snapshot, { kind: 'historyGap', reason: 'applicationAdmissionLost' });
      }
    }
  };

  const runWorkerAttempt = async (snapshot: Snapshot, context: PluginInvocationContext): Promise<void> => {
    const caller = context.caller;
    if (caller?.kind !== 'plugin' || caller.pluginId !== SLACK_PLUGIN_ID || caller.originSurface !== 'background'
      || caller.contribution.id !== SLACK_SOCKET_BACKGROUND_SERVICE_ID
      || caller.contribution.qualifiedId !== `${SLACK_PLUGIN_ID}/backgroundServices/${SLACK_SOCKET_BACKGROUND_SERVICE_ID}`) {
      throw new Error('Slack socket worker attempts require the current background supervisor.');
    }
    const entry = workers.get(snapshot.connectionId);
    if (!entry || connectionFingerprint(entry.snapshot) !== connectionFingerprint(snapshot) || entry.controller.signal.aborted || context.signal.aborted) return;
    let result: SlackSocketWorkerResult = { kind: 'stopped' };
    try {
      const configuration = readSlackConnectionConfiguration(snapshot);
      if ('kind' in configuration) { result = { kind: 'notReady', failure: configuration }; return; }
      if (!snapshot.credentialRef) { result = { kind: 'notReady', failure: { kind: 'notReady', reason: 'credentialInvalid' } }; return; }
      const credentials = await materializeExactSlackCredentials(context, snapshot.credentialRef);
      if ('kind' in credentials) { result = { kind: 'notReady', failure: credentials }; return; }
      const api = createSlackApi({ credentials, http: context.services.http });
      const identity = await api.getIdentity({ signal: context.signal });
      if ('kind' in identity) { result = { kind: 'notReady', failure: identity }; return; }
      if (identity.teamId !== configuration.teamId || identity.appId !== configuration.appId
        || identity.botUserId !== configuration.botUserId || identity.botId !== configuration.botId) {
        result = { kind: 'notReady', failure: { kind: 'notReady', reason: 'invalidConfiguration', diagnostic: 'The Slack credential no longer matches this connection.' } };
        return;
      }
      if (context.signal.aborted || entry.controller.signal.aborted) return;
      entry.worker = startSlackSocketWorker({
        connection: { connectionId: snapshot.connectionId, get authorityEpoch() { return entry.snapshot.authorityEpoch; }, identity }, api,
        webSockets: context.services.http, signal: context.signal,
        async admitObservation(value, options) {
          try {
            await context.services.actions.execute({ pluginId: 'happier.channels', localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.observationIngest }, value, options);
          } catch (error) { stopOnCollectionUpdateRequired(error, context); throw error; }
        },
        reportConnectionStatus() {
          if (workers.get(snapshot.connectionId) === entry && !context.signal.aborted && !entry.controller.signal.aborted) {
            retryAt.delete(snapshot.connectionId);
            addFact(entry.snapshot, { kind: 'providerReadiness', status: 'ready' });
          }
        },
      });
      result = await entry.worker.result;
    } catch (error) {
      if (!stopOnCollectionUpdateRequired(error, context) && !context.signal.aborted && !entry.controller.signal.aborted) result = { kind: 'notReady', failure: {
        kind: 'notReady', reason: 'network', diagnostic: 'Slack Socket Mode could not be initialized.' } };
    } finally {
      recordResult(entry, result);
      if (result.kind === 'notReady' && workers.get(snapshot.connectionId) === entry
        && !entry.controller.signal.aborted && !context.signal.aborted) {
        await projectSourceConnectionStatus(snapshot, 'reconnecting', context);
      }
    }
  };

  const publishFacts = async (snapshot: Snapshot, context: BackgroundServiceContext): Promise<boolean> => {
    if (updateRequired || context.signal.aborted) return false;
    const key = factKey(snapshot);
    const facts = pendingFacts.get(key);
    if (!facts?.length) return true;
    for (const fact of facts) {
      if (updateRequired || context.signal.aborted) return false;
      try {
        const result = ConversationTransportFactReportResultV1Schema.parse(await context.services.actions.execute({
          pluginId: 'happier.channels', localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport,
        }, { connectionId: snapshot.connectionId, authorityEpoch: snapshot.authorityEpoch, fact }, { signal: context.signal }));
        if (result.kind === 'staleAuthority') { pendingFacts.delete(key); return false; }
        if (fact.kind === 'historyGap') await projectSourceConnectionStatus(snapshot, 'historyGap', context);
        else if (fact.kind === 'providerReadiness' && fact.status === 'ready') await projectSourceConnectionStatus(snapshot, 'ready', context);
      } catch (error) { if (!stopOnCollectionUpdateRequired(error, context)) retryReconciliation(); return false; }
    }
    // Preserve any newer fact queued while publication was in flight.
    const remaining = (pendingFacts.get(key) ?? []).filter(fact => !facts.includes(fact));
    if (remaining.length) pendingFacts.set(key, remaining); else pendingFacts.delete(key);
    return true;
  };

  const reconcile = async (context: BackgroundServiceContext): Promise<void> => {
    if (updateRequired) return;
    recoveryAt = undefined;
    let listed: ReturnType<typeof ConversationProviderConnectionsSnapshotV1Schema.parse>;
    try {
      listed = ConversationProviderConnectionsSnapshotV1Schema.parse(await context.services.actions.execute({
        pluginId: 'happier.channels', localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList,
      }, {}, { signal: context.signal }));
    } catch (error) {
      if (stopOnCollectionUpdateRequired(error, context)) return;
      retryReconciliation(); return;
    }
    const current = new Set<string>();
    const retainedFactKeys = new Set<string>();
    for (const discovery of Object.values(listed)) {
      current.add(discovery.connectionId);
      let snapshot: Snapshot;
      try {
        const read = ConversationProviderConnectionReadResultV1Schema.parse(await context.services.actions.execute({
          pluginId: 'happier.channels', localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead,
        }, { connectionId: discovery.connectionId }, { signal: context.signal }));
        const values = Object.values(read);
        if (values.length !== 1 || values[0]?.connectionId !== discovery.connectionId) throw new Error('Slack connection authority is unavailable.');
        snapshot = values[0];
      } catch (error) {
        if (stopOnCollectionUpdateRequired(error, context)) return;
        retryReconciliation();
        const entry = workers.get(discovery.connectionId);
        if (entry) retainedFactKeys.add(factKey(entry.snapshot));
        continue;
      }
      retainedFactKeys.add(factKey(snapshot));
      const entry = workers.get(snapshot.connectionId);
      if (entry && connectionFingerprint(entry.snapshot) !== connectionFingerprint(snapshot)) {
        entry.replacement = snapshot;
        stopEntry(entry, 'reconcile');
        // Only this connection waits for its predecessor. Other connections
        // keep reconciling while cancellation settles at the host boundary.
        continue;
      }
      if (entry) entry.snapshot = snapshot;
      const factsReady = await publishFacts(snapshot, context);
      if (!eligible(snapshot) || !factsReady) {
        const active = workers.get(snapshot.connectionId);
        if (active) stopEntry(active, 'reconcile');
        continue;
      }
      if (workers.has(snapshot.connectionId) || (retryAt.get(snapshot.connectionId) ?? 0) > Date.now()) continue;
      retryAt.delete(snapshot.connectionId);
      const controller = new AbortController();
      const next: WorkerEntry = { snapshot, controller, worker: null, completion: Promise.resolve(), stopIntent: null, replacement: null };
      workers.set(snapshot.connectionId, next);
      next.completion = (async () => {
        try {
          await context.services.actions.execute({ pluginId: SLACK_PLUGIN_ID, localId: SLACK_SOCKET_WORKER_ATTEMPT_ACTION_ID }, snapshot, { signal: controller.signal });
        } catch {
          if (!controller.signal.aborted) recordResult(next, { kind: 'notReady', failure: { kind: 'notReady', reason: 'network' } });
        } finally {
          if (workers.get(snapshot.connectionId) === next) workers.delete(snapshot.connectionId);
          if (!controller.signal.aborted && !retryAt.has(snapshot.connectionId)) retryAt.set(snapshot.connectionId, Date.now() + RECOVERY_INTERVAL_MS);
          wake();
        }
      })();
    }
    for (const [id, entry] of workers) if (!current.has(id)) stopEntry(entry, 'reconcile');
    for (const key of pendingFacts.keys()) if (!retainedFactKeys.has(key)) pendingFacts.delete(key);
    for (const id of retryAt.keys()) if (!current.has(id)) retryAt.delete(id);
  };

  const run = async (context: BackgroundServiceContext): Promise<void> => {
    if (disposed || running) throw new Error('Slack socket supervisor is unavailable.');
    if (updateRequired) return;
    const controller = new AbortController();
    abortRun = controller;
    let invalidated = true;
    let resume: (() => void) | undefined;
    wake = () => { invalidated = true; resume?.(); };
    const abort = () => { controller.abort(); wake(); };
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    const credentials = context.services.connectedAccounts.watch(SLACK_CREDENTIAL_PURPOSE, event => {
      if (!event.authorityChanged) return;
      retryAt.clear();
      wake();
    });
    running = (async () => {
      try {
        while (!controller.signal.aborted) {
          invalidated = false;
          await reconcile({ ...context, signal: controller.signal });
          if (controller.signal.aborted) break;
          if (invalidated) continue;
          const deadlines = [...retryAt.values()].filter(at => at > Date.now());
          if (recoveryAt !== undefined) deadlines.push(recoveryAt);
          const deadline = deadlines.length === 0 ? undefined : Math.min(...deadlines);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await new Promise<void>(resolve => {
              resume = resolve;
              if (deadline !== undefined) timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
              if (invalidated || controller.signal.aborted) resolve();
            });
          } finally { clearTimeout(timer); resume = undefined; }
        }
      } finally {
        await credentials.dispose();
        context.signal.removeEventListener('abort', abort);
        await stopAll('generationRetired');
        wake = () => {};
        abortRun = null;
      }
    })();
    try { await running; } finally { running = null; }
  };

  return {
    run,
    invalidateConnections(): void { wake(); },
    runWorkerAttempt,
    async dispose(): Promise<void> {
      disposed = true;
      abortRun?.abort();
      wake();
      await stopAll('generationRetired');
    },
  };
}
