import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  ConversationProvidersContributionProtocolV1,
} from '@happier-dev/channels-protocol/v1';
import { assertConversationProviderContributionV1 } from '@happier-dev/channels-protocol/testing/v1';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

const fixture = await import('../src/index.mjs');
const { PROVIDER_ACTION_IDS } = fixture;
const CORE_PROVIDER_OPERATION_ACTION_IDS = Object.freeze({
  setup: 'fixture/execute-provider-setup-v1',
  connectionTest: 'fixture/execute-provider-connection-test-v1',
  endpointResolve: 'fixture/execute-provider-endpoint-resolve-v1',
  principalResolve: 'fixture/execute-provider-principal-resolve-v1',
  messageDeliver: 'fixture/execute-provider-message-deliver-v1',
  deliveryReconcile: 'fixture/execute-provider-delivery-reconcile-v1',
  connectionStop: 'fixture/execute-provider-connection-stop-v1',
});

const fixtureProviderConformance = assertConversationProviderContributionV1(fixture.manifest);
const fixtureProviderContributionMatches = fixture.manifest.contributes.targetedPluginContributions.filter((candidate) => (
  candidate.target.pluginId === 'happier.channels'
  && candidate.target.pointId === 'providers'
  && candidate.protocol.id === 'happier.channels/providers'
  && candidate.protocol.version === 1
));
if (fixtureProviderContributionMatches.length !== 1) {
  throw new Error('Fixture must declare exactly one Channels provider contribution.');
}
const [fixtureProviderContribution] = fixtureProviderContributionMatches;

function runAdmittedProviderOperation(readOperation) {
  return async (input, context) => {
    const operation = readOperation();
    if (operation === undefined) throw new Error('Fixture provider operation was not admitted.');
    const completed = await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
      operation,
      input,
      { signal: context.signal },
    );
    return completed.result;
  };
}

function createCoreTarget(operationSlots) {
  return definePlugin({
    id: 'happier.channels',
    version: '1.0.0',
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './core-target.mjs' },
    activation: { events: [{ kind: 'startup' }] },
    contributionPoints: {
      providers: ConversationProvidersContributionProtocolV1.point(),
    },
    actions: {
      [CORE_PROVIDER_OPERATION_ACTION_IDS.setup]: {
        title: 'Execute admitted fixture setup',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        run: runAdmittedProviderOperation(() => operationSlots.setup),
      },
      [CORE_PROVIDER_OPERATION_ACTION_IDS.connectionTest]: {
        title: 'Execute admitted fixture connection test',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        run: runAdmittedProviderOperation(() => operationSlots.connectionTest),
      },
      [CORE_PROVIDER_OPERATION_ACTION_IDS.endpointResolve]: {
        title: 'Execute admitted fixture endpoint resolution',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        run: runAdmittedProviderOperation(() => operationSlots.endpointResolve),
      },
      [CORE_PROVIDER_OPERATION_ACTION_IDS.principalResolve]: {
        title: 'Execute admitted fixture principal resolution',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        run: runAdmittedProviderOperation(() => operationSlots.principalResolve),
      },
      [CORE_PROVIDER_OPERATION_ACTION_IDS.messageDeliver]: {
        title: 'Execute admitted fixture message delivery',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        run: runAdmittedProviderOperation(() => operationSlots.messageDeliver),
      },
      [CORE_PROVIDER_OPERATION_ACTION_IDS.deliveryReconcile]: {
        title: 'Execute admitted fixture delivery reconciliation',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        run: runAdmittedProviderOperation(() => operationSlots.deliveryReconcile),
      },
      [CORE_PROVIDER_OPERATION_ACTION_IDS.connectionStop]: {
        title: 'Execute admitted fixture connection stop',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        run: runAdmittedProviderOperation(() => operationSlots.connectionStop),
      },
    },
  });
}

function issueAdmittedProviderOperation(coreTestkit, testkit, point, role, localId) {
  return coreTestkit.issueAdmittedTargetedOperation({
    point,
    contributor: {
      testkit,
      contributionId: fixtureProviderContribution.id,
    },
    role,
    action: {
      pluginId: fixtureProviderConformance.manifest.id,
      localId,
    },
  });
}

