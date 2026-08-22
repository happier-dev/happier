import {
  definePlugin,
  PluginError,
} from '@happier-dev/plugin-sdk';
import {
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  ConversationProvidersContributionProtocolV1,
  ConversationConnectionTestInputV1Schema,
  ConversationConnectionTestResultV1Schema,
  ConversationDeliveryInputV1Schema,
  ConversationDeliveryReconcileInputV1Schema,
  ConversationDeliveryResultV1Schema,
  ConversationEndpointResolveInputV1Schema,
  ConversationEndpointResolveResultV1Schema,
  ConversationPrincipalResolveInputV1Schema,
  ConversationPrincipalResolveResultV1Schema,
  ConversationProviderConnectionStopInputV1Schema,
  ConversationProviderConnectionStopResultV1Schema,
  ConversationProviderConnectionsSnapshotV1Schema,
  ConversationProviderObservationIngestInputV1Schema,
  ConversationProviderSetupResultV1Schema,
  ConversationTransportFactReportResultV1Schema,
} from '@happier-dev/channels-protocol/v1';

const PLUGIN_ID = 'acme.channels.out-of-tree-socket';
const CHANNELS_CORE_PLUGIN_ID = 'happier.channels';
const FIXTURE_ORIGIN = 'https://channels-fixture.invalid';
const DEFAULT_SOCKET_PATH = '/socket';
const PROVIDER_CONNECTION_KEY = 'fixture:socket';
const INTEGRATION_PRINCIPAL = Object.freeze({ id: 'fixture:integration', label: 'Fixture integration' });
const HUMAN_PRINCIPAL = Object.freeze({ id: 'fixture:human', label: 'Fixture human', kind: 'human' });
const FIXTURE_ENDPOINT = Object.freeze({ kind: 'direct', audience: 'direct', id: 'fixture:room', label: 'Fixture room' });
const MAX_STATUS_BYTES = 16 * 1024;
const MAX_OUTBOUND_TEXT_CODE_POINTS = 4096;
const RECONCILIATION_INTERVAL_MS = 30_000;
const STOP_WAIT_MS = 2_000;

/**
 * These are intentionally fixture-owned local Action identities. The
 * Channels core admits them from the serialized targeted contribution rather
 * than relying on a Channels-wide Action id registry or naming convention.
 */
const PROVIDER_ACTION_IDS = Object.freeze({
  setup: 'fixture/setup',
  connectionTest: 'fixture/test',
  endpointResolve: 'fixture/endpoint',
  principalResolve: 'fixture/principal',
  messageDeliver: 'fixture/deliver',
  deliveryReconcile: 'fixture/reconcile',
  connectionStop: 'fixture/stop',
});

const channelsProvidersV1 = ConversationProvidersContributionProtocolV1;

function actionContract(operation) {
  const declaration = operation.declaration;
  return {
    ...(declaration.input.kind === 'protocolDefined'
      ? { inputSchema: declaration.input.schema.jsonSchema }
      : {}),
    resultSchema: declaration.resultSchema.jsonSchema,
    surfaces: declaration.surfaces,
    execution: { target: 'daemon' },
    dangerLevel: declaration.dangerLevel,
  };
}

const setupInputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    socketUrl: { type: 'string', minLength: 1, maxLength: 2048 },
    pairingCode: { type: 'string', minLength: 1, maxLength: 256 },
  },
  required: ['socketUrl', 'pairingCode'],
});

const state = {
  generation: 0,
  status: {
    v: 1,
    state: 'idle',
    generation: 0,
    activeConnectionIds: [],
    lastInvalidatedAt: null,
    reconciliation: null,
  },
  invalidators: new Set(),
  observer: null,
};

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameJsonValue(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => sameJsonValue(entry, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameJsonValue(left[key], right[key]));
}

