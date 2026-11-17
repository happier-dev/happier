import { describe, expect, it, vi } from 'vitest';

// The fixture's real publication policy imports fs; load it before replacing that boundary.
const { createBundledPluginPublicationFsFixture } = await vi.hoisted(async () => (
  import('@/plugins/projection/registry/builtIn/locators.testkit')
));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return createBundledPluginPublicationFsFixture(actual);
});

import { withAdmittedSessionRun, type AdmittedSessionRunFixture } from './testkit/admittedSessionRun';

import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { listExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import { indexAgentRoutingIdsByContributionIdentity, readAgentRoutingIdForContributionIdentity } from '@/plugins/projection/registry/agentRoutingIdentity';

import { createNativeSessionBoundary } from './testkit/nativeSessionContext';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { createExecutionRunRpcActionExecutor } from '@/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction';
import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

const presentUser = { verifiedPeerAuthority: 'present_user' } as const;
const readRun = async (fixture: AdmittedSessionRunFixture, runId: string) => fixture.bridge
  ? fixture.bridge.getPublic(runId)!
  : ExecutionRunGetResponseSchema.parse(await fixture.rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId }, presentUser)).run;
const wait = (fixture: AdmittedSessionRunFixture, runId: string) => fixture.bridge
  ? fixture.bridge.waitForTerminal(runId) : fixture.rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_WAIT, { runId }, presentUser);
const send = (fixture: AdmittedSessionRunFixture, runId: string, message: string, resume = false) => fixture.bridge
  ? fixture.bridge.send(runId, { message, resume }) : fixture.rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, { runId, message, resume }, presentUser);
const stop = (fixture: AdmittedSessionRunFixture, runId: string) => fixture.bridge
  ? fixture.bridge.stop(runId) : fixture.rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId }, presentUser);
const rawStart = (fixture: AdmittedSessionRunFixture, input: Record<string, unknown> = {}) => fixture.rpc.invokeLocal(
  SESSION_RPC_METHODS.EXECUTION_RUN_START, {
    sessionId: fixture.session.sessionId, intent: 'delegate', backendTarget: { kind: 'agent', identity: fixture.agentIdentity },
    instructions: 'Inspect.', permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded',
    ioMode: 'request_response', modelSelection: null, connectedServices: null, ...input,
  }, presentUser);

