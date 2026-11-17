import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { createInstalledProjectAgentLaunchFixture } from '@/daemon/testkit/installedProjectAgentLaunchFixture';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import type { AgentState } from '@/api/types';
import { createServer } from 'node:http';
import { writeDaemonState } from '@/persistence';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExecutionRunGetResponseSchema, ExecutionRunStartResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { hasExplicitlyEmptyManagedMcpSelection } from '@/mcp/servers/resolveSessionCapabilitiesForDirectory';
import { readRetainedExecutionRunRecord } from '@/daemon/executionRunRegistry';
import { withAdmittedSessionRun } from '@/agent/runtime/bridges/executionRun/testkit/admittedSessionRun';
import { createMuseMspProcessFixture, MUSE_MSP_PLAYBACK_SCRIPT,
  readMuseMspProcessAudit, waitForMuseMspProcessAudit } from './testkit/mspProcess.js';

it.each([
  { kind: 'question', scenario: 'question-single-choice' },
  { kind: 'approval', scenario: 'approval-abort' },
] as const)('applies a retained Muse $kind through the real parent Action only after native ACK', async ({ kind, scenario }) => {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-retained-muse-question-'));
  const bin = join(scratch, 'bin');
  const home = join(scratch, 'native-home');
  const auditPath = join(scratch, 'native-audit.json');
  const decisionAckPath = join(scratch, 'release-native-ack');
  const lifetime = new AbortController();
  let phase = 'fixture_start';
  onTestFailed(async () => {
    const nativeAudit = await readMuseMspProcessAudit(auditPath).then(audit => ({
      methods: audit.methods, initializeCount: audit.initializeCount,
      receiptCount: audit.receiptCount, decisionCount: audit.decisionCount, released: audit.released,
    }), () => ({ status: 'absent' }));
    console.error('Actual retained native boundary failure', { phase, nativeAudit });
  });
  try {
    await mkdir(bin);
    await mkdir(home);
    const native = await createMuseMspProcessFixture({ scenario, auditPath, decisionAckPath });
    const executable = await native.resolveExecutable();
    // The genuine executable lookup has only this shim in PATH. Its absolute
    // interpreter never falls through to an installed Muse or an owner Account.
    await writeFile(join(bin, 'muse'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('muse 1.4.14'); } else {
${MUSE_MSP_PLAYBACK_SCRIPT}
}
`, { mode: 0o755 });
    await withAdmittedSessionRun({
      runtimePluginIds: ['happier.agent.muse'],
      parentRuntime: true,
      parentCapabilitySelection: { mcp: { v: 1, managedServersEnabled: false, happierToolsEnabled: false,
        forceIncludeServerIds: [], forceExcludeServerIds: [] } },
      nativeToolEnvironment: { ...executable.env, PATH: bin, MUSE_INSTALL_DIR: bin,
        HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
        XDG_CACHE_HOME: join(home, 'cache'), CODEX_HOME: join(home, 'codex') },
      async run(fixture) {
        let runId: string;
        const readCapabilityFacts = async (includeChild: boolean) => {
          const metadata = fixture.session.getMetadataSnapshot();
          const retained = includeChild ? await readRetainedExecutionRunRecord(runId) : null;
          return {
            parent: { mcpSelectionV1: metadata?.mcpSelectionV1 ?? null,
              skillSelectionV1: metadata?.skillSelectionV1 ?? null },
            // Exact canonical predicate consumed by composeRunToolBinding.
            parentManagedMcpExplicitlyEmpty: hasExplicitlyEmptyManagedMcpSelection(metadata),
            normalizedChildSelection: retained?.state.launch?.capabilitySelection ?? null,
          };
        };
        const beforeStart = await readCapabilityFacts(false);
        try {
          phase = 'run_start';
          const started = await fixture.start({ backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.muse', localId: 'muse' } },
            instructions: 'Ask the captured native color question.', permissionMode: 'default',
            // This permission-only journey explicitly selects no managed MCP.
            capabilitySelection: { mcp: { managedServersEnabled: false, happierToolsEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] } },
            retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' });
          runId = started.runId;
        } catch (cause) {
          throw new Error(`Actual daemon boundary: ${JSON.stringify(fixture.daemonObservations)}`, { cause });
        }
        // START admits asynchronous provisioning. Observe its existing public
        // lifecycle too, so failed provisioning cannot wait for absent stdio.
        const observeRun = async () => {
          const observed = ExecutionRunGetResponseSchema.parse(await fixture.rpc.invokeLocal(
            SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId }, { verifiedPeerAuthority: 'present_user' }));
          if (observed.run.status !== 'running') {
            const nativeAudit = await readMuseMspProcessAudit(auditPath).then(audit => ({
              methods: audit.methods, initializeCount: audit.initializeCount,
              receiptCount: audit.receiptCount, decisionCount: audit.decisionCount,
            }), () => ({ status: 'absent' }));
            lifetime.abort(new Error(`Actual retained native startup: ${JSON.stringify({ status: observed.run.status,
              error: observed.run.error, daemon: fixture.daemonObservations,
              home: fixture.readHomeBoundary(), nativeAudit,
              beforeStart, atFailure: await readCapabilityFacts(true) })}`));
          }
        };
        const stopObserving = fixture.session.subscribeExecutionRunActivitySnapshots(() => {
          void observeRun().catch(error => lifetime.abort(error));
        });
        try {
          await observeRun();
          phase = 'native_receipt';
          expect(await waitForMuseMspProcessAudit(auditPath, audit => audit.nativeResponseCount > 0,
            { signal: lifetime.signal })).toMatchObject({ receiptCount: 1, decisionCount: 0, released: false });
          stopObserving();
          phase = 'parent_interaction';
          let requestId: string | undefined;
          await vi.waitFor(() => {
            const pending = Object.entries(fixture.session.getAgentStateSnapshot()?.requests ?? {})
              .find(([, value]) => kind === 'question' ? value.tool === 'AskUserQuestion' : value.nativeChoices?.source === 'muse');
            expect(pending?.[1]).toMatchObject(kind === 'question' ? { kind: 'user_action', arguments: { questions: [
              { id: 'color', question: 'Which color do you prefer?', selection: 'single',
                options: [{ label: 'Blue' }, { label: 'Green' }] },
            ] } } : { kind: 'permission', nativeChoices: { choices: [
              { id: 'allow_once', decision: 'approved', scope: 'once' },
              { id: 'abort', decision: 'abort', scope: 'once' },
            ] } });
            requestId = pending?.[0];
          });
          if (!requestId) throw new Error('Expected the real parent pending question occurrence');
          const pending = fixture.session.getAgentStateSnapshot()?.requests?.[requestId];
          if (kind === 'question') {
            const observed = ExecutionRunGetResponseSchema.parse(await fixture.rpc.invokeLocal(
              SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId }, { verifiedPeerAuthority: 'present_user' }));
            expect(observed.run.attention).toBeUndefined();
          }
          if (kind === 'approval') {
            phase = 'run_permission_attention';
            await vi.waitFor(async () => {
              const observed = ExecutionRunGetResponseSchema.parse(await fixture.rpc.invokeLocal(
                SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId }, { verifiedPeerAuthority: 'present_user' }));
              expect(observed.run.attention).toMatchObject({ kind: 'permission_required', requestIds: [requestId],
                requests: [{ requestId, createdAt: pending?.createdAt, nativeChoices: pending?.nativeChoices }] });
            });
          }
          const answer = (note?: string) => fixture.session.rpcHandlerManager.handleRequest({
            method: `${fixture.session.sessionId}:${kind === 'question' ? RPC_METHODS.SESSION_USER_ACTION_ANSWER : RPC_METHODS.SESSION_PERMISSION_RESPOND}`,
            params: kind === 'question' ? { id: requestId, approved: true, answers: { color: ['Blue'] },
              ...(note ? { answerDetails: { color: { note } } } : {}) } : {
              id: requestId, ...(pending?.turnId ? { turnId: pending.turnId } : {}), approved: false, decision: 'abort', nativeChoice: {
                requirementId: pending?.nativeChoices?.requirementId, choiceId: 'abort' },
            },
            callerAuthority: 'present_user',
            authorization: { kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_PERMISSION_RESPOND,
              sessionId: fixture.session.sessionId,
              actor: { kind: 'accountUser', accountId: 'alice', relationship: 'owner' } },
          }, undefined, 'authenticated_home_socket');
          // Schema-derived overlong note reaches native application. Its refusal
          // must not report host success, complete the record, or release effects.
          if (kind === 'question') {
            phase = 'native_refusal';
            expect(await answer('x'.repeat(501))).toMatchObject({ error: expect.any(String) });
            expect(await readMuseMspProcessAudit(auditPath)).toMatchObject({ decisionCount: 0, released: false });
            expect(fixture.session.getAgentStateSnapshot()?.requests?.[requestId]).toBeDefined();
            expect(fixture.session.getAgentStateSnapshot()?.completedRequests?.[requestId]).toBeUndefined();
          }
          phase = 'native_ack_held';
          let answered = false;
          const application = answer().then(result => { answered = true; return result; });
          await Promise.race([
            waitForMuseMspProcessAudit(auditPath, audit => audit.decisionAckPending, { signal: lifetime.signal }),
            application.then(result => { throw new Error(`Parent Action returned before the native acknowledgement gate: ${JSON.stringify(result)}`); }),
          ]);
          // Synthetic ACK ordering retains captured native settlement/effects.
          // Give the actual pipe receiver its normal event-loop turn before
          // checking that observed settlement cannot finish the parent Action.
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(answered).toBe(false);
          expect(fixture.session.getAgentStateSnapshot()?.requests?.[requestId]).toBeDefined();
          expect(fixture.session.getAgentStateSnapshot()?.completedRequests?.[requestId]).toBeUndefined();
          await writeFile(decisionAckPath + '.complete', 'release');
          await rename(decisionAckPath + '.complete', decisionAckPath);
          phase = 'native_answer';
          expect(await application).toBeUndefined();
          expect(await readMuseMspProcessAudit(auditPath)).toMatchObject({ decisionCount: 1, released: true });
          expect(fixture.session.getAgentStateSnapshot()?.requests?.[requestId]).toBeUndefined();
          expect(fixture.session.getAgentStateSnapshot()?.completedRequests?.[requestId]).toMatchObject({
            decision: kind === 'question' ? 'approved' : 'abort',
            ...(kind === 'question' ? { answeredBy: { kind: 'person', accountId: 'alice' }, structuredAnswersV1: { color: ['Blue'] } } : {
              permissionDecisionActorV1: { kind: 'accountUser', accountId: 'alice', relationship: 'owner' },
              nativeChoice: { requirementId: pending?.nativeChoices?.requirementId, choiceId: 'abort' },
            }),
          });
        } finally { stopObserving(); }
      },
    });
    const audit = await readMuseMspProcessAudit(auditPath);
    expect(audit).toMatchObject({ initializeCount: 1, initializedCount: 1, decisionCount: 1 });
    expect(audit.methods.filter(method => method === 'session/start')).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'turn/start')).toHaveLength(1);
    expect(audit.methods.filter(method => method === (kind === 'question' ? 'userInput/answer' : 'approval/decide')))
      .toHaveLength(kind === 'question' ? 2 : 1);
    expect(audit.decisionAckPending).toBe(false);
  } finally {
    lifetime.abort();
    await rm(scratch, { recursive: true, force: true });
  }
});

it.each([
  { lifetime: 'retained', answer: 'allow_once', scenario: 'approval-allow-once' },
  { lifetime: 'finite', answer: 'allow_once', scenario: 'approval-allow-once' },
  { lifetime: 'retained', answer: 'question', scenario: 'question-single-choice' },
  { lifetime: 'finite', answer: 'question', scenario: 'question-single-choice' },
] as const)('settles the offered $lifetime detached native $answer through the Machine owner', async ({ lifetime, answer, scenario }) => {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-detached-approval-'));
  onTestFinished(() => rm(scratch, { recursive: true, force: true }));
  const bin = join(scratch, 'bin');
  await mkdir(bin);
  const auditPath = join(scratch, 'audit.json');
  const native = await createMuseMspProcessFixture({ scenario, auditPath });
  const executable = await native.resolveExecutable();
  await writeFile(join(bin, 'muse'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('muse 1.4.14'); } else {
${MUSE_MSP_PLAYBACK_SCRIPT}
}
`, { mode: 0o755 });
  for (const [key, value] of Object.entries({ ...executable.env, PATH: bin, MUSE_INSTALL_DIR: bin })) vi.stubEnv(key, value);
  vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
  const installed = await createInstalledProjectAgentLaunchFixture({ prepareProject: false, preserveLaunchEnvironment: true,
    accountActionCredentials: { token: `header.${Buffer.from(JSON.stringify({ sub: 'requester', session: 'native-approval' })).toString('base64url')}.signature`, encryption: null },
    agentIsolationEnabled: false, agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) } });
  const h = installed.f;
  const admitted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: h.directory, controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.muse'] } });
  onTestFinished(() => admitted.dispose());
  const daemonHttp = createServer((request, response) => {
    if (request.url !== '/execution-run/admission') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ admitted: true }));
  });
  await new Promise<void>(resolve => daemonHttp.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve, reject) => daemonHttp.close(error => error ? reject(error) : resolve())));
  const address = daemonHttp.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture daemon');
  writeDaemonState({ pid: process.pid, httpPort: address.port, startedAt: Date.now(),
    startedWithCliVersion: 'fixture', controlToken: 'fixture-control-token' });
  const rpc = installed.rpc;
  let state: AgentState = {};
  let notifyRequest!: () => void;
  const published = new Promise<void>(resolve => { notifyRequest = resolve; });
  const store = new AgentStateRequestStore({ logPrefix: '[detached-muse-approval]', target: {
    scopeId: 'detached-muse-approval', readState: () => state,
    updateState: async update => {
      state = update(state);
      if (Object.keys(state.requests ?? {}).length > 0) notifyRequest();
    },
  } });
  const context = { callerAuthority: 'present_user' as const, signal: h.signal, requesterSessionBootstrap: h.bootstrap,
    machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: 'machine',
      installationId: h.installation.installationId, role: 'manage' as const, encryptionMode: 'plain' as const },
    verifyMachineAdmissionCurrent: h.bootstrap.isCurrent };
  const started = await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
    sessionId: null, backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.muse', localId: 'muse' } },
    intent: 'agent', instructions: 'Run the captured approval operation.', permissionMode: 'default', localInputId: 'approval-input',
    cwd: h.directory, retentionPolicy: lifetime === 'retained' ? 'resumable' : 'ephemeral',
    runClass: lifetime === 'retained' ? 'long_lived' : 'bounded', ioMode: 'streaming',
    capabilitySelection: { mcp: { managedServersEnabled: false, happierToolsEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] } },
  }, { signal: h.signal, rpcContext: context, localActionContext: { executionRunPermissionRequestStore: store } });
  expect(started, JSON.stringify(started)).toMatchObject({ runId: expect.any(String) });
  const { runId } = ExecutionRunStartResponseSchema.parse(started);
  const read = async () => ExecutionRunGetResponseSchema.parse(await rpc.invokeLocal(
    SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId }, { rpcContext: context }));
  try {
    const observation = new AbortController();
    try {
      await Promise.race([published, rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_WAIT,
        { runId, condition: 'terminal' }, { rpcContext: context, signal: observation.signal }).then(async result => {
          throw new Error(`Native Run ended before publishing its request: ${JSON.stringify(result)}`);
        })]);
    } finally { observation.abort(); }
    const observed = await read();
    expect(observed.run.status, JSON.stringify(observed.run.error)).toBe('running');
    const pending = Object.entries(state.requests ?? {})[0];
    if (!pending) throw new Error('Missing published native request');
    const [requestId, metadata] = pending;
    if (answer === 'allow_once') {
      const request = observed.run.attention?.requests?.[0];
      expect(request).toMatchObject({ requestId, nativeChoices: { choices: expect.arrayContaining([
        expect.objectContaining({ id: 'allow_once' }),
      ]) } });
      expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND, { runId,
        requestId: request!.requestId,
        nativeChoice: { requirementId: request!.nativeChoices!.requirementId, choiceId: 'allow_once' },
      }, { rpcContext: context })).toEqual({ ok: true });
    } else {
      expect(metadata).toMatchObject({ kind: 'user_action', arguments: { questions: [expect.objectContaining({ id: 'color' })] } });
      expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND,
        { runId, requestId, answers: { color: ['Blue'] } }, { rpcContext: context })).toEqual({ ok: true });
    }
    expect(state.requests?.[requestId]).toBeUndefined();
    expect(await readMuseMspProcessAudit(auditPath)).toMatchObject({ decisionCount: 1, released: true });
    expect((await read()).run.attention).toBeUndefined();
  } catch (error) {
    const observed = await read();
    const audit = await readMuseMspProcessAudit(auditPath);
    console.error('Native settlement before cleanup', { status: observed.run.status,
      inputTurns: observed.run.inputTurns, requestIds: Object.keys(state.requests ?? {}),
      decisionCount: audit.decisionCount, released: audit.released });
    throw error;
  } finally {
    await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId }, { rpcContext: context });
  }
});