function providerFailure(reason, diagnostic) {
  return {
    kind: 'notReady',
    reason,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function assertChannelsCoreCaller(context) {
  if (
    context.surface !== 'plugin'
    || context.caller?.kind !== 'plugin'
    || context.caller.pluginId !== CHANNELS_CORE_PLUGIN_ID
  ) {
    throw new PluginError({
      code: 'fixture_channels_core_caller_required',
      message: 'Fixture Channel provider Actions require the Channels core plugin caller.',
    });
  }
}

function channelsCoreAction(run) {
  return async (input, context) => {
    assertChannelsCoreCaller(context);
    return await run(input, context);
  };
}

function validateSocketUrl(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('socketUrl must be a non-empty string');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('socketUrl is not a valid URL');
  }
  if (parsed.protocol !== 'wss:' || parsed.host !== new URL(FIXTURE_ORIGIN).host) {
    throw new Error(`socketUrl must use wss at ${FIXTURE_ORIGIN}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('socketUrl may not carry credentials or query state');
  }
  if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = DEFAULT_SOCKET_PATH;
  return parsed.href;
}

function statusSnapshot() {
  return Object.freeze({
    ...state.status,
    generation: state.generation,
    activeConnectionIds: [...state.status.activeConnectionIds],
  });
}

function updateStatus(next) {
  state.status = Object.freeze({ ...state.status, ...next });
  for (const invalidate of state.invalidators) invalidate();
}

function statusRuntime() {
  return {
    read() {
      const bytes = new TextEncoder().encode(JSON.stringify(statusSnapshot()));
      if (bytes.byteLength > MAX_STATUS_BYTES) throw new Error('status resource exceeded its declared byte bound');
      return bytes;
    },
    observe(invalidate) {
      state.invalidators.add(invalidate);
      return {
        dispose() {
          state.invalidators.delete(invalidate);
        },
      };
    },
  };
}

function setup(input) {
  if (!isRecord(input)) throw new Error('setup input must be an object');
  const socketUrl = validateSocketUrl(input.socketUrl);
  if (typeof input.pairingCode !== 'string' || input.pairingCode.length === 0) {
    throw new Error('pairingCode must be a non-empty secret');
  }
  // Setup validates the transient handoff but deliberately does not retain it.
  // Restartable credentials belong to the Connected Accounts owner, not this provider.
  return ConversationProviderSetupResultV1Schema.parse({
    v: 1,
    credentialRef: null,
    providerConnectionKey: PROVIDER_CONNECTION_KEY,
    providerConfigVersion: 1,
    providerConfig: { socketUrl },
    integrationPrincipal: INTEGRATION_PRINCIPAL,
    supportedTransports: ['socket'],
    recommendedTransport: 'socket',
    overlapSafety: 'safe',
    replayContinuity: 'sessionBound',
    outboundTextLimit: { maximum: 4096, unit: 'unicodeCodePoints' },
  });
}

function parseSocketUrlFromConnection(connection) {
  if (connection.providerConnectionKey !== PROVIDER_CONNECTION_KEY) {
    throw new Error('connection providerConnectionKey is not owned by this fixture');
  }
  if (!isRecord(connection.providerConfig) || typeof connection.providerConfig.socketUrl !== 'string') {
    throw new Error('connection providerConfig does not contain socketUrl');
  }
  return validateSocketUrl(connection.providerConfig.socketUrl);
}

function connectionTest(input) {
  const connection = ConversationConnectionTestInputV1Schema.parse(input);
  if (connection.selectedTransport !== 'socket') {
    return ConversationConnectionTestResultV1Schema.parse(providerFailure('unsupported'));
  }
  try {
    parseSocketUrlFromConnection(connection);
  } catch {
    return ConversationConnectionTestResultV1Schema.parse(providerFailure('invalidConfiguration'));
  }
  return ConversationConnectionTestResultV1Schema.parse({
    kind: 'ready',
    integrationPrincipal: INTEGRATION_PRINCIPAL,
    providerConnectionKey: PROVIDER_CONNECTION_KEY,
  });
}

function endpointResolve(input) {
  const connection = ConversationEndpointResolveInputV1Schema.parse(input);
  if ((connection.kinds !== undefined && !connection.kinds.includes(FIXTURE_ENDPOINT.kind))
    || (connection.query !== FIXTURE_ENDPOINT.id && connection.query !== FIXTURE_ENDPOINT.label)) {
    return ConversationEndpointResolveResultV1Schema.parse({ kind: 'resolved', candidates: [] });
  }
  return ConversationEndpointResolveResultV1Schema.parse({ kind: 'resolved', candidates: [FIXTURE_ENDPOINT] });
}

function principalResolve(input) {
  const connection = ConversationPrincipalResolveInputV1Schema.parse(input);
  if (connection.endpoint.kind !== FIXTURE_ENDPOINT.kind || connection.endpoint.id !== FIXTURE_ENDPOINT.id) {
    return ConversationPrincipalResolveResultV1Schema.parse({ kind: 'resolved', candidates: [] });
  }
  if (connection.query !== HUMAN_PRINCIPAL.id && connection.query !== HUMAN_PRINCIPAL.label) {
    return ConversationPrincipalResolveResultV1Schema.parse({ kind: 'resolved', candidates: [] });
  }
  return ConversationPrincipalResolveResultV1Schema.parse({ kind: 'resolved', candidates: [HUMAN_PRINCIPAL] });
}

function coreAction(localId) {
  return { pluginId: CHANNELS_CORE_PLUGIN_ID, localId };
}

function connectionFingerprint(snapshot) {
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

function connectionFactKey(snapshot) {
  return JSON.stringify([snapshot.connectionId, snapshot.authorityEpoch]);
}

function isExactFrozenOldWorker(snapshot, request) {
  return request.authorityEpoch > 1
    && snapshot.connectionId === request.connectionId
    && snapshot.authorityEpoch === request.authorityEpoch - 1
    && snapshot.providerConnectionKey === request.providerConnectionKey
    && snapshot.providerConfigVersion === request.providerConfigVersion
    && sameJsonValue(snapshot.providerConfig, request.providerConfig)
    && sameJsonValue(snapshot.credentialRef, request.credentialRef);
}

function waitForDelay(delayMs, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForCompletion(completion, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), STOP_WAIT_MS);
    const onAbort = () => finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    void completion.then(() => finish(true), () => finish(true));
  });
}

function parseSocketFrame(message) {
  if (message.kind !== 'text') throw new Error('fixture socket frame must be text');
  const parsed = JSON.parse(message.text);
  if (!isRecord(parsed) || typeof parsed.kind !== 'string') {
    throw new Error('fixture socket frame must contain a kind');
  }
  return parsed;
}

function createObserver(context, generation) {
  const controller = new AbortController();
  const workers = new Map();
  const pendingFacts = new Map();
  const reportedNotRunning = new Set();
  const suspendedFingerprints = new Set();
  const observer = {};
  let reconciliationTail = Promise.resolve();

  const isCurrent = () => state.observer === observer && !controller.signal.aborted;

  const refreshStatus = (statusState = 'active', reconciliation = 'current') => {
    if (!isCurrent()) return;
    updateStatus({
      state: statusState,
      generation,
      activeConnectionIds: [...workers.keys()].sort(),
      reconciliation,
    });
  };

  const stopWorker = (entry, intent) => {
    if (entry.stopIntent === null || intent === 'explicit') entry.stopIntent = intent;
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(new Error(`Fixture socket stopped for ${intent}.`));
    }
    try { entry.socket?.close({ code: 1000, reason: `fixture ${intent}` }); } catch { /* host close is best effort */ }
  };

  const stopAllWorkers = (intent) => {
    for (const entry of workers.values()) stopWorker(entry, intent);
  };

  const addFact = (snapshot, fact) => {
    if (!isCurrent()) return;
    const key = connectionFactKey(snapshot);
    const facts = pendingFacts.get(key) ?? [];
    if (!facts.some((candidate) => candidate.kind === fact.kind && candidate.reason === fact.reason)) {
      pendingFacts.set(key, [...facts, fact]);
    }
  };

  const reportPendingFacts = async (snapshot, actionContext) => {
    const key = connectionFactKey(snapshot);
    const facts = pendingFacts.get(key);
    if (!facts || facts.length === 0) return true;
    for (const fact of facts) {
      if (!isCurrent()) return false;
      let result;
      try {
        result = await actionContext.services.actions.execute(
          coreAction(CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport),
          { connectionId: snapshot.connectionId, authorityEpoch: snapshot.authorityEpoch, fact },
          { signal: actionContext.signal },
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
      if (fact.kind === 'stopConfirmed') reportedNotRunning.add(key);
    }
    pendingFacts.delete(key);
    return true;
  };

  const observeConnection = async (entry) => {
    let socket;
    try {
      const socketUrl = parseSocketUrlFromConnection(entry.snapshot);
      const openWebSocket = context.services.http?.openWebSocket;
      if (typeof openWebSocket !== 'function') throw new Error('host SDK does not provide the declared WebSocket client');
      socket = await openWebSocket({
        url: socketUrl,
        protocols: ['channels-fixture-v1'],
        maxMessageBytes: 128 * 1024,
      }, { signal: entry.controller.signal });
      entry.socket = socket;
      if (!isCurrent() || entry.controller.signal.aborted) return { kind: 'stopped' };
      await socket.send({
        kind: 'text',
        text: JSON.stringify({
          kind: 'subscribe',
          connectionId: entry.snapshot.connectionId,
          requiresFullSharedMessageContent: entry.snapshot.requiresFullSharedMessageContent,
        }),
      }, { signal: entry.controller.signal });
      while (isCurrent() && !entry.controller.signal.aborted) {
        let received;
        try {
          received = await socket.receive({ signal: entry.controller.signal });
        } catch {
          return entry.controller.signal.aborted || !isCurrent()
            ? { kind: 'stopped' }
            : { kind: 'historyGap', reason: 'providerHistoryUnavailable' };
        }
        if (received.kind === 'closed') {
          return entry.controller.signal.aborted || !isCurrent()
            ? { kind: 'stopped' }
            : { kind: 'historyGap', reason: 'providerHistoryUnavailable' };
        }
        let frame;
        try {
          frame = parseSocketFrame(received);
        } catch {
          return { kind: 'historyGap', reason: 'providerHistoryUnavailable' };
        }
        if (frame.kind === 'historyGap') {
          return { kind: 'historyGap', reason: 'providerHistoryUnavailable' };
        }
        if (frame.kind !== 'observation') {
          return { kind: 'historyGap', reason: 'providerHistoryUnavailable' };
        }
        let ingress;
        try {
          ingress = ConversationProviderObservationIngestInputV1Schema.parse({
            connectionId: entry.snapshot.connectionId,
            observation: frame.observation,
          });
        } catch {
          return { kind: 'historyGap', reason: 'providerHistoryUnavailable' };
        }
        try {
          await context.services.actions.execute(
            coreAction(CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.observationIngest),
            ingress,
            { signal: entry.controller.signal },
          );
        } catch {
          return { kind: 'historyGap', reason: 'applicationAdmissionLost' };
        }
      }
      return { kind: 'stopped' };
    } catch {
      return { kind: 'stopped' };
    } finally {
      try { socket?.close({ code: 1000, reason: 'fixture observer complete' }); } catch { /* host close is best effort */ }
      try { socket?.dispose?.(); } catch { /* disposal is idempotent at the host boundary */ }
    }
  };

  const requestReconciliation = (actionContext, connectionId) => {
    const run = reconciliationTail.then(async () => {
      if (!isCurrent()) return;
      let source;
      try {
        source = await actionContext.services.actions.execute(
          coreAction(
            connectionId === undefined
              ? CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList
              : CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead,
          ),
          connectionId === undefined ? {} : { connectionId },
          { signal: actionContext.signal },
        );
      } catch {
        stopAllWorkers('reconcile');
        refreshStatus('unavailable', 'coreUnavailable');
        return;
      }
      const parsed = ConversationProviderConnectionsSnapshotV1Schema.safeParse(source);
      if (!parsed.success) {
        stopAllWorkers('reconcile');
        refreshStatus('unavailable', 'invalidCoreSnapshot');
        return;
      }
      const snapshots = parsed.data;
      const reconcileSnapshot = async (snapshot) => {
        const fingerprint = connectionFingerprint(snapshot);
        const existing = workers.get(snapshot.connectionId);
        if (existing && existing.fingerprint !== fingerprint) {
          stopWorker(existing, 'reconcile');
          return;
        }
        if (snapshot.deletionState === 'pendingStopReconciliation') {
          if (existing) {
            stopWorker(existing, 'reconcile');
            return;
          }
          const key = connectionFactKey(snapshot);
          const hasPendingStopConfirmation = (pendingFacts.get(key) ?? []).some(
            (fact) => fact.kind === 'stopConfirmed',
          );
          if (!reportedNotRunning.has(key) && !hasPendingStopConfirmation) {
            addFact(snapshot, { kind: 'stopConfirmed', reason: 'notRunningOnReconcile' });
            reportedNotRunning.add(key);
          }
          await reportPendingFacts(snapshot, actionContext);
          return;
        }
        if (!snapshot.enabled || snapshot.deletionState !== 'none') {
          if (existing) stopWorker(existing, 'reconcile');
          return;
        }
        if (!await reportPendingFacts(snapshot, actionContext)) {
          if (existing) stopWorker(existing, 'reconcile');
          return;
        }
        if (suspendedFingerprints.has(fingerprint)) return;
        if (existing?.fingerprint === fingerprint) return;
        const entry = {
          snapshot,
          fingerprint,
          controller: new AbortController(),
          socket: null,
          stopIntent: null,
          explicitStopAuthorityEpoch: null,
          completion: Promise.resolve(),
        };
        const abortWorker = () => entry.controller.abort(controller.signal.reason);
        if (controller.signal.aborted) abortWorker();
        else controller.signal.addEventListener('abort', abortWorker, { once: true });
        workers.set(snapshot.connectionId, entry);
        refreshStatus();
        entry.completion = observeConnection(entry).then((result) => {
          controller.signal.removeEventListener('abort', abortWorker);
          if (workers.get(snapshot.connectionId) === entry) workers.delete(snapshot.connectionId);
          if (isCurrent()) {
            if (result.kind === 'historyGap') {
              addFact(snapshot, result);
              suspendedFingerprints.add(entry.fingerprint);
            }
            if (entry.stopIntent === 'explicit') {
              addFact({
                ...snapshot,
                authorityEpoch: entry.explicitStopAuthorityEpoch ?? snapshot.authorityEpoch,
              }, { kind: 'stopConfirmed', reason: 'explicitStop' });
            }
            refreshStatus();
            // A direct `stopped` result is the caller's settlement proof. Do
            // not race it with the recovery report path before the core can
            // settle its retained pending row. Pending/response-loss recovery
            // is retried by the periodic authoritative reconciliation, while
            // a restarted generation reports `notRunningOnReconcile`.
            if (entry.stopIntent !== 'explicit') void requestReconciliation(context);
          }
        });
      };

      if (connectionId === undefined) {
        const currentKeys = new Set(Object.values(snapshots).map(connectionFactKey));
        const currentFingerprints = new Set(Object.values(snapshots).map(connectionFingerprint));
        for (const key of pendingFacts.keys()) if (!currentKeys.has(key)) pendingFacts.delete(key);
        for (const key of reportedNotRunning) if (!currentKeys.has(key)) reportedNotRunning.delete(key);
        for (const fingerprint of suspendedFingerprints) {
          if (!currentFingerprints.has(fingerprint)) suspendedFingerprints.delete(fingerprint);
        }
        const currentIds = new Set(Object.keys(snapshots));
        for (const snapshot of Object.values(snapshots)) await reconcileSnapshot(snapshot);
        for (const [activeConnectionId, entry] of workers) {
          if (!currentIds.has(activeConnectionId)) stopWorker(entry, 'reconcile');
        }
      } else {
        const snapshot = snapshots[connectionId];
        if (snapshot === undefined) {
          const existing = workers.get(connectionId);
          if (existing) stopWorker(existing, 'reconcile');
        } else {
          await reconcileSnapshot(snapshot);
        }
      }
      refreshStatus();
    });
    reconciliationTail = run.catch(() => undefined);
    return run;
  };

  const stop = async (request, actionContext) => {
    const entry = workers.get(request.connectionId);
    if (!entry) {
      return ConversationProviderConnectionStopResultV1Schema.parse({ kind: 'notRunning' });
    }
    if (!isExactFrozenOldWorker(entry.snapshot, request)) {
      return ConversationProviderConnectionStopResultV1Schema.parse({
        kind: 'notReady',
        reason: 'invalidConfiguration',
        diagnostic: 'Fixture socket worker does not match the frozen old connection stop request.',
      });
    }
    entry.explicitStopAuthorityEpoch = request.authorityEpoch;
    stopWorker(entry, 'explicit');
    const stopped = await waitForCompletion(entry.completion, actionContext.signal);
    return ConversationProviderConnectionStopResultV1Schema.parse({ kind: stopped ? 'stopped' : 'pending' });
  };

  const retire = () => {
    if (!controller.signal.aborted) controller.abort(new Error('Fixture observer generation retired.'));
    stopAllWorkers('generationRetired');
  };

  const run = async () => {
    const abortFromContext = () => retire();
    if (context.signal.aborted) abortFromContext();
    else context.signal.addEventListener('abort', abortFromContext, { once: true });
    try {
      await requestReconciliation(context);
      while (isCurrent()) {
        await waitForDelay(RECONCILIATION_INTERVAL_MS, controller.signal);
        if (isCurrent()) await requestReconciliation(context);
      }
    } finally {
      context.signal.removeEventListener('abort', abortFromContext);
      stopAllWorkers('generationRetired');
      await Promise.allSettled([...workers.values()].map((entry) => entry.completion));
      if (state.observer === observer) {
        state.observer = null;
        updateStatus({
          state: 'idle',
          generation,
          activeConnectionIds: [],
          reconciliation: null,
        });
      }
    }
  };

  Object.assign(observer, { run, retire, stop });
  return observer;
}

async function runObserver(context) {
  const generation = ++state.generation;
  const previous = state.observer;
  const observer = createObserver(context, generation);
  state.observer = observer;
  previous?.retire();
  updateStatus({
    state: 'reconciling',
    generation,
    activeConnectionIds: [],
    reconciliation: 'starting',
  });
  await observer.run();
}

async function stop(input, context) {
  const request = ConversationProviderConnectionStopInputV1Schema.parse(input);
  if (!state.observer) {
    return ConversationProviderConnectionStopResultV1Schema.parse({ kind: 'notRunning' });
  }
  return state.observer.stop(request, context);
}

async function deliver(input, context) {
  const delivery = ConversationDeliveryInputV1Schema.parse(input);
  if (delivery.endpoint.kind !== FIXTURE_ENDPOINT.kind || delivery.endpoint.id !== FIXTURE_ENDPOINT.id) {
    return ConversationDeliveryResultV1Schema.parse({ kind: 'notDelivered', retry: 'never' });
  }
  if (Array.from(delivery.content).length > MAX_OUTBOUND_TEXT_CODE_POINTS) {
    return ConversationDeliveryResultV1Schema.parse({ kind: 'notDelivered', retry: 'never' });
  }
  const socketUrl = parseSocketUrlFromConnection(delivery);
  if (context.signal.aborted) return ConversationDeliveryResultV1Schema.parse({ kind: 'notDelivered', retry: 'safe' });
  let socket;
  let sendStarted = false;
  try {
    const openWebSocket = context.services.http?.openWebSocket;
    if (typeof openWebSocket !== 'function') throw new Error('host SDK does not provide the declared WebSocket client');
    socket = await openWebSocket({ url: socketUrl, protocols: ['channels-fixture-v1'], maxMessageBytes: 128 * 1024 }, { signal: context.signal });
    sendStarted = true;
    await socket.send({ kind: 'text', text: JSON.stringify({
      v: 1,
      kind: 'deliver',
      endpoint: delivery.endpoint,
      content: delivery.content,
      deliveryKey: delivery.deliveryKey,
      ...(delivery.replyContext ? { replyContext: delivery.replyContext } : {}),
    }) }, { signal: context.signal });
    return ConversationDeliveryResultV1Schema.parse({ kind: 'delivered', providerMessageIds: [`fixture:${delivery.deliveryKey}`] });
  } catch {
    if (!sendStarted) return ConversationDeliveryResultV1Schema.parse({ kind: 'notDelivered', retry: 'safe' });
    return ConversationDeliveryResultV1Schema.parse({ kind: 'outcomeUnknown' });
  } finally {
    try { await socket?.close({ code: 1000, reason: 'fixture delivery complete' }); } catch { /* best effort */ }
    try { socket?.dispose?.(); } catch { /* disposal is idempotent at the host boundary */ }
  }
}

function reconcileDelivery(input) {
  // The socket protocol has no delivery-key lookup. A reconciliation call must
  // therefore preserve core custody of the ambiguous result rather than replay
  // the original delivery or fabricate a receipt.
  ConversationDeliveryReconcileInputV1Schema.parse(input);
  return ConversationDeliveryResultV1Schema.parse({ kind: 'outcomeUnknown' });
}

const actions = {
  [PROVIDER_ACTION_IDS.setup]: {
    title: 'Set up external socket channel',
    description: 'Pair the deterministic fixture socket and create a Channel connection.',
    scopes: ['global'],
    inputSchema: setupInputSchema,
    inputHints: {
      title: 'Pair external socket',
      description: 'Provide the fixture endpoint and one-time pairing code.',
      submitLabel: 'Pair',
      fields: [
        { path: 'socketUrl', title: 'Socket URL', placeholder: 'wss://channels-fixture.invalid/socket', widget: 'url', required: true },
        { path: 'pairingCode', title: 'Pairing code', widget: 'secret', required: true },
      ],
    },
    hostAccess: ['fixture-network-client'],
    ...actionContract(channelsProvidersV1.operations.setup),
    run: channelsCoreAction(async (input) => setup(input)),
  },
  [PROVIDER_ACTION_IDS.connectionTest]: {
    title: 'Test external socket channel',
    scopes: ['global'],
    ...actionContract(channelsProvidersV1.operations.connectionTest),
    run: channelsCoreAction(async (input) => connectionTest(input)),
  },
  [PROVIDER_ACTION_IDS.endpointResolve]: {
    title: 'Resolve fixture endpoints',
    scopes: ['global'],
    ...actionContract(channelsProvidersV1.operations.endpointResolve),
    run: channelsCoreAction(async (input) => endpointResolve(input)),
  },
  [PROVIDER_ACTION_IDS.principalResolve]: {
    title: 'Resolve fixture principals',
    scopes: ['global'],
    ...actionContract(channelsProvidersV1.operations.principalResolve),
    run: channelsCoreAction(async (input) => principalResolve(input)),
  },
  [PROVIDER_ACTION_IDS.connectionStop]: {
    title: 'Stop external socket channel',
    scopes: ['global'],
    confirmation: { title: 'Stop external socket channel' },
    ...actionContract(channelsProvidersV1.operations.connectionStop),
    run: channelsCoreAction(async (input, context) => stop(input, context)),
  },
  [PROVIDER_ACTION_IDS.messageDeliver]: {
    title: 'Deliver a fixture message',
    scopes: ['global'],
    confirmation: { title: 'Deliver fixture message' },
    hostAccess: ['fixture-network-client'],
    ...actionContract(channelsProvidersV1.operations.messageDeliver),
    run: channelsCoreAction(async (input, context) => deliver(input, context)),
  },
  [PROVIDER_ACTION_IDS.deliveryReconcile]: {
    title: 'Reconcile fixture message delivery',
    scopes: ['global'],
    ...actionContract(channelsProvidersV1.operations.deliveryReconcile),
    run: channelsCoreAction(async (input) => reconcileDelivery(input)),
  },
};

const plugin = definePlugin({
  id: PLUGIN_ID,
  version: '1.0.0',
  displayName: 'External socket channel fixture',
  description: 'Public-only out-of-tree provider fixture for Conversation Channels.',
  engines: { happier: '>=0.0.0 <1.0.0' },
  runtime: { apiVersion: 1 },
  entrypoints: { daemon: './src/index.mjs' },
  activation: { events: [{ kind: 'startup' }] },
  brand: { iconResourceId: 'brand-icon' },
  hostAccess: {
    required: [{
      id: 'fixture-network-client',
      capability: 'network.client',
      reason: 'Receive deterministic socket frames through the host-vended WebSocket client.',
      scope: {
        targets: [{ kind: 'fixedOrigin', origin: FIXTURE_ORIGIN }],
        transports: ['websocket'],
        privateNetwork: false,
      },
    }],
    optional: [],
  },
  actions,
  contributesTo: {
    [CHANNELS_CORE_PLUGIN_ID]: {
      providers: {
        'fixture-socket': channelsProvidersV1.contribute({
          operations: {
            setup: channelsProvidersV1.operations.setup.bind(PROVIDER_ACTION_IDS.setup),
            connectionTest: channelsProvidersV1.operations.connectionTest.bind(PROVIDER_ACTION_IDS.connectionTest),
            endpointResolve: channelsProvidersV1.operations.endpointResolve.bind(PROVIDER_ACTION_IDS.endpointResolve),
            principalResolve: channelsProvidersV1.operations.principalResolve.bind(PROVIDER_ACTION_IDS.principalResolve),
            messageDeliver: channelsProvidersV1.operations.messageDeliver.bind(PROVIDER_ACTION_IDS.messageDeliver),
            deliveryReconcile: channelsProvidersV1.operations.deliveryReconcile.bind(PROVIDER_ACTION_IDS.deliveryReconcile),
            connectionStop: channelsProvidersV1.operations.connectionStop.bind(PROVIDER_ACTION_IDS.connectionStop),
          },
        }),
      },
    },
  },
  resources: {
    'brand-icon': {
      kind: 'asset',
      path: 'assets/brand.png',
      contentType: 'image/png',
    },
    'status-v1': {
      source: 'dynamic',
      kind: 'config',
      contentType: 'application/json',
      scope: 'global',
      maxBytes: MAX_STATUS_BYTES,
      runtime: statusRuntime(),
    },
  },
  backgroundServices: [{
    declaration: { id: 'socket-observer', title: 'Fixture socket observer' },
    runner: runObserver,
  }],
});

export const manifest = plugin.manifest;
export const activate = plugin.activate;
export { PROVIDER_ACTION_IDS };