async function createActivation() {
  let activeServices;
  const operationSlots = {};
  const coreTarget = createCoreTarget(operationSlots);
  const fixtureServices = {
    actions: {
      // The provider's socket observer calls only fixed reverse Channels
      // Actions (list/read/ingest/fact-report). Provider role execution above
      // is deliberately separate and can use only admitted opaque handles.
      execute(...args) {
        if (!activeServices?.actions) throw new Error('fixture Action test did not provide core Actions');
        return activeServices.actions.execute(...args);
      },
    },
    http: {
      openWebSocket(...args) {
        if (!activeServices?.http) throw new Error('fixture Action test did not provide host WebSockets');
        return activeServices.http.openWebSocket(...args);
      },
    },
  };
  const testkit = await createPluginTestkit({
    manifest: fixture.manifest,
    module: { activate: fixture.activate },
    services: fixtureServices,
  });
  const coreTestkit = await createPluginTestkit({
    manifest: coreTarget.manifest,
    module: { activate: coreTarget.activate },
    targetedContributionContributors: [testkit],
  });
  const admittedOperations = Object.freeze({
    setup: issueAdmittedProviderOperation(
      coreTestkit,
      testkit,
      coreTarget.contributionPoints.providers,
      'setup',
      fixtureProviderConformance.contribution.operations.setup,
    ),
    connectionTest: issueAdmittedProviderOperation(
      coreTestkit,
      testkit,
      coreTarget.contributionPoints.providers,
      'connectionTest',
      fixtureProviderConformance.contribution.operations.connectionTest,
    ),
    endpointResolve: issueAdmittedProviderOperation(
      coreTestkit,
      testkit,
      coreTarget.contributionPoints.providers,
      'endpointResolve',
      fixtureProviderConformance.contribution.operations.endpointResolve,
    ),
    principalResolve: issueAdmittedProviderOperation(
      coreTestkit,
      testkit,
      coreTarget.contributionPoints.providers,
      'principalResolve',
      fixtureProviderConformance.contribution.operations.principalResolve,
    ),
    messageDeliver: issueAdmittedProviderOperation(
      coreTestkit,
      testkit,
      coreTarget.contributionPoints.providers,
      'messageDeliver',
      fixtureProviderConformance.contribution.operations.messageDeliver,
    ),
    deliveryReconcile: issueAdmittedProviderOperation(
      coreTestkit,
      testkit,
      coreTarget.contributionPoints.providers,
      'deliveryReconcile',
      fixtureProviderConformance.contribution.operations.deliveryReconcile,
    ),
    connectionStop: issueAdmittedProviderOperation(
      coreTestkit,
      testkit,
      coreTarget.contributionPoints.providers,
      'connectionStop',
      fixtureProviderConformance.contribution.operations.connectionStop,
    ),
  });
  Object.assign(operationSlots, admittedOperations);
  const resourceRuntime = testkit.registration('resources', 'status-v1');
  const backgroundRunner = testkit.registration('backgroundServices', 'socket-observer');
  assert.ok(resourceRuntime);
  assert.ok(backgroundRunner);
  return {
    testkit,
    coreTestkit,
    resourceRuntime,
    backgroundRunner,
    setServices: (services) => { activeServices = services; },
    admittedOperations,
    replaceConnectionTestOperationForTest: (operation) => {
      operationSlots.connectionTest = operation;
    },
    invokeProvider: Object.freeze({
      setup: async (input, context) => {
        activeServices = context?.services;
        return await coreTestkit.invokeAction(CORE_PROVIDER_OPERATION_ACTION_IDS.setup, input, {
          surface: 'plugin',
          ...(context?.signal ? { signal: context.signal } : {}),
        });
      },
      connectionTest: async (input, context) => {
        activeServices = context?.services;
        return await coreTestkit.invokeAction(CORE_PROVIDER_OPERATION_ACTION_IDS.connectionTest, input, {
          surface: 'plugin',
          ...(context?.signal ? { signal: context.signal } : {}),
        });
      },
      endpointResolve: async (input, context) => {
        activeServices = context?.services;
        return await coreTestkit.invokeAction(CORE_PROVIDER_OPERATION_ACTION_IDS.endpointResolve, input, {
          surface: 'plugin',
          ...(context?.signal ? { signal: context.signal } : {}),
        });
      },
      principalResolve: async (input, context) => {
        activeServices = context?.services;
        return await coreTestkit.invokeAction(CORE_PROVIDER_OPERATION_ACTION_IDS.principalResolve, input, {
          surface: 'plugin',
          ...(context?.signal ? { signal: context.signal } : {}),
        });
      },
      messageDeliver: async (input, context) => {
        activeServices = context?.services;
        return await coreTestkit.invokeAction(CORE_PROVIDER_OPERATION_ACTION_IDS.messageDeliver, input, {
          surface: 'plugin',
          ...(context?.signal ? { signal: context.signal } : {}),
        });
      },
      deliveryReconcile: async (input, context) => {
        activeServices = context?.services;
        return await coreTestkit.invokeAction(CORE_PROVIDER_OPERATION_ACTION_IDS.deliveryReconcile, input, {
          surface: 'plugin',
          ...(context?.signal ? { signal: context.signal } : {}),
        });
      },
      connectionStop: async (input, context) => {
        activeServices = context?.services;
        return await coreTestkit.invokeAction(CORE_PROVIDER_OPERATION_ACTION_IDS.connectionStop, input, {
          surface: 'plugin',
          ...(context?.signal ? { signal: context.signal } : {}),
        });
      },
    }),
    dispose: async () => {
      await coreTestkit.dispose();
      await testkit.dispose();
    },
  };
}

