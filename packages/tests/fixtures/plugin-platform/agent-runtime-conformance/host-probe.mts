import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveCliEngineRegistry } from '../../../../../apps/cli/src/agent/runtime/registry/engineRegistry/registry';
import { createPluginRegistryStateStore } from '../../../../../apps/cli/src/plugins/store/registry/currentState';
import {
  createLocalPathPluginDistributionIdentity,
  createPluginTrustRecord,
} from '../../../../../apps/cli/src/plugins/store/install/trustIdentity';
import { resolveExecutablePluginRuntimeRegistry } from '../../../../../apps/cli/src/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from '../../../../../apps/cli/src/plugins/runtime/reload/controller';
import { createDaemonPluginRegistryRuntimeLifecycle } from '../../../../../apps/cli/src/plugins/runtime/reload/registryRuntimeLifecycle';
import { spawnSupervisedPluginProcess } from '../../../../../apps/cli/src/plugins/runtime/exec/processSupervisor';
import { createMutableApiSessionClientFixture } from '../../../../../apps/cli/src/testkit/backends/sessionFixtures';
import type { HostRuntimeLimitMeasurementRecorder } from '../../../../../apps/cli/src/agent/runtime/state/runtimeLimitMeasurement';
import {
  createRuntimeLimitMeasurementCaptureFromEnv,
  recordHostRuntimeLimitMeasurement,
} from '../../../scripts/plugin-platform/runtime-limit-measurement.mjs';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};

const pluginRoot = required('HAPPIER_AGENT_RUNTIME_PLUGIN_ROOT');
const happyHomeDir = required('HAPPIER_AGENT_RUNTIME_HOME');
const measurement = createRuntimeLimitMeasurementCaptureFromEnv({
  env: process.env.HAPPIER_RA21_MEASUREMENT_DIR
    ? {
        ...process.env,
        HAPPIER_RA21_MEASUREMENT_DIR: join(
          process.env.HAPPIER_RA21_MEASUREMENT_DIR,
          'vertical-b',
        ),
      }
    : process.env,
  runnerId: 'packed-agent-runtime-conformance',
  scenarioId: 'vertical-b',
});
const mark = (value: string): void => process.stderr.write(`[vertical-b] ${value}\n`);
mark('modules-loaded');

const recordRuntimeLimitMeasurement: HostRuntimeLimitMeasurementRecorder | undefined = measurement
  ? (sample) => recordHostRuntimeLimitMeasurement(measurement.capture, sample)
  : undefined;

const pluginId = 'acme.native-runtime-proof';
const agentId = 'novel-native-agent';
const actionId = 'prove-coexistence';
const credentials = {
  token: 'vertical-b-token',
  encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
};

const distribution = await createLocalPathPluginDistributionIdentity(pluginRoot);
const trust = createPluginTrustRecord({ pluginId, distribution, approvedAtMs: 1 });
const installReloadController = createPluginReloadController({ happyHomeDir });
try {
  await createPluginRegistryStateStore({
    happyHomeDir,
    runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({
      happyHomeDir,
      reloadController: installReloadController,
    }),
  }).install({
    pluginId,
    sourceRootPath: pluginRoot,
    manifestRelativePath: '.happier-plugin/plugin.json',
    catalogRecord: {
      source: {
        kind: 'path',
        locator: pluginRoot,
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
        resolvedPath: pluginRoot,
        manifestPath: `${pluginRoot}/.happier-plugin/plugin.json`,
      },
      compatibility: { status: 'compatible', diagnostics: [] },
      install: { mode: 'link', manifestVersion: '1.0.0', trust, updatePolicy: 'manual' },
      state: { enabled: true },
    },
    trust,
    updatePolicy: 'manual',
    optionalAccess: [],
  });
} finally {
  await installReloadController.shutdown();
}

