import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import { ActionIdSchema, createActionExecutor } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';

const io = vi.hoisted(() => vi.fn());
// HTTP and Socket.IO are external boundaries; exact routing, codecs and RPC owners remain real.
vi.mock('socket.io-client', () => ({ io }));
import { createCliActionDeps } from './createCliActionDeps';

const responses: unknown[] = [];
const requests: { method: string; params: unknown }[] = [];
const replacementRows: { id: string; replacedByMachineId?: string }[] = [];
let releaseHome = () => {};
let observeRequest: (() => void) | undefined;

describe('CLI machine terminal Action', () => {
  beforeEach(() => {
    responses.length = 0;
    requests.length = 0;
    replacementRows.length = 0;
    observeRequest = undefined;
    releaseHome = publishServerHttpRuntimeOrigin('https://home.invalid', 'https');
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/machines') return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() }, data: replacementRows };
      if (!path.startsWith('/v1/machines/')) throw new Error(`Unexpected Home HTTP read: ${path}`);
      return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() },
        data: { machine: { id: decodeURIComponent(path.slice('/v1/machines/'.length)),
          storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } } };
    });
    bindApiSessionSocketMock(io, createApiSessionSocketStub({
      emitWithAck: async (event, payload) => {
        if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object'
          || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
          throw new Error('Unexpected Machine RPC boundary request');
        }
        requests.push({ method: payload.method, params: payload.params });
        observeRequest?.();
        if (!responses.length) throw new Error(`Unexpected Machine RPC: ${payload.method}`);
        const response = await responses.shift();
        if (response && typeof response === 'object' && 'ok' in response && response.ok === false
          && 'errorCode' in response) return response;
        return { ok: true, result: response };
      },
    }));
  });
  afterEach(() => { releaseHome(); vi.useRealTimers(); vi.restoreAllMocks(); });
  it.each([
    ['transport', { ok: false, errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE, error: 'unreachable' }, 'partial_failure', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE],
    ['old daemon', { ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Method not found' }, 'unsupported_daemon', undefined],
    ['invalid response', { ok: true }, 'partial_failure', 'invalid_response'],
  ] as const)('preserves the status-read failure for %s', async (_label, response, status, errorCode) => {
    const credentials = { token: 'token', encryption: null };
    const deps = createCliActionDeps({ token: credentials.token, credentials,
      sessionId: 'session', serverId: 'home', serverIdentityId: 'home-identity', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null });
    responses.push(response);
    expect(await deps.sessionRuntimeRefresh!({
      sessionId: 'session', machineId: 'worker', serverId: 'home',
      context: { surface: 'cli', authority: 'present_user', serverId: 'home' } }))
      .toMatchObject({ ok: false, status,
        ...(errorCode ? { diagnostics: { errorCode } } : { reasonCode: 'unsupported_daemon_version' }) });
    expect(requests.map(request => request.method)).toEqual([`worker:${RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET}`]);
  });
  it.each(['session', 'different-session', 'busy', 'activity_unavailable'])('preserves exact refresh acknowledgement and diagnostics (%s)', async scenario => {
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
      sessionId: 'session', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null }));
    const restartResult = scenario === 'busy'
      ? { ok: false, status: 'busy', sessionId: 'session', reasonCode: 'turn_in_progress',
        diagnostics: { busySource: 'foreground_turn', turnId: 'active-turn' } }
      : scenario === 'activity_unavailable'
        ? { ok: false, status: 'partial_failure', sessionId: 'session', diagnostics: { activityObservation: 'unavailable' } }
        : { ok: true, status: 'restarted', sessionId: scenario };
    responses.push({ v: 1, sessionId: 'session', machineId: 'worker', daemonId: 'daemon', observedAtMs: 1,
      runner: { pid: 123, runtimeId: 'old-runtime', cliVersion: '1', entrypointVersion: 'old',
        processCommandHash: 'old-command', entrypointSource: 'process_command', startedBy: 'daemon', startingMode: 'remote' },
      daemon: { cliVersion: '2', startedWithCliVersion: '2', currentEntrypointVersion: 'current-runtime', currentEntrypointSource: 'packaged_runtime' },
      versionState: 'stale', statusSource: 'daemon_tracking', plannedRestart: { supported: true, eligible: true, disabledReason: null },
    }, restartResult);
    expect(await executor.execute(ActionIdSchema.parse('session.runtime.refresh'), {
      sessionId: 'session', machineId: 'worker', serverId: 'home',
    }, { surface: 'cli', authority: 'present_user', serverId: 'home' }))
      .toEqual({ ok: true, result: scenario === 'different-session'
        ? { ok: false, status: 'partial_failure', sessionId: 'session', diagnostics: { errorCode: 'invalid_response' } }
        : restartResult });
    expect(requests).toEqual([
      { method: `worker:${RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET}`, params: { sessionId: 'session' } },
      { method: `worker:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`, params: {
        sessionId: 'session', mode: 'if_stale', reason: 'ui_stale_runner_banner', expectedRunnerPid: 123,
        expectedProcessCommandHash: 'old-command', expectedRunnerEntrypointIdentity: 'old-runtime',
      } },
    ]);
  });
  it('keeps retained observation, explicit Stop and output bytes on their original Machines after replacement', async () => {
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
      sessionId: 'session', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null }));
    replacementRows.push({ id: 'custodian', replacedByMachineId: 'replacement-custodian' },
      { id: 'replacement-custodian' }, { id: 'worker', replacedByMachineId: 'replacement-worker' }, { id: 'replacement-worker' });
    const unavailable = { ok: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
    const address = { serverId: 'home', machineId: 'custodian', operationId: 'operation' };
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home' } as const;
    responses.push(unavailable, { kind: 'not_found' });
    expect(await executor.execute('action.operations.get', address, context))
      .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
    expect(requests).toEqual([{ method: 'custodian:actionOperation.get.v2', params: { operationId: 'operation' } }]);
    responses.length = 0;
    requests.length = 0;
    responses.push(unavailable, { kind: 'requested' });
    expect(await executor.execute('action.operations.cancel', address, { ...context,
      presentUserConfirmation: { actionId: 'action.operations.cancel' },
    })).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
    expect(requests).toEqual([{ method: 'custodian:actionOperation.cancel.v1', params: { operationId: 'operation' } }]);
    responses.length = 0;
    requests.length = 0;
    responses.push(unavailable, { kind: 'not_found' });
    expect(await executor.execute('wait', { target: { kind: 'action_operation', ...address }, condition: { kind: 'terminal' } }, context))
      .toMatchObject({ ok: true, result: { disposition: 'outcome_uncertain', target: { kind: 'action_operation', ...address } } });
    expect(requests).toEqual([{ method: 'custodian:actionOperation.get.v2', params: { operationId: 'operation', waitForTerminal: true } }]);
    responses.length = 0;
    requests.length = 0;
    const snapshot = { version: 1, operationId: 'operation', revision: 2, actionId: 'projects.script.run', state: 'failed',
      scope: { accountId: 'account', machineId: 'custodian' }, title: 'Run', createdAt: 1, startedAt: 2, settledAt: 3,
      cancellation: 'supported', error: { errorCode: 'process_exited', error: 'Exit 1' },
      domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home', machineId: 'worker',
        workspaceRefId: 'workspace', cwd: '/project', terminalId: 'pty' } };
    responses.push({ kind: 'found', operation: snapshot }, unavailable, {
      ok: true, terminalId: 'pty', frames: [], nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true,
    });
    expect(await executor.execute('projects.execution.output.read', { ...address, byteOffset: 0 }, context))
      .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
    expect(requests).toEqual([
      { method: 'custodian:actionOperation.get.v2', params: { operationId: 'operation' } },
      { method: `worker:${RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES}`, params: { terminalId: 'pty', byteOffset: 0 } },
    ]);
    expect(axios.get).not.toHaveBeenCalledWith('https://home.invalid/v1/machines', expect.any(Object));
  });
  it('reads failed command output through the stored attachment and incumbent byte cursor', async () => {
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
      sessionId: 'session', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null }));
    const snapshot = { version: 1, operationId: 'operation', revision: 2, actionId: 'projects.script.run', state: 'failed',
      scope: { accountId: 'account', machineId: 'custodian' }, title: 'Run', createdAt: 1, startedAt: 2, settledAt: 3,
      cancellation: 'supported', error: { errorCode: 'process_exited', error: 'Exit 1' },
      domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home', machineId: 'worker',
        workspaceRefId: 'workspace', cwd: '/project', terminalId: 'pty' } };
    const output = { ok: true, terminalId: 'pty', frames: [
      { t: 'gap', terminalId: 'pty', droppedBeforeByteOffset: 4, nextAvailableByteOffset: 4, reason: 'ring_overflow' },
      { t: 'bytes', terminalId: 'pty', seq: 1, byteOffset: 4, byteLength: 3, encoding: 'base64', data: 'YWJj' },
    ], nextByteOffset: 7, availableByteOffset: 7, droppedBeforeByteOffset: 4, done: true };
    responses.push({ kind: 'found', operation: snapshot }, output);
    expect(await executor.execute('projects.execution.output.read', {
      serverId: 'home', machineId: 'custodian', operationId: 'operation', byteOffset: 0, maxBytes: 8,
    }, { surface: 'cli', serverId: 'home' })).toEqual({ ok: true, result: output });
    expect(requests).toEqual([
      { method: 'custodian:actionOperation.get.v2', params: { operationId: 'operation' } },
      { method: `worker:${RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES}`, params: { terminalId: 'pty', byteOffset: 0, maxBytes: 8 } },
    ]);
    requests.length = 0;
    responses.push({ kind: 'not_found' });
    expect(await executor.execute('projects.execution.output.read', {
      serverId: 'home', machineId: 'custodian', operationId: 'operation', byteOffset: 0,
    }, { surface: 'cli', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'operation_not_found' });
    expect(requests.map(request => request.method)).toEqual(['custodian:actionOperation.get.v2']);
  });
  it('runs code text references through the existing workspace search dependency and exact Machine transport', async () => {
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
      sessionId: 'session', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null }));
    responses.push({ status: 'unavailable', reason: 'no_capable_server' }, { ok: true, files: [{ path: 'src/a.ts', matches: [{ line: 2, column16: 1, length16: 6,
      text: 'needle()', before: [], after: [] }] }], hasMore: false, coverage: 'complete' });
    expect(await executor.execute('code.references.list', { machineId: 'machine', rootPath: '/project', path: 'src/a.ts', line: 2, symbol: 'needle' },
      { surface: 'cli', serverId: 'home' })).toMatchObject({ ok: true, result: { status: 'ok', source: 'text_matches',
        locations: [{ path: 'src/a.ts', range: { start: { line: 1, character: 0 } } }] } });
    expect(requests).toMatchObject([{ method: `machine:${RPC_METHODS.DAEMON_LSP_QUERY}`, params: {
      rootPath: '/project', path: 'src/a.ts', kind: 'references', position: { line: 1, symbol: 'needle' }, text: 'disk',
    } }, { method: `machine:${RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH}`, params: {
      rootPath: '/project', query: expect.stringContaining('needle'), regex: true, matchCase: true,
    } }]);
  });

  it('composes semantic disk queries and restart without confusing Home and language-server ids', async () => {
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
      sessionId: 'session', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null }));
    const answer = { status: 'ok', kind: 'hover', fileHash: 'a'.repeat(64), sections: [
      { serverId: 'typescript', label: 'TypeScript', markdown: 'const needle: number' },
    ] };
    responses.push(answer, { status: 'ok' }, { ok: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
      errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home' } as const;
    const input = { machineId: 'machine', rootPath: '/project', path: 'src/a.ts', line: 2, symbol: 'needle', occurrence: 2 };
    expect(await executor.execute('code.hover.get', input, context)).toEqual({ ok: true, result: answer });
    expect(await executor.execute('code.restart', { machineId: 'machine', rootPath: '/project', serverId: 'typescript' }, context))
      .toEqual({ ok: true, result: { status: 'ok' } });
    expect(await executor.execute('code.hover.get', input, context))
      .toEqual({ ok: true, result: { status: 'unavailable', reason: 'update_required' } });
    expect(requests).toEqual([
      { method: `machine:${RPC_METHODS.DAEMON_LSP_QUERY}`, params: { rootPath: '/project', path: 'src/a.ts',
        kind: 'hover', text: 'disk', position: { line: 1, symbol: 'needle', occurrence: 2 } } },
      { method: `machine:${RPC_METHODS.DAEMON_LSP_RESTART}`, params: { rootPath: '/project', serverId: 'typescript' } },
      { method: `machine:${RPC_METHODS.DAEMON_LSP_QUERY}`, params: { rootPath: '/project', path: 'src/a.ts',
        kind: 'hover', text: 'disk', position: { line: 1, symbol: 'needle', occurrence: 2 } } },
    ]);
  });

  it.each(['code.hover.get', 'code.restart'] as const)('keeps a slow %s reply cancellation-owned beyond the generic Machine deadline', async actionId => {
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
      sessionId: 'session', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null }));
    const answer = actionId === 'code.restart' ? { status: 'ok' } : { status: 'ok', kind: 'hover', fileHash: 'a'.repeat(64), sections: [] };
    let releaseReply!: () => void;
    const reply = new Promise<unknown>(resolve => { releaseReply = () => resolve(answer); });
    responses.push(reply);
    let sent = false;
    observeRequest = () => { sent = true; };
    const controller = new AbortController();
    const input = actionId === 'code.restart' ? { machineId: 'machine', rootPath: '/project' }
      : { machineId: 'machine', rootPath: '/project', path: 'a.ts', line: 1, character: 0 };
    vi.useFakeTimers();
    let settled = false;
    const pending = executor.execute(actionId, input, { surface: 'cli', authority: 'present_user', serverId: 'home', signal: controller.signal })
      .finally(() => { settled = true; });
    try {
      await vi.waitUntil(() => sent);
      await vi.advanceTimersByTimeAsync(20_001);
      expect(settled).toBe(false);
      releaseReply();
      expect(await pending).toEqual({ ok: true, result: answer });
      expect(controller.signal.aborted).toBe(false);
      sent = false;
      let releaseCancelledReply!: () => void;
      responses.push(new Promise<unknown>(resolve => { releaseCancelledReply = () => resolve(answer); }));
      const cancelController = new AbortController();
      const cancelled = executor.execute(actionId, input, { surface: 'cli', authority: 'present_user', serverId: 'home', signal: cancelController.signal });
      try {
        await vi.waitUntil(() => sent);
        cancelController.abort();
        expect(await cancelled).toMatchObject({ ok: false });
      } finally {
        releaseCancelledReply();
        cancelController.abort();
        await cancelled;
      }
    } finally {
      releaseReply();
      controller.abort();
      await pending;
    }
  });

  it('searches workspace content through the exact machine transport with cancellation', async () => {
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
      sessionId: 'session', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null }));
    const controller = new AbortController();
    const signal = controller.signal;
    const page = { ok: true, files: [], hasMore: false, coverage: 'complete' };
    responses.push(page);
    expect(await executor.execute('workspace.files.search', { machineId: 'machine', rootPath: '/project', query: 'needle' },
      { surface: 'cli', serverId: 'home', signal })).toEqual({ ok: true, result: page });
    expect(requests).toEqual([{ method: `machine:${RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH}`,
      params: { rootPath: '/project', query: 'needle' } }]);
    expect(axios.get).toHaveBeenLastCalledWith('https://home.invalid/v1/machines/machine', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    // The transport combines caller cancellation with its own lifetime and
    // retires that operation signal after consuming the successful response.
    expect(vi.mocked(axios.get).mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
    expect(signal.aborted).toBe(false);
    expect(await executor.execute('workspace.files.search', { machineId: 'machine', rootPath: '/project', query: 'needle' },
      { surface: 'cli', serverId: 'other' })).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(requests).toHaveLength(1);

    let observeRequest!: (signal: unknown) => void;
    const started = new Promise<unknown>(resolve => { observeRequest = resolve; });
    vi.mocked(axios.get).mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      const requestSignal = options?.signal;
      observeRequest(requestSignal);
      if (!(requestSignal instanceof AbortSignal)) {
        reject(new Error('Machine HTTP read has no cancellation signal'));
        return;
      }
      requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
    }));
    const pending = executor.execute('workspace.files.search', { machineId: 'machine', rootPath: '/project', query: 'needle' },
      { surface: 'cli', serverId: 'home', signal });
    try {
      const requestSignal = await started;
      expect(requestSignal).toMatchObject({ aborted: false });
      controller.abort();
      expect(requestSignal).toMatchObject({ aborted: true, reason: signal.reason });
      expect(await pending).toMatchObject({ ok: false });
      expect(requests).toHaveLength(1);
    } finally {
      controller.abort();
      await pending;
    }
  });
  it('lists through the authenticated exact-machine transport and rejects unavailable credentials', async () => {
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials, sessionId: 'session', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null }));
    responses.push({ ok: true, terminals: [] });
    expect(await executor.execute('machines.terminal.list', { serverId: 'home', machineId: 'machine' }, { surface: 'cli', authority: 'present_user', serverId: 'home' }))
      .toEqual({ ok: true, result: { ok: true, terminals: [] } });
    expect(requests).toEqual([{ method: `machine:${RPC_METHODS.DAEMON_TERMINAL_LIST}`, params: {} }]);
    const restricted = createActionExecutor(createCliActionDeps({ token: 'token', sessionId: 'session', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null }));
    expect(await restricted.execute('machines.terminal.list', { serverId: 'home', machineId: 'other' }, { surface: 'cli', authority: 'present_user', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'terminal_transport_unavailable' });
  });
  it('opens the canonical PTY and preserves the exact Home and request', async () => {
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
    const executor = createActionExecutor({ ...createCliActionDeps({ token: credentials.token, credentials,
      sessionId: 'session', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null }) });
    responses.push({ ok: true, terminalId: 'pty', reused: true });
    expect(await executor.execute('machines.terminal.open', { serverId: 'home', machineId: 'machine', terminalKey: 'shell', cwd: '/project' }, {
      surface: 'cli', authority: 'present_user', serverId: 'home', presentUserConfirmation: { actionId: 'machines.terminal.open' },
    })).toEqual({ ok: true, result: { ok: true, terminalId: 'pty', reused: true } });
    expect(requests).toEqual([{ method: `machine:${RPC_METHODS.DAEMON_TERMINAL_ENSURE}`, params: { terminalKey: 'shell', cwd: '/project' } }]);
    expect(axios.get).toHaveBeenCalledWith('https://home.invalid/v1/machines/machine', expect.any(Object));
  });
  it('refuses another unauthenticated machine instead of borrowing a direct transport', async () => {
    const invoke = vi.fn(async () => ({ ok: true, terminalId: 'pty', reused: false }));
    const executor = createActionExecutor({ ...createCliActionDeps({ token: 'token', sessionId: 'session', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'exact', invoke } }) });
    expect(await executor.execute('machines.terminal.open', { serverId: 'home', machineId: 'other', terminalKey: 'shell' }, { surface: 'cli', serverId: 'home', authority: 'present_user', presentUserConfirmation: { actionId: 'machines.terminal.open' } }))
      .toMatchObject({ ok: false, errorCode: 'terminal_transport_unavailable' });
    expect(invoke).not.toHaveBeenCalled();
  });
});
