// Real admitted plugin -> existing detached Run host composer -> native OS child.
// No ApiSessionClient, Happier Session id, or Session context is created by this draft.
import { expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/selection/v1';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import {
  createNativeAgentExecutionRunContextLeaseFactory,
  createNativeAgentExecutionRunHostRuntime,
  type NativeAgentRuntimeLeaseIdentity,
} from '@/agent/runtime/bridges/executionRun/nativeAgentExecutionRun';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadRetainedAgentRuntimeLeaf } from '@/plugins/runtime/runner/loadRetainedAgentRuntimeLeaf';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { prepareProjectAgentLaunch } from '@/workspaces/projectSetup/projectAgentLaunch';
import { configuration } from '@/configuration';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import {
  createMuseMspProcessFixture,
  readMuseMspProcessAudit,
} from './testkit/mspProcess.js';

type Host = ReturnType<typeof createNativeAgentExecutionRunHostRuntime>;
type Start = Parameters<typeof createNativeAgentExecutionRunContextLeaseFactory>[0]['start'];
type WorkflowUsage = Parameters<NonNullable<NonNullable<Start>['observeWorkflowUsage']>>[0];

// Exact consecutive turns from one native conversation; the process boundary
// owns each receive window and remaps only the submitted command identity.
const threeTurns = { recordingPath: fileURLToPath(new URL('./testkit/fixtures/isolated-three-turns.json', import.meta.url)),
  playbackSteps: [{ requestRow: 3, receiveUntilRow: 6 },
    { requestRow: 6, receiveUntilRow: 25 }, { requestRow: 25, receiveUntilRow: 43 },
    { requestRow: 43, receiveUntilRow: 61 }] } as const;