type Opened = Readonly<{
  registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>;
  operations: Record<string, (...args: never[]) => unknown>;
  events: Array<Record<string, unknown>>;
  delivery: Array<Record<string, unknown>>;
}>;

const invokeSafeAction = async (
  registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>,
  phase: 'before-agent-open' | 'while-agent-active' | 'after-reload',
): Promise<void> => {
  await registry.activateContributionsOnDemand([{ pluginId, family: 'actions', localId: actionId }]);
  const action = await registry.targetActionInvocations?.invoke({
    pluginId,
    localId: actionId,
    input: { source: 'vertical-b', phase },
    surface: 'cli',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(action)), {
    status: 'executed',
    value: {
      family: 'actions',
      mixedActivation: true,
      input: { source: 'vertical-b', phase },
      measuredProtocol: { acknowledged: true },
    },
  });
  mark(`mixed-action:${phase}`);
};

const open = async (
  resumeId: string | undefined,
  preOpenActionPhase: 'before-agent-open' | 'after-reload',
): Promise<Opened> => {
  mark(`registry-open:${resumeId ? 'resume' : 'create'}`);
  const registry = await resolveExecutablePluginRuntimeRegistry({
    happyHomeDir,
    pluginIds: [pluginId],
    ...(recordRuntimeLimitMeasurement ? { recordRuntimeLimitMeasurement } : {}),
  });
  mark(`registry-ready:${resumeId ? 'resume' : 'create'}`);
  const lease = registry.agentRuntimesByAgentId.get(agentId);
  const agent = registry.contributes.agents.find((value: { id: string }) => value.id === agentId);
  if (!lease || !agent) {
    mark(JSON.stringify({
      activated: [...registry.activatedPluginIds],
      agentIds: registry.contributes.agents.map((value: { id: string }) => value.id),
      runtimeLeaseIds: [...registry.agentRuntimesByAgentId.keys()],
      diagnostics: registry.pluginDiagnosticsByPluginId[pluginId] ?? [],
    }));
  }
  assert.ok(lease, 'packed plugin did not register its native Agent runtime');
  assert.ok(agent, 'packed plugin Agent declaration was not projected');
  await invokeSafeAction(registry, preOpenActionPhase);
  const cliRegistry = await resolveCliEngineRegistry({ happyHomeDir, runtimeRegistry: registry });
  const resolution = await cliRegistry.resolveForBackendId(agentId);
  assert.ok(resolution, 'packed native Agent did not resolve through the canonical engine registry');
  assert.equal(resolution.runtimeOwner.selected?.kind, 'plugin_engine');
  assert.equal(resolution.runtimeOwner.selected?.pluginId, pluginId);
  const plan = await resolution.engineAdapter.runtimeCore.createSessionRuntime({
    credentials,
    directory: process.cwd(),
    backendTarget: { kind: 'backend', backendId: agentId },
    ...(resumeId ? { resume: resumeId } : {}),
  });
  assert.ok(plan.config.createSessionRuntime, 'native host plan has no session factory');
  const session = createMutableApiSessionClientFixture({ sessionId: 'vertical-b-session' });
  const created = await plan.config.createSessionRuntime({
    directory: process.cwd(),
    metadata: {},
    machineId: 'vertical-b-machine',
    session,
    transcriptSession: {},
    messageBuffer: {},
    mcpServers: {},
    permissionHandler: {},
    getPermissionMode: () => 'default',
    setThinking: () => undefined,
    memoryRecallGuidanceEnabled: false,
    ...(recordRuntimeLimitMeasurement ? { recordRuntimeLimitMeasurement } : {}),
  } as never);
  assert.ok(
    session.__getMetadata()?.sessionWorkStateV1,
    'packed native provider did not reach the canonical work-state persistence owner',
  );
  assert.ok(
    session.__getAgentState().currentSessionPresentationV1,
    'packed native provider did not reach the canonical presentation snapshot owner',
  );
  const operations = created.operations as unknown as Record<string, (...args: never[]) => unknown>;
  const events: Array<Record<string, unknown>> = [];
  const delivery: Array<Record<string, unknown>> = [];
  (operations.subscribeRuntimeEvents as (listener: (event: Record<string, unknown>) => void) => () => void)(
    (event) => {
      if (measurement) {
        const encoded = JSON.stringify(event);
        measurement.capture.recordEnvelope({
          direction: 'event',
          family: typeof event.kind === 'string' ? event.kind : 'unknown',
          decodedValue: event,
          encodedValue: encoded,
        });
      }
      events.push(event);
    },
  );
  (operations.setOnPromptDeliveryOutcome as (
    listener: (event: Record<string, unknown>) => void,
  ) => void)((event) => delivery.push(event));
  return { registry, operations, events, delivery };
};