function invokeProviderAction(invokeProviderOperation, input, context) {
  return invokeProviderOperation(input, context);
}

function connection(providerConfig) {
  return {
    v: 1,
    connectionId: 'connection-1',
    providerConnectionKey: 'fixture:socket',
    providerConfigVersion: 1,
    providerConfig,
    credentialRef: null,
  };
}

function status(resourceRuntime) {
  return JSON.parse(new TextDecoder().decode(resourceRuntime.read()));
}

function plainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function reconciliationSnapshot(overrides = {}) {
  return {
    ...connection({ socketUrl: 'wss://channels-fixture.invalid/socket' }),
    authorityEpoch: 7,
    enabled: true,
    deletionState: 'none',
    requiresFullSharedMessageContent: true,
    ...overrides,
  };
}

function socketMessageObservation() {
  return {
    kind: 'fullText',
    observation: {
      v: 1,
      occurrenceId: 'fixture:occurrence:1',
      occurredAt: 1_725_000_000_000,
      transport: { kind: 'socket' },
      endpoint: { kind: 'direct', audience: 'direct', id: 'fixture:room' },
      actor: {
        principalId: 'fixture:human',
        kind: 'human',
        isIntegrationSelf: false,
      },
      message: {
        id: 'fixture:message:1',
        text: 'incoming fixture message',
        addressingEvidence: 'none',
        contentProvenance: 'original',
        providerTimestamp: 1_725_000_000_000,
      },
    },
  };
}

function createSocket({ frames = [], ignoreAbort = false } = {}) {
  const pending = [...frames];
  const sent = [];
  let receiveResolver;
  let closeCount = 0;
  return {
    sent,
    get closeCount() { return closeCount; },
    async send(message) { sent.push(message); },
    receive({ signal } = {}) {
      if (pending.length > 0) return Promise.resolve(pending.shift());
      return new Promise((resolve) => {
        receiveResolver = resolve;
        if (!ignoreAbort && signal) {
          if (signal.aborted) {
            resolve({ kind: 'closed', close: { kind: 'aborted', wasClean: true } });
          } else {
            signal.addEventListener('abort', () => {
              resolve({ kind: 'closed', close: { kind: 'aborted', wasClean: true } });
            }, { once: true });
          }
        }
      });
    },
    close() {
      closeCount += 1;
      if (!ignoreAbort) receiveResolver?.({ kind: 'closed', close: { kind: 'local', wasClean: true } });
    },
    dispose() {},
    push(frame) { receiveResolver?.(frame); },
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for fixture runtime transition');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test('every provider Action requires a host-stamped Channels core caller', async (t) => {
  const { testkit, setServices, dispose } = await createActivation();
  t.after(dispose);
  const input = connection({ socketUrl: 'wss://channels-fixture.invalid/socket' });
  setServices({
    actions: { execute: async () => ({ kind: 'admitted' }) },
    http: {
      openWebSocket: async () => ({
        async send() {},
        close() {},
        dispose() {},
      }),
    },
  });
  const actionInputs = {
    [PROVIDER_ACTION_IDS.setup]: {
      socketUrl: 'wss://channels-fixture.invalid/socket',
      pairingCode: 'one-time-secret',
    },
    [PROVIDER_ACTION_IDS.connectionTest]: { ...input, selectedTransport: 'socket' },
    [PROVIDER_ACTION_IDS.endpointResolve]: { ...input, query: 'fixture:room' },
    [PROVIDER_ACTION_IDS.principalResolve]: {
      ...input,
      endpoint: { kind: 'direct', audience: 'direct', id: 'fixture:room' },
      query: 'fixture:human',
    },
    [PROVIDER_ACTION_IDS.connectionStop]: {
      ...input,
      authorityEpoch: 1,
      reason: 'disable',
    },
    [PROVIDER_ACTION_IDS.messageDeliver]: {
      ...input,
      endpoint: { kind: 'direct', audience: 'direct', id: 'fixture:room' },
      content: 'hello fixture',
      deliveryKey: 'delivery-direct-caller',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    },
    [PROVIDER_ACTION_IDS.deliveryReconcile]: {
      ...input,
      endpoint: { kind: 'direct', audience: 'direct', id: 'fixture:room' },
      deliveryKey: 'delivery-direct-caller',
    },
  };

  for (const [localId, actionInput] of Object.entries(actionInputs)) {
    await assert.rejects(
      testkit.invokeAction(localId, actionInput, { surface: 'plugin' }),
      (error) => error?.code === 'fixture_channels_core_caller_required',
      localId,
    );
  }
});