async function withDetachedRun(
  lifetime: 'finite' | 'retained',
  body: (fixture: Readonly<{
    host: Host;
    runId: string;
    messages: AgentMessage[];
    usage: WorkflowUsage[];
    launchCount(): number;
    close(): Promise<void>;
    audit(): ReturnType<typeof readMuseMspProcessAudit>;
  }>) => Promise<void>,
  nativeOptions: Parameters<typeof createMuseMspProcessFixture>[0] = threeTurns,
  selectedOptions: Pick<Parameters<typeof createNativeAgentExecutionRunHostRuntime>[0]['options'], 'modelSelection' | 'configuration'> = {},
  cwd = process.cwd(),
) {
  const controller = new AbortController();
  const scratch = await mkdtemp(join(tmpdir(), 'happier-muse-detached-'));
  const auditPath = join(scratch, 'native-audit.json');
  // A genuine Home boundary reports no accepted Project rows. The existing
  // Project launch owner decides that this ordinary workspace is unassociated.
  const home = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const body = request.method === 'POST' && path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
      ? ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', rows: [], coverage: 'complete' })
      : request.method === 'GET' && path === '/v1/account/encryption'
        ? AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 1 })
      : request.method === 'GET' && path === '/v1/account/encryption/currentness'
        ? createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) : undefined;
    response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body ?? { error: 'fixture_route_unavailable' }));
  });
  await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
  const address = home.address();
  if (!address || typeof address === 'string') throw new Error('SETUP: detached Home address is unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'muse-detached-owner', session: 'fixture-terminal' })).toString('base64url')}.signature`, encryption: null };
  let admitted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
  let host: Host | undefined;
  try {
    admitted = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
      pluginIds: ['happier.agent.muse'],
      scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() },
    } });
    const registry = admitted.registry;
    const registered = registry.agentRuntimesByAgentId.get('muse');
    if (!registered?.sessionRunnerFactoryBinding) throw new Error('SETUP: admitted Muse factory is unavailable');
    const leaf = await loadRetainedAgentRuntimeLeaf({
      paths: resolvePluginStorePaths({ happyHomeDir: admitted.happyHomeDir }),
      binding: registered.sessionRunnerFactoryBinding,
      developmentOccurrenceId: registered.occurrenceId,
    });
    const runtime = await leaf.factory({ plugin: { id: 'happier.agent.muse', version: registered.pluginVersion },
      agent: { id: 'muse' }, signal: controller.signal });
    const native = await createMuseMspProcessFixture({ ...nativeOptions, auditPath, cwd });
    let launched = 0;
    // Only executable/path resolution is replaced at the OS boundary; the qualified SDK Exec stays real.
    const exec = createStablePluginExecService({ ...native, signal: controller.signal,
      isOccurrenceCurrent: registered.isCurrent,
      async resolveExecutable() { launched++; return native.resolveExecutable(); },
      async prepareAgentNativeLaunch(signal, cwd, environment) {
        const prepared = await prepareProjectAgentLaunch({ cwd: cwd ?? process.cwd(),
          machineId: 'muse-detached-fixture', serverId: configuration.activeServerId,
          serverHttpBaseUrl: origin, account: { credentials }, signal,
          ...(environment ? { configEnvironment: environment } : {}) });
        expect(prepared).toEqual({ kind: 'notAssociated' });
        return undefined;
      },
    });
    const runId = randomUUID();
    const lease: NativeAgentRuntimeLeaseIdentity = {
      pluginId: 'happier.agent.muse', pluginVersion: registered.pluginVersion,
      agentId: 'muse', localAgentId: 'muse', occurrenceId: registered.occurrenceId,
      isCurrent: registered.isCurrent,
    };
    const usage: WorkflowUsage[] = [];
    const start = { intent: 'delegate', runClass: lifetime === 'finite' ? 'bounded' : 'long_lived',
      retentionPolicy: lifetime === 'finite' ? 'ephemeral' : 'resumable',
      ioMode: lifetime === 'finite' ? 'request_response' : 'streaming',
      observeWorkflowUsage(observation: WorkflowUsage) { usage.push(observation); },
    } as const satisfies Start;
    const createExecutionRunContext = createNativeAgentExecutionRunContextLeaseFactory({
      lease, runId, start, permissionMode: 'default',
      controllerOccurrenceId: randomUUID(), callId: randomUUID(), sidechainId: randomUUID(),
      runtimeRegistry: registry, directory: cwd, machineId: 'muse-detached-fixture',
      happyHomeDir: admitted.happyHomeDir, accountSettings: null,
      async createInvocationServices({ currentSession, signal, readActiveTurnAdmissionWitness, actionRequestAttributionV1 }) {
        const services = await registry.createAgentInvocationServices({
          pluginId: lease.pluginId, pluginVersion: lease.pluginVersion, agentId: lease.agentId,
          occurrenceId: lease.occurrenceId, correlationId: runId, cwd, signal,
          isOccurrenceCurrent: lease.isCurrent,
          // This is the canonical detached interaction binding. There is deliberately no `session` operand.
          currentSession, readActiveTurnAdmissionWitness, actionRequestAttributionV1,
        });
        return { ...services, exec };
      },
    });
    // The real host consumes the declared finite/retained facet here.
    // No method-existence assertion or fabricated replacement factory stands before this consumer.
    host = createNativeAgentExecutionRunHostRuntime({ runtime,
      executionRunContextV1: runtime.sessions?.executionRunContextV1,
      ...(lifetime === 'retained' ? { retainedConversation: true } : {}),
      lease, options: { cwd, runId, scope: 'detached', backendId: 'muse',
        permissionMode: 'default', start, ...selectedOptions },
      supportsResume: false, createExecutionRunContext,
    });
    const messages: AgentMessage[] = [];
    host.subscribeMessages(message => messages.push(message));
    await body({ host, runId, messages, usage, launchCount: () => launched,
      close: () => host!.dispose(), audit: () => readMuseMspProcessAudit(auditPath) });
  } finally {
    try { await host?.dispose(); }
    finally {
      controller.abort();
      try { await admitted?.dispose(); }
      finally {
        await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
        await rm(scratch, { recursive: true, force: true });
      }
    }
  }
}

it('returns finite Muse output through the real detached host composer', async () => {
  await withDetachedRun('finite', async ({ host, messages, launchCount, close, audit }) => {
    await host.provisionRuntime({ initialPrompt: 'Reply with exactly PEBBLE. Do not use tools.' });
    await host.waitForTurnCompletion?.();
    expect(messages.filter(message => message.type === 'model-output')).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model-output', textDelta: 'echo: ISOLATED-HISTORY-0000' }),
    ]));
    expect(messages.filter(message => message.type === 'status' && message.status === 'error')).toEqual([]);
    await close();
    expect(launchCount()).toBe(1);
    const observed = await audit();
    expect(observed).toMatchObject({ initializeCount: 1, initializedCount: 1 });
    expect(observed.methods.filter(method => method === 'session/start')).toHaveLength(1);
    expect(observed.methods.filter(method => method === 'turn/start')).toHaveLength(1);
  });
});