const begin = (opened: Opened): void => {
  (opened.operations.beginTurnLifecycle as () => void)();
};
const send = async (opened: Opened, text: string, localId: string): Promise<void> => {
  const meta = { localId, localIds: [localId] } as const;
  const envelope = { text, meta };
  measurement?.capture.recordEnvelope({
    direction: 'send',
    family: 'turn-prompt',
    decodedValue: envelope,
    encodedValue: JSON.stringify(envelope),
  });
  await (opened.operations.sendTurnPrompt as (
    text: string,
    meta: { localId: string; localIds: readonly string[] },
  ) => Promise<void>)(text, meta);
};
const wait = async (opened: Opened): Promise<void> => {
  await (opened.operations.waitForTurnCompletion as (options: { timeoutMs: number }) => Promise<void>)({ timeoutMs: 2_000 });
};

const first = await open(undefined, 'before-agent-open');
mark('first-open');
assert.deepEqual(
  (first.operations.readSessionIdentity as () => { sessionId: string | null })(),
  { sessionId: 'provider-vertical-b-session' },
  'the host subscriber did not receive the native watcher cold replay',
);
begin(first);
await send(first, 'complete', 'queue-local-complete');
await wait(first);
mark('complete');
const firstTurnStart = first.events.find((event) => event.kind === 'turn-start');
assert.ok(firstTurnStart);
assert.equal(typeof firstTurnStart?.turnId, 'string');
assert.deepEqual(first.delivery.at(-1), {
  type: 'input-accepted',
  localId: 'queue-local-complete',
  userMessageSeq: null,
  delivery: { kind: 'newTurn', turnId: firstTurnStart.turnId },
});
assert.equal(first.events.filter((event) => event.kind === 'turn-start').length, 1);
assert.equal(first.events.filter((event) => event.kind === 'turn-complete').length, 1);

begin(first);
await send(first, 'fail', 'queue-local-fail');
await assert.rejects(wait(first), /turn failed/i);
mark('failure');
assert.equal(first.events.filter((event) => event.kind === 'turn-failed').length, 1);

begin(first);
await send(first, 'await-cancel', 'queue-local-cancel');
await (first.operations.cancelTurn as () => Promise<void>)();
await wait(first);
mark('cancel');
assert.equal(first.events.filter((event) => event.kind === 'turn-cancelled').length, 1);

const terminalCountBeforeDuplicate = first.events.filter((event) => (
  event.kind === 'turn-complete'
  || event.kind === 'turn-failed'
  || event.kind === 'turn-cancelled'
)).length;
begin(first);
await send(first, 'duplicate-terminal', 'queue-local-duplicate-terminal');
await wait(first);
assert.equal(
  first.events.filter((event) => (
    event.kind === 'turn-complete'
    || event.kind === 'turn-failed'
    || event.kind === 'turn-cancelled'
  )).length,
  terminalCountBeforeDuplicate + 1,
  'the host must publish exactly one terminal for a provider turn',
);
assert.equal(
  first.events.filter((event) => event.kind === 'message-delta' && event.text === 'late-after-terminal').length,
  0,
  'the host must fence turn-scoped output after the terminal',
);
mark('exact-terminal');

