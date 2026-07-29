import { readFile, writeFile } from 'node:fs/promises';

import type {
  AgentSessionRuntimeContext,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agent-runtime';

import {
  tryCreateDaemonAgentRuntimeCarrier,
  tryCreateDaemonAgentRuntimeTurnContributionsBridge,
} from '@/agent/runtime/session/process/agentRuntimeDaemonBridgeClient';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import { projectRuntimeTranscriptEvent } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { createExternalSessionTerminalFollowProjector } from '@/session/external/terminalFollowProjection';

const role = process.env.G3_CHILD_ROLE;
const resultPath = process.env.G3_CHILD_RESULT_PATH;
const readyPath = process.env.G3_CHILD_READY_PATH;
if (!role || !resultPath || !readyPath) {
  throw new Error('Missing G3 child fixture environment');
}

const carrier = tryCreateDaemonAgentRuntimeCarrier();
if (!carrier?.runtime.sessions) {
  throw new Error('Expected the daemon-owned native Agent carrier');
}
await writeFile(readyPath, 'carrier-created\n', 'utf8');

const controller = new AbortController();
const events: AgentSessionRuntimeEvent[] = [];
const waiters = new Set<() => void>();
const notify = () => {
  for (const waiter of [...waiters]) waiter();
};
const waitForEvent = async (
  predicate: (event: AgentSessionRuntimeEvent) => boolean,
  timeoutMs = 20_000,
) => {
  const existing = events.find(predicate);
  if (existing) return existing;
  return await new Promise<AgentSessionRuntimeEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`Timed out waiting for child event; observed ${JSON.stringify(events)}`));
    }, timeoutMs);
    const check = () => {
      const observed = events.find(predicate);
      if (!observed) return;
      clearTimeout(timeout);
      waiters.delete(check);
      resolve(observed);
    };
    waiters.add(check);
  });
};

const disposable = () => Object.freeze({ dispose() {} });
const current = Object.freeze({
  interactions: Object.freeze({
    async request(request: Readonly<{ kind: string }>) {
      return Object.freeze({ kind: request.kind, status: 'cancelled' });
    },
  }),
  media: Object.freeze({
    async registerSourceRoot() {
      return Object.freeze({
        async publishGenerated() {
          return Object.freeze({ status: 'published' as const });
        },
        dispose() {},
      });
    },
  }),
  async summary() {
    return null;
  },
  async send() {
    return Object.freeze({ status: 'sent' as const });
  },
});
const sessionServices = Object.freeze({
  features: Object.freeze({
    isEnabled() {
      return false;
    },
  }),
  models: Object.freeze({
    bind() {
      return disposable();
    },
  }),
  activeInput: Object.freeze({
    bind() {
      return disposable();
    },
    publishStatus() {},
  }),
});

// This is a process-boundary fixture: only the service members exercised by the
// public ACP composer are implemented, while production schemas validate every wire value.
const context = Object.freeze({
  plugin: Object.freeze({ id: carrier.descriptor.pluginId, version: carrier.descriptor.pluginVersion }),
  contribution: Object.freeze({ id: carrier.descriptor.agentId }),
  surface: 'cli',
  signal: controller.signal,
  services: Object.freeze({
    sessions: Object.freeze({ current }),
  }),
  ui: Object.freeze({
    async requestApproval() {
      return Object.freeze({ status: 'cancelled' as const });
    },
    async askQuestions() {
      return Object.freeze({ status: 'cancelled' as const });
    },
    async confirm() {
      return false;
    },
    async notify() {},
    status: Object.freeze({ async set() {} }),
    widget: Object.freeze({ async set() {} }),
    title: Object.freeze({ async set() {} }),
    composer: Object.freeze({ async replace() {} }),
  }),
  agent: Object.freeze({ id: carrier.descriptor.agentId }),
  session: Object.freeze({
    id: 'g3-real-session',
    cwd: process.cwd(),
    activity: 'active',
    connectedAccounts: Object.freeze([]),
    services: sessionServices,
  }),
  protocols: Object.freeze({}),
  workState: Object.freeze({
    publisher() {
      return Object.freeze({
        async publish() {
          return Object.freeze({ status: 'applied' as const, revision: 'fixture', sourceSequence: 0 });
        },
      });
    },
  }),
}) as unknown as AgentSessionRuntimeContext;

