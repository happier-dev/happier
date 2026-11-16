import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ExternalActionExecutionResultV1Schema, projectExternalActionExecutionResultV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { SessionMetadataTuplePatchV1Schema, V2SessionByIdResponseSchema } from '@happier-dev/protocol';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { readSessionExplicitStopV1FromMetadata, writeSessionExplicitStopV1ToMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { createNativeAgentSessionWorkStateService } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionWorkState';
import { createPluginTranscriptFileFollowService } from '@/plugins/runtime/context/transcripts/fileFollow';
import { createTranscriptFileFollowPathGrantRegistry } from '@/plugins/runtime/context/transcripts/fileFollowGrants';
import { ApiSessionClient } from './sessionClient';
import { routeSessionGoalControl } from '@/session/goalControls/sessionGoalControlRouter';
import { withTempDir } from '@/testkit/fs/tempDir';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createClaudeNativeGoalWorkStatePublisher } from '../../../../../packages/plugins/claude/src/agent/runtime/nativeServices';
import { createClaudeGoalWorkStateSource } from '../../../../../packages/plugins/claude/src/agent/transcripts/goalSource';
import { createClaudeAgentSdkTurnOperations } from '../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createEventsFixture, createPluginContextFixture, createSdkExecFixture, createSessionHooksFixture, createTerminalHostFixture } from '../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';
import { handleActionsCommand } from '@/cli/commands/actions';
import { compileActionCliCommands } from '@/cli/actions/compiledCommands';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { runCompiledActionCliCommand } from '@/cli/actions/executeCommand';

// Only Home HTTP and Socket.IO are substituted. Registration, native source,
// publication, tuple serialization and the Session's local projection stay real.
vi.mock('axios');
vi.mock('socket.io-client', () => ({ io: () => createApiSessionSocketStub() }));

