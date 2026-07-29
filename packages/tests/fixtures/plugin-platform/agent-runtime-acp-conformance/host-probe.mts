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
import { createMutableApiSessionClientFixture } from '../../../../../apps/cli/src/testkit/backends/sessionFixtures';
import { createRuntimeLimitMeasurementCaptureFromEnv } from '../../../scripts/plugin-platform/runtime-limit-measurement.mjs';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};

const pluginRoot = required('HAPPIER_DECLARATIVE_ACP_PLUGIN_ROOT');
const happyHomeDir = required('HAPPIER_DECLARATIVE_ACP_HOME');
const measurement = createRuntimeLimitMeasurementCaptureFromEnv({
  env: process.env.HAPPIER_RA21_MEASUREMENT_DIR
    ? {
        ...process.env,
        HAPPIER_RA21_MEASUREMENT_DIR: join(
          process.env.HAPPIER_RA21_MEASUREMENT_DIR,
          'declarative-acp',
        ),
      }
    : process.env,
  runnerId: 'packed-agent-runtime-conformance',
  scenarioId: 'declarative-acp',
});
const pluginId = 'acme.declarative-acp-proof';
const agentId = 'novel-declarative-acp-agent';
const credentials = {
  token: 'declarative-acp-token',
  encryption: { type: 'legacy', secret: new Uint8Array([9, 8, 7]) },
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

type RuntimeRegistry = Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>;
type Operations = Record<string, (...args: never[]) => unknown>;
type Opened = Readonly<{
  registry: RuntimeRegistry;
  runtimeCore: Readonly<{
    createSessionRuntime(sessionParams: unknown): Promise<unknown>;
  }>;
  operations: Operations;
  events: Array<Record<string, unknown>>;
}>;
const pluginWidePermissionCancellations: Array<Readonly<{ pluginId: string; reason: string }>> = [];
const sessionScopedPermissionCancellations: Array<Readonly<{
  pluginId: string;
  runtimeId: string;
  requestId: string;
}>> = [];
const sessionScopedPermissionRequests: Array<Readonly<{
  pluginId: string;
  runtimeId: string;
  requestId: string;
}>> = [];
let markPermissionInteractionStarted: (() => void) | null = null;
const permissionInteractionStarted = new Promise<void>((resolve) => {
  markPermissionInteractionStarted = resolve;
});
const permissionHandler = {
  handleToolCall(
    requestId: string,
    _toolName: string,
    _input: unknown,
    options?: Readonly<{
      owner?: Readonly<{ kind: string; pluginId?: string; runtimeId?: string }>;
      signal?: AbortSignal;
    }>,
  ): Promise<never> {
    const owner = options?.owner;
    const signal = options?.signal;
    assert.equal(owner?.kind, 'plugin');
    assert.equal(owner?.pluginId, pluginId);
    assert.equal(typeof owner?.runtimeId, 'string');
    assert.ok(signal, 'current-session permission request has no cancellation signal');
    sessionScopedPermissionRequests.push({
      pluginId,
      runtimeId: owner!.runtimeId!,
      requestId,
    });
    markPermissionInteractionStarted?.();
    markPermissionInteractionStarted = null;
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        sessionScopedPermissionCancellations.push({
          pluginId,
          runtimeId: owner!.runtimeId!,
          requestId,
        });
        reject(new Error('declarative ACP session scope retired'));
      }, { once: true });
    });
  },
  async cancelByPlugin(cancelledPluginId: string, reason: string): Promise<void> {
    pluginWidePermissionCancellations.push({ pluginId: cancelledPluginId, reason });
  },
};

const createHostRuntime = async (runtimeCore: Opened['runtimeCore'], resumeId?: string) => {
  const plan = await runtimeCore.createSessionRuntime({
    credentials,
    directory: process.cwd(),
    backendTarget: { kind: 'backend', backendId: agentId },
    ...(resumeId ? { resume: resumeId } : {}),
  }) as {
    config: {
      createSessionRuntime?: (params: unknown) => Promise<{ operations: unknown }>;
    };
  };
  assert.ok(plan.config.createSessionRuntime, 'declarative ACP host plan has no session factory');
  return await plan.config.createSessionRuntime({
    directory: process.cwd(),
    metadata: {},
    machineId: 'declarative-acp-machine',
    session: createMutableApiSessionClientFixture({ sessionId: 'declarative-acp-session' }),
    transcriptSession: {},
    messageBuffer: {},
    mcpServers: {},
    permissionHandler,
    getPermissionMode: () => 'default',
    setThinking: () => undefined,
    memoryRecallGuidanceEnabled: false,
  });
};