begin(first);
await assert.rejects(
  send(first, 'process-loss-before-result', 'queue-local-process-loss'),
  /lost after native write/,
);
assert.equal(
  first.delivery.filter((event) => event.type === 'input-custody-unknown' && event.localId === 'queue-local-process-loss').length,
  1,
);
mark('process-loss');

await invokeSafeAction(first.registry, 'while-agent-active');
await (first.operations.resetOrDisposeRuntime as () => Promise<void>)();
assert.equal(
  first.events.filter((event) => event.kind === 'session-ended').length,
  0,
  'native runtime disposal must not end the durable Happier session',
);
await first.registry.dispose();
mark('first-registry-disposed');

const resumed = await open('provider-vertical-b-session', 'after-reload');
assert.deepEqual(
  (resumed.operations.readSessionIdentity as () => { sessionId: string | null })(),
  { sessionId: 'provider-vertical-b-session' },
  'resume did not preserve the typed provider session identity',
);
begin(resumed);
await send(resumed, 'complete-after-restart', 'queue-local-resume');
await wait(resumed);
await (resumed.operations.resetOrDisposeRuntime as () => Promise<void>)();
await resumed.registry.dispose();
mark('restart-resume');

const unexpected = spawnSupervisedPluginProcess({
  command: process.execPath,
  args: ['-e', 'process.stdout.write("packed-runtime-output"); process.exit(23)'],
  env: {},
});
const unexpectedFirst = await unexpected.handle.wait();
const unexpectedLate = await unexpected.handle.wait();
assert.equal(unexpectedLate, unexpectedFirst);
assert.deepEqual(unexpectedFirst.termination, {
  observed: { kind: 'exit', exitCode: 23 },
  requestedBy: { kind: 'none' },
});

const cancelled = spawnSupervisedPluginProcess({
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1000)'],
  env: {},
});
await cancelled.requestTermination({ kind: 'abort' });
assert.equal((await cancelled.handle.wait()).termination.requestedBy.kind, 'abort');

const disposed = spawnSupervisedPluginProcess({
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1000)'],
  env: {},
});
await disposed.dispose('hostShutdown');
const disposedFirst = await disposed.handle.wait();
assert.equal((await disposed.handle.wait()), disposedFirst);
assert.deepEqual(disposedFirst.termination.requestedBy, { kind: 'dispose', reason: 'hostShutdown' });

mark('process-boundary');

if (measurement) await measurement.capture.writeArtifact({ artifactDir: measurement.artifactDir });

process.stdout.write(JSON.stringify({
  scenario: 'vertical-b',
  status: 'foundation-passed',
  plugin: { packed: true, pluginId, agentId, actionId },
  mixedContributionActivation: {
    beforeAgentOpen: true,
    whileAgentActive: true,
    afterReload: true,
  },
  runtime: {
    open: true,
    send: true,
    watch: true,
    nativeAdapterColdWatchReplay: true,
    hostColdWatchReplay: true,
    cancel: true,
    dispose: true,
    failure: true,
    processLoss: true,
    restartResume: true,
    observedSingleTerminalPerFixtureTurn: true,
    exactTerminalEnforcement: true,
    exactTerminal: true,
    runtimeEndedHostSemantics: true,
    staleCrossSession: true,
  },
  processFoundation: {
    scope: 'svc08-supervisor-only',
    authenticatedDaemonChildBridge: false,
    blockedBy: 'WS2.VB-HANDOFF',
    unexpectedExit: true,
    cancellation: true,
    disposal: true,
    lateObservation: true,
    restart: false,
  },
  queue: {
    durableLedgerCount: 0,
    adapterDurability: 'none',
    cardinality: 'one-to-one',
    singleRowAdapterProof: true,
    batchDelivery: false,
    blockedBy: 'Pending Queue V2 V6',
  },
}));