describe('native Goal canonical Session readback', () => {
  let client: ApiSessionClient | undefined;
  const heldReads: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const release of heldReads.splice(0)) await release();
    await client?.close();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  function createHome(layoutVersion: 0 | 1 = 1) {
    const token = 'goal-fixture-token';
    const credentials = { token, encryption: null };
    const metadata = createTestMetadata({ path: '/goal-fixture', flavor: 'claude' });
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
      metadata, agentState: null, storedContentMode: 'plain' });
    let raw = createSessionRecordFixture({ id: 'goal-readback', encryptionMode: 'plain', metadataLayoutVersion: layoutVersion,
      metadata: layoutVersion === 0 ? JSON.stringify(metadata) : fields.sharedMetadata.ciphertext,
      ...(layoutVersion === 1 ? { ownerMetadata: fields.ownerMetadata } : {}), metadataVersion: 1,
      agentState: null, agentStateVersion: 0, share: null });
    V2SessionByIdResponseSchema.parse({ session: raw });
    let heldRead: Promise<void> | null = null;
    let releaseRead = () => {};
    let readEntered = false;
    vi.mocked(axios.get).mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v2/sessions/goal-readback') {
        const observed = raw;
        const held = heldRead;
        heldRead = null;
        if (held) { readEntered = true; await held; }
        return { status: 200, data: { session: observed } };
      }
      return { status: 404, data: {} };
    });
    vi.mocked(axios.patch).mockImplementation(async (_url, body) => {
      const patch = SessionMetadataTuplePatchV1Schema.parse(body);
      if (patch.mode !== 'owner' && patch.mode !== 'owner_migration') throw new Error('Expected owner tuple mutation');
      const next = patch.mode === 'owner_migration' ? patch.target : patch;
      raw = { ...raw, metadataLayoutVersion: 1, metadata: next.sharedMetadata.ciphertext, ownerMetadata: next.ownerMetadata,
        metadataVersion: raw.metadataVersion + 1, agentState: next.agentState.ciphertext,
        agentStateVersion: raw.agentStateVersion + 1 };
      return { status: 200, data: { success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: raw.metadataVersion }, agentState: { version: raw.agentStateVersion } } };
    });
    const socket = createApiSessionSocketStub();
    client = new ApiSessionClient(token, createPlainSessionFixture({ id: raw.id, metadataLayoutVersion: layoutVersion,
      metadata, metadataVersion: 1, ownerMetadata: layoutVersion === 0 ? null : fields.ownerMetadataValue,
      ...(layoutVersion === 1 ? { ownerMetadataEnvelope: fields.ownerMetadata } : {}) }), {
      metadataAuthority: { kind: 'owner', credentials },
      getAccountEncryptionCurrentness: async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }),
      durableMutationDeliveryInitiallyActive: false,
      transport: { serverId: 'goal-home', serverUrl: 'https://goal-home.test',
        createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
    });
    return { session: client, commitExternalStop() {
      const stop = { v: 1, cause: 'explicit_stop', requestId: 'external-stop', requestedAtMs: 1 } as const;
      const stopped = writeSessionExplicitStopV1ToMetadata(metadata, stop);
      const next = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
        metadata: stopped, agentState: null, storedContentMode: 'plain' });
      raw = { ...raw, metadata: next.sharedMetadata.ciphertext, ownerMetadata: next.ownerMetadata,
        metadataVersion: raw.metadataVersion + 1 };
      return stop;
    }, holdRead() {
      readEntered = false;
      heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
      const refresh = client!.refreshSessionSnapshotFromServerRequired({ reason: 'explicit-drain' });
      const release = async () => { releaseRead(); await refresh; };
      heldReads.push(release);
      return { entered: async () => await vi.waitFor(() => expect(readEntered).toBe(true)), release };
    } };
  }

  it('reads committed Stop intent after a snapshot request already in flight', async () => {
    const { session, holdRead, commitExternalStop } = createHome();
    const previous = holdRead();
    await previous.entered();
    const stop = commitExternalStop();
    expect(readSessionExplicitStopV1FromMetadata(session.getMetadataSnapshot())).toBeNull();
    const refreshed = session.refreshSessionSnapshotFromServerRequired({ reason: 'explicit-drain', afterCurrentRead: true });
    await previous.release();
    await refreshed;
    expect(readSessionExplicitStopV1FromMetadata(session.getMetadataSnapshot())).toEqual(stop);
  });

  it.each([0, 1] as const)('reads external native Goal receipts despite older layout-%s refreshes', async layoutVersion => {
    const { session, holdRead } = createHome(layoutVersion);
    const workState = createNativeAgentSessionWorkStateService({ session, pluginId: 'acme.native-agent',
      contributionId: 'external-native', agentId: 'external-native', occurrenceId: 'goal-occurrence',
      declarations: [{ id: 'goals', itemKinds: ['goal'] }], isCurrent: () => true });
    // The plugin receives this public host context; no internal collaborator is mocked.
    const context = { workState, services: { logger: { warn: () => {} } } } as unknown as AgentSessionRuntimeContext;
    const publishGoal = createClaudeNativeGoalWorkStatePublisher(context);
    let publication = Promise.resolve();
    const source = createClaudeGoalWorkStateSource({ backendId: 'external-native', agentId: 'external-native',
      publishWorkStateSnapshot: snapshot => { publication = publishGoal(snapshot); return publication; },
      getCurrentClaudeSessionId: () => 'native-goal-readback' });
    let nativeRevision = 0;
    session.setSessionRuntimeControls({
      refreshGoal: async () => undefined,
      setGoal: async objective => {
        source.recordGoalSetIntent();
        await source.observeTranscriptMessage({ type: 'attachment', sessionId: 'native-goal-readback',
          uuid: `goal-native-${++nativeRevision}`, timestamp: new Date().toISOString(),
          attachment: { type: 'goal_status', sentinel: true, met: false, condition: objective } });
        await publication;
      },
      clearGoal: async () => { source.clearGoalWorkState(); await publication; },
    });
    const refresh = holdRead();
    await refresh.entered();
    await expect(session.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_GOAL_SET,
      { objective: 'Preserve native readback' })).resolves.toMatchObject({
        workState: { items: [expect.objectContaining({ title: 'Preserve native readback' })] },
      });
    await refresh.release();
    await expect(session.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_GOAL_GET, {})).resolves.toMatchObject({
      workState: { items: [expect.objectContaining({ title: 'Preserve native readback' })] },
    });
    const beforeClear = holdRead();
    await beforeClear.entered();
    await expect(session.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR, {}))
      .resolves.toMatchObject({ workState: { items: [] } });
    await beforeClear.release();
    await expect(session.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_GOAL_GET, {}))
      .resolves.toMatchObject({ workState: { items: [] } });
    await expect(session.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_GOAL_SET,
      { objective: 'Preserve native readback' })).resolves.toMatchObject({
        workState: { items: [expect.objectContaining({ title: 'Preserve native readback', vendorRef: 'goal-native-2' })] },
      });
  });

  it.each([
    { correctlyDeclared: true, starting: false, rekey: false },
    { correctlyDeclared: false, starting: false, rekey: false },
    { correctlyDeclared: true, starting: true, rekey: false },
    { correctlyDeclared: false, starting: true, rekey: false },
    { correctlyDeclared: true, starting: true, rekey: true },
    { correctlyDeclared: false, starting: true, rekey: true },
  ])('keeps SDK Goal receipts on the real Session projection (source correctly declared: $correctlyDeclared, starting: $starting, rekey: $rekey)', async ({ correctlyDeclared, starting, rekey }) => {
    await withTempDir('goal-sdk-readback-', async directory => {
      const { session, holdRead } = createHome();
      const exec = createSdkExecFixture();
      const hooks = createSessionHooksFixture();
      const workState = createNativeAgentSessionWorkStateService({ session, pluginId: 'happier.agent.claude',
        contributionId: 'claude', agentId: 'claude', occurrenceId: 'sdk-goal-occurrence',
        declarations: [{ id: correctlyDeclared ? 'goals' : 'wrong-source', itemKinds: ['goal'] }], isCurrent: () => true });
      const context = { workState, services: { logger: { warn: () => {} } } } as unknown as AgentSessionRuntimeContext;
      const scope = { kind: 'session' as const, sessionId: session.sessionId };
      const grants = createTranscriptFileFollowPathGrantRegistry();
      const fileFollow = createPluginTranscriptFileFollowService({ pluginId: 'happier.agent.claude',
        runtimeId: 'sdk-goal-occurrence', readScope: () => scope, fileFollowPathGrants: grants });
      const sdkContext = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service,
        { exec: exec.service, sessionHooks: hooks.service });
      const operations = createClaudeAgentSdkTurnOperations({
        ctx: { ...sdkContext, agentRuntime: { ...sdkContext.agentRuntime,
          transcripts: { ...sdkContext.agentRuntime.transcripts, fileFollow } } },
        directory, launchEnv: {}, permissionMode: 'default', happierSessionId: session.sessionId,
        ...(starting ? {} : { resume: 'native-goal-readback' }), enableSessionWorkState: true, enableSessionResumability: true,
        publishGoalWorkState: createClaudeNativeGoalWorkStatePublisher(context),
      });
      session.setSessionRuntimeControls({ refreshGoal: async () => undefined,
        setGoal: operations.setGoal, clearGoal: operations.clearGoal });
      const transcript = join(directory, 'native-goal-readback.jsonl');
      if (!starting) await writeFile(transcript, '');
      let commandOrdinal = 0;
      const command = async (method: typeof SESSION_RPC_METHODS.SESSION_GOAL_SET | typeof SESSION_RPC_METHODS.SESSION_GOAL_CLEAR) => {
        const ordinal = ++commandOrdinal;
        const nativeSessionId = rekey ? `native-goal-readback-${ordinal}` : 'native-goal-readback';
        const commandTranscript = rekey ? join(directory, `${nativeSessionId}.jsonl`) : transcript;
        const request = method === SESSION_RPC_METHODS.SESSION_GOAL_SET ? { objective: 'SDK native readback' } : undefined;
        let receiptSettled = false;
        const receipt = routeSessionGoalControl({ token: 'goal-fixture-token', sessionId: session.sessionId,
          rawSession: createSessionRecordFixture({ id: session.sessionId, active: true, encryptionMode: 'plain' }),
          metadata: null, currentMachineId: null, mode: 'plain', ctx: null,
          operation: method === SESSION_RPC_METHODS.SESSION_GOAL_SET ? 'set' : 'clear', request,
          callLiveSessionRpc: () => session.rpcHandlerManager.invokeLocal(method, request ?? {}),
        }).then(result => { receiptSettled = true; return result; });
        await vi.waitFor(() => expect(exec.processes.length).toBe(ordinal));
        const process = exec.processes[ordinal - 1]!;
        await vi.waitFor(() => expect(process.written.some(row => typeof row === 'object' && row !== null && Reflect.get(row, 'type') === 'user')).toBe(true));
        const row = process.written.find(row => typeof row === 'object' && row !== null && Reflect.get(row, 'type') === 'user');
        if (!row || typeof row !== 'object' || typeof Reflect.get(row, 'uuid') !== 'string') throw new Error('SDK command UUID missing');
        await process.emit({ type: 'system', subtype: 'init', session_id: nativeSessionId, slash_commands: ['goal'] });
        const hook = hooks.service.startServer.mock.calls[0]?.[0];
        if (!hook?.onSessionHook) throw new Error('Native hook server missing');
        await grants.grant({ pluginId: 'happier.agent.claude', runtimeId: 'sdk-goal-occurrence', scope,
          path: commandTranscript, reason: 'providerTranscriptSource',
          evidence: { kind: 'sessionStartTranscriptPath', providerSessionId: nativeSessionId } });
        await hook.onSessionHook(nativeSessionId, { hook_event_name: 'SessionStart',
          session_id: nativeSessionId, source: starting ? 'startup' : 'resume', transcript_path: commandTranscript, cwd: directory });
        // R58 native transcripts: active sentinel precedes the SDK UUID echo;
        // the echo's parentUuid joins that exact attachment (not objective text).
        if (method === SESSION_RPC_METHODS.SESSION_GOAL_SET) {
          await appendFile(commandTranscript, `${JSON.stringify({ type: 'attachment', uuid: `sdk-goal-${ordinal}`,
            sessionId: nativeSessionId, timestamp: new Date().toISOString(),
            attachment: { type: 'goal_status', sentinel: true, met: false, condition: 'SDK native readback' } })}\n`);
        }
        await appendFile(commandTranscript, `${JSON.stringify({ type: 'user', uuid: Reflect.get(row, 'uuid'),
          parentUuid: `sdk-goal-${ordinal}`, sessionId: nativeSessionId, timestamp: new Date().toISOString(),
          message: { role: 'user', content: '<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>SDK native readback</command-args>' } })}\n`);
        if (method === SESSION_RPC_METHODS.SESSION_GOAL_CLEAR) {
          await process.emit({ type: 'result', subtype: 'success', is_error: false, session_id: nativeSessionId,
            num_turns: 1, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1 });
        }
        await vi.waitFor(() => expect(receiptSettled, 'native Goal receipt must settle from its linked publication').toBe(true));
        const result = await receipt;
        return { result, async finish() {
          if (method === SESSION_RPC_METHODS.SESSION_GOAL_SET) {
            // Keep native work open through the successful Set and immediate Get.
            await process.emit({ type: 'result', subtype: 'success', is_error: false, session_id: nativeSessionId,
              num_turns: 1, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1 });
          }
          await operations.waitForProviderTurnCompletion();
        } };
      };
      try {
        const refresh = holdRead();
        await refresh.entered();
        const first = await command(SESSION_RPC_METHODS.SESSION_GOAL_SET);
        if (!correctlyDeclared) {
          expect(first.result).toMatchObject({ ok: false, errorCode: 'session_goal_control_work_state_unavailable',
            goalControlFailure: { phase: 'host_publication_rejected' } });
          // Carry the real SDK→host→RPC→router refusal through Action execution
          // and the strict public consumer. The wrong source declaration above
          // deliberately breaks publication, rather than replacing an owner.
          const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"session.goal.set": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), sessionGoalSet: async () => first.result });
          const action = await executor.execute('session.goal.set', {
            sessionId: session.sessionId, objective: 'SDK native readback',
          }, { surface: 'cli' });
          expect(ExternalActionExecutionResultV1Schema.parse(projectExternalActionExecutionResultV1(action)))
            .toMatchObject({ ok: false, errorCode: 'session_goal_control_work_state_unavailable',
              goalControlFailure: { phase: 'host_publication_rejected' } });
          let output = '';
          vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
            output += String(chunk);
            const callback = args.find(argument => typeof argument === 'function');
            if (typeof callback === 'function') callback();
            return true;
          });
          const deps = {
            readCredentialsFn: async () => ({ token: 'goal-fixture-token', encryption: null }),
            createExecutorFn: () => ({ ...executor,
              resolveSessionTarget: async (sessionId: string) => ({ ok: true as const, sessionId }) }),
          };
          await handleActionsCommand(['invoke', 'session.goal.set', '--input-json', JSON.stringify({
            sessionId: session.sessionId, objective: 'SDK native readback',
          }), '--json'], deps);
          // Compile the real Goal schema into the shared friendly adapter;
          // publishing a new friendly command is outside this presentation fix.
          const [command] = compileActionCliCommands([{ spec: getActionSpec('session.goal.set'),
            binding: { path: ['session', 'goal', 'set'], positionals: ['sessionId'], visibility: 'canonical' } }]);
          if (!command) throw new Error('Missing friendly Goal command');
          await runCompiledActionCliCommand({ command,
            argv: ['session', 'goal', 'set', session.sessionId, '--objective', 'SDK native readback', '--json'], deps });
          const envelopes = output.trim().split('\n').map(line => JSON.parse(line));
          expect(envelopes).toEqual(['actions_invoke', 'session_goal_set'].map(kind => ({
            v: 1, ok: false, kind, error: { code: 'session_goal_control_work_state_unavailable',
              message: 'session_goal_control_work_state_unavailable',
              goalControlFailure: { phase: 'host_publication_rejected' } },
          })));
          expect(process.exitCode).toBe(1);
          await refresh.release();
          await expect(session.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_GOAL_GET, {}))
            .resolves.toMatchObject({ workState: null });
          await first.finish();
          return;
        }
        expect(first.result).toMatchObject({
          workState: { items: [expect.objectContaining({ title: 'SDK native readback' })] },
        });
        await refresh.release();
        await expect(session.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_GOAL_GET, {}))
          .resolves.toMatchObject({ workState: { items: [expect.objectContaining({ title: 'SDK native readback' })] } });
        await first.finish();
        const cleared = await command(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR);
        expect(cleared.result).toMatchObject({ workState: { items: [] } });
        await cleared.finish();
        await expect(session.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_GOAL_GET, {}))
          .resolves.toMatchObject({ workState: { items: [] } });
        const repeated = await command(SESSION_RPC_METHODS.SESSION_GOAL_SET);
        expect(repeated.result).toMatchObject({
          workState: { items: [expect.objectContaining({ title: 'SDK native readback', vendorRef: 'sdk-goal-3' })] },
        });
        await expect(session.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_GOAL_GET, {}))
          .resolves.toMatchObject({ workState: { items: [expect.objectContaining({ title: 'SDK native readback', vendorRef: 'sdk-goal-3' })] } });
        await repeated.finish();
      } finally {
        await operations.disposeProviderSession();
      }
    });
  });
});