it('preserves the native finite usage observation through the existing host workflow observer', async () => {
  await withDetachedRun('finite', async ({ host, usage }) => {
    await host.provisionRuntime({ initialPrompt: 'Reply with exactly PEBBLE. Do not use tools.' });
    await host.waitForTurnCompletion?.();
    // The native echo row omits cache-read/write counters and context usage.
    // Its accounting observation must survive without inventing measurements.
    expect(usage).toEqual([
      expect.objectContaining({ observation: expect.objectContaining({
        provider: 'muse', scope: 'turn_delta', tokens: null,
        availability: { inputTokens: false, outputTokens: false, reportedCostUsd: false },
      }) }),
    ]);
    expect(usage[0]!.observation.contextSnapshot).toBeUndefined();
  });
});

it('returns the native finite refusal without output or a completed result', async () => {
  await withDetachedRun('finite', async ({ host, messages, close, audit }) => {
    await host.provisionRuntime({ initialPrompt: 'Refuse this constructed admission.' });
    // Provision returns the finite terminal handle; its completion fence owns
    // the native failure result, including failures emitted before watch.
    await expect(host.waitForTurnCompletion?.())
      .rejects.toMatchObject({ executionRunErrorCode: 'provider_request_rejected' });
    expect(messages.filter(message => message.type === 'model-output')).toEqual([]);
    expect(messages.filter(message => message.type === 'status' && message.status === 'error')).toHaveLength(1);
    expect(messages.filter(message => message.type === 'status' && message.status === 'idle')).toEqual([]);
    await close();
    expect((await audit()).methods.filter(method => method === 'turn/start')).toHaveLength(1);
  }, { ...threeTurns, turnFailure: 'refuse' });
});

it('cancels the finite owning turn through the native interrupt and reports stopped once', async () => {
  // The captured start and interrupt receive windows share the actual native
  // turn identity. Their adjacency, omitting an intervening approval, is a
  // constructed cancellation vector; it is not a claim of an observed turn.
  await withDetachedRun('finite', async ({ host, runId, messages, close, audit }) => {
    await host.provisionRuntime({ initialPrompt: 'Start the captured interruptible turn.' });
    await host.cancel(runId);
    await host.waitForTurnCompletion?.();
    expect(messages.filter(message => message.type === 'status' && message.status === 'stopped')).toHaveLength(1);
    expect(messages.filter(message => message.type === 'status' && message.status === 'error')).toEqual([]);
    await close();
    const observed = await audit();
    const turn = observed.commandTargets.find(command => command.method === 'turn/start');
    expect(turn).toBeDefined();
    expect(observed.commandTargets.filter(command => command.method === 'turn/interrupt')).toEqual([
      expect.objectContaining({ sessionId: turn!.sessionId, turnId: turn!.commandId }),
    ]);
  }, { recordingPath: fileURLToPath(new URL('./testkit/fixtures/advanced.json', import.meta.url)),
    playbackSteps: [{ requestRow: 6, receiveUntilRow: 11 }, { requestRow: 78, receiveUntilRow: 84 },
      { requestRow: 104, receiveUntilRow: 113 }] });
});

it('opens no input, watches before sends, and keeps three retained host turns in one native conversation', async () => {
  await withDetachedRun('retained', async ({ host, runId, messages, usage, launchCount, close, audit }) => {
    // Existing host lazily creates the native conversation on first admitted input.
    // openConversation receives that request but must submit zero input itself:
    // the real host installs its watcher before it calls conversation.send.
    await host.provisionRuntime();
    expect(launchCount()).toBe(0);
    for (const localId of ['first', 'second', 'third']) {
      await expect(host.deliverInput(runId, { text: 'Reply with exactly PEBBLE. Do not use tools.' }, { localId }))
        .resolves.toMatchObject({ status: 'admitted' });
      await host.waitForTurnCompletion?.();
    }
    expect(messages.filter(message => message.type === 'model-output').map(message => message.textDelta)
      .filter(text => text !== undefined)).toEqual([
      'echo: ISOLATED-HISTORY-0000', 'echo: ISOLATED-HISTORY-0001', 'echo: ISOLATED-HISTORY-0002',
    ]);
    expect(usage).toHaveLength(3);
    for (const value of usage) {
      expect(value.observation).toMatchObject({ provider: 'muse', scope: 'turn_delta', tokens: null,
        availability: { inputTokens: false, outputTokens: false, reportedCostUsd: false } });
      expect(value.observation.contextSnapshot).toBeUndefined();
    }
    await close();
    expect(launchCount()).toBe(1);
    const observed = await audit();
    expect(observed).toMatchObject({ initializeCount: 1, initializedCount: 1 });
    expect(observed.methods.filter(method => method === 'session/start')).toHaveLength(1);
    expect(observed.methods.filter(method => method === 'turn/start')).toHaveLength(3);
  });
});