const request = role === 'restart' || role === 'packed-restart'
  ? {
      kind: 'resume' as const,
      sessionId: 'g3-real-session',
      cwd: process.cwd(),
      providerSessionId: 'provider-g3-composed',
    }
  : {
      kind: 'create' as const,
      sessionId: 'g3-real-session',
      cwd: process.cwd(),
    };
const runtime = await carrier.runtime.sessions.open(request, context);
let externalSessionTakeoverResult: unknown = null;
let externalSessionFollowResult: unknown = null;
const externalSessionFollowEvents: unknown[] = [];
const externalSessionProjectedTranscript: unknown[] = [];
if (role === 'external') {
  const externalSessionHostOperations =
    carrier.externalSessionHostOperations.bindSession(request.sessionId);
  const ref = Object.freeze({
    agentId: carrier.descriptor.agentId,
    sourceId: 'fixture',
    remoteSessionId: 'g3-real-external-session',
  });
  const source = Object.freeze({
    kind: 'codexHome' as const,
    home: 'user' as const,
  });
  externalSessionTakeoverResult =
    await externalSessionHostOperations.executeTakeover({ ref, source });
  let acknowledgeFollowEvent: () => void = () => {};
  const followEventReceived = new Promise<void>((resolveFollowEvent) => {
    acknowledgeFollowEvent = resolveFollowEvent;
  });
  let acknowledgeProjectionCommitStarted: () => void = () => {};
  const projectionCommitStarted = new Promise<void>((resolveStarted) => {
    acknowledgeProjectionCommitStarted = resolveStarted;
  });
  let releaseProjectionCommit: () => void = () => {};
  const projectionCommitRelease = new Promise<void>((resolveCommit) => {
    releaseProjectionCommit = resolveCommit;
  });
  const publishFollowEvent = createExternalSessionTerminalFollowProjector({
    sessionId: request.sessionId,
    agentId: carrier.descriptor.agentId,
    projectRuntimeEvent: async (event) => await projectRuntimeTranscriptEvent({
      session: {
        sessionId: request.sessionId,
        sendUserTextMessage() {},
        async sendAgentMessageCommitted() {},
        async enqueueAgentMessageCommitted(
          provider: string,
          body: unknown,
          options: unknown,
        ) {
          acknowledgeProjectionCommitStarted();
          await projectionCommitRelease;
          externalSessionProjectedTranscript.push({
            provider,
            body,
            options,
          });
          return Object.freeze({ persisted: true, delivered: false });
        },
      },
      provider: carrier.descriptor.agentId,
      event,
    }),
  });
  const followResult = await externalSessionHostOperations.executeFollow({
    ref,
    source,
    options: {},
    listener: async (event) => {
      externalSessionFollowEvents.push(event);
      acknowledgeFollowEvent();
      await publishFollowEvent(event);
    },
  });
  externalSessionFollowResult = followResult.status === 'following'
    ? Object.freeze({
        status: followResult.status,
        startingCursor: followResult.startingCursor,
      })
    : followResult;
  if (followResult.status !== 'following') {
    throw new Error(
      `Expected real child External Session follow, received ${JSON.stringify(followResult)}`,
    );
  }
  await followEventReceived;
  await projectionCommitStarted;
  let retirementSettled = false;
  const retirement = externalSessionHostOperations.retire().then(() => {
    retirementSettled = true;
  });
  const closeSeenPath = `${resultPath}.follow-close-seen`;
  const closeSeenDeadline = Date.now() + 20_000;
  while (true) {
    if (await readFile(closeSeenPath, 'utf8').then(
      (value) => value === 'close\n',
      () => false,
    )) {
      break;
    }
    if (Date.now() >= closeSeenDeadline) {
      throw new Error('Timed out waiting for daemon follow-close request');
    }
    await new Promise<void>((resolveRetry) => {
      setTimeout(resolveRetry, 10);
    });
  }
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  if (retirementSettled) {
    throw new Error(
      'External Session follow retired before its canonical projection committed',
    );
  }
  releaseProjectionCommit();
  await retirement;
  const followAckPath = `${resultPath}.follow-ack`;
  const followAckDeadline = Date.now() + 20_000;
  while (true) {
    if (await readFile(followAckPath, 'utf8').then(
      (value) => value === 'ack\n',
      () => false,
    )) {
      break;
    }
    if (Date.now() >= followAckDeadline) {
      throw new Error('Timed out waiting for daemon follow-effect acknowledgement');
    }
    await new Promise<void>((resolveRetry) => {
      setTimeout(resolveRetry, 10);
    });
  }
  await runtime.dispose('session_closed');
  await writeFile(resultPath, JSON.stringify({
    role,
    externalSessionTakeoverResult,
    externalSessionFollowResult,
    externalSessionFollowEvents,
    externalSessionProjectedTranscript,
  }), 'utf8');
  controller.abort();
  process.exit(0);
}
const runtimeOperations = createNativeAgentSessionOperations(
  runtime,
  request.sessionId,
);
const runtimeEvents: unknown[] = [];
const transcriptProjectionResults: unknown[] = [];
const durableTranscript: unknown[] = [];
let durableCommitPending = false;
let releaseDurableCommit: () => void = () => {};
const durableCommitRelease = new Promise<void>((resolve) => {
  releaseDurableCommit = resolve;
});
const transcriptSession = {
  sessionId: request.sessionId,
  sendUserTextMessage() {},
  async sendAgentMessageCommitted(
    provider: string,
    body: unknown,
    options: unknown,
  ) {
    durableTranscript.push({ provider, body, options });
  },
  async enqueueAgentMessageCommitted(
    provider: string,
    body: unknown,
    options: unknown,
  ) {
    if (role === 'restart') {
      durableCommitPending = true;
      await durableCommitRelease;
      durableCommitPending = false;
    }
    durableTranscript.push({ provider, body, options });
    return Object.freeze({ persisted: true, delivered: false });
  },
};
const runtimeMessageDeltaBridge = createKeyedStreamedTranscriptBridge({
  provider: carrier.descriptor.agentId,
  createSessionForStream: () => transcriptSession,
  initialCheckpointDelayMs: 0,
  checkpointIntervalMs: 10_000,
  checkpointMinChars: 999,
  liveSnapshotIntervalMs: null,
});
const pendingTranscriptProjections = new Set<Promise<void>>();
let runtimeTranscriptProjectionSerial = Promise.resolve();
runtimeOperations.subscribeRuntimeEvents((event) => {
  runtimeEvents.push(event);
  const projection = runtimeTranscriptProjectionSerial.then(async () => {
    transcriptProjectionResults.push(await projectRuntimeTranscriptEvent({
      session: transcriptSession,
      provider: carrier.descriptor.agentId,
      runtimeMessageDeltaBridge,
      event,
    }));
  });
  pendingTranscriptProjections.add(projection);
  const removeSettled = () => pendingTranscriptProjections.delete(projection);
  void projection.then(removeSettled, removeSettled);
  runtimeTranscriptProjectionSerial = projection.catch(() => undefined);
});
if (!runtimeOperations.subscribeCanonicalAgentSessionEvents) {
  throw new Error('Expected canonical native Agent session event subscription');
}
runtimeOperations.subscribeCanonicalAgentSessionEvents((event) => {
  events.push(event);
  notify();
});
await waitForEvent((event) => (
  event.kind === 'provider-session-id'
  && event.providerSessionId === (
    role === 'packed'
      ? 'provider-g3-real-session'
      : 'provider-g3-composed'
  )
));
const sessionIdentityAfterSubscribe = runtimeOperations.readSessionIdentity();
const turnContributionsBridge =
  tryCreateDaemonAgentRuntimeTurnContributionsBridge();
