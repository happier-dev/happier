import { admitTestExecSpawn, prepareTestNativeSocketDirectory } from './client.test-support';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ExecService, PluginProcessHandle, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { AgentSessionGoalControlContext, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { decodeVoiceAssistantActions, getVoiceActionFunctionTool } from '@happier-dev/protocol/voice/actions';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import { createCodexAgentRuntime } from '../engine.js';
import { connectManagedJsonRpcTestClient, createManagedJsonRpcTestClient } from '../../../../../../../apps/cli/src/testkit/process/managedJsonRpc';

// These opt-in probes own every native process/Home and use a local model stub.
// Only the SDK Exec/OS and host-publication boundaries are substituted.
const nativeBinary = process.env.HAPPIER_CODEX_NATIVE_TEST_BIN;
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: process.env.TMPDIR || actual.userInfo().homedir }) };
});

describe.skipIf(!nativeBinary || process.platform === 'win32')('real native Codex factory Goal reopen', () => {
  it('round trips advertised code-mode host functions before reopening paused Goals', async ({ onTestFinished }) => {
    const root = await mkdtemp('/tmp/orc-goalreopen-cont4-factory-');
    const priorTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const env = { PATH: process.env.PATH ?? '', CODEX_HOME: root };
    const descriptor = getVoiceActionFunctionTool();
    const action = { t: getActionSpec('servers.list').bindings!.voiceClientToolName!, args: {} };
    const decodedCalls: unknown[] = [];
    const advertisedNames: string[] = [];
    const returnedOutputs: string[] = [];
    // Responses wire provenance: LOCAL-ROUTING's installed Codex 0.162.1/Muse
    // reproduction (probe-dispatch.py). Muse flattens namespace + function into
    // a dotted name; Codex must advertise a directly callable ordinary function.
    const model = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      // The loopback HTTP peer is the external model boundary.
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        tools?: { type: string; name?: string; tools?: { name: string }[] }[];
        input?: { type: string; output?: unknown }[];
      };
      const names = (body.tools ?? []).flatMap(tool => tool.type === 'namespace'
        ? (tool.tools ?? []).map(child => `${tool.name}.${child.name}`) : typeof tool.name === 'string' ? [tool.name] : []);
      const offered = names.find(name => name === descriptor.name || name.endsWith(`.${descriptor.name}`));
      const outputs = (body.input ?? []).filter(item => item.type === 'function_call_output');
      returnedOutputs.push(...outputs.map(item => JSON.stringify(item.output)));
      if (outputs.length === 0) advertisedNames.push(...names);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const message = offered && outputs.length === 0
        ? { id: 'voice-host-call', call_id: 'voice-host-call', type: 'function_call', name: offered,
          arguments: JSON.stringify({ ...action, args: JSON.stringify(action.args) }), status: 'completed' }
        : { id: 'goal-reopen-reply', type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Ready.', annotations: [] }] };
      const result = { id: 'goal-reopen-response', object: 'response', status: 'completed', output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      for (const event of [
        { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: message },
        { type: 'response.output_item.done', output_index: 0, item: message },
        { type: 'response.completed', response: result },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    const address = model.address();
    if (!address || typeof address === 'string') throw new Error('Local model unavailable');
    const children: PluginProcessHandle[] = [];
    let controlOccurrence = 0;
    let disableControlGoals = false;
    const launch = (args: readonly string[], processEnv: Readonly<Record<string, string>> = env): PluginProcessHandle => {
      const child = spawn(nativeBinary!, [...args], { cwd: root, env: processEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (bytes: Buffer) => stdout.push(bytes));
      child.stderr.on('data', (bytes: Buffer) => stderr.push(bytes));
      let disposed = false;
      const termination = once(child, 'exit').then(([code, signal]): PluginProcessResult['termination'] => ({
        requestedBy: disposed ? { kind: 'dispose', reason: 'caller' } : { kind: 'none' },
        observed: signal ? { kind: 'signal', signal } : { kind: 'exit', exitCode: code ?? 1 },
      }));
      const result = once(child, 'close').then(async (): Promise<PluginProcessResult> => ({
        stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), stdoutTruncated: false, stderrTruncated: false,
        termination: await termination,
      }));
      const handle: PluginProcessHandle = {
        write: async bytes => { child.stdin.write(bytes); }, closeStdin: async () => { child.stdin.end(); },
        onOutput: () => ({ dispose() {} }), waitForExit: () => termination, wait: () => result,
        dispose: async () => { disposed = true; if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await result; },
      };
      children.push(handle);
      return handle;
    };
    // SDK Exec is the external process adapter. The real native executable,
    // transport/client, factory, startup and Goal projection remain intact.
    const exec = {
      withSpawnAdmission: admitTestExecSpawn,
      prepareNativeSocketDirectory: prepareTestNativeSocketDirectory,
      systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' }, executablePath: nativeBinary }) },
      run: async (request: { args: readonly string[] }) => await launch(request.args).wait(),
      spawn: async (request: { args: readonly string[]; env: Record<string, string> }) => launch(request.args, request.env),
      clients: { connectJsonRpc: (request: { endpoint: { socketPath: string }; maxFrameBytes?: number; requestTimeoutMs?: number }, options?: { signal?: AbortSignal }) => connectManagedJsonRpcTestClient({ cwd: root, socketPath: request.endpoint.socketPath, maxFrameBytes: request.maxFrameBytes, requestTimeoutMs: request.requestTimeoutMs, signal: options?.signal }), spawn: async (request: { launch: { args: readonly string[]; env: Readonly<Record<string, string>> }; maxFrameBytes: number; requestTimeoutMs: number }) => {
        // Use a separate, owned native process for each ordinary control client.
        // Unix IPC replaces stdio only at the OS boundary in this probe.
        const socketPath = join(root, `control-${++controlOccurrence}.sock`);
        const args = [...request.launch.args];
        const listenIndex = args.indexOf('--listen');
        if (listenIndex >= 0) args.splice(listenIndex + 1, 1, `unix://${socketPath}`);
        else args.push('--listen', `unix://${socketPath}`);
        const processHandle = launch([...args,
          ...(disableControlGoals ? ['--disable', 'goals'] : [])], request.launch.env);
        await expect.poll(async () => await stat(socketPath).then(() => true, () => false)).toBe(true);
        const connection = await createManagedJsonRpcTestClient({ cwd: root, command: nativeBinary!, environment: env,
          args: ['app-server', 'proxy', '--sock', socketPath],
          maxFrameBytes: request.maxFrameBytes, requestTimeoutMs: request.requestTimeoutMs });
        return { client: connection.client, process: connection.process, wait: () => connection.wait(),
          dispose: async () => { await connection.dispose(); await processHandle.dispose(); } };
      } },
    } as unknown as ExecService;
    type Snapshot = Parameters<ReturnType<AgentSessionRuntimeContext['workState']['publisher']>['publish']>[0];
    const snapshots: Snapshot[] = [];
    const publisher = { publish: async (snapshot: Snapshot) => {
      snapshots.push(snapshot);
      return { status: 'applied' as const, revision: String(snapshots.length), sourceSequence: snapshot.sourceSequence };
    } } satisfies ReturnType<AgentSessionRuntimeContext['workState']['publisher']>;
    const diagnostics: Readonly<Record<string, unknown>>[] = [];
    const signal = new AbortController().signal;
    const context = { signal, workState: { publisher: () => publisher },
      services: { exec, sessions: {}, logger: { debug: (message: string, fields: Readonly<Record<string, unknown>>) => {
        if (message === 'Codex app-server initial goal read') diagnostics.push(fields);
      }, info() {}, warn() {}, error() {} } },
      agent: { id: 'codex' }, session: { id: 'native-goal-reopen', services: {} }, ui: { title: { set: async () => undefined } },
    } as unknown as AgentSessionRuntimeContext;
    const runtime = await createCodexAgentRuntime({ plugin: { id: 'happier.agent.codex', version: '1.0.0' }, agent: { id: 'codex' }, signal });
    if (!runtime.sessions?.goals) throw new Error('Native Goal factory unavailable');
    const request = { sessionId: context.session.id, cwd: root,
      launchEnvironment: { values: env, unset: ['CODEX_SQLITE_HOME', 'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON'] },
      configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: 'goal-probe-model', updatedAtMs: 1 },
        permissionIntent: { value: 'default' as const, updatedAtMs: 1 }, options: {} },
      functionTools: [{ ...descriptor, async call(input: Parameters<typeof decodeVoiceAssistantActions>[0][number]) {
        const decoded = decodeVoiceAssistantActions([input]);
        decodedCalls.push(decoded);
        return { ok: !decoded.failure, marker: decoded.failure ? 'INVALID_ACTION' : 'HOST_ACCEPTED' };
      } }] };
    let active: Awaited<ReturnType<typeof runtime.sessions.open>> | undefined;
    const cleanup = async () => {
      await active?.dispose(); active = undefined;
      for (const child of children) await child.dispose();
      model.closeAllConnections();
      if (model.listening) await new Promise<void>(resolve => model.close(() => resolve()));
      if (priorTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = priorTmpdir;
      await rm(root, { recursive: true, force: true });
    };
    // Vitest timeouts finish the test before its pending body reaches finally.
    onTestFinished(cleanup);
    try {
      // Select from the installed binary rather than recreating its catalog schema.
      const catalogResult = await exec.run({ executable: { kind: 'systemTool', id: 'codex-cli' },
        args: ['debug', 'models'], cwd: { root: 'workspace', relativePath: '' } });
      const catalog = JSON.parse(new TextDecoder().decode(catalogResult.stdout)) as { models: Record<string, unknown>[] };
      const codeModeModel = catalog.models.find(model => model.tool_mode === 'code_mode_only');
      expect(codeModeModel).toBeDefined();
      await writeFile(join(root, 'models.json'), JSON.stringify({ models: [{ ...codeModeModel,
        slug: 'goal-probe-model', prefer_websockets: false, use_responses_lite: false }] }));
      await writeFile(join(root, 'config.toml'), [
        'model_provider = "goal-probe"', 'model = "goal-probe-model"',
        `model_catalog_json = ${JSON.stringify(join(root, 'models.json'))}`,
        '[model_providers.goal-probe]', 'name = "Local Goal probe"',
        `base_url = "http://127.0.0.1:${address.port}"`, 'wire_api = "responses"', 'requires_openai_auth = false',
      ].join('\n'));
      active = await runtime.sessions.open({ ...request, kind: 'create' }, context);
      expect(new TextDecoder().decode((await exec.run({ executable: { kind: 'systemTool', id: 'codex-cli' },
        args: ['--version'], cwd: { root: 'workspace', relativePath: '' } })).stdout).trim()).toBe('codex-cli 0.162.1');
      const events: AgentSessionRuntimeEvent[] = [];
      let settleTurn!: (event: AgentSessionRuntimeEvent) => void;
      const completed = new Promise<AgentSessionRuntimeEvent>(resolve => { settleTurn = resolve; });
      const watch = active.watch(event => {
        events.push(event);
        if (event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled') settleTurn(event);
      });
      await active.send({ inputIds: ['goal-probe-initial'], input: { text: 'Reply Ready.' },
        delivery: { kind: 'newTurn', turnId: 'goal-probe-turn' } });
      expect(await completed).toMatchObject({ kind: 'turn-complete' });
      expect(decodedCalls, JSON.stringify({ advertisedNames, returnedOutputs }))
        .toEqual([{ assistantText: '', actions: [action] }]);
      expect(advertisedNames).toContain(descriptor.name);
      expect(returnedOutputs.some(output => output.includes('HOST_ACCEPTED'))).toBe(true);
      watch.dispose();
      const threadId = events.find(event => event.kind === 'provider-session-id')?.providerSessionId;
      if (!threadId) throw new Error('Native thread identity unavailable');
      const control = { signal, services: { exec }, session: { id: context.session.id, cwd: root,
        activity: 'inactive', providerSessionId: threadId, connectedAccounts: [], launchEnvironment: request.launchEnvironment }, goalSource: publisher } as unknown as AgentSessionGoalControlContext;
      await expect(active.goals!.set({ objective: 'Retained B', status: 'paused' },
        { ...control, session: { ...control.session, activity: 'active' } })).resolves.toMatchObject({ status: 'applied' });
      await active.dispose(); active = undefined;
      await expect(runtime.sessions.goals.set({ objective: 'Retained B', status: 'paused' }, control)).resolves.toMatchObject({ status: 'applied' });
      await expect(runtime.sessions.goals.get(control)).resolves.toMatchObject({ status: 'applied' });
      const retained = snapshots.at(-1)?.items;
      expect(retained).toMatchObject([{ title: 'Retained B', status: 'paused', tokenBudget: null }]);
      // Native 0.162.1 returns -32600 for disabled Goals even with a valid,
      // persisted thread. It is unsupported, not a transient control failure.
      disableControlGoals = true;
      try {
        for (const operation of ['get', 'set', 'clear'] as const) {
          const result = operation === 'set'
            ? await runtime.sessions.goals.set({ status: 'paused' }, control)
            : await runtime.sessions.goals[operation](control);
          expect(result).toMatchObject({ status: 'unsupported', diagnostic: { code: 'codex_goals_disabled',
            details: { stage: `thread/goal/${operation}`, errorCode: '-32600' } } });
        }
      } finally { disableControlGoals = false; }
      snapshots.length = 0;
      active = await runtime.sessions.open({ ...request, kind: 'resume', providerSessionId: threadId }, context);
      expect(diagnostics).toMatchObject([{ threadId, kind: 'present', goalThreadId: threadId }]);
      expect(snapshots.length).toBeGreaterThan(0);
      for (const snapshot of snapshots) expect(snapshot.items).toEqual(retained);
      await expect(active.goals!.get({ ...control, session: { ...control.session, activity: 'active' } })).resolves.toMatchObject({ status: 'applied' });
      for (const snapshot of snapshots) expect(snapshot.items).toEqual(retained);
      await expect(active.goals!.set({ objective: 'Changed C', status: 'paused' }, { ...control, session: { ...control.session, activity: 'active' } })).resolves.toMatchObject({ status: 'applied' });
      expect(snapshots.at(-1)?.items).toMatchObject([{ title: 'Changed C', status: 'paused' }]);
      await active.dispose(); active = undefined;
      await expect(runtime.sessions.goals.clear(control)).resolves.toMatchObject({ status: 'applied' });
      snapshots.length = 0;
      diagnostics.length = 0;
      active = await runtime.sessions.open({ ...request, kind: 'resume', providerSessionId: threadId }, context);
      expect(diagnostics).toMatchObject([{ threadId, kind: 'absent', goalThreadId: null }]);
      expect(snapshots.length).toBeGreaterThan(0);
      for (const snapshot of snapshots) expect(snapshot.items).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 60_000);
});