test('the Channels target retains exact admitted provider-role handles through execution and retirement', async (t) => {
  const {
    testkit,
    invokeProvider,
    admittedOperations,
    replaceConnectionTestOperationForTest,
    dispose,
  } = await createActivation();
  t.after(dispose);

  const original = admittedOperations.connectionTest;
  assert.deepEqual(original.identity.target, { pluginId: 'happier.channels' });
  assert.deepEqual(original.identity.point, {
    pointId: 'providers',
    protocol: { id: 'happier.channels/providers', version: 1 },
  });
  assert.deepEqual(
    Object.fromEntries(Object.entries(admittedOperations).map(([role, operation]) => [role, operation.identity.role])),
    {
      setup: 'setup',
      connectionTest: 'connectionTest',
      endpointResolve: 'endpointResolve',
      principalResolve: 'principalResolve',
      messageDeliver: 'messageDeliver',
      deliveryReconcile: 'deliveryReconcile',
      connectionStop: 'connectionStop',
    },
  );
  assert.equal(original.identity.contributor.pluginId, fixture.manifest.id);
  assert.equal(original.identity.contributor.contributionId, 'fixture-socket');
  assert.equal(typeof original.identity.contributor.immutableGenerationId, 'string');
  assert.notEqual(original.identity.contributor.immutableGenerationId, '');
  assert.equal(
    new Set(Object.values(admittedOperations).map((operation) => (
      operation.identity.contributor.immutableGenerationId
    ))).size,
    1,
  );

  replaceConnectionTestOperationForTest(Object.freeze({ identity: original.identity }));
  await assert.rejects(
    invokeProvider.connectionTest({
      ...connection({ socketUrl: 'wss://channels-fixture.invalid/socket' }),
      selectedTransport: 'socket',
    }),
    (error) => error?.code === 'plugin_admitted_targeted_operation_handle_invalid',
  );

  replaceConnectionTestOperationForTest(original);
  assert.deepEqual(
    plainJson(await invokeProvider.connectionTest({
      ...connection({ socketUrl: 'wss://channels-fixture.invalid/socket' }),
      selectedTransport: 'socket',
    })),
    {
      kind: 'ready',
      integrationPrincipal: { id: 'fixture:integration', label: 'Fixture integration' },
      providerConnectionKey: 'fixture:socket',
    },
  );

  await testkit.dispose();
  await assert.rejects(
    invokeProvider.connectionTest({
      ...connection({ socketUrl: 'wss://channels-fixture.invalid/socket' }),
      selectedTransport: 'socket',
    }),
    (error) => error?.code === 'plugin_action_generation_retired',
  );
});