if (!turnContributionsBridge) {
  throw new Error('Expected the daemon-owned turn contribution bridge');
}
const agentContextPayload = {
  sessionId: request.sessionId,
  agentId: carrier.descriptor.agentId,
  runtimeFamily: 'hostSession' as const,
  prompt: 'bridge prompt',
  messages: [{ role: 'user' as const, content: 'bridge prompt' }],
  timestampMs: 1,
};
const packedRole = role === 'packed' || role === 'packed-restart';
const promptContributions = packedRole
  ? {
      kind: 'prompt' as const,
      promptAssetBlocks: [],
    }
  : await turnContributionsBridge.resolvePrompt({
      sessionId: request.sessionId,
      featureIds: ['execution.runs'],
      signal: controller.signal,
    });
const transformedAgentContext = packedRole
  ? agentContextPayload
  : await turnContributionsBridge.transformAgentContext({
    sessionId: request.sessionId,
    payload: agentContextPayload,
    signal: controller.signal,
  });
await writeFile(readyPath, 'session-opened\n', 'utf8');

if (packedRole) {
  const turnId =
    role === 'packed-restart' ? 'turn-packed-restart' : 'turn-packed';
  runtimeOperations.beginTurnLifecycle();
  await runtimeOperations.sendTurnPrompt(
    'packed daemon-child bridge',
    {
      localId:
        role === 'packed-restart'
          ? 'input-packed-restart'
          : 'input-packed',
      turnId,
    },
  );
  const terminalEvent = await waitForEvent((event) => (
    (
      event.kind === 'turn-complete'
      && event.turnId === turnId
    )
    || event.kind === 'runtime-ended'
  ));
  if (terminalEvent.kind !== 'turn-complete') {
    throw new Error(
      `Packed daemon-child runtime ended before turn completion: ${JSON.stringify(terminalEvent)}`,
    );
  }
  while (pendingTranscriptProjections.size > 0) {
    await Promise.allSettled([...pendingTranscriptProjections]);
  }
  await runtimeOperations.resetOrDisposeRuntime('session_closed');
  await writeFile(resultPath, JSON.stringify({
    role,
    carrierCurrent: carrier.isCurrent(),
    promptContributions,
    transformedAgentContext,
    events,
    runtimeEvents,
    sessionIdentityAfterSubscribe,
    providerSessionIdentityEventCount: events.filter(
      (event) => event.kind === 'provider-session-id',
    ).length,
    runtimeIdentityPublicationCount: runtimeEvents.filter(
      (event) => (
        typeof event === 'object'
        && event !== null
        && 'kind' in event
        && event.kind === 'session-id-publish'
      ),
    ).length,
    transcriptProjectionResults,
    durableTranscript,
  }), 'utf8');
  controller.abort();
  process.exit(0);
}