const open = async (resumeId?: string): Promise<Opened> => {
  const registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, pluginIds: [pluginId] });
  const cliRegistry = await resolveCliEngineRegistry({ happyHomeDir, runtimeRegistry: registry });
  const resolution = await cliRegistry.resolveForBackendId(agentId);
  assert.ok(resolution, 'packed declarative ACP Agent did not resolve');
  assert.equal(resolution.runtimeOwner.selected?.kind, 'plugin_engine');
  assert.equal(resolution.runtimeOwner.selected?.pluginId, pluginId);
  const runtimeCore = resolution.engineAdapter.runtimeCore;
  const created = await createHostRuntime(runtimeCore, resumeId);
  const operations = created.operations as unknown as Operations;
  const events: Array<Record<string, unknown>> = [];
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
  return { registry, runtimeCore, operations, events };
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
  await (opened.operations.waitForTurnCompletion as (
    options: { timeoutMs: number },
  ) => Promise<void>)({ timeoutMs: 3_000 });
};
const terminalCount = (opened: Opened, kind: string): number => (
  opened.events.filter((event) => event.kind === kind).length
);

const first = await open();
assert.deepEqual(
  (first.operations.readSessionIdentity as () => { sessionId: string | null })(),
  { sessionId: 'provider-declarative-created' },
);

begin(first);
await send(first, 'complete', 'declarative-complete');
await wait(first);
assert.equal(terminalCount(first, 'turn-complete'), 1);
assert.equal(first.events.some((event) => (
  event.kind === 'message-delta'
  && (event.delta as { text?: unknown } | undefined)?.text === 'packed declarative ACP'
)), true);

begin(first);
await send(first, 'refuse', 'declarative-refuse');
await assert.rejects(wait(first), /turn failed/i);
assert.equal(terminalCount(first, 'turn-failed'), 1);

begin(first);
const preAckSend = send(first, 'cancel-before-ack', 'declarative-cancel-before-ack');
await new Promise((resolve) => setTimeout(resolve, 50));
await (first.operations.cancelTurn as () => Promise<void>)();
await preAckSend;
await wait(first);
assert.equal(terminalCount(first, 'turn-cancelled'), 1);

begin(first);
await send(first, 'cancel-after-ack', 'declarative-cancel-after-ack');
await (first.operations.cancelTurn as () => Promise<void>)();
await wait(first);
assert.equal(terminalCount(first, 'turn-cancelled'), 2);

const pluginWideCancellationCountBeforeSessionDispose =
  pluginWidePermissionCancellations.length;
begin(first);
const pendingPermissionSend = send(
  first,
  'permission-pending',
  'declarative-permission-pending',
);
await Promise.race([
  permissionInteractionStarted,
  new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for declarative ACP permission request')),
      3_000,
    );
    timer.unref?.();
  }),
]);
await (first.operations.resetOrDisposeRuntime as () => Promise<void>)();
await pendingPermissionSend;
await first.registry.dispose();
assert.equal(
  pluginWidePermissionCancellations.length,
  pluginWideCancellationCountBeforeSessionDispose,
  'session disposal must not use plugin-wide permission cancellation',
);
assert.equal(
  pluginWidePermissionCancellations.some(({ reason }) => reason === 'plugin_deactivated'),
  false,
);
assert.deepEqual(
  sessionScopedPermissionCancellations,
  sessionScopedPermissionRequests,
  'session disposal did not cancel its exact in-flight permission request',
);
await assert.rejects(
  async () => {
    const stale = await createHostRuntime(first.runtimeCore);
    await (stale.operations as unknown as { resetOrDisposeRuntime(): Promise<void> }).resetOrDisposeRuntime();
  },
  { code: 'plugin_generation_stale' },
);

const resumed = await open('provider-declarative-created');
assert.deepEqual(
  (resumed.operations.readSessionIdentity as () => { sessionId: string | null })(),
  { sessionId: 'provider-declarative-created' },
);
begin(resumed);
await send(resumed, 'complete after reload', 'declarative-resumed-complete');
await wait(resumed);
await (resumed.operations.resetOrDisposeRuntime as () => Promise<void>)();
await resumed.registry.dispose();

const exited = await open();
begin(exited);
await send(exited, 'unexpected-exit', 'declarative-unexpected-exit');
await assert.rejects(wait(exited), /turn failed|runtime ended|process/i);
assert.equal(terminalCount(exited, 'turn-failed'), 1);
await assert.rejects(
  send(exited, 'after unexpected exit', 'declarative-after-exit'),
  /unavailable|ended|disposed/i,
);
await (exited.operations.resetOrDisposeRuntime as () => Promise<void>)();
await exited.registry.dispose();

if (measurement) await measurement.capture.writeArtifact({ artifactDir: measurement.artifactDir });

process.stdout.write(`${JSON.stringify({
  scenario: 'declarative-acp',
  status: 'declarative-acp-passed',
  plugin: {
    packed: true,
    staticManifest: true,
    daemonEntrypoint: false,
    pluginId,
    agentId,
  },
  runtime: {
    create: true,
    resume: true,
    officialCompleted: true,
    officialRefused: true,
    officialCancelled: true,
    cancelBeforeAcknowledgement: true,
    cancelAfterAcknowledgement: true,
    unexpectedExit: true,
    reloadDispose: true,
    generationFencing: true,
  },
})}\n`);