test('public runtime performs setup, resolution, and typed delivery without retaining pairing input', async (t) => {
  const { invokeProvider, resourceRuntime, dispose } = await createActivation();
  t.after(dispose);
  const setup = plainJson(await invokeProviderAction(invokeProvider.setup, {
    socketUrl: 'wss://channels-fixture.invalid/socket',
    pairingCode: 'one-time-secret',
  }));
  assert.equal(setup.providerConfig.socketUrl, 'wss://channels-fixture.invalid/socket');
  assert.equal(setup.replayContinuity, 'sessionBound');
  assert.equal(JSON.stringify(setup).includes('one-time-secret'), false);

  const input = connection(setup.providerConfig);
  assert.deepEqual(plainJson(await invokeProviderAction(invokeProvider.connectionTest, {
    ...input,
    selectedTransport: 'socket',
  })), {
    kind: 'ready',
    integrationPrincipal: { id: 'fixture:integration', label: 'Fixture integration' },
    providerConnectionKey: 'fixture:socket',
  });
  assert.deepEqual(
    plainJson(await invokeProviderAction(invokeProvider.endpointResolve, { ...input, query: 'fixture:room' })),
    { kind: 'resolved', candidates: [{ kind: 'direct', audience: 'direct', id: 'fixture:room', label: 'Fixture room' }] },
  );
  assert.deepEqual(
    plainJson(await invokeProviderAction(invokeProvider.endpointResolve, { ...input, query: 'fixture:room', kinds: ['shared'] })),
    { kind: 'resolved', candidates: [] },
  );
  assert.deepEqual(
    plainJson(await invokeProviderAction(invokeProvider.principalResolve, {
      ...input,
      endpoint: { kind: 'direct', audience: 'direct', id: 'fixture:room' },
      query: 'fixture:human',
    })),
    { kind: 'resolved', candidates: [{ id: 'fixture:human', label: 'Fixture human', kind: 'human' }] },
  );

  const sent = [];
  let openedSocketCount = 0;
  const fakeSocket = {
    async send(message) { sent.push(message); },
    async close() {},
  };
  const context = {
    signal: new AbortController().signal,
    services: {
      http: {
        openWebSocket: async () => {
          openedSocketCount += 1;
          return fakeSocket;
        },
      },
    },
  };
  assert.deepEqual(
    plainJson(await invokeProviderAction(invokeProvider.messageDeliver, {
      ...input,
      endpoint: { kind: 'direct', audience: 'direct', id: 'fixture:room' },
      content: 'hello fixture',
      deliveryKey: 'delivery-1',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    }, context)),
    { kind: 'delivered', providerMessageIds: ['fixture:delivery-1'] },
  );
  assert.equal(sent.length, 1);
  const delivered = JSON.parse(sent[0].text);
  assert.equal(delivered.deliveryKey, 'delivery-1');
  assert.equal(Object.hasOwn(delivered, 'pairingCode'), false);
  assert.equal(JSON.stringify(delivered).includes('one-time-secret'), false);
  assert.deepEqual(
    plainJson(await invokeProviderAction(invokeProvider.deliveryReconcile, {
      ...input,
      endpoint: { kind: 'direct', audience: 'direct', id: 'fixture:room' },
      deliveryKey: 'delivery-1',
    }, context)),
    { kind: 'outcomeUnknown' },
  );
  assert.equal(openedSocketCount, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(status(resourceRuntime).activeConnectionIds, []);
});

test('expected connection unavailability stays in the Channels in-band result contract', async (t) => {
  const { invokeProvider, dispose } = await createActivation();
  t.after(dispose);

  const socketConnection = connection({ socketUrl: 'wss://channels-fixture.invalid/socket' });
  assert.deepEqual(
    plainJson(await invokeProviderAction(invokeProvider.connectionTest, {
      ...socketConnection,
      selectedTransport: 'checkpointedPull',
    })),
    { kind: 'notReady', reason: 'unsupported' },
  );

  assert.deepEqual(
    plainJson(await invokeProviderAction(invokeProvider.connectionTest, {
      ...connection({ socketUrl: 'wss://other-fixture.invalid/socket' }),
      selectedTransport: 'socket',
    })),
    { kind: 'notReady', reason: 'invalidConfiguration' },
  );
});

test('background observer forwards checkpoint-free endpoint-routed socket observations through public list/read authority', async (t) => {
  const { invokeProvider, backgroundRunner, resourceRuntime, dispose } = await createActivation();
  t.after(dispose);
  const controller = new AbortController();
  let current = reconciliationSnapshot();
  const calls = [];
  const ingested = [];
  const facts = [];
  const socket = createSocket({
    frames: [{
      kind: 'text',
      text: JSON.stringify({ kind: 'observation', observation: socketMessageObservation() }),
    }],
  });
  const coreActions = {
    async execute(ref, input) {
      calls.push({ ref, input });
      if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
        return { [current.connectionId]: current };
      }
      if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead) {
        return { [current.connectionId]: current };
      }
      if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.observationIngest) {
        ingested.push(input);
        return { kind: 'admitted' };
      }
      if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
        facts.push(input);
        return { kind: 'recorded' };
      }
      throw new Error(`unexpected core Action ${ref.localId}`);
    },
  };
  const context = {
    signal: controller.signal,
    services: {
      actions: coreActions,
      http: { openWebSocket: async () => socket },
    },
  };

  const running = backgroundRunner(context);
  await waitFor(() => status(resourceRuntime).state === 'active');
  await waitFor(() => ingested.length === 1);
  assert.deepEqual(status(resourceRuntime).activeConnectionIds, ['connection-1']);
  assert.deepEqual(calls[0], {
    ref: { pluginId: 'happier.channels', localId: 'provider/connections-list-v1' },
    input: {},
  });
  assert.deepEqual(JSON.parse(socket.sent[0].text), {
    kind: 'subscribe',
    connectionId: 'connection-1',
    requiresFullSharedMessageContent: true,
  });
  assert.deepEqual(plainJson(ingested), [{
    connectionId: 'connection-1',
    entry: {
      observation: socketMessageObservation(),
      eventCandidate: null,
    },
  }]);

  assert.deepEqual(
    plainJson(await invokeProviderAction(invokeProvider.connectionStop, {
      ...connection(current.providerConfig),
      authorityEpoch: current.authorityEpoch,
      reason: 'delete',
    }, context)),
    {
      kind: 'notReady',
      reason: 'invalidConfiguration',
      diagnostic: 'Fixture socket worker does not match the frozen old connection stop request.',
    },
  );
  assert.equal(socket.closeCount, 0);

  current = reconciliationSnapshot({
    authorityEpoch: 8,
    enabled: false,
    deletionState: 'pendingStopReconciliation',
  });
  assert.deepEqual(
    plainJson(await invokeProviderAction(invokeProvider.connectionStop, {
      ...connection(current.providerConfig),
      authorityEpoch: current.authorityEpoch,
      reason: 'delete',
    }, context)),
    { kind: 'stopped' },
  );
  assert.equal(calls.some(({ ref }) => (
    ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead
  )), false);
  assert.deepEqual(plainJson(facts), []);

  controller.abort();
  await running;
  assert.equal(status(resourceRuntime).state, 'idle');
  assert.equal(status(resourceRuntime).reconciliation, null);
});