it('fails a finite helper requiring human interaction instead of approving it or claiming completion', async () => {
  await withDetachedRun('finite', async ({ host, messages, close, audit }) => {
    await host.provisionRuntime({ initialPrompt: 'Run the captured approval-requiring operation.' });
    await expect(host.waitForTurnCompletion?.()).rejects.toMatchObject({
      executionRunErrorCode: 'execution_run_interaction_unavailable',
    });
    expect(messages.filter(message => message.type === 'status' && message.status === 'error')).toHaveLength(1);
    await close();
    const observed = await audit();
    // Finite teardown may retire the process before its presentation receipt is
    // observed. The unavailable outcome must never authorize the native effect.
    expect(observed).toMatchObject({ decisionCount: 0, released: false });
  }, { scenario: 'approval-abort' });
});

it('fails a finite helper requiring a native question without fabricating an answer', async () => {
  await withDetachedRun('finite', async ({ host, messages, close, audit }) => {
    await host.provisionRuntime({ initialPrompt: 'Ask the captured single-choice question.' });
    await expect(host.waitForTurnCompletion?.()).rejects.toMatchObject({
      executionRunErrorCode: 'execution_run_interaction_unavailable',
    });
    expect(messages.filter(message => message.type === 'status' && message.status === 'error')).toHaveLength(1);
    await close();
    const observed = await audit();
    expect(observed).toMatchObject({ decisionCount: 0, released: false });
    expect(observed.methods.filter(method => method === 'userInput/answer')).toHaveLength(0);
  }, { scenario: 'question-single-choice' });
});

it('resolves an explicitly selected detached Run model through the shared native catalog', async () => {
  await withDetachedRun('finite', async ({ host, messages, close, audit }) => {
    await host.provisionRuntime({ initialPrompt: 'Reply with exactly PEBBLE. Do not use tools.' });
    await host.waitForTurnCompletion?.();
    expect(messages.some(message => message.type === 'model-output' && message.textDelta === 'PEBBLE')).toBe(true);
    await close();
    expect((await audit()).modelSelections).toEqual([{ providerId: 'meta', modelId: 'muse-spark-1.2' }]);
  }, {}, { modelSelection: ProviderBoundModelRefSchema.parse({
    agentTargetKey: 'agent:happier.agent.muse/muse', providerConnectionId: null, modelId: 'meta/muse-spark-1.2',
  }) });
});

it('sends a verified local image through the real finite Run host', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'happier-muse-run-image-'));
  const path = '.happier/uploads/messages/muse-run-input/image.png';
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
  const bytes = Buffer.from(imageBase64, 'base64');
  try {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), bytes);
    await withDetachedRun('finite', async ({ host, runId, close, audit }) => {
      await host.provisionRuntime();
      const result = await host.deliverInput(runId, { text: 'PEBBLE', structuredInput: { v: 1,
        imageInputs: [{ id: 'selected-run-image', kind: 'localImage', path, mimeType: 'image/png',
          sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
          provenance: { kind: 'sessionAttachmentUpload' } }],
      } });
      expect(result).toMatchObject({ status: 'admitted' });
      await host.waitForTurnCompletion?.();
      await close();
      expect((await audit()).turnInputs).toEqual([[{ type: 'text', text: 'PEBBLE' },
        { type: 'image', mediaType: 'image/png', base64Data: imageBase64 }]]);
    }, { recordingPath: fileURLToPath(new URL('./testkit/fixtures/isolated-echo-image.json', import.meta.url)) }, {}, cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