const turnId = role === 'restart' ? 'turn-restart' : 'turn-loss';
let sendInterruptedByRetirement = false;
try {
  runtimeOperations.beginTurnLifecycle();
  await runtimeOperations.sendTurnPrompt(
    role === 'restart'
      ? 'complete after restart'
      : 'hang until generation retires',
    { localId: `input-${role}`, turnId },
  );
} catch (error) {
  if (
    role !== 'loss'
    || !(error instanceof Error)
    || !('code' in error)
    || error.code !== 'ABORT_ERR'
  ) {
    throw error;
  }
  sendInterruptedByRetirement = true;
}
await writeFile(
  readyPath,
  `${sendInterruptedByRetirement ? 'send-retired' : 'send-admitted'}:${events.map((event) => event.kind).join(',')}\n`,
  'utf8',
);

let disposalStarted = false;
let disposalStartedBeforeDurableCommitReleased = false;
let durableCommitWasPendingAtTurnCompletion = false;
if (role === 'restart') {
  await runtimeOperations.waitForTurnCompletion();
  durableCommitWasPendingAtTurnCompletion = durableCommitPending;
  const drainThenDispose = (async () => {
    while (pendingTranscriptProjections.size > 0) {
      await Promise.allSettled([...pendingTranscriptProjections]);
    }
    disposalStarted = true;
    await runtimeOperations.resetOrDisposeRuntime('session_closed');
  })();
  await new Promise<void>((resolve) => setImmediate(resolve));
  disposalStartedBeforeDurableCommitReleased = disposalStarted;
  releaseDurableCommit();
  await drainThenDispose;
} else {
  await waitForEvent((event) => event.kind === 'turn-start' && event.turnId === turnId);
  await writeFile(readyPath, 'ready\n', 'utf8');
  await waitForEvent((event) => event.kind === 'runtime-ended');
  while (pendingTranscriptProjections.size > 0) {
    await Promise.allSettled([...pendingTranscriptProjections]);
  }
}

await writeFile(resultPath, JSON.stringify({
  role,
  carrierCurrent: carrier.isCurrent(),
  promptContributions,
  transformedAgentContext,
  events,
  runtimeEvents,
  externalSessionTakeoverResult,
  externalSessionFollowResult,
  externalSessionFollowEvents,
  sessionIdentityAfterSubscribe,
  providerSessionIdentityEventCount: events.filter(
    (event) => event.kind === 'provider-session-id',
  ).length,
  runtimeIdentityPublicationCount: runtimeEvents.filter(
    (event) => (
      typeof event === 'object'
      && event !== null
      && 'kind' in event
      && event.kind === 'session-id-publish'
    ),
  ).length,
  transcriptProjectionResults,
  durableTranscript,
  durableCommitWasPendingAtTurnCompletion,
  disposalStartedBeforeDurableCommitReleased,
}), 'utf8');
controller.abort();