test('an application admission loss reports a history gap before suspending the unchanged socket snapshot', async (t) => {
  const { backgroundRunner, resourceRuntime, dispose } = await createActivation();
  t.after(dispose);
  const controller = new AbortController();
  const current = reconciliationSnapshot();
  const facts = [];
  let openedSocketCount = 0;
  const socket = createSocket({
    frames: [{
      kind: 'text',
      text: JSON.stringify({ kind: 'observation', observation: socketMessageObservation() }),
    }],
  });
  const context = {
    signal: controller.signal,
    services: {
      actions: {
        async execute(ref, input) {
          if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
            return { [current.connectionId]: current };
          }
          if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.observationIngest) {
            throw new Error('core admission is unavailable');
          }
          if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
            facts.push(input);
            return { kind: 'recorded' };
          }
          throw new Error(`unexpected core Action ${ref.localId}`);
        },
      },
      http: {
        openWebSocket: async () => {
          openedSocketCount += 1;
          return socket;
        },
      },
    },
  };

  const running = backgroundRunner(context);
  await waitFor(() => facts.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(plainJson(facts), [{
    connectionId: 'connection-1',
    authorityEpoch: 7,
    fact: { kind: 'historyGap', reason: 'applicationAdmissionLost' },
  }]);
  assert.equal(openedSocketCount, 1);
  assert.deepEqual(status(resourceRuntime).activeConnectionIds, []);

  controller.abort();
  await running;
});

test('restart reconciliation reports a retained pending stop only after proving no local worker exists', async (t) => {
  const { backgroundRunner, dispose } = await createActivation();
  t.after(dispose);
  const controller = new AbortController();
  const current = reconciliationSnapshot({
    authorityEpoch: 8,
    enabled: false,
    deletionState: 'pendingStopReconciliation',
  });
  const facts = [];
  const running = backgroundRunner({
    signal: controller.signal,
    services: {
      actions: {
        async execute(ref, input) {
          if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
            return { [current.connectionId]: current };
          }
          if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
            facts.push(input);
            return { kind: 'recorded' };
          }
          throw new Error(`unexpected core Action ${ref.localId}`);
        },
      },
      http: {
        openWebSocket: async () => {
          throw new Error('pending-stop restart reconciliation must not start a socket');
        },
      },
    },
  });

  await waitFor(() => facts.length === 1);
  assert.deepEqual(plainJson(facts), [{
    connectionId: 'connection-1',
    authorityEpoch: 8,
    fact: { kind: 'stopConfirmed', reason: 'notRunningOnReconcile' },
  }]);

  controller.abort();
  await running;
});

test('a timed-out stop retains E+1 recovery authority and a replacement generation reports no worker', async (t) => {
  const { invokeProvider, backgroundRunner, resourceRuntime, dispose } = await createActivation();
  t.after(dispose);
  const firstController = new AbortController();
  const replacementController = new AbortController();
  let current = reconciliationSnapshot();
  const facts = [];
  const socket = createSocket({ ignoreAbort: true });
  const actions = {
    async execute(ref, input) {
      if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
        return { [current.connectionId]: current };
      }
      if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
        facts.push(input);
        return { kind: 'recorded' };
      }
      throw new Error(`unexpected core Action ${ref.localId}`);
    },
  };
  const first = backgroundRunner({
    signal: firstController.signal,
    services: {
      actions,
      http: { openWebSocket: async () => socket },
    },
  });
  await waitFor(() => status(resourceRuntime).activeConnectionIds[0] === 'connection-1');

  current = reconciliationSnapshot({
    authorityEpoch: 8,
    enabled: false,
    deletionState: 'pendingStopReconciliation',
  });
  assert.deepEqual(
    plainJson(await invokeProviderAction(invokeProvider.connectionStop, {
      ...connection(current.providerConfig),
      authorityEpoch: current.authorityEpoch,
      reason: 'delete',
    }, {
      signal: new AbortController().signal,
      services: { actions, http: { openWebSocket: async () => socket } },
    })),
    { kind: 'pending' },
  );
  assert.deepEqual(facts, []);

  socket.push({ kind: 'closed', close: { kind: 'local', wasClean: true } });
  await waitFor(() => status(resourceRuntime).activeConnectionIds.length === 0);
  firstController.abort();
  await first;

  const replacement = backgroundRunner({
    signal: replacementController.signal,
    services: {
      actions,
      http: {
        openWebSocket: async () => {
          throw new Error('pending-stop replacement must not start a socket');
        },
      },
    },
  });
  await waitFor(() => facts.length === 1);
  assert.deepEqual(plainJson(facts), [{
    connectionId: 'connection-1',
    authorityEpoch: 8,
    fact: { kind: 'stopConfirmed', reason: 'notRunningOnReconcile' },
  }]);

  replacementController.abort();
  await replacement;
});