describe('ExecutionRunHostBridge admitted registry integration', () => {
  it('validates default contributed Review options at admission before creating a Run', async () => {
    await withAdmittedSessionRun({ directOwner: true, profile: true, profileIntent: 'review', run: async fixture => {
      const agentId = readAgentRoutingIdForContributionIdentity(indexAgentRoutingIdsByContributionIdentity(
        fixture.admittedRuntime.registry.contributes.agents), fixture.agentIdentity)!;
      const profile = fixture.admittedRuntime.registry.contributes.executionRunProfiles!.find(entry => entry.definition.id === 'memory')!;
      const sourceCustody = fixture.admittedRuntime.registry.pluginFinalPolicyCurrentRuntimesById!.get(profile.pluginId!)!.sourceCustody;
      const request = { intent: 'review' as const, retentionPolicy: 'resumable' as const,
        intentInput: { engines: { [agentId]: { effort: 'invalid' } } } };
      // Explicit selection reaches profile validation before generic Review scope preparation.
      await expect(fixture.start({ ...request, profileId: `${profile.pluginId}/memory`, profileSourceCustody: sourceCustody }))
        .rejects.toMatchObject({ code: 'execution_run_profile_options_invalid' });
      await expect(fixture.start(request))
        .rejects.toMatchObject({ code: 'execution_run_profile_options_invalid' });
      expect(fixture.nativeOpen).not.toHaveBeenCalled();
      expect(await listExecutionRunMarkers()).toEqual([]);
    } });
  });
  it('refuses an unavailable Machine sandbox choice before creating a detached Run', async () => {
    await withAdmittedSessionRun({ directOwner: true,
      machineMetadata: {
        isolationV1: { environment: 'managed-guest', provisionerId: 'example.machine/guest' },
        isolationPolicyV1: { configuredSandboxes: {}, workKinds: {
          sessions: { kind: 'directly' }, botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' },
        }, agentNativeSandboxEnabled: true },
      },
      run: async fixture => {
        await expect(fixture.start({ sessionId: null, intent: 'plan' })).rejects.toMatchObject({
          rpcErrorCode: 'target_unavailable', details: {
            executionRunStart: { v: 1, runCreation: 'noRunCreated' },
            issues: [{ code: 'not_available_in_sandbox_type', path: ['configuration', 'nativeSandbox'] }],
          },
        });
        expect(fixture.nativeDetachedOpen).not.toHaveBeenCalled();
        expect(await listExecutionRunMarkers()).toEqual([]);
      } });
  });

  it('uses the isolated Machine sandbox default for a detached Run while preserving approvals', async () => {
    await withAdmittedSessionRun({ directOwner: true, nativeSandboxAvailable: true,
      machineMetadata: { isolationV1: { environment: 'managed-guest', provisionerId: 'example.machine/guest' } },
      run: async fixture => {
        const started = await fixture.start({ sessionId: null, intent: 'plan' });
        try {
          await vi.waitFor(() => expect(fixture.nativeDetachedOpen.mock.calls[0]?.[0].configuration)
            .toMatchObject({ nativeSandbox: 'off', permissionIntent: { value: 'read-only' } }));
        } finally {
          await fixture.bridge!.stop(started.runId);
          await fixture.bridge!.waitForTerminal(started.runId);
        }
      } });
  });

  it('persists streamed child tool provenance from its admitted runtime through the Run scope', async () => {
    const observations: unknown[] = [];
    await withAdmittedSessionRun({ directOwner: true, observeTranscriptObservation: payload => observations.push(payload), run: async fixture => {
      fixture.nativeOpen.mockImplementation(async request => {
        let publish: ((event: AgentSessionRuntimeEvent) => void) | undefined;
        let sequence = 0;
        const base = () => ({ sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: Date.now() });
        return {
          watch(listener) { publish = listener; return { dispose() {} }; },
          async send(input) {
            const turnId = input.delivery.turnId;
            publish?.({ ...base(), kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
            publish?.({ ...base(), kind: 'turn-start', turnId, startedBy: 'host' });
            publish?.({ ...base(), kind: 'tool-call', turnId, toolCallId: 'child-read', toolName: 'Read', input: { path: 'README.md' } });
            publish?.({ ...base(), kind: 'tool-result', turnId, toolCallId: 'child-read', output: { text: 'Read content' } });
            publish?.({ ...base(), kind: 'message-delta', turnId, channel: 'assistant', text: JSON.stringify({ summary: 'Read completed.', deliverables: [] }) });
            publish?.({ ...base(), kind: 'turn-complete', turnId });
            return { status: 'admitted' };
          },
          async cancel() { return { status: 'notRunning' }; },
          async dispose() {},
        };
      });
      const started = await fixture.start();
      await wait(fixture, started.runId);
      const source = { v: 3, protocol: 'native', agent: fixture.agentIdentity };
      for (const data of [
        { type: 'tool-call', callId: expect.stringMatching(/:child-read$/), input: expect.objectContaining({ _happier: expect.objectContaining(source) }) },
        { type: 'tool-result', callId: expect.stringMatching(/:child-read$/), output: expect.objectContaining({ _happier: expect.objectContaining(source) }) },
      ]) {
        expect(observations).toContainEqual(expect.objectContaining({ content: expect.objectContaining({
          t: 'plain', v: expect.objectContaining({ content: expect.objectContaining({ data: expect.objectContaining(data) }) }),
        }) }));
      }
    } });
  });

  it('writes a running marker on start and a terminal marker on completion', async () => {
    await withAdmittedSessionRun({ run: async fixture => {
      const native = createNativeSessionBoundary();
      fixture.nativeOpen.mockImplementation(native.open);
      await fixture.session.updateMetadata(metadata => ({ ...metadata, nativeSandbox: 'off' }));
      const started = await fixture.start({ modelId: 'requested-child-model' });
      await native.waitForInputs(1);
      expect(native.opens).toMatchObject([{ configuration: { nativeSandbox: 'off',
        model: { value: 'requested-child-model' }, permissionIntent: { value: 'read-only' } } }]);
      await vi.waitFor(async () => expect((await listExecutionRunMarkers()).find(marker => marker.runId === started.runId))
        .toMatchObject({ status: 'running', intent: 'delegate', permissionMode: 'read_only' }));
      await vi.waitFor(() => expect(fixture.lifecycleEvents).toContainEqual(expect.objectContaining({
        eventId: 'executionRun.started', happySessionId: fixture.session.sessionId,
        payload: expect.objectContaining({ runId: started.runId, intent: 'delegate', runClass: 'bounded' }),
      })));
      native.complete();
      await fixture.rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_WAIT, { runId: started.runId }, { verifiedPeerAuthority: 'present_user' });
      const state = ExecutionRunGetResponseSchema.parse(await fixture.rpc.invokeLocal(
        SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId }, { verifiedPeerAuthority: 'present_user' }));
      const agentId = readAgentRoutingIdForContributionIdentity(indexAgentRoutingIdsByContributionIdentity(
        fixture.admittedRuntime.registry.contributes.agents), fixture.agentIdentity);
      expect(state.run).toMatchObject({ status: 'succeeded', backendTarget: { kind: 'builtInAgent', agentId } });
      await vi.waitFor(async () => expect((await listExecutionRunMarkers()).find(marker => marker.runId === started.runId))
        .toMatchObject({ status: 'succeeded', intent: 'delegate', permissionMode: 'read_only',
          backendTarget: { kind: 'backend', backendId: agentId },
          startedAtMs: expect.any(Number), updatedAtMs: expect.any(Number) }));
      await vi.waitFor(() => expect(fixture.lifecycleEvents).toContainEqual(expect.objectContaining({
        eventId: 'executionRun.completed', happySessionId: fixture.session.sessionId,
        payload: expect.objectContaining({ runId: started.runId, status: 'succeeded' }),
      })));
    } });
  });

  it('consumes admitted profile launch facts and refuses replaced or removed source custody', async () => {
    await withAdmittedSessionRun({ profile: true, run: async fixture => {
      const native = createNativeSessionBoundary();
      fixture.nativeOpen.mockImplementation(native.open);
      const profile = fixture.admittedRuntime.registry.contributes.executionRunProfiles?.find(entry => entry.definition.id === 'memory');
      const current = profile?.pluginId
        ? fixture.admittedRuntime.registry.pluginFinalPolicyCurrentRuntimesById?.get(profile.pluginId) : null;
      if (!current?.applied) throw new Error('Missing admitted profile custody');
      const selection = { intent: 'memory_hints' as const, profileId: `${profile!.pluginId}/memory`, profileSourceCustody: current.sourceCustody };
      const started = await fixture.start({ ...selection, instructions: 'Recall this repository.',
        retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' });
      await native.waitForInputs(1);
      expect(JSON.stringify(native.inputs[0])).toContain('Contributed memory policy');
      expect(JSON.stringify(native.inputs[0])).toContain('Recall this repository.');
      native.complete();
      await wait(fixture, started.runId);
      expect(await readRun(fixture, started.runId)).toMatchObject({ retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'streaming' });
      await fixture.replaceAgent({ profile: true });
      expect(await rawStart(fixture, selection)).toMatchObject({ ok: false, errorCode: 'execution_run_profile_stale' });
      await fixture.replaceAgent({ profile: false });
      expect(await rawStart(fixture, selection)).toMatchObject({ ok: false, errorCode: 'execution_run_profile_stale' });
      expect(native.opens).toHaveLength(1);
    } });
  });

  it('refuses a fresh Run after its authoritative contribution snapshot is retired', async () => {
    await withAdmittedSessionRun({ run: async fixture => {
      await fixture.admittedRuntime.dispose();
      const failure = await rawStart(fixture);
      expect(failure).toMatchObject({ ok: false, errorCode: 'native_agent_privileged_effect_outcome_unknown',
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
        failureCause: { phase: 'execution.run.start', errorClass: 'Error',
          errorCode: 'native_agent_privileged_effect_outcome_unknown', httpStatus: null } });
      expect(Object.keys(failure)).toEqual(expect.arrayContaining(['ok', 'error', 'errorCode', 'details', 'failureCause']));
      expect(failure).not.toHaveProperty('cause');
      expect(failure).not.toHaveProperty('stack');
      expect(fixture.nativeOpen).not.toHaveBeenCalled();
      expect(await listExecutionRunMarkers()).toEqual([]);
    } });
  });

  it('retains its admitted Agent across source retirement until native disposal', async () => {
    await withAdmittedSessionRun({ run: async fixture => {
      const native = createNativeSessionBoundary();
      fixture.nativeOpen.mockImplementation(native.open);
      const started = await fixture.start();
      await native.waitForInputs(1);
      await fixture.admittedRuntime.dispose();
      expect(native.isDisposed()).toBe(false);
      expect(fixture.activationDisposals).toEqual([]);
      native.complete();
      await wait(fixture, started.runId);
      await native.whenDisposed();
      expect(native.isDisposed()).toBe(true);
      await vi.waitFor(() => expect(fixture.activationDisposals).toEqual([fixture.agentIdentity.pluginId]));
      expect(await readRun(fixture, started.runId)).toMatchObject({ status: 'succeeded' });
    } });
  });

  it('releases a terminal child with an unaccepted parent report while another child stays active', async () => {
    await withAdmittedSessionRun({ directOwner: true, run: async fixture => {
      const completed = createNativeSessionBoundary();
      const sibling = createNativeSessionBoundary();
      fixture.nativeOpen.mockImplementationOnce(completed.open).mockImplementationOnce(sibling.open);
      const first = await fixture.start({ notifyParentOnCompletion: true, runReportPolicy: { preset: 'everything' } });
      await completed.waitForInputs(1);
      const second = await fixture.start();
      await sibling.waitForInputs(1);

      completed.complete();
      await wait(fixture, first.runId);
      await vi.waitFor(() => expect(completed.isDisposed()).toBe(true));
      const signal = new AbortController().signal;
      const pending = await fixture.bridge!.prepareWorkerUpdates(fixture.session.sessionId, { signal });
      expect(pending.map(item => item.update.workerId)).toContain(first.runId);
      expect(sibling.isDisposed()).toBe(false);
      expect(await readRun(fixture, second.runId)).toMatchObject({ status: 'running', turnInFlight: true });

      sibling.complete();
      await wait(fixture, second.runId);
      await vi.waitFor(() => expect(sibling.isDisposed()).toBe(true));
      // Report acceptance has independent custody; native cleanup cannot consume it.
      expect((await fixture.bridge!.prepareWorkerUpdates(fixture.session.sessionId, { signal }))
        .map(item => item.update.workerId)).toContain(first.runId);
    } });
  });

  it('releases a terminal child while Home holds its final transcript acknowledgement', async () => {
    let releaseAck!: () => void;
    const acknowledgement = new Promise<void>(resolve => { releaseAck = resolve; });
    let isTerminal = async () => false;
    let ackHeld = false;
    await withAdmittedSessionRun({ beforeTranscriptAck: async () => {
      if (!(await isTerminal())) return;
      ackHeld = true;
      await acknowledgement;
    }, run: async fixture => {
      const native = createNativeSessionBoundary();
      fixture.nativeOpen.mockImplementation(native.open);
      const started = await fixture.start();
      await native.waitForInputs(1);
      isTerminal = async () => (await readRun(fixture, started.runId)).status === 'succeeded';
      try {
        native.complete();
        await vi.waitFor(() => expect(ackHeld).toBe(true));
        expect(await readRun(fixture, started.runId)).toMatchObject({ status: 'succeeded' });
        await vi.waitFor(() => expect(native.isDisposed()).toBe(true));
        await wait(fixture, started.runId);
      } finally {
        isTerminal = async () => false;
        releaseAck();
        await fixture.session.flushDurableMutationDelivery();
      }
    } });
  });

  it('ACKs retained ephemeral inputs before completion, publishes activity, and emits the final tool result only on stop', async () => {
    await withAdmittedSessionRun({ resume: true, directOwner: true, run: async fixture => {
      const native = createNativeSessionBoundary();
      fixture.nativeOpen.mockImplementation(native.open);
      const transcript = vi.spyOn(fixture.session, 'enqueueAgentMessageCommitted');
      const finalResults = () => transcript.mock.calls.filter(([, body]) => body.type === 'tool-result');
      const messages = () => transcript.mock.calls.flatMap(([, body]) => body.type === 'message' ? [body.message] : []);
      const started = await fixture.start({ instructions: '', runClass: 'long_lived', retentionPolicy: 'ephemeral',
        ioMode: 'request_response', display: { title: 'Global Voice', participantLabel: 'Voice', groupId: 'group_1' } });
      await native.waitForOpens(1);
      await vi.waitFor(async () => expect(await readRun(fixture, started.runId)).toMatchObject({ status: 'running', turnInFlight: false }));
      const beforeSend = Date.now();
      expect(await send(fixture, started.runId, 'hello')).toMatchObject({ ok: true });
      await native.waitForInputs(1);
      native.complete('reply:hello');
      await vi.waitFor(() => expect(messages()).toEqual(['reply:hello']));
      await vi.waitFor(async () => expect(await readRun(fixture, started.runId)).toMatchObject({
        status: 'running', turnInFlight: false, display: { groupId: 'group_1' },
      }));
      expect(native.isDisposed()).toBe(false);
      expect(finalResults()).toHaveLength(0);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          send(fixture, started.runId, 'next'),
          new Promise(resolve => { timeout = setTimeout(() => resolve({ ok: false, errorCode: 'timeout' }), 500); }),
        ]);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      } finally { clearTimeout(timeout); }
      await native.waitForInputs(2);
      expect(await readRun(fixture, started.runId)).toMatchObject({ status: 'running', turnInFlight: true });
      native.complete('reply:next');
      await vi.waitFor(() => expect(messages()).toEqual(['reply:hello', 'reply:next']));
      expect(finalResults()).toHaveLength(0);
      await vi.waitFor(async () => {
        const marker = (await listExecutionRunMarkers()).find(value => value.runId === started.runId);
        expect(marker).toMatchObject({ status: 'running', permissionMode: 'read_only' });
        expect(marker!.lastActivityAtMs).toBeGreaterThanOrEqual(beforeSend);
        expect(marker!.updatedAtMs).toBeGreaterThanOrEqual(beforeSend);
      });
      await vi.waitFor(() => expect(fixture.lifecycleEvents).toContainEqual(expect.objectContaining({ eventId: 'executionRun.messageSent',
        happySessionId: fixture.session.sessionId, payload: expect.objectContaining({ runId: started.runId, message: 'hello', resume: false }) })));
      expect(await stop(fixture, started.runId)).toMatchObject({ ok: true });
      await wait(fixture, started.runId);
      expect(await readRun(fixture, started.runId)).toMatchObject({ status: 'cancelled' });
      await vi.waitFor(() => expect(native.isDisposed()).toBe(true));
      await vi.waitFor(() => expect(finalResults()).toHaveLength(1));
      await vi.waitFor(() => expect(fixture.lifecycleEvents).toContainEqual(expect.objectContaining({ eventId: 'executionRun.stopped',
        payload: expect.objectContaining({ runId: started.runId, reason: 'user' }) })));
    } });
  });

  it('preserves the Run identity and native checkpoint when direct send resumes a stopped Run', async () => {
    await withAdmittedSessionRun({ resume: true, directOwner: true, run: async fixture => {
      const native = createNativeSessionBoundary();
      fixture.nativeOpen.mockImplementation(native.open);
      const started = await fixture.start({ instructions: '', runClass: 'long_lived', retentionPolicy: 'resumable' });
      await native.waitForOpens(1);
      expect(await stop(fixture, started.runId)).toMatchObject({ ok: true });
      await wait(fixture, started.runId);
      await native.whenDisposed();
      const resumed = await send(fixture, started.runId, 'resume this run', true);
      expect(resumed, JSON.stringify({ resumed, opens: native.opens.map(open => ({ kind: open.kind, sessionId: open.sessionId })) })).toMatchObject({ ok: true });
      await native.waitForInputs(1);
      expect(native.opens.at(-1)).toMatchObject({ kind: 'resume', providerSessionId: 'registry-native-session' });
      expect(await readRun(fixture, started.runId)).toMatchObject({ runId: started.runId, status: 'running' });
      expect(JSON.stringify(native.inputs.at(-1))).toContain('resume this run');
      await stop(fixture, started.runId);
      await wait(fixture, started.runId);
    } });
  });

  it('settles resumed bounded inputs through canonical completion without a new Run', async () => {
    await withAdmittedSessionRun({ resume: true, directOwner: true, run: async fixture => {
      const native = createNativeSessionBoundary();
      fixture.nativeOpen.mockImplementation(native.open);
      const started = await fixture.start({ retentionPolicy: 'resumable' });
      await native.waitForInputs(1);
      native.complete(JSON.stringify({ summary: 'first', deliverables: [] }));
      await wait(fixture, started.runId);
      await vi.waitFor(() => expect(native.isDisposed()).toBe(true));
      expect(await readRun(fixture, started.runId)).toMatchObject({ status: 'succeeded', lifecycle: { v: 1, state: 'recoverable_with_input' } });
      const actions = createExecutionRunRpcActionExecutor({ manager: fixture.bridge!,
        context: { cwd: fixture.directory, sessionId: fixture.session.sessionId }, isExecutionRunsEnabled: () => true,
        policy: resolveExecutionRunPolicy({ defaults: { boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null, maxTurns: null } }),
      });
      for (const actionId of ['execution.run.ensure', 'execution.run.ensure_or_start'] as const) {
        expect(await actions.execute(actionId, { sessionId: fixture.session.sessionId, runId: started.runId, resume: true },
          { surface: 'rpc', authority: 'present_user' })).toMatchObject({
          ok: false, errorCode: 'execution_run_input_required',
        });
      }
      expect(await send(fixture, started.runId, 'Ordinary input must refuse'))
        .toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
      expect(native.opens).toHaveLength(1);
      expect(native.inputs).toHaveLength(1);
      const resumed = await send(fixture, started.runId, 'Review again.', true);
      expect(resumed, JSON.stringify({ resumed, opens: native.opens.map(open => ({ kind: open.kind, sessionId: open.sessionId })) })).toMatchObject({ ok: true });
      await native.waitForInputs(2);
      expect(native.opens.at(-1)).toMatchObject({ kind: 'resume', providerSessionId: 'registry-native-session' });
      expect(native.isDisposed()).toBe(false);
      native.complete(JSON.stringify({ summary: 'resumed', deliverables: [] }));
      await wait(fixture, started.runId);
      await vi.waitFor(() => expect(native.isDisposed()).toBe(true));
      expect(await readRun(fixture, started.runId)).toMatchObject({ runId: started.runId, status: 'succeeded' });
      expect(native.inputs).toHaveLength(2);
      expect(JSON.stringify(native.inputs[1])).toContain('Review again.');
      expect((await listExecutionRunMarkers()).filter(marker => marker.status === 'running')).toEqual([]);
    } });
  });

  it('preserves the configured ACP definition id through actual subprocess execution and public state', async () => {
    await withAdmittedSessionRun({ runtimePluginIds: ['happier.agent.custom-acp'], acpCatalog(directory) {
      const script = writeAcpTestAgentScript({ dir: directory, fileName: 'registry-acp-agent.mjs', source: `
        let buffer = ''; const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
        process.stdin.on('data', chunk => { buffer += chunk.toString(); let newline;
          while ((newline = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue; const request = JSON.parse(line);
            const ok = result => send({ jsonrpc: '2.0', id: request.id, result });
            if (request.method === 'initialize') ok({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
            else if (request.method === 'session/new') ok({ sessionId: 'configured-provider-session' });
            else if (request.method === 'session/prompt') {
              send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: request.params.sessionId,
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text',
                  text: JSON.stringify({ summary: 'Configured ACP completed.', deliverables: [] }) } } } });
              ok({ stopReason: 'end_turn' });
            }
            else if (request.id != null) ok({});
          }
        });` });
      return AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{ id: 'review-bot', name: 'review-bot', title: 'Review Bot',
        launch: { kind: 'command', command: process.execPath, args: [script] }, env: {},
        capabilities: { supportsLoadSession: false, supportsModes: 'unknown', supportsModels: 'unknown', supportsConfigOptions: 'unknown', promptImageSupport: 'no' },
        createdAt: 1, updatedAt: 2 }] });
    }, run: async fixture => {
      const started = await fixture.start({ backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' } });
      await wait(fixture, started.runId);
      const run = await readRun(fixture, started.runId);
      expect(run, JSON.stringify(run.error)).toMatchObject({ status: 'succeeded', backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' } });
      expect(fixture.nativeOpen).not.toHaveBeenCalled();
      await vi.waitFor(async () => {
        const marker = (await listExecutionRunMarkers()).find(marker => marker.runId === started.runId);
        expect(marker).toMatchObject({ status: 'succeeded' });
        // The canonical bounded marker keeps identity, not launch selectors.
        expect(marker?.backendTarget).toEqual({ kind: 'backend', backendId: 'review-bot' });
      });
    } });
  });

  it('projects native SDK startup rejection as terminal failure without a usable controller', async () => {
    await withAdmittedSessionRun({ run: async fixture => {
      fixture.nativeOpen.mockRejectedValue(new Error('startup probe failed'));
      const started = await fixture.start();
      await wait(fixture, started.runId);
      const run = await readRun(fixture, started.runId);
      expect(run).toMatchObject({ status: 'failed', lifecycle: { v: 1, state: 'unavailable' },
        error: expect.objectContaining({ message: 'startup probe failed' }) });
      expect(run.interaction).toBeUndefined();
      expect(fixture.nativeOpen).toHaveBeenCalledTimes(1);
      await vi.waitFor(async () => expect((await listExecutionRunMarkers()).find(marker => marker.runId === started.runId))
        .toMatchObject({ status: 'failed' }));
    } });
  });
});
