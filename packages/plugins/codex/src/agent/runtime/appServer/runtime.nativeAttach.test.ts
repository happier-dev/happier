import { sanitizeNativeAgentSessionBoundaryError } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord, StrictJsonValueSchema } from '@happier-dev/protocol';
import type { AgentExecutionRunConversationEventV1, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import { createCodexNativeAppServerSessionRuntime } from './native.js';
import { startCodexAppServerRuntime } from './runtime.js';
import { withCodexNativeAttachFixture as withFixture } from './runtime.nativeAttach.test-support.js';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';

// The fixture owns TMPDIR. Isolate the OS-user startup lock from live Agents,
// while retaining the real file-lock and native socket/client behavior.
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: process.env.TMPDIR || actual.userInfo().homedir }) };
});

describe('native Codex attachment preparation', () => {
  it.each(['session', 'run'] as const)('retains %s startup rejection when native cleanup also fails', async surface => {
    await withFixture(async ({ openConfiguredSession, openConfiguredRun, failResume, nativeProcessExits }) => {
      failResume('Native startup refused: Bearer private-provider-token');
      const failure: unknown = await (surface === 'session' ? openConfiguredSession() : openConfiguredRun('existing-thread'))
        .catch(error => error);
      const retained = sanitizeNativeAgentSessionBoundaryError(failure, true);
      const issue = SessionRuntimeIssueV1Schema.parse(classifyPrimarySessionRuntimeIssue({
        cause: 'session_error', error: retained, provider: 'codex', occurredAt: 100,
      }));
      expect(retained).toMatchObject({ code: 'agent_startup_rpc_rejected', details: { failureCause: {
        phase: 'thread_open', providerErrorCode: -32000,
      } } });
      expect(issue).toMatchObject({ code: 'agent_startup_rpc_rejected', failureCause: { providerErrorCode: -32000 } });
      expect(nativeProcessExits.length).toBeGreaterThan(0);
      expect(JSON.stringify(issue)).not.toContain('private-provider-token');
      expect(JSON.stringify(issue)).not.toContain('PRIVATE_CLEANUP_PATH');
    }, { threadStartFailure: { code: -32000, message: 'Native startup refused: Bearer private-provider-token' },
      nativeCleanupFailure: Object.assign(new Error('PRIVATE_CLEANUP_PATH'), { code: 'EACCES' }) });
  });

  it.each([
    { variant: 'httpConnectionFailed', status: 401, providerCode: 'provider_endpoint_unauthorized' },
    { variant: 'responseStreamConnectionFailed', status: 401, providerCode: 'provider_endpoint_unauthorized' },
    { variant: 'httpConnectionFailed', status: 403, providerCode: null },
    { variant: 'httpConnectionFailed', status: 500, providerCode: null },
    { variant: 'httpConnectionFailed', status: null, providerCode: 'provider_endpoint_unreachable' },
    { variant: 'responseStreamConnectionFailed', status: null, providerCode: 'provider_endpoint_unreachable' },
    { variant: 'responseStreamDisconnected', status: null, providerCode: 'provider_endpoint_unreachable' },
    { variant: 'responseTooManyFailedAttempts', status: null, providerCode: null },
    { variant: 'other', status: null, providerCode: null },
  ])('attributes a Provider terminal transport failure without native sign-in recovery ($variant/$status)', async ({ variant, status, providerCode }) => {
    await withFixture(async ({ openConfiguredSession, emitNotification }) => {
      const session = await openConfiguredSession();
      const events: AgentSessionRuntimeEvent[] = [];
      session.watch(event => events.push(event));
      await session.send({ inputIds: ['provider-auth-input'], input: { text: 'hello' },
        delivery: { kind: 'newTurn', turnId: 'provider-auth-turn' } });
      emitNotification('turn/completed', { threadId: 'fresh-thread', turn: {
        id: 'provider-turn-1', status: 'failed', error: {
          message: 'PRIVATE_PROVIDER_RESPONSE invalid API key',
          codexErrorInfo: variant === 'other' ? 'other' : { [variant]: { httpStatusCode: status } },
        },
      } });
      await vi.waitFor(() => expect(events.some(event => event.kind === 'turn-failed')).toBe(true));
      const failed = events.find(event => event.kind === 'turn-failed');
      if (failed?.kind !== 'turn-failed') throw new Error('Missing terminal failure');
      expect(failed.diagnostic.details).not.toHaveProperty('runtimeAuthClassification');
      if (providerCode) {
        const retryable = providerCode === 'provider_endpoint_unreachable';
        expect(failed.diagnostic).toMatchObject({ code: providerCode, details: {
          providerError: { v: 1, code: providerCode, connectionId: 'pc_work',
            retryable, action: retryable ? 'retry' : 'replace_secret' },
          failureCause: { code: providerCode,
            ...(status === null ? {} : { httpStatus: status }) },
        } });
        expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: failed.diagnostic,
          provider: 'codex', occurredAt: 100 })).toMatchObject({ code: providerCode, source: 'agent_session_error' });
      } else {
        expect(failed.diagnostic.code).not.toBe('provider_endpoint_unauthorized');
        expect(failed.diagnostic.code).not.toBe('provider_endpoint_unreachable');
        expect(failed.diagnostic.details).not.toHaveProperty('providerError');
      }
      expect(JSON.stringify(events)).not.toContain('PRIVATE_');
    }, { providerBinding: {
      connectionId: 'pc_work', model: { id: 'fixture-model', name: 'Fixture' },
      upstream: { protocol: 'openai-responses', normalizedUrl: 'https://gateway.example.test/v1', credential: 'apiKey' },
      materialization: { v: 1, kind: 'engineConfig', engineConfig: { v: 1, modelProvider: 'ollama', config: {} } },
    } });
  });

  it('retains redacted provider rejection details through public native startup and issue publication', async () => {
    await withFixture(async ({ openConfiguredSession, requests }) => {
      const failure = await openConfiguredSession().then(
        () => { throw new Error('Expected native startup refusal'); },
        (error: unknown) => error,
      );
      const retained = sanitizeNativeAgentSessionBoundaryError(failure, true);
      const issue = SessionRuntimeIssueV1Schema.parse(classifyPrimarySessionRuntimeIssue({
        cause: 'session_error', error: retained, provider: 'codex', occurredAt: 100,
      }));
      expect(retained).toMatchObject({ code: 'agent_startup_rpc_rejected', details: { failureCause: {
        phase: 'thread_open', providerErrorCode: -32603,
        providerErrorMessage: expect.stringContaining('Thread creation failed:'),
      } } });
      expect(issue).toMatchObject({ failureCause: {
        phase: 'thread_open', providerErrorCode: -32603,
        providerErrorMessage: expect.stringContaining('[REDACTED]'),
      } });
      for (const value of [failure, retained, issue]) {
        expect(JSON.stringify(value)).not.toContain('private-provider-token');
        expect(JSON.stringify(value)).not.toContain('private-api-key');
      }
      expect(requests.filter(request => request.method === 'thread/start')).toHaveLength(1);
      expect(requests.some(request => request.method === 'turn/start')).toBe(false);
    }, { threadStartFailure: {
      code: -32603,
      message: 'Thread creation failed: Bearer private-provider-token; api_key=private-api-key',
    } });
  });

  it.skipIf(process.platform === 'win32').each(['session', 'run'] as const)(
    'retains the native permission cause through sanitized %s startup and public issue projection',
    async (scope) => {
      const logs: unknown[] = [];
      await withFixture(async ({ openConfiguredSession, openConfiguredRun }) => {
        const failure: unknown = await (scope === 'session' ? openConfiguredSession() : openConfiguredRun())
          .then(() => null, error => error);
        expect(failure).toMatchObject({ code: 'agent_startup_transport_failed', details: {
          failureCause: { code: 'EACCES', phase: 'client_start' },
        } });
        const retained = sanitizeNativeAgentSessionBoundaryError(failure, true);
        const issue = SessionRuntimeIssueV1Schema.parse(classifyPrimarySessionRuntimeIssue({
          cause: 'session_error', error: retained, provider: 'codex', occurredAt: 100,
        }));
        expect(issue.failureCause).toMatchObject({ code: 'EACCES', phase: 'client_start' });
        expect(logs).toContainEqual(expect.objectContaining({ failureCause: expect.objectContaining({ code: 'EACCES' }) }));
        expect(JSON.stringify([failure, retained, issue, logs])).not.toContain('PRIVATE_');
      }, {
        nativeSpawnFailure: Object.assign(new Error('PRIVATE_NATIVE_STDERR'), {
          code: 'EACCES', syscall: 'spawn /PRIVATE_BINARY', path: '/PRIVATE_HOME',
        }),
        logger: { debug: (_message, fields) => { logs.push(fields); }, warn: (_message, fields) => { logs.push(fields); } },
        skills: { pluginRoot: '/fixture', skillsRoot: '/fixture/skills', items: [], nativeDisables: [] },
      });
    },
  );

  it('projects a flattened upstream model_not_found through the real native failure wiring', async () => {
    await withFixture(async ({ openConfiguredSession, emitNotification }) => {
      const session = await openConfiguredSession();
      const events: AgentSessionRuntimeEvent[] = [];
      session.watch(event => events.push(AgentSessionRuntimeEventSchema.parse(event)));
      await expect(session.send({ inputIds: ['model-probe'], input: { text: 'Reply OK.' },
        delivery: { kind: 'newTurn', turnId: 'model-probe-turn' } })).resolves.toMatchObject({ status: 'admitted' });
      emitNotification('turn/completed', { threadId: 'fresh-thread', turn: {
        id: 'provider-turn-1', status: 'failed', error: { codexErrorInfo: 'other',
          message: `HTTP 400: ${JSON.stringify({ error: { type: 'invalid_request_error',
            code: 'model_not_found', param: null, message: 'PRIVATE_PROVIDER_BODY' } })}` },
      } });
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        kind: 'turn-failed', turnId: 'model-probe-turn', diagnostic: expect.objectContaining({
          code: 'provider_model_not_found', message: expect.stringMatching(/choose another model/i),
        }),
      })));
      expect(JSON.stringify(events)).not.toContain('PRIVATE_PROVIDER_BODY');
    });
  });

  it('maps startup instructions to native developerInstructions on create', async () => {
    await withFixture(async ({ openConfiguredSession, requests }) => {
      await openConfiguredSession();
      expect(requests.find(request => request.method === 'thread/start')?.params)
        .toMatchObject({ developerInstructions: 'Global Voice developer instructions.' });
      expect(requests.some(request => request.method === 'turn/start')).toBe(false);
    }, { startupInstructions: { v: 1, id: 'happier.global_voice_agent', revision: 1,
      instructions: 'Global Voice developer instructions.' } });
  });

  it('passes the host-frozen raw MCP launch configuration to the native app-server', async () => {
    const mcpServers = Object.freeze({ happier: Object.freeze({
      command: 'happier-mcp', args: Object.freeze(['serve']),
      env: Object.freeze({ HAPPIER_MCP_MODE: 'session' }),
    }) });
    const launches: Array<readonly string[]> = [];
    await withFixture(async ({ openConfiguredSession, requests }) => {
      await openConfiguredSession();
      expect(launches[0]).toEqual(expect.arrayContaining([
        'mcp_servers.happier.command="happier-mcp"',
        'mcp_servers.happier.args=["serve"]',
        'mcp_servers.happier.env={HAPPIER_MCP_MODE="session"}',
      ]));
      expect(requests.find(request => request.method === 'thread/start')?.params)
        .not.toHaveProperty('modelProvider');
    }, { mcpServers, observer: {
      recordAppServerRequest() {}, recordLaunch: launch => { launches.push(launch.argv); },
    } });
  });

  it('uses canonical session authentication without a realtime API-key purpose or watcher', async () => {
    const connectedAccounts = {
      getBinding: vi.fn<ConnectedAccountsService['getBinding']>(async () => null),
      requestSelection: vi.fn<ConnectedAccountsService['requestSelection']>(),
      materialize: vi.fn<ConnectedAccountsService['materialize']>(),
      listAccounts: vi.fn<ConnectedAccountsService['listAccounts']>(),
      materializeListedAccount: vi.fn<ConnectedAccountsService['materializeListedAccount']>(),
      watch: vi.fn<ConnectedAccountsService['watch']>(() => ({ dispose() {} })),
    } satisfies ConnectedAccountsService;
    const launches: Array<Readonly<Record<string, string | undefined>> | undefined> = [];
    await withFixture(async ({ openConfiguredSession }) => {
      await openConfiguredSession();
      expect(connectedAccounts.getBinding.mock.calls.map(([purpose]) => purpose)).not.toContain('realtime_upstream');
      expect(connectedAccounts.materialize).not.toHaveBeenCalled();
      expect(connectedAccounts.watch.mock.calls.map(([purpose]) => purpose)).not.toContain('realtime_upstream');
      expect(launches.length).toBeGreaterThan(0);
      expect(launches.every(env => env?.OPENAI_API_KEY === undefined)).toBe(true);
    }, { connectedAccounts, observer: {
      recordAppServerRequest() {}, recordLaunch: launch => { launches.push(launch.env); },
    } });
  });

  it('passes exact validated Provider engine configuration to the native app-server', async () => {
    const modelProvider = 'happier_0123456789abcdef0123456789abcdef';
    const engineConfig = Object.freeze({ v: 1 as const, modelProvider, config: Object.freeze({
      [`model_providers.${modelProvider}`]: Object.freeze({ name: 'Happier provider' as const,
        base_url: 'https://gateway.example.test/v1', wire_api: 'responses' as const,
        env_key: 'HAPPIER_CODEX_PROVIDER_API_KEY' as const, requires_openai_auth: false as const,
        supports_websockets: false as const }),
    }) });
    await withFixture(async ({ openConfiguredSession, requests }) => {
      await openConfiguredSession();
      expect(requests.find(request => request.method === 'thread/start')?.params).toMatchObject({
        model: 'gpt-5.6-luna', modelProvider, config: engineConfig.config,
      });
    }, { providerBinding: { connectionId: 'pc_work', model: { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      upstream: { protocol: 'openai-responses', normalizedUrl: 'https://gateway.example.test/v1', credential: 'apiKey' },
      materialization: { v: 1, kind: 'engineConfig', engineConfig } } });
  });

  it.each([
    { requested: 'medium', expected: 'low' },
    { requested: 'max', expected: 'max' },
  ])('applies only the selected Provider model effort subset ($requested)', async ({ requested, expected }) => {
    const engineConfig = { v: 1 as const, modelProvider: 'ollama', config: {} };
    await withFixture(async ({ openConfiguredSession, requests }) => {
      const session = await openConfiguredSession();
      await session.updateConfiguration?.({
        mode: { value: null, updatedAtMs: 1 }, model: { value: 'fixture-model', updatedAtMs: 1 },
        permissionIntent: { value: 'read-only', updatedAtMs: 1 },
        options: { reasoning_effort: { value: requested, updatedAtMs: 2 } },
      });
      await session.send({ inputIds: ['effort-input'], input: { text: 'Reply OK.' },
        delivery: { kind: 'newTurn', turnId: 'effort-turn' } });
      expect(requests.find(request => request.method === 'turn/start')?.params).toMatchObject({ effort: expected });
    }, { providerBinding: { connectionId: 'pc_work',
      model: { id: 'fixture-model', name: 'Fixture', capabilities: { reasoningControls: 'supported' },
        modelOptions: [{ id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'high',
          options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'max', name: 'Max' }] }] },
      upstream: { protocol: 'openai-responses', normalizedUrl: 'https://gateway.example.test/v1', credential: 'apiKey' },
      materialization: { v: 1, kind: 'engineConfig', engineConfig } } });
  });

  it.each([
    { scope: 'session', requested: 'max', declared: true, expected: 'max' },
    { scope: 'run', requested: 'max', declared: true, expected: 'max' },
    { scope: 'session', requested: 'medium', declared: true, expected: undefined },
    { scope: 'run', requested: 'medium', declared: true, expected: undefined },
    { scope: 'session', requested: 'high', declared: false, expected: undefined },
    { scope: 'run', requested: 'high', declared: false, expected: undefined },
  ])('applies declared Provider effort at $scope startup ($requested, declared=$declared)', async ({ scope, requested, declared, expected }) => {
    await withFixture(async ({ openConfiguredSession, openConfiguredRun, requests }) => {
      const conversation = scope === 'session' ? await openConfiguredSession() : await openConfiguredRun();
      await conversation.send({ inputIds: ['effort-input'], input: { text: 'Reply OK.' },
        delivery: { kind: 'newTurn', turnId: 'effort-turn' } });
      const thread = requests.find(request => request.method === 'thread/start')?.params;
      const turn = requests.find(request => request.method === 'turn/start')?.params;
      expect(turn).toHaveProperty('model', 'fixture-model');
      expect(turn?.effort).toBe(expected);
      expect((thread?.config as Record<string, unknown> | undefined)?.model_reasoning_effort).toBe(expected);
    }, { configuration: {
      mode: { value: null, updatedAtMs: 1 }, model: { value: 'stale-selected-model', updatedAtMs: 1 },
      permissionIntent: { value: 'read-only', updatedAtMs: 1 },
      options: { reasoning_effort: { value: requested, updatedAtMs: 1 } },
    }, providerBinding: { connectionId: 'pc_work',
      model: { id: 'fixture-model', name: 'Fixture', capabilities: { reasoningControls: 'supported' },
        ...(declared ? { modelOptions: [{ id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'high',
          options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'max', name: 'Max' }] }] } : {}) },
      upstream: { protocol: 'openai-responses', normalizedUrl: 'https://gateway.example.test/v1', credential: 'apiKey' },
      materialization: { v: 1, kind: 'engineConfig', engineConfig: { v: 1, modelProvider: 'ollama', config: {} } } } });
  });

  it.skipIf(process.platform === 'win32')('keeps the primary turn active when a completed execution run releases its process', async () => {
    const nativeTurns = new Map<string, { complete(): void; isOpen(): boolean }>();
    await withFixture(async ({ openConfiguredSession, openConfiguredRun, endpoints, nativeProcessExits }) => {
      const primary = await openConfiguredSession();
      const primaryEvents: AgentSessionRuntimeEvent[] = [];
      primary.watch(event => primaryEvents.push(AgentSessionRuntimeEventSchema.parse(event)));
      await expect(primary.send({
        inputIds: ['primary-input'], input: { text: 'Keep working on the primary task.' },
        delivery: { kind: 'newTurn', turnId: 'primary-turn' },
      })).resolves.toMatchObject({ status: 'admitted' });

      const child = await openConfiguredRun();
      const childEvents: AgentExecutionRunConversationEventV1[] = [];
      child.watch(event => childEvents.push(event));
      await expect(child.send({
        inputIds: ['child-input'], input: { text: 'Complete the delegated task.' },
        delivery: { kind: 'newTurn', turnId: 'child-turn' },
      })).resolves.toMatchObject({ status: 'admitted' });
      await vi.waitFor(() => expect(nativeTurns.has('provider-turn-2')).toBe(true));
      nativeTurns.get('provider-turn-2')!.complete();
      await vi.waitFor(() => expect(childEvents).toContainEqual(expect.objectContaining({
        kind: 'turn-complete', turnId: 'child-turn',
      })));
      await child.dispose();

      expect(endpoints).toHaveLength(2);
      expect(nativeProcessExits).toEqual([endpoints[1]]);
      expect(nativeTurns.get('provider-turn-1')?.isOpen()).toBe(true);
      expect(primaryEvents.some(event => event.kind === 'turn-complete')).toBe(false);
      nativeTurns.get('provider-turn-1')!.complete();
      await vi.waitFor(() => expect(primaryEvents).toContainEqual(expect.objectContaining({
        kind: 'turn-complete', turnId: 'primary-turn',
      })));
      await expect(primary.send({
        inputIds: ['primary-followup'], input: { text: 'Continue after the child finished.' },
        delivery: { kind: 'newTurn', turnId: 'primary-followup-turn' },
      })).resolves.toMatchObject({ status: 'admitted' });
      expect(nativeProcessExits).toEqual([endpoints[1]]);
    }, {
      onTurnStart: ({ socket, params, turnId }) => {
        // Deliver each native completion only to its process's connection.
        nativeTurns.set(turnId, {
          complete: () => socket.send(JSON.stringify({ method: 'turn/completed', params: {
            threadId: params.threadId, turn: { id: turnId, status: 'completed' },
          } })),
          isOpen: () => socket.readyState === socket.OPEN,
        });
      },
    });
  });

  it('materializes the fresh native thread before any input even without startup instructions', async () => {
    await withFixture(async ({ openConfiguredSession, resume, requests }) => {
      const session = await openConfiguredSession();
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch(event => events.push(AgentSessionRuntimeEventSchema.parse(event)));
      try {
        await expect(resume()).resolves.toMatchObject({ thread: { id: 'fresh-thread', turns: [] } });
        expect(events).toContainEqual(expect.objectContaining({ kind: 'provider-session-id', providerSessionId: 'fresh-thread' }));
        expect(requests.some(request => request.method === 'turn/start')).toBe(false);
      } finally { subscription.dispose(); }
    }, { startupInstructions: null });
  });
  it('projects the c27 code-mode command once under its native command identity', async () => {
    await withFixture(async ({ runtime, emitNotification }) => {
      const native = createCodexNativeAppServerSessionRuntime(runtime, 'actual-happier-session');
      const events: AgentSessionRuntimeEvent[] = [];
      native.watch(event => events.push(AgentSessionRuntimeEventSchema.parse(event)));
      try {
        await native.send({ inputIds: ['pwd'], input: { text: 'Execute pwd' },
          delivery: { kind: 'newTurn', turnId: 'host-pwd' } });
        const scope = { threadId: 'fresh-thread', turnId: 'provider-turn-1' };
        // c27-history-settled.json seq6/7/11/12: outer code execution is
        // transport plumbing; the nested command has its own native identity.
        emitNotification('rawResponseItem/completed', { ...scope, item: {
          type: 'custom_tool_call', call_id: 'call-code', name: 'exec',
          input: 'const r = await tools.exec_command({cmd:"pwd"}); text(r.output);',
        } });
        const command = { type: 'commandExecution', id: 'exec-command', command: '/bin/bash -lc pwd' };
        emitNotification('item/started', { ...scope, item: command });
        emitNotification('rawResponseItem/completed', { ...scope, item: {
          type: 'custom_tool_call_output', call_id: 'call-code', output: 'Script running with cell ID 1',
        } });
        emitNotification('item/completed', { ...scope, item: {
          ...command, status: 'completed', aggregatedOutput: '/workspace\n', exitCode: 0,
        } });
        emitNotification('turn/completed', { threadId: 'fresh-thread', turn: { id: scope.turnId, status: 'completed' } });
        await vi.waitFor(() => expect(events.some(event => event.kind === 'turn-complete')).toBe(true));
        expect(events.filter(event => event.kind === 'tool-call')).toEqual([
          expect.objectContaining({ toolCallId: 'exec-command', toolName: 'Bash' }),
        ]);
        expect(events.filter(event => event.kind === 'tool-result')).toEqual([
          expect.objectContaining({ toolCallId: 'exec-command', output: expect.objectContaining({ aggregatedOutput: '/workspace\n', exitCode: 0 }) }),
        ]);
        await native.send({ inputIds: ['failed-script'], input: { text: 'Try another command' },
          delivery: { kind: 'newTurn', turnId: 'host-failed-script' } });
        const nextScope = { threadId: 'fresh-thread', turnId: 'provider-turn-2' };
        emitNotification('rawResponseItem/completed', { ...nextScope, item: {
          type: 'custom_tool_call', call_id: 'call-code', name: 'exec', input: 'await tools.exec_command({cmd:"pwd"});',
        } });
        emitNotification('rawResponseItem/completed', { ...nextScope, item: {
          type: 'custom_tool_call_output', call_id: 'call-code', output: 'Sandbox startup failed before a typed command existed',
        } });
        emitNotification('turn/completed', { threadId: 'fresh-thread', turn: { id: nextScope.turnId, status: 'completed' } });
        await vi.waitFor(() => expect(events.filter(event => event.kind === 'turn-complete')).toHaveLength(2));
        expect(events.filter(event => event.kind === 'tool-call')).toHaveLength(2);
        expect(events.filter(event => event.kind === 'tool-result').at(-1)).toMatchObject({
          toolCallId: 'call-code', output: 'Sandbox startup failed before a typed command existed',
        });
      } finally { await native.dispose(); }
    });
  });
  it.skipIf(process.platform === 'win32')('provides a supported runtime and product install remedy without disclosing native failure content', async () => {
    const sentinel = 'PRIVATE_NATIVE_RUNTIME_SENTINEL';
    await withFixture(async ({ openConfiguredSession }) => {
      const failure: unknown = await openConfiguredSession().then(() => null, error => error);
      expect(failure).toMatchObject({ code: 'codex_tool_restriction_unsupported_runtime' });
      if (!(failure instanceof Error)) throw new Error('Expected a typed startup refusal');
      expect(failure.message).toContain('0.162.1');
      expect(failure.message).toContain('machines.agents.install');
      expect(failure.message).not.toContain(sentinel);
    }, {
      nativeSpawnFailure: new PluginError({ code: 'codex_tool_restriction_unsupported_runtime', message: sentinel }),
      skills: { pluginRoot: '/fixture', skillsRoot: '/fixture/skills', items: [], nativeDisables: [] },
    });
  });
  it.skipIf(process.platform === 'win32').each([
    { scope: 'session', mode: 'read-only', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } },
    { scope: 'run', mode: 'read-only', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } },
    { scope: 'session', mode: 'yolo', sandbox: 'danger-full-access', sandboxPolicy: undefined },
  ] as const)('lets host-mediated MCP approval reach the host in a native $scope ($mode)', async ({ scope, mode, sandbox, sandboxPolicy }) => {
    await withFixture(async ({ openConfiguredSession, openConfiguredRun, requests, emitNotification }) => {
      const session = scope === 'session' ? await openConfiguredSession() : await openConfiguredRun();
      const sent = session.send({ inputIds: ['mcp-read'], input: { text: 'Read the selected MCP tool.' },
        delivery: { kind: 'newTurn', turnId: 'mcp-read-turn' } });
      const approvalPolicy = { granular: { sandbox_approval: false, rules: false,
        mcp_elicitations: true, request_permissions: false, skill_approval: false } };
      // Codex 0.162.1 rejects a prompted MCP tool before sending host input
      // when the thread uses `never` (including the :read-only profile).
      try {
        await vi.waitFor(() => expect(requests.some(request => request.method === 'turn/start')).toBe(true));
        const thread = requests.find(request => request.method === 'thread/start')?.params;
        expect(thread).toMatchObject({ approvalPolicy, sandbox });
        expect(thread).not.toHaveProperty('permissions');
        const turn = requests.find(request => request.method === 'turn/start')?.params;
        expect(turn?.approvalPolicy).toEqual(approvalPolicy);
        expect(turn?.sandboxPolicy).toEqual(sandboxPolicy);
        expect(turn).not.toHaveProperty('permissions');
      } finally {
        emitNotification('turn/completed', { threadId: 'fresh-thread', turn: { id: 'provider-turn-1', status: 'completed' } });
        await sent;
      }
    }, {
      permissionMode: mode, mcpServers: { docs: { command: 'fixture-bridge' } },
      mcpToolPolicy: { docs: { unlisted: 'deny', tools: { read: 'ask' } } },
    });
  });

  it.skipIf(process.platform === 'win32')('resumes the same persisted thread with a changed MCP launch set', async () => {
    await withFixture(async ({ openConfiguredSession, requests, nativeLaunches, emitNotification }) => {
      const initial = await openConfiguredSession();
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = initial.watch(event => events.push(event));
      try {
        await initial.send({ inputIds: ['before-restart'], input: { text: 'Remember the conversation.' },
          delivery: { kind: 'newTurn', turnId: 'host-turn-before' } });
        emitNotification('turn/completed', { threadId: 'fresh-thread', turn: { id: 'provider-turn-1', status: 'completed' } });
        await expect.poll(() => events.some(event => event.kind === 'turn-complete')).toBe(true);
        expect(events).toContainEqual(expect.objectContaining({ kind: 'provider-session-id', providerSessionId: 'fresh-thread' }));
      } finally { subscription.dispose(); await initial.dispose(); }

      const resumed = await openConfiguredSession('fresh-thread', { wilson: { command: 'fixture-bridge' } });
      expect(RuntimeDescriptorV1Schema.parse(resumed.runtimeDescriptorV1)).toMatchObject({ agent: { providerSessionId: 'fresh-thread' } });
      expect(requests.filter(request => request.method === 'thread/start')).toHaveLength(1);
      expect(requests.filter(request => request.method === 'thread/resume').map(request => request.params.threadId))
        .toEqual(['fresh-thread']);
      expect(nativeLaunches).toHaveLength(2);
      expect(nativeLaunches[0]).not.toContain('mcp_servers.happier__wilson.command="fixture-bridge"');
      expect(nativeLaunches[1]).toContain('mcp_servers.happier__wilson.command="fixture-bridge"');
      const resumedEvents: AgentSessionRuntimeEvent[] = [];
      const resumedSubscription = resumed.watch(event => resumedEvents.push(event));
      try {
        await resumed.send({ inputIds: ['after-restart'], input: { text: 'Continue our conversation.' },
          delivery: { kind: 'newTurn', turnId: 'host-turn-after' } });
        expect(requests.filter(request => request.method === 'turn/start').map(request => request.params.threadId))
          .toEqual(['fresh-thread', 'fresh-thread']);
        emitNotification('turn/completed', { threadId: 'fresh-thread', turn: { id: 'provider-turn-2', status: 'completed' } });
        await expect.poll(() => resumedEvents.some(event => event.kind === 'turn-complete' && event.turnId === 'host-turn-after')).toBe(true);
      } finally { resumedSubscription.dispose(); }
    });
  });

  it.skipIf(process.platform === 'win32').each(['session', 'run'] as const)('diagnoses a native %s startup failure without exposing native error content', async scope => {
    const logs: unknown[] = [];
    const secret = 'PRIVATE_NATIVE_STARTUP_SENTINEL';
    const failure = Object.assign(new Error(secret, { cause: new Error(secret) }), {
      code: 'PLUGIN_EXEC_GENERATION_STALE', privatePayload: secret,
    });
    await withFixture(async ({ openConfiguredSession, openConfiguredRun }) => {
      await expect(scope === 'session' ? openConfiguredSession() : openConfiguredRun()).rejects.toMatchObject({
        code: 'agent_startup_failed',
      });
      expect(logs).toContainEqual({ stage: 'skills', errorName: 'Error', errorCode: 'PLUGIN_EXEC_GENERATION_STALE' });
      expect(JSON.stringify(logs)).not.toContain(secret);
    }, {
      nativeSpawnFailure: failure,
      logger: { debug: (_message, fields) => { logs.push(fields); }, warn() {} },
      skills: { pluginRoot: '/fixture', skillsRoot: '/fixture/skills', items: [], nativeDisables: [] },
    });
  });

  it.each(['assistant', 'reasoning'] as const)('clears an existing %s draft with an empty normalized final without manufacturing empty output', async (channel) => {
    await withFixture(async ({ runtime, emitNotification }) => {
      await startCodexAppServerRuntime(runtime);
      const session = createCodexNativeAppServerSessionRuntime(runtime, 'session-empty-final');
      const events: AgentSessionRuntimeEvent[] = [];
      session.watch((event) => events.push(event));
      for (let turn = 1; turn <= 2; turn += 1) {
        const turnId = `empty-final-turn-${turn}`;
        const hasDraft = turn === 1;
        await session.send({
          inputIds: [`empty-input-${turn}`], input: { text: 'Use the final output' },
          delivery: { kind: 'newTurn', turnId },
        });
        if (hasDraft) emitNotification(channel === 'assistant' ? 'item/agentMessage/delta' : 'item/reasoning/textDelta', {
          threadId: 'fresh-thread', turnId: `provider-turn-${turn}`, itemId: 'removed', delta: 'Removed draft',
        });
        emitNotification('item/completed', {
          threadId: 'fresh-thread', turnId: `provider-turn-${turn}`,
          item: { id: 'removed', type: channel === 'assistant' ? 'agentMessage' : 'reasoning', text: '' },
        });
        emitNotification('item/agentMessage/delta', {
          threadId: 'fresh-thread', turnId: `provider-turn-${turn}`, itemId: 'retained', delta: 'Retained answer',
        });
        emitNotification('item/completed', {
          threadId: 'fresh-thread', turnId: `provider-turn-${turn}`,
          item: { id: 'retained', type: 'agentMessage', text: 'Retained answer' },
        });
        emitNotification('turn/completed', {
          threadId: 'fresh-thread', turn: { id: `provider-turn-${turn}`, status: 'completed' },
        });
        await expect.poll(() => events.some((event) => event.kind === 'turn-complete' && event.turnId === turnId)).toBe(true);
        const output = events.filter((event) => event.turnId === turnId);
        const snapshots = output.filter((event) => event.kind === 'transcript-message-committed');
        if (hasDraft) {
          const draft = output.find((event) => event.kind === 'message-delta' && event.text === 'Removed draft');
          expect(draft).toMatchObject({ kind: 'message-delta', channel, messageId: expect.any(String) });
          if (draft?.kind !== 'message-delta' || !draft.messageId) throw new Error('Missing draft identity');
          expect(snapshots).toMatchObject([{ role: channel, text: '', messageId: draft.messageId }]);
          if (channel === 'assistant') expect(output.filter((event) => event.kind === 'message-delta' || event.kind === 'transcript-message-committed')).toMatchObject([
            { kind: 'message-delta', text: 'Removed draft' },
            { kind: 'transcript-message-committed', text: '' },
            { kind: 'message-delta', text: 'Retained answer' },
          ]);
        } else {
          expect(snapshots).toEqual([]);
          expect(output.filter((event) => event.kind === 'message-delta').map((event) => event.text)).toEqual(['Retained answer']);
        }
        expect(output).toContainEqual(expect.objectContaining({ kind: 'message-delta', channel: 'assistant', text: 'Retained answer' }));
      }
    });
  });

  it('correlates a corrected reasoning snapshot with its streamed segment', async () => {
    await withFixture(async ({ runtime, emitNotification }) => {
      await startCodexAppServerRuntime(runtime);
      const session = createCodexNativeAppServerSessionRuntime(runtime, 'session-reasoning-replacement');
      const events: AgentSessionRuntimeEvent[] = [];
      session.watch((event) => events.push(event));
      await session.send({
        inputIds: ['reasoning-input'], input: { text: 'Think through the report' },
        delivery: { kind: 'newTurn', turnId: 'reasoning-turn' },
      });
      emitNotification('item/reasoning/textDelta', {
        threadId: 'fresh-thread', turnId: 'provider-turn-1', itemId: 'analysis', delta: 'Draft analysis',
      });
      emitNotification('item/completed', {
        threadId: 'fresh-thread', turnId: 'provider-turn-1',
        item: { id: 'analysis', type: 'reasoning', text: 'Corrected analysis' },
      });
      emitNotification('turn/completed', {
        threadId: 'fresh-thread', turn: { id: 'provider-turn-1', status: 'completed' },
      });
      await expect.poll(() => events.some((event) => event.kind === 'turn-complete')).toBe(true);
      const delta = events.find((event) => event.kind === 'message-delta');
      expect(delta).toMatchObject({ kind: 'message-delta', channel: 'reasoning', text: 'Draft analysis', messageId: expect.any(String) });
      if (delta?.kind !== 'message-delta' || !delta.messageId) throw new Error('Missing reasoning message identity');
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'transcript-message-committed', role: 'reasoning', text: 'Corrected analysis',
        messageId: delta.messageId, turnId: 'reasoning-turn',
      }));
    });
  });

  it.each(['item/completed', 'rawResponseItem/completed'] as const)('correlates corrected assistant snapshots with their streamed message and exact host turn (%s)', async (finalMethod) => {
    await withFixture(async ({ runtime, emitNotification }) => {
      await startCodexAppServerRuntime(runtime);
      const session = createCodexNativeAppServerSessionRuntime(runtime, 'session-replacement');
      const events: AgentSessionRuntimeEvent[] = [];
      session.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));
      const messageIds: string[] = [];
      for (let turn = 1; turn <= 2; turn += 1) {
        const turnId = `host-turn-${turn}`;
        await session.send({
          inputIds: [`input-${turn}`], input: { text: 'Produce the final report' },
          delivery: { kind: 'newTurn', turnId },
        });
        emitNotification('item/agentMessage/delta', {
          threadId: 'fresh-thread', turnId: `provider-turn-${turn}`, itemId: 'report', delta: 'Draft report',
        });
        emitNotification(finalMethod, {
          threadId: 'fresh-thread', turnId: `provider-turn-${turn}`,
          item: finalMethod === 'item/completed'
            ? { id: 'report', type: 'agentMessage', text: 'Corrected report' }
            : { id: 'report', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Corrected report' }] },
        });
        emitNotification('item/agentMessage/delta', {
          threadId: 'fresh-thread', turnId: `provider-turn-${turn}`, itemId: 'acknowledgment', delta: 'Artifact delivered.',
        });
        emitNotification('item/completed', {
          threadId: 'fresh-thread', turnId: `provider-turn-${turn}`,
          item: { id: 'acknowledgment', type: 'agentMessage', text: 'Artifact delivered.' },
        });
        emitNotification('turn/completed', {
          threadId: 'fresh-thread', turn: { id: `provider-turn-${turn}`, status: 'completed' },
        });
        await expect.poll(() => events.some((event) => event.kind === 'turn-complete' && event.turnId === turnId)).toBe(true);
        const delta = events.find((event) => event.kind === 'message-delta' && event.turnId === turnId);
        expect(delta).toMatchObject({ kind: 'message-delta', channel: 'assistant', text: 'Draft report', messageId: expect.any(String) });
        if (delta?.kind !== 'message-delta' || !delta.messageId) throw new Error('Missing assistant message identity');
        messageIds.push(delta.messageId);
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'transcript-message-committed', role: 'assistant', text: 'Corrected report',
          messageId: delta.messageId, turnId,
        }));
        expect(events.filter((event) => event.turnId === turnId
          && (event.kind === 'message-delta' || event.kind === 'transcript-message-committed'))).toMatchObject([
          { kind: 'message-delta', text: 'Draft report' },
          { kind: 'transcript-message-committed', text: 'Corrected report' },
          { kind: 'message-delta', text: 'Artifact delivered.' },
        ]);
      }
      expect(messageIds[0]).not.toBe(messageIds[1]);
    });
  });

  it.skipIf(process.platform === 'win32')('publishes native App Server mode on an ordinary fresh open', async () => {
    await withFixture(async ({ openConfiguredSession }) => {
      const session = await openConfiguredSession();
      expect(RuntimeDescriptorV1Schema.parse(session.runtimeDescriptorV1)).toMatchObject({
        v: 1, agentId: 'codex', agent: { backendMode: 'appServer' },
      });
    });
  });
  it.each(['provider', 'connectedAccount'] as const)('opens a no-tools thread with %s auth despite an inherited MCP map', async (authority) => {
    const launches: Array<readonly string[]> = [];
    const authBytes = new TextEncoder().encode(JSON.stringify({
      auth_mode: 'chatgptAuthTokens', tokens: { access_token: 'fixture-access', account_id: 'fixture-account' },
    }));
    await withFixture(async ({ runtime, requests }) => {
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      expect(launches[0]).toEqual(expect.arrayContaining([
        'features.shell_tool=false', 'features.view_image=false', 'web_search="disabled"',
        'features.code_mode.excluded_tool_namespaces=["functions"]',
      ]));
      expect(launches[0].some(value => value.startsWith('mcp_servers.'))).toBe(false);
      const thread = requests.find(request => request.method === 'thread/start')?.params;
      expect([':read-only', 'read-only']).toContain(thread?.permissions ?? thread?.sandbox);
      if (authority === 'connectedAccount') {
        expect(requests.find(request => request.method === 'account/login/start')?.params)
          .toMatchObject({ type: 'chatgptAuthTokens', chatgptAccountId: 'fixture-account' });
      }
    }, {
      ...(authority === 'provider'
        ? { initialProviderBinding: { v: 1 as const, modelProvider: 'ollama', config: {} } }
        : { processEnv: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
          { kind: 'profile', serviceId: 'openai-codex', profileId: 'fixture' },
        ]) }, runtimeAuthHost: {
          nativeHome: { root: '/fixture', readFiles: async () => ({ 'auth.json': authBytes }) },
          refreshRuntimeAuth: async () => ({ status: 'refreshed' as const, result: {
            accessToken: 'fixture-access', providerAccountId: 'fixture-account',
          } }),
        } }),
      toolRestriction: { unlistedTools: 'deny', allowedTools: [] },
      mcpServers: { wilson: { command: 'fixture-bridge', enabledTools: ['allowed_echo'] } },
      // Native config and model catalog are independent process/network boundary evidence.
      nativeMcpServers: {}, nativeToolMode: 'direct',
      observer: { recordAppServerRequest() {}, recordLaunch: launch => { launches.push(launch.argv); } },
    });
  });
  it.skipIf(process.platform === 'win32')('keeps a Connected Account no-tools Run confined through follow-up turns', async () => {
    const authBytes = new TextEncoder().encode(JSON.stringify({
      auth_mode: 'chatgptAuthTokens', tokens: { access_token: 'fixture-access', account_id: 'fixture-account' },
    }));
    await withFixture(async ({ openConfiguredRun, requests, nativeLaunches, emitNotification }) => {
      const run = await openConfiguredRun();
      const events: AgentExecutionRunConversationEventV1[] = [];
      run.watch(event => events.push(event));
      for (const [index, text] of ['Plain discussion answer', '{"summary":"Structured follow-up"}'].entries()) {
        const turnId = `discussion-${index}`;
        await expect(run.send({ inputIds: [turnId], input: { text: 'Discuss this stop.' },
          delivery: { kind: 'newTurn', turnId } })).resolves.toMatchObject({ status: 'admitted' });
        emitNotification('item/completed', { threadId: 'fresh-thread', turnId: `provider-turn-${index + 1}`,
          item: { id: `answer-${index}`, type: 'agentMessage', text } });
        emitNotification('turn/completed', { threadId: 'fresh-thread',
          turn: { id: `provider-turn-${index + 1}`, status: 'completed' } });
        await expect.poll(() => events.some(event => event.kind === 'turn-complete' && event.turnId === turnId)).toBe(true);
        expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', turnId, text }));
      }
      expect(nativeLaunches[0]).toContain('features.shell_tool=false');
      expect(nativeLaunches[0].some(value => value.startsWith('mcp_servers.'))).toBe(false);
      expect(requests.find(request => request.method === 'account/login/start')?.params)
        .toMatchObject({ type: 'chatgptAuthTokens', chatgptAccountId: 'fixture-account' });
      expect(requests.filter(request => request.method === 'turn/start').map(request => request.params.threadId))
        .toEqual(['fresh-thread', 'fresh-thread']);
    }, {
      toolRestriction: { unlistedTools: 'deny', allowedTools: [] },
      mcpServers: { wilson: { command: 'fixture-bridge', enabledTools: ['allowed_echo'] } },
      nativeMcpServers: {}, nativeToolMode: 'direct',
      processEnv: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
        { kind: 'profile', serviceId: 'openai-codex', profileId: 'fixture' },
      ]) },
      runtimeAuthHost: {
        nativeHome: { root: '/fixture', readFiles: async () => ({ 'auth.json': authBytes }) },
        refreshRuntimeAuth: async () => ({ status: 'refreshed', result: {
          accessToken: 'fixture-access', providerAccountId: 'fixture-account',
        } }),
      },
    });
  });
  it('rejects an MCP server the native process exposes despite the no-tools recipe', async () => {
    await withFixture(async ({ runtime, requests }) => {
      await expect(runtime.prepareProviderCliAttach()).rejects.toMatchObject({
        code: 'codex_tool_restriction_unsupported_runtime',
      });
      expect(requests.some(request => request.method === 'thread/start')).toBe(false);
    }, {
      toolRestriction: { unlistedTools: 'deny', allowedTools: [] },
      mcpServers: { wilson: { command: 'fixture-bridge', enabledTools: ['allowed_echo'] } },
      nativeMcpServers: { happier__wilson: { enabled: true } },
    });
  });
  it.each([
    { initialProviderBinding: { v: 1 as const, modelProvider: 'ollama', config: {} } },
    { processEnv: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{ kind: 'profile', serviceId: 'openai-codex', profileId: 'fixture' }]) } },
  ])('refuses a model catalog from another provider or Connected Account authority before startup', async (externalAuthority) => {
    await withFixture(async ({ runtime, requests }) => {
      await expect(runtime.prepareProviderCliAttach()).rejects.toMatchObject({ code: 'codex_tool_restriction_unsupported_auth' });
      expect(requests.some(request => request.method === 'thread/start')).toBe(false);
    }, {
      ...externalAuthority,
      toolRestriction: { unlistedTools: 'deny', allowedTools: ['mcp__wilson__allowed_echo'] },
      mcpServers: { wilson: { command: 'fixture-bridge', enabledTools: ['allowed_echo'] } },
    });
  });
  it('refuses external account changes before native login can invalidate the tool-mode evidence', async () => {
    await withFixture(async ({ runtime, requests }) => {
      const credential = buildConnectedServiceCredentialRecord({
        now: 1000, serviceId: 'openai-codex', profileId: 'fixture', kind: 'oauth', expiresAt: 2000,
        oauth: { accessToken: 'fixture', refreshToken: 'fixture', idToken: 'fixture', scope: null, tokenType: null,
          providerAccountId: 'fixture', providerEmail: 'fixture@example.test' },
      });
      await expect(runtime.runtimeAuth.apply({ serviceId: 'openai-codex', authGeneration: { credential: StrictJsonValueSchema.parse(credential) } }))
        .rejects.toMatchObject({ code: 'codex_tool_restriction_unsupported_auth' });
      expect(requests.some(request => request.method === 'account/login/start')).toBe(false);
    }, {
      toolRestriction: { unlistedTools: 'deny', allowedTools: ['mcp__wilson__allowed_echo'] },
      mcpServers: { wilson: { command: 'fixture-bridge', enabledTools: ['allowed_echo'] } },
    });
  });
  it.skipIf(process.platform === 'win32')('preserves the safe typed tool-policy refusal through native startup sanitization', async () => {
    await withFixture(async ({ openConfiguredSession }) => {
      await expect(openConfiguredSession()).rejects.toMatchObject({
        code: 'codex_tool_restriction_unsupported_model',
        message: expect.stringContaining('codex_tool_restriction_unsupported_model'),
      });
    }, {
      nativeToolMode: 'direct',
      toolRestriction: { unlistedTools: 'deny', allowedTools: ['mcp__wilson__allowed_echo'] },
      mcpServers: { wilson: { command: 'fixture-bridge', enabledTools: ['allowed_echo'] } },
    });
  });
  it.skipIf(process.platform === 'win32')('rejects a direct-tool model update before applying it to a confined MCP session', async () => {
    await withFixture(async ({ runtime, requests }) => {
      await expect(runtime.updateConfig?.({ modelId: 'direct-model' })).rejects.toMatchObject({
        code: 'codex_tool_restriction_unsupported_model',
      });
      expect(requests.some(request => request.method === 'turn/start')).toBe(false);
    }, {
      toolRestriction: { unlistedTools: 'deny', allowedTools: ['mcp__wilson__allowed_echo'] },
      mcpServers: { wilson: { command: 'fixture-bridge', enabledTools: ['allowed_echo'] } },
    });
  });
  it.skipIf(process.platform === 'win32')('launches the shared native server with the frozen recipe and canonical filtered MCP catalog', async () => {
    await withFixture(async ({ openConfiguredSession, nativeLaunches }) => {
      await openConfiguredSession();
      expect(nativeLaunches[0]).toEqual(expect.arrayContaining([
        'features.shell_tool=false', 'features.view_image=false', 'web_search="disabled"',
        'mcp_servers.happier__wilson.enabled_tools=["allowed_echo"]',
        'mcp_servers.happier__wilson.default_tools_approval_mode="approve"',
      ]));
    }, {
      toolRestriction: { unlistedTools: 'deny', allowedTools: ['mcp__wilson__allowed_echo'] },
      mcpServers: { wilson: { command: 'fixture-bridge', enabledTools: ['allowed_echo'] } },
    });
  });
  it('retains confinement when a live configuration update requests unrestricted native permissions', async () => {
    await withFixture(async ({ runtime, requests }) => {
      await runtime.updateConfig?.({ permissionMode: 'yolo' });
      await runtime.prepareProviderCliAttach();
      const nativePolicy = requests.find((request) => request.method === 'thread/start')?.params;
      expect([':read-only', 'read-only']).toContain(nativePolicy?.permissions ?? nativePolicy?.sandbox);
      if (!nativePolicy?.permissions) expect(nativePolicy?.approvalPolicy).toBe('never');
    }, { toolRestriction: { unlistedTools: 'deny', allowedTools: [] } });
  });
  it.skipIf(process.platform === 'win32')('starts through native control with a long host temporary directory', async () => {
    await withFixture(async ({ openConfiguredSession }) => {
      const session = await openConfiguredSession();
      const presentation = await session.prepareTerminalPresentation?.();
      expect(presentation).toMatchObject({
        kind: 'provider_attach',
        metadata: { runtimeDescriptorV1: { agent: { providerSessionId: 'fresh-thread' } } },
      });
    }, { longTemporaryDirectory: true });
  });
  it.skipIf(process.platform === 'win32')('carries a safe typed startup rejection without provider text or tokens', async () => {
    await withFixture(async ({ openConfiguredSession, failResume }) => {
      failResume('provider refused startup: Bearer private-startup-token /private/config');
      const error = await openConfiguredSession('existing-thread').catch((failure: unknown) => failure);
      expect(error).toMatchObject({ name: 'CodexAppServerStartupError', code: 'agent_startup_rpc_rejected' });
      expect(String(error)).not.toContain('private-startup-token');
      expect(String(error)).not.toContain('/private/config');
      expect(JSON.stringify(error)).not.toContain('private-startup-token');
    });
  });
  it.each([
    ['no rollout found for thread id missing-thread', 'AGENT_RESUME_PROVIDER_STATE_MISSING'],
    ['provider temporarily unavailable', undefined],
  ])('classifies resume rejection %s without starting a replacement thread', async (message, code) => {
    await withFixture(async ({ runtime, requests, failResume }) => {
      failResume(message);
      const error = await startCodexAppServerRuntime(runtime, {
        resumeId: 'missing-thread', preserveRequestedThreadId: true,
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error & { code?: unknown }).code).toBe(code ?? -32000);
      expect(requests.filter((request) => request.method === 'thread/resume').map((request) => request.params.threadId))
        .toEqual(['missing-thread']);
      expect(requests.some((request) => request.method === 'thread/start')).toBe(false);
    });
  });
  it.skipIf(process.platform === 'win32')('preserves the typed missing-state reason through native session startup sanitization', async () => {
    const logs: unknown[] = [];
    await withFixture(async ({ openConfiguredSession, requests, failResume }) => {
      failResume('no rollout found for thread id missing-thread');
      const error = await openConfiguredSession('missing-thread').catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: 'AGENT_RESUME_PROVIDER_STATE_MISSING' });
      expect(logs).toContainEqual({ stage: 'native_session', errorName: 'Error', errorCode: 'AGENT_RESUME_PROVIDER_STATE_MISSING' });
      expect(requests.filter((request) => request.method === 'thread/resume').map((request) => request.params.threadId))
        .toEqual(['missing-thread']);
      expect(requests.some((request) => request.method === 'thread/start')).toBe(false);
    }, { logger: { debug: (_message, fields) => { logs.push(fields); }, warn() {} } });
  });
  it.skipIf(process.platform === 'win32')('applies initial canonical effort before startup instructions initialize the native attachment thread', async () => {
    await withFixture(async ({ openConfiguredSession, requests }) => {
      const session = await openConfiguredSession();
      await session.prepareTerminalPresentation?.();
      expect(requests.find((r) => r.method === 'thread/start')?.params).toMatchObject({
        model: 'fixture-model', permissions: ':read-only',
        config: { model_reasoning_effort: 'low' },
        developerInstructions: 'Actual startup instructions.',
      });
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
    });
  });
  it('materializes zero-turn fresh threads once and preserves identity and policy on repeat attach', async () => {
    await withFixture(async ({ runtime, requests, resume }) => {
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      expect(runtime.identity.read()).toEqual({ providerSessionId: 'fresh-thread' });
      await expect(resume()).resolves.toMatchObject({ thread: { id: 'fresh-thread', turns: [] }, sandbox: { type: 'readOnly' }, reasoningEffort: 'low' });
      await expect(resume()).resolves.toMatchObject({ thread: { id: 'fresh-thread', turns: [] } });
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'thread/name/set')).toEqual([{ method: 'thread/name/set', params: { threadId: 'fresh-thread', name: 'Happier session actual-happier-session' } }]);
      expect(requests.filter((r) => r.method === 'thread/read')).toEqual([{ method: 'thread/read', params: { threadId: 'fresh-thread', includeTurns: true } }]);
      expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
      expect(requests.find((r) => r.method === 'thread/start')?.params).toMatchObject({ permissions: ':read-only', config: { model_reasoning_effort: 'low' } });
      await runtime.updateConfig?.({ modelId: 'later-model' });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      await runtime.updateConfig?.({ permissionMode: 'acceptEdits' });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
    });
  });

  it('keeps an existing resumed thread name and does not initialize a new thread', async () => {
    await withFixture(async ({ runtime, requests }) => {
      await startCodexAppServerRuntime(runtime, { resumeId: 'existing-thread', importHistory: false });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('existing-thread');
      expect(requests.filter((r) => ['thread/start', 'thread/name/set', 'thread/read', 'turn/start'].includes(r.method))).toEqual([]);
    });
  });

  it('keeps a realtime zero-turn identity provisional until native rollout materialization', async () => {
    await withFixture(async ({ runtime, requests, resume }) => {
      await startCodexAppServerRuntime(runtime);
      const started = await runtime.realtimeConversation.start({ transport: { kind: 'webrtc', offerSdp: 'offer' } });
      expect(started.status).toBe('started');
      if (started.status !== 'started') throw new Error('Realtime fixture failed to start');
      expect(runtime.identity.read()).toEqual({ providerSessionId: null });
      await expect(resume()).rejects.toThrow('no rollout found');

      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      expect(runtime.identity.read()).toEqual({ providerSessionId: 'fresh-thread' });
      await expect(resume()).resolves.toMatchObject({ thread: { id: 'fresh-thread', turns: [] } });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      await expect(resume()).resolves.toMatchObject({ thread: { id: 'fresh-thread', turns: [] } });
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'thread/name/set')).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'thread/read')).toHaveLength(1);
      expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
      await started.handle.stop();
      await runtime.updateConfig?.({ modelId: 'later-model' });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'thread/read')).toHaveLength(1);
    });
  });

  it('withholds attachment identity if the fresh rollout cannot be materialized', async () => {
    await withFixture(async ({ runtime, failRead }) => {
      failRead();
      await expect(runtime.prepareProviderCliAttach()).rejects.toThrow('rollout persistence failed');
      expect(runtime.identity.read()).toEqual({ providerSessionId: null });
    });
  });
});