test('a malformed received frame reports provider history loss before suspending the unchanged socket snapshot', async (t) => {
  const { backgroundRunner, resourceRuntime, dispose } = await createActivation();
  t.after(dispose);
  const controller = new AbortController();
  const current = reconciliationSnapshot();
  const facts = [];
  let openedSocketCount = 0;
  const socket = createSocket({
    frames: [{ kind: 'text', text: '{not-json' }],
  });
  const context = {
    signal: controller.signal,
    services: {
      actions: {
        async execute(ref, input) {
          if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
            return { [current.connectionId]: current };
          }
          if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
            facts.push(input);
            return { kind: 'recorded' };
          }
          throw new Error(`unexpected core Action ${ref.localId}`);
        },
      },
      http: {
        openWebSocket: async () => {
          openedSocketCount += 1;
          return socket;
        },
      },
    },
  };

  const running = backgroundRunner(context);
  await waitFor(() => facts.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(plainJson(facts), [{
    connectionId: 'connection-1',
    authorityEpoch: 7,
    fact: { kind: 'historyGap', reason: 'providerHistoryUnavailable' },
  }]);
  assert.equal(openedSocketCount, 1);
  assert.deepEqual(status(resourceRuntime).activeConnectionIds, []);

  controller.abort();
  await running;
});

test('an unsolicited socket close reports provider history loss before any reconnect', async (t) => {
  const { backgroundRunner, resourceRuntime, dispose } = await createActivation();
  t.after(dispose);
  const controller = new AbortController();
  const current = reconciliationSnapshot();
  const facts = [];
  let openedSocketCount = 0;
  const firstSocket = createSocket({
    frames: [{ kind: 'closed', close: { kind: 'remote', wasClean: true } }],
  });
  const replacementSocket = createSocket();
  const context = {
    signal: controller.signal,
    services: {
      actions: {
        async execute(ref, input) {
          if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
            return { [current.connectionId]: current };
          }
          if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
            facts.push(input);
            return { kind: 'recorded' };
          }
          throw new Error(`unexpected core Action ${ref.localId}`);
        },
      },
      http: {
        openWebSocket: async () => {
          openedSocketCount += 1;
          return openedSocketCount === 1 ? firstSocket : replacementSocket;
        },
      },
    },
  };

  const running = backgroundRunner(context);
  try {
    await waitFor(() => facts.length === 1 || openedSocketCount > 1);
    assert.deepEqual(plainJson(facts), [{
      connectionId: 'connection-1',
      authorityEpoch: 7,
      fact: { kind: 'historyGap', reason: 'providerHistoryUnavailable' },
    }]);
    assert.equal(openedSocketCount, 1);
    assert.deepEqual(status(resourceRuntime).activeConnectionIds, []);
  } finally {
    controller.abort();
    await running;
  }
});

test('a socket receive failure reports provider history loss before any reconnect', async (t) => {
  const { backgroundRunner, resourceRuntime, dispose } = await createActivation();
  t.after(dispose);
  const controller = new AbortController();
  const current = reconciliationSnapshot();
  const facts = [];
  let openedSocketCount = 0;
  const failedSocket = {
    async send() {},
    async receive() { throw new Error('fixture receive failed'); },
    close() {},
    dispose() {},
  };
  const replacementSocket = createSocket();
  const context = {
    signal: controller.signal,
    services: {
      actions: {
        async execute(ref, input) {
          if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
            return { [current.connectionId]: current };
          }
          if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
            facts.push(input);
            return { kind: 'recorded' };
          }
          throw new Error(`unexpected core Action ${ref.localId}`);
        },
      },
      http: {
        openWebSocket: async () => {
          openedSocketCount += 1;
          return openedSocketCount === 1 ? failedSocket : replacementSocket;
        },
      },
    },
  };

  const running = backgroundRunner(context);
  try {
    await waitFor(() => facts.length === 1 || openedSocketCount > 1);
    assert.deepEqual(plainJson(facts), [{
      connectionId: 'connection-1',
      authorityEpoch: 7,
      fact: { kind: 'historyGap', reason: 'providerHistoryUnavailable' },
    }]);
    assert.equal(openedSocketCount, 1);
    assert.deepEqual(status(resourceRuntime).activeConnectionIds, []);
  } finally {
    controller.abort();
    await running;
  }
});

test('a retired observer generation cannot report a late socket history gap or overwrite the replacement status', async (t) => {
  const { backgroundRunner, resourceRuntime, dispose } = await createActivation();
  t.after(dispose);
  const firstController = new AbortController();
  const secondController = new AbortController();
  const facts = [];
  const firstSocket = createSocket({ ignoreAbort: true });
  const secondSocket = createSocket();
  const firstCurrent = reconciliationSnapshot({ connectionId: 'connection-1' });
  const secondCurrent = reconciliationSnapshot({ connectionId: 'connection-2', authorityEpoch: 8 });
  const actionsFor = (current) => ({
    async execute(ref, input) {
      if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
        return { [current.connectionId]: current };
      }
      if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead) {
        return { [current.connectionId]: current };
      }
      if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
        facts.push(input);
        return { kind: 'recorded' };
      }
      if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.observationIngest) {
        return { kind: 'admitted' };
      }
      throw new Error(`unexpected core Action ${ref.localId}`);
    },
  });

  const first = backgroundRunner({
    signal: firstController.signal,
    services: {
      actions: actionsFor(firstCurrent),
      http: { openWebSocket: async () => firstSocket },
    },
  });
  await waitFor(() => firstSocket.sent.length === 1);

  const second = backgroundRunner({
    signal: secondController.signal,
    services: {
      actions: actionsFor(secondCurrent),
      http: { openWebSocket: async () => secondSocket },
    },
  });
  await waitFor(() => status(resourceRuntime).activeConnectionIds[0] === 'connection-2');
  assert.equal(firstSocket.closeCount > 0, true);

  firstSocket.push({ kind: 'text', text: JSON.stringify({ kind: 'historyGap' }) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(facts, []);
  assert.deepEqual(status(resourceRuntime).activeConnectionIds, ['connection-2']);

  firstController.abort();
  secondController.abort();
  await first;
  await second;
});

test('provider update, uninstall, and remount retire each socket generation before a fresh reconciliation', async (t) => {
  const { backgroundRunner, resourceRuntime, dispose } = await createActivation();
  t.after(dispose);
  const updateController = new AbortController();
  const uninstallController = new AbortController();
  const remountController = new AbortController();
  const updateSocket = createSocket();
  const uninstallSocket = createSocket();
  const remountSocket = createSocket();
  const updateConnection = reconciliationSnapshot({ connectionId: 'connection-update' });
  const uninstallConnection = reconciliationSnapshot({
    connectionId: 'connection-uninstall',
    authorityEpoch: 8,
  });
  const remountConnection = reconciliationSnapshot({
    connectionId: 'connection-remount',
    authorityEpoch: 9,
  });
  const actionsFor = (current) => ({
    async execute(ref, input) {
      if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList) {
        assert.deepEqual(input, {});
        return { [current.connectionId]: current };
      }
      if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead) {
        assert.equal(input.connectionId, current.connectionId);
        return { [current.connectionId]: current };
      }
      if (ref.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport) {
        return { kind: 'recorded' };
      }
      throw new Error(`unexpected core Action ${ref.localId}`);
    },
  });

  const updated = backgroundRunner({
    signal: updateController.signal,
    services: {
      actions: actionsFor(updateConnection),
      http: { openWebSocket: async () => updateSocket },
    },
  });
  await waitFor(() => status(resourceRuntime).activeConnectionIds[0] === 'connection-update');

  const uninstalling = backgroundRunner({
    signal: uninstallController.signal,
    services: {
      actions: actionsFor(uninstallConnection),
      http: { openWebSocket: async () => uninstallSocket },
    },
  });
  await waitFor(() => status(resourceRuntime).activeConnectionIds[0] === 'connection-uninstall');
  assert.equal(updateSocket.closeCount > 0, true);

  uninstallController.abort();
  await uninstalling;
  assert.equal(uninstallSocket.closeCount > 0, true);
  assert.equal(status(resourceRuntime).state, 'idle');
  assert.deepEqual(status(resourceRuntime).activeConnectionIds, []);

  const remounted = backgroundRunner({
    signal: remountController.signal,
    services: {
      actions: actionsFor(remountConnection),
      http: { openWebSocket: async () => remountSocket },
    },
  });
  await waitFor(() => status(resourceRuntime).activeConnectionIds[0] === 'connection-remount');
  assert.equal(remountSocket.sent.length, 1);

  updateController.abort();
  remountController.abort();
  await updated;
  await remounted;
});

test('connection-stop is typed and idempotent while reconciliation has no live socket', async (t) => {
  const { invokeProvider, dispose } = await createActivation();
  t.after(dispose);
  const setup = await invokeProviderAction(invokeProvider.setup, {
    socketUrl: 'wss://channels-fixture.invalid/socket',
    pairingCode: 'one-time-secret',
  });
  const stopInput = {
    ...connection(setup.providerConfig),
    authorityEpoch: 1,
    reason: 'disable',
  };
  assert.deepEqual(
    plainJson(await invokeProviderAction(invokeProvider.connectionStop, stopInput)),
    { kind: 'notRunning' },
  );
  assert.deepEqual(
    plainJson(await invokeProviderAction(invokeProvider.connectionStop, stopInput)),
    { kind: 'notRunning' },
  );
});
