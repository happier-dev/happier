import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

type MockUndiciRequestOptions = RequestInit & Readonly<{
  dispatcher?: unknown;
  headersTimeout?: number;
}>;

type MockUndiciResponse = Readonly<{
  statusCode: number;
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<Uint8Array> & Readonly<{
    destroy?: (error?: Error) => unknown;
  }>;
}>;

const undiciRequest = vi.hoisted(() => vi.fn(async (
  url: URL | RequestInfo,
  options?: MockUndiciRequestOptions,
): Promise<MockUndiciResponse> => {
  const response = await fetch(url, options);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    statusCode: response.status,
    headers,
    body: {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield bytes;
      },
    },
  };
}));

const undiciAgent = vi.hoisted(() => {
  const destroy = vi.fn(async () => undefined);
  const instances: Array<Readonly<{ destroy: typeof destroy }>> = [];
  const Agent = vi.fn(() => {
    const dispatcher = { destroy };
    instances.push(dispatcher);
    return dispatcher;
  });
  return { Agent, destroy, instances };
});

vi.mock('undici', () => ({ request: undiciRequest, Agent: undiciAgent.Agent }));

import {
  HappierActionError,
  HappierAgentUnavailableError,
  HappierClientClosedError,
  type HappierExecutionRunStream,
  HappierSessionInitialInputError,
  type HappierMachineClient,
  HappierSessionSpawnError,
  type HappierSessionSpawnInput,
  HappierTransportError,
  type HappierTranscriptItem,
  type PublicActionInputById,
  type PublicActionResultById,
  connect,
  isHappierActionApprovalRequestCreated,
} from './index.js';

const TEST_API_TOKEN = 'hap_v1_123e4567-e89b-42d3-a456-426614174000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TEST_ALT_API_TOKEN = 'hap_v1_223e4567-e89b-42d3-a456-426614174001_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function responseForRequest(init: RequestInit | undefined, body: Record<string, unknown>, status = 200): Response {
  const request = init?.body === undefined
    ? undefined
    : JSON.parse(String(init.body)) as Readonly<{ requestId?: unknown }>;
  return response({
    ...body,
    ...(typeof request?.requestId === 'string' ? { requestId: request.requestId } : {}),
  }, status);
}

function failingResponseBody(error: unknown, beforeThrow?: () => void): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      beforeThrow?.();
      throw error;
    },
  };
}

function isHappierSessionInitialInputError(
  error: unknown,
): error is HappierSessionInitialInputError {
  return error instanceof HappierSessionInitialInputError;
}

describe('Happier SDK client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    undiciRequest.mockClear();
    undiciAgent.Agent.mockClear();
    undiciAgent.destroy.mockReset();
    undiciAgent.destroy.mockResolvedValue(undefined);
    undiciAgent.instances.length = 0;
  });

  it('rejects padded or over-limit machine and Session identities without normalizing them', () => {
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });

    expect(() => client.machine(' machine-1 ')).toThrow(TypeError);
    expect(() => client.machine('m'.repeat(257))).toThrow(TypeError);
    expect(() => client.sessions.get(' session-1 ')).toThrow(TypeError);
    expect(() => client.sessions.get('s'.repeat(192))).toThrow(TypeError);
  });

  it('rejects padded API Tokens without normalizing credential bytes', () => {
    expect(() => connect({ endpoint: 'http://daemon', token: ' hap_v1_123e4567-e89b-42d3-a456-426614174000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ' })).toThrow(TypeError);
  });

  it('owns one dispatcher per root client, shares it with bound clients, and closes it once', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => response({
      v: 1,
      actionId: 'machines.list',
      execution: { ok: true, result: [] },
    }));
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const machine = client.machine('machine-1');
    await client.actions.execute('machines.list', {});
    await machine.actions.execute('machines.list', {});

    expect(undiciAgent.Agent).toHaveBeenCalledTimes(1);
    expect(undiciAgent.instances).toHaveLength(1);
    const dispatcher = undiciAgent.instances[0];
    expect(undiciRequest.mock.calls.map(([, options]) => options?.dispatcher)).toEqual([
      dispatcher,
      dispatcher,
    ]);

    const firstClose = client.close();
    const secondClose = machine.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;
    expect(undiciAgent.destroy).toHaveBeenCalledTimes(1);
  });

  it('finishes active transcript and execution-run cleanup before disposing its dispatcher', async () => {
    const order: string[] = [];
    undiciAgent.destroy.mockImplementation(async () => {
      order.push('dispatcher.destroy');
    });
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      order.push(actionId);
      if (actionId === 'execution.run.stream.start') {
        return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { streamId: 'stream-1' } } });
      }
      if (actionId === 'transcript.follow') {
        return response({
          v: 1,
          actionId,
          execution: { ok: true, result: { items: [{ role: 'assistant' }], nextCursor: '1', truncated: false } },
        });
      }
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { ok: true } } });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    await client.runs.startStream({ runId: 'run-1', message: 'Continue.' });
    const iterator = client.sessions.get('session-1').followTranscript()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { role: 'assistant' } });

    await client.close();

    const destroyIndex = order.indexOf('dispatcher.destroy');
    expect(order).toContain('execution.run.stream.cancel');
    expect(order).toContain('transcript.unfollow');
    expect(destroyIndex).toBeGreaterThan(order.indexOf('execution.run.stream.cancel'));
    expect(destroyIndex).toBeGreaterThan(order.indexOf('transcript.unfollow'));
  });

  it('does not start an unconsumed transcript lifecycle after its client closes', async () => {
    const actionIds: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL | RequestInfo) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      actionIds.push(actionId);
      return response({ v: 1, actionId, execution: { ok: true, result: { ok: true } } });
    }));

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const transcript = client.sessions.get('session-1').followTranscript();
    await client.close();

    await expect(transcript[Symbol.asyncIterator]().next()).resolves.toEqual({ done: true, value: undefined });
    expect(actionIds).toEqual([]);
  });

  it('executes one raw typed Action through the frozen HTTP envelope', async () => {
    const fetch = vi.fn(async () => response({
      v: 1,
      actionId: 'machines.list',
      execution: { ok: true, result: [{ id: 'machine-1' }] },
    }));
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://127.0.0.1:3000/', token: TEST_ALT_API_TOKEN });
    await expect(client.actions.execute('machines.list', {})).resolves.toEqual([{ id: 'machine-1' }]);

    expect(fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:3000/v1/actions/machines.list'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer ' + TEST_ALT_API_TOKEN }),
        body: JSON.stringify({ v: 1, input: {} }),
      }),
    );
  });

  it('rejects a response whose echoed request id does not match the request', async () => {
    const fetch = vi.fn(async () => response({
      v: 1,
      actionId: 'session.stop',
      requestId: 'different-request',
      execution: { ok: true, result: { stopped: true } },
    }));
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    await expect(client.actions.execute(
      'session.stop',
      { sessionId: 'session-1' },
      { requestId: 'request-1' },
    )).rejects.toMatchObject({
      name: 'HappierTransportError',
      message: 'The Happier Action API returned an invalid response envelope.',
    });
  });

  it('rejects a missing or unsolicited request-id echo', async () => {
    const responses = [
      {
        v: 1,
        actionId: 'session.stop',
        execution: { ok: true, result: { stopped: true } },
      },
      {
        v: 1,
        actionId: 'machines.list',
        requestId: 'unsolicited-request',
        execution: { ok: true, result: [] },
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => response(responses.shift())));

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    await expect(client.actions.execute(
      'session.stop',
      { sessionId: 'session-1' },
      { requestId: 'request-1' },
    )).rejects.toBeInstanceOf(HappierTransportError);
    await expect(client.actions.execute('machines.list', {})).rejects.toBeInstanceOf(HappierTransportError);
  });

  it('validates caller request ids through the Protocol request-id schema without rewriting them', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'session.stop',
      execution: { ok: true, result: { stopped: true } },
    }));
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });

    // The original value is sent unchanged, including Unicode.
    await expect(client.actions.execute(
      'session.stop',
      { sessionId: 'session-1' },
      { requestId: 'corrélation-☃' },
    )).resolves.toEqual({ stopped: true });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ requestId: 'corrélation-☃' });

    // The full 128-code-unit bound is admitted; 129 is a local TypeError.
    await expect(client.actions.execute(
      'session.stop',
      { sessionId: 'session-1' },
      { requestId: 'r'.repeat(128) },
    )).resolves.toEqual({ stopped: true });
    await expect(client.actions.execute(
      'session.stop',
      { sessionId: 'session-1' },
      { requestId: 'r'.repeat(129) },
    )).rejects.toThrow(new TypeError('requestId must be 1-128 code units with no outer whitespace'));

    // Outer whitespace is rejected, never trimmed into a different identity.
    await expect(client.actions.execute(
      'session.stop',
      { sessionId: 'session-1' },
      { requestId: ' padded ' },
    )).rejects.toBeInstanceOf(TypeError);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('still generates a UUID request id for a mutation when none is supplied', async () => {
    let requestId: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      requestId = JSON.parse(String(init?.body)).requestId;
      return responseForRequest(init, {
        v: 1,
        actionId: 'session.message.send',
        execution: { ok: true, result: { accepted: true } },
      });
    }));

    await connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
      .actions.execute('session.message.send', { sessionId: 'session-1', message: 'Continue.', localId: 'input-1' });

    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  });

  it('preserves the effective generated request id on Action errors', async () => {
    let requestId: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      requestId = JSON.parse(String(init?.body)).requestId;
      return response({
        v: 1,
        actionId: 'session.message.send',
        requestId,
        execution: { ok: false, errorCode: 'action_failed', error: 'Could not stop Session.' },
      });
    }));

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const error = await client.actions.execute('session.message.send', {
      sessionId: 'session-1',
      message: 'Continue.',
      localId: 'input-1',
    }).catch((cause) => cause);

    expect(requestId).toEqual(expect.any(String));
    expect(error).toMatchObject({
      name: 'HappierActionError',
      code: 'action_failed',
      requestId,
    });
  });

  it('preserves the effective generated request id on transport errors', async () => {
    let requestId: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      requestId = JSON.parse(String(init?.body)).requestId;
      return response({ error: 'invalid_token' }, 401);
    }));

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const error = await client.actions.execute('session.message.send', {
      sessionId: 'session-1',
      message: 'Continue.',
      localId: 'input-1',
    }).catch((cause) => cause);

    expect(requestId).toEqual(expect.any(String));
    expect(error).toMatchObject({
      name: 'HappierTransportError',
      code: 'invalid_token',
      status: 401,
      requestId,
    });
  });

  it('sends and waits through the correlated session Action', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'session.message.send',
      execution: { ok: true, result: { accepted: true } },
    }));
    vi.stubGlobal('fetch', fetch);

    await connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
      .machine('machine-7')
      .sessions
      .get('session-1')
      .sendAndWait(
        'Inspect the failure, then report back.',
        { localId: 'input-1', timeoutSeconds: 3600 },
        { requestId: 'request-1' },
      );

    expect(fetch).toHaveBeenCalledWith(
      new URL('http://daemon/v1/actions/session.message.send'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      v: 1,
      requestId: 'request-1',
      target: { kind: 'machine', machineId: 'machine-7' },
      input: {
        sessionId: 'session-1',
        message: 'Inspect the failure, then report back.',
        localId: 'input-1',
        timeoutSeconds: 3600,
        wait: true,
      },
    });
    expect(undiciRequest).toHaveBeenCalledWith(
      new URL('http://daemon/v1/actions/session.message.send'),
      expect.objectContaining({ headersTimeout: 0 }),
    );
  });

  it('defaults root fluent Session operations to their canonical Session target', async () => {
    const requests: Array<Readonly<{ actionId: string; body: Record<string, unknown> }>> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ actionId, body });
      return responseForRequest(init, {
        v: 1,
        actionId,
        execution: {
          ok: true,
          result: actionId === 'session.wait.idle'
            ? { idle: true }
            : actionId === 'session.transcript.get'
              ? { messages: [] }
              : { ok: true },
        },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const session = connect({ endpoint: 'https://api.example.test', token: TEST_API_TOKEN })
      .sessions.get('session-1');
    await session.send('Continue.');
    await session.sendAndWait('Continue and wait.');
    await session.waitForIdle();
    await session.history();
    await session.stop();

    expect(requests.map(({ actionId }) => actionId)).toEqual([
      'session.message.send',
      'session.message.send',
      'session.wait.idle',
      'session.transcript.get',
      'session.stop',
    ]);
    for (const { body } of requests) {
      expect(body.target).toEqual({ kind: 'session', sessionId: 'session-1' });
    }
  });

  it('lets an explicit root fluent Session target override Session routing metadata', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'session.message.send',
      execution: { ok: true, result: { ok: true } },
    }));
    vi.stubGlobal('fetch', fetch);

    await connect({ endpoint: 'https://api.example.test', token: TEST_API_TOKEN })
      .sessions.get('session-1')
      .send('Continue.', { target: { kind: 'machine', machineId: 'machine-7' } });

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      target: { kind: 'machine', machineId: 'machine-7' },
    });
  });

  it('seals every machine-bound raw Action to its selected machine', async () => {
    const requests: unknown[] = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      return response({
        v: 1,
        actionId: 'machines.list',
        execution: { ok: true, result: [{ id: 'machine-8' }] },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const machine = client.machine('machine-7');
    const otherMachine = { kind: 'machine', machineId: 'machine-8' } as const;

    if (false) {
      // @ts-expect-error A machine-bound Action cannot replace its selected target.
      machine.actions.execute('machines.list', {}, { target: otherMachine });
      // @ts-expect-error Generated Action methods share the machine-bound option contract.
      machine.actions.machines.list({}, { target: otherMachine });
      // @ts-expect-error Action discovery is also sealed when accessed from a machine client.
      machine.actions.search({ query: 'machine' }, { target: otherMachine });
      // @ts-expect-error Action-definition lookup is also sealed when accessed from a machine client.
      machine.actions.get({ id: 'session.status.get' }, { target: otherMachine });
      // @ts-expect-error Contributed Action invocation is also sealed when accessed from a machine client.
      machine.actions.invoke({ pluginId: 'acme.notes', localId: 'save' }, {}, { target: otherMachine });
    }

    await expect(machine.actions.execute('machines.list', {}, {
      // @ts-expect-error Runtime callers cannot redirect a machine-bound client either.
      target: otherMachine,
      requestId: 'conflicting-request',
    })).rejects.toMatchObject({
      code: 'machine_target_conflict',
      requestId: 'conflicting-request',
    });
    await expect(machine.actions.machines.list({}, {
      // @ts-expect-error Generated methods also reject an attempted runtime redirect.
      target: otherMachine,
    })).rejects.toMatchObject({ code: 'machine_target_conflict' });
    await expect(machine.actions.search({ query: 'machine' }, {
      // @ts-expect-error The search convenience method also rejects an attempted runtime redirect.
      target: otherMachine,
    })).rejects.toMatchObject({ code: 'machine_target_conflict' });
    await expect(machine.actions.get({ id: 'session.status.get' }, {
      // @ts-expect-error The definition convenience method also rejects an attempted runtime redirect.
      target: otherMachine,
    })).rejects.toMatchObject({ code: 'machine_target_conflict' });
    await expect(machine.actions.invoke({ pluginId: 'acme.notes', localId: 'save' }, {}, {
      // @ts-expect-error The invoke convenience method also rejects an attempted runtime redirect.
      target: otherMachine,
    })).rejects.toMatchObject({ code: 'machine_target_conflict' });
    expect(fetch).not.toHaveBeenCalled();

    await client.actions.execute('machines.list', {}, { target: otherMachine });
    expect(requests).toEqual([{
      v: 1,
      target: otherMachine,
      input: {},
    }]);
  });

  it('lists narrow machine bootstrap rows through the authenticated server route', async () => {
    const fetch = vi.fn(async () => response([{
      id: 'machine-1',
      active: true,
      revokedAt: null,
      replacedByMachineId: null,
    }]));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;

    const client = connect({ endpoint: 'https://api.example.test/root/', token: TEST_ALT_API_TOKEN });
    await expect(client.machines.list({ signal })).resolves.toEqual([{
      id: 'machine-1',
      active: true,
      revokedAt: null,
      replacedByMachineId: null,
    }]);
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://api.example.test/root/v1/machines'),
      expect.objectContaining({
        method: 'GET',
        headers: { authorization: 'Bearer ' + TEST_ALT_API_TOKEN },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('rejects legacy full machine rows at the external bootstrap boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([{
      id: 'machine-1',
      active: true,
      revokedAt: null,
      replacedByMachineId: null,
      metadata: '{"host":"workstation"}',
    }])));

    await expect(
      connect({ endpoint: 'https://api.example.test', token: TEST_API_TOKEN }).machines.list(),
    ).rejects.toBeInstanceOf(HappierTransportError);
  });

  it('makes generated methods zero-logic call-throughs and binds machine targets', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => response({
      v: 1,
      actionId: 'session.spawn_new',
      execution: { ok: true, result: { sessionId: 'session-1' } },
      requestId: JSON.parse(String(init?.body)).requestId,
    }));
    vi.stubGlobal('fetch', fetch);

    const machine = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).machine('machine-7');
    const spawnInput = {
      directory: '/repo',
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
    } as const;
    await machine.actions.session.spawnNew(spawnInput, { requestId: 'request-1' });

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      v: 1,
      requestId: 'request-1',
      target: { kind: 'machine', machineId: 'machine-7' },
      input: spawnInput,
    });
  });

  it('maps compact machine-bound session creation and accepts already-admitted input', async () => {
    const requests: Array<Readonly<{ actionId: string; body: unknown }>> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const body = JSON.parse(String(init?.body));
      requests.push({ actionId, body });
      if (actionId === 'agents.backends.list') {
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              items: [{
                targetKey: 'backend:happier.agent.codex',
                label: 'Codex',
                enabled: true,
                agentId: 'codex',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
              }],
            },
          },
        });
      }
      return responseForRequest(init, {
        v: 1,
        actionId,
        execution: {
          ok: true,
          result: {
            type: 'success',
            disposition: 'created',
            sessionId: 'session-1',
            executionTarget: { serverId: 'server-1', machineId: 'machine-7' },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'alreadyAccepted', localId: 'initial-input-1' },
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const machine = client.machine('machine-7');
    const otherMachine = { kind: 'machine', machineId: 'machine-8' } as const;
    expectTypeOf(machine).toEqualTypeOf<HappierMachineClient>();
    expectTypeOf<HappierSessionSpawnInput['modelSelection']>().toEqualTypeOf<
      PublicActionInputById['session.spawn_new']['modelSelection']
    >();
    expectTypeOf<HappierSessionSpawnInput['agentModeId']>().toEqualTypeOf<
      PublicActionInputById['session.spawn_new']['agentModeId']
    >();
    expectTypeOf<HappierSessionSpawnInput>().not.toHaveProperty('environmentVariables');
    expectTypeOf<HappierSessionSpawnInput['agent']>().toEqualTypeOf<string>();

    const input = {
      directory: '/repo',
      agent: 'codex',
      initialMessage: 'Inspect the failing tests.',
      agentModeId: 'review',
      title: 'External agent session',
    } as const satisfies HappierSessionSpawnInput;

    // @ts-expect-error The target is supplied only by machine(machineId).
    const targetConflict: HappierSessionSpawnInput = { ...input, executionTarget: { serverId: 'wrong', machineId: 'other' } };
    const agentTargetConflict: HappierSessionSpawnInput = {
      ...input,
      // @ts-expect-error Fluent input accepts one Agent routing id, never a raw target.
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
    };
    void targetConflict;
    void agentTargetConflict;

    if (false) {
      const rootSession = client.sessions.get('session-1');
      rootSession.send('Inspect the failing tests.', { target: otherMachine });
      client.sessions.spawn(input, { target: otherMachine });
      // @ts-expect-error A machine-bound Session spawn cannot replace its selected target.
      machine.sessions.spawn(input, { target: otherMachine });
      const machineSession = machine.sessions.get('session-1');
      // @ts-expect-error A machine-bound Session handle cannot replace its selected target.
      machineSession.send('Inspect the failing tests.', { target: otherMachine });
      // @ts-expect-error Every machine-bound Session handle call stays on its selected target.
      machineSession.waitForIdle({}, { target: otherMachine });
    }

    const session = await machine.sessions.spawn(input, { requestId: 'request-1' });
    expect(session.id).toBe('session-1');
    expect(requests).toEqual([
      {
        actionId: 'agents.backends.list',
        body: {
          v: 1,
          target: { kind: 'machine', machineId: 'machine-7' },
          input: { includeDisabled: true },
        },
      },
      {
        actionId: 'session.spawn_new',
        body: {
          v: 1,
          requestId: 'request-1',
          target: { kind: 'machine', machineId: 'machine-7' },
          input: {
            directory: '/repo',
            agentTarget: {
              kind: 'agent',
              identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            initialInput: { text: 'Inspect the failing tests.' },
            agentModeId: 'review',
            title: 'External agent session',
          },
        },
      },
    ]);

  });

  it('surfaces deferred Session-creation approval as a typed Action error', async () => {
    const approval = {
      kind: 'approval_request_created',
      artifactId: 'approval-1',
      actionId: 'session.spawn_new',
    } as const;
    const requests: Array<Readonly<{ actionId: string; requestId?: string }>> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const requestId = JSON.parse(String(init?.body)).requestId;
      requests.push({ actionId, ...(typeof requestId === 'string' ? { requestId } : {}) });
      if (actionId === 'agents.backends.list') {
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              items: [{
                targetKey: 'backend:happier.agent.codex',
                label: 'Codex',
                enabled: true,
                agentId: 'codex',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
              }],
            },
          },
        });
      }
      const actionApproval = { ...approval, actionId };
      return responseForRequest(init, {
        v: 1,
        actionId,
        execution: { ok: true, result: actionApproval },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const rawApproval = await client.actions.execute('session.stop', { sessionId: 'session-1' });
    expect(isHappierActionApprovalRequestCreated(rawApproval)).toBe(true);
    expect(rawApproval).toEqual({ ...approval, actionId: 'session.stop' });

    const failure = client
      .machine('machine-7')
      .sessions.spawn({ directory: '/repo', agent: 'codex' });

    await expect(failure).rejects.toBeInstanceOf(HappierActionError);
    await expect(failure).rejects.toMatchObject({
      code: 'approval_required',
      details: approval,
      requestId: expect.any(String),
    });
    await expect(failure).rejects.not.toBeInstanceOf(HappierSessionSpawnError);
    const rejection = await failure.catch((error) => error);
    expect(requests).toEqual([
      { actionId: 'session.stop' },
      { actionId: 'agents.backends.list' },
      { actionId: 'session.spawn_new', requestId: expect.any(String) },
    ]);
    expect(rejection.requestId).toBe(requests[2]?.requestId);
  });

  it.each([
    ['missing artifact identity', { kind: 'approval_request_created', actionId: 'session.stop' }],
    ['mismatched Action identity', { kind: 'approval_request_created', artifactId: 'approval-1', actionId: 'machines.list' }],
  ] as const)('rejects a malformed raw approval result with %s', async (_case, approval) => {
    vi.stubGlobal('fetch', vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'session.stop',
      execution: { ok: true, result: approval },
    })));

    await expect(
      connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
        .actions.execute('session.stop', { sessionId: 'session-1' }),
    ).rejects.toMatchObject({
      name: 'HappierTransportError',
      message: 'The Happier Action API returned an invalid approval result.',
    });
  });

  it('maps compact daemon-local session creation without a target', async () => {
    const requests: Array<Readonly<{ actionId: string; body: unknown }>> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const body = JSON.parse(String(init?.body));
      requests.push({ actionId, body });
      if (actionId === 'agents.backends.list') {
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              items: [{
                targetKey: 'backend:happier.agent.codex',
                label: 'Codex',
                enabled: true,
                agentId: 'codex',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
              }],
            },
          },
        });
      }
      return responseForRequest(init, {
        v: 1,
        actionId,
        execution: {
          ok: true,
          result: {
            type: 'success',
            disposition: 'created',
            sessionId: 'session-1',
            executionTarget: { serverId: 'server-1', machineId: 'machine-7' },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'accepted', localId: 'initial-input-1' },
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const session = await connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).sessions.spawn({
      directory: '/repo',
      agent: 'codex',
    }, { requestId: 'request-1' });

    expect(session.id).toBe('session-1');
    expect(requests).toEqual([
      {
        actionId: 'agents.backends.list',
        body: {
          v: 1,
          input: { includeDisabled: true },
        },
      },
      {
        actionId: 'session.spawn_new',
        body: {
          v: 1,
          requestId: 'request-1',
          input: {
            directory: '/repo',
            agentTarget: {
              kind: 'agent',
              identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
          },
        },
      },
    ]);
  });

  it('forwards an unbound fluent spawn target to inventory but keeps request identity on the mutation', async () => {
    const requests: Array<Readonly<{ actionId: string; body: unknown }>> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const body = JSON.parse(String(init?.body));
      requests.push({ actionId, body });
      if (actionId === 'agents.backends.list') {
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              items: [{
                targetKey: 'backend:happier.agent.codex',
                label: 'Codex',
                enabled: true,
                agentId: 'codex',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
              }],
            },
          },
        });
      }
      return responseForRequest(init, {
        v: 1,
        actionId,
        execution: {
          ok: true,
          result: {
            type: 'success',
            disposition: 'created',
            sessionId: 'session-1',
            executionTarget: { serverId: 'server-1', machineId: 'machine-7' },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'notRequested' },
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const target = { kind: 'machine', machineId: 'machine-7' } as const;
    await connect({ endpoint: 'https://api.example.test', token: TEST_API_TOKEN }).sessions.spawn({
      directory: '/repo',
      agent: 'codex',
    }, { target, requestId: 'spawn-request-1' });

    expect(requests).toEqual([
      {
        actionId: 'agents.backends.list',
        body: {
          v: 1,
          target,
          input: { includeDisabled: true },
        },
      },
      {
        actionId: 'session.spawn_new',
        body: {
          v: 1,
          requestId: 'spawn-request-1',
          target,
          input: {
            directory: '/repo',
            agentTarget: {
              kind: 'agent',
              identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
          },
        },
      },
    ]);
  });

  it('reports the exact unavailable Agent outcome before attempting a spawn', async () => {
    const cases = [
      {
        reason: 'not_installed' as const,
        items: [{
          targetKey: 'backend:happier.agent.claude',
          label: 'codex',
          enabled: true,
          agentId: 'claude',
          identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
        }],
      },
      {
        reason: 'disabled' as const,
        items: [{
          targetKey: 'backend:happier.agent.codex',
          label: 'Codex',
          enabled: false,
          agentId: 'codex',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        }],
      },
      {
        reason: 'identity_unavailable' as const,
        items: [{
          targetKey: 'acpBackend:codex',
          label: 'Codex',
          enabled: true,
          agentId: 'codex',
        }],
      },
    ];

    for (const testCase of cases) {
      const fetch = vi.fn(async (url: URL | RequestInfo, _init?: RequestInit) => response({
        v: 1,
        actionId: decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? ''),
        execution: { ok: true, result: { items: testCase.items } },
      }));
      vi.stubGlobal('fetch', fetch);

      const failure = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
        .machine('machine-7')
        .sessions.spawn({ directory: '/repo', agent: 'codex' });
      await expect(failure).rejects.toBeInstanceOf(HappierAgentUnavailableError);
      await expect(failure).rejects.toMatchObject({ agentId: 'codex', reason: testCase.reason });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
        v: 1,
        target: { kind: 'machine', machineId: 'machine-7' },
        input: { includeDisabled: true },
      });
    }
  });

  it.each([
    ['rejected', { status: 'rejected', code: 'session_input_target_update_required' }],
    ['outcome unknown', {
      status: 'outcomeUnknown',
      localId: 'initial-input-1',
      code: 'machine_admission_acknowledgement_failed',
    }],
    ['not requested', { status: 'notRequested' }],
  ] as const)(
    'preserves the committed Session when requested initial input is %s',
    async (_label, initialInput) => {
      const actionIds: string[] = [];
      const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
        const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
        actionIds.push(actionId);
        if (actionId === 'agents.backends.list') {
          return responseForRequest(init, {
            v: 1,
            actionId,
            execution: {
              ok: true,
              result: {
                items: [{
                  targetKey: 'backend:happier.agent.codex',
                  label: 'Codex',
                  enabled: true,
                  agentId: 'codex',
                  identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                }],
              },
            },
          });
        }
        if (actionId === 'session.spawn_new') {
          return responseForRequest(init, {
            v: 1,
            actionId,
            execution: {
              ok: true,
              result: {
                type: 'success',
                disposition: 'created',
                sessionId: 'session-1',
                executionTarget: { serverId: 'server-1', machineId: 'machine-7' },
                organizationPlacement: { folderId: null, tagIds: [] },
                initialInput,
              },
            },
          });
        }
        return responseForRequest(init, {
          v: 1,
          actionId,
          execution: { ok: true, result: { accepted: true } },
        });
      });
      vi.stubGlobal('fetch', fetch);

      const failure = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
        .machine('machine-7')
        .sessions.spawn({
          directory: '/repo',
          agent: 'codex',
          initialMessage: 'This must be admitted or reported.',
        });

      await expect(failure).rejects.toMatchObject({
        name: 'HappierSessionInitialInputError',
        session: { id: 'session-1' },
        result: {
          type: 'success',
          sessionId: 'session-1',
          initialInput,
        },
      });
      expect(actionIds).toEqual(['agents.backends.list', 'session.spawn_new']);

      let partial: unknown;
      await failure.catch((error: unknown) => {
        partial = error;
      });
      if (!isHappierSessionInitialInputError(partial)) {
        throw new Error('Expected a recoverable initial-input error.');
      }
      await partial.session.send('Recover through the committed Session handle.');
      expect(actionIds).toEqual([
        'agents.backends.list',
        'session.spawn_new',
        'session.message.send',
      ]);
    },
  );

  it('keeps initial-input partial success raw for callers that use the Action layer', async () => {
    const partialResult = {
      type: 'success',
      disposition: 'created',
      sessionId: 'session-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-7' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'rejected', code: 'session_input_target_update_required' },
    } as const;
    vi.stubGlobal('fetch', vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'session.spawn_new',
      execution: { ok: true, result: partialResult },
    })));

    const result = await connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
      .machine('machine-7')
      .actions.session.spawnNew({
        directory: '/repo',
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
      });
    expect(result).toEqual(partialResult);
  });

  it('forwards AbortSignal and close aborts pending work and rejects later calls', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const pending = client.actions.execute('machines.list', {});
    await client.close();

    await expect(pending).rejects.toBeInstanceOf(HappierClientClosedError);
    expect(requestSignal?.aborted).toBe(true);
    await expect(client.actions.execute('machines.list', {})).rejects.toBeInstanceOf(HappierClientClosedError);
  });

  it('preserves a caller abort that occurs while reading an HTTP response body', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped reading');
    undiciRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: failingResponseBody(reason, () => controller.abort(reason)),
    });

    const failure = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
      .actions.execute('machines.list', {}, { signal: controller.signal });

    await expect(failure).rejects.toBe(reason);
  });

  it('preserves client closure that occurs while reading an HTTP response body', async () => {
    let client: ReturnType<typeof connect>;
    undiciRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: failingResponseBody(new Error('response body was interrupted'), () => {
        void client.close();
      }),
    });
    client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });

    await expect(client.actions.execute('machines.list', {})).rejects.toBeInstanceOf(HappierClientClosedError);
  });

  it('normalizes an uninterrupted response-body failure as a transport error', async () => {
    const invalidJson = new SyntaxError('invalid JSON');
    undiciRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: failingResponseBody(invalidJson),
    });

    const failure = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).actions.execute('machines.list', {});

    await expect(failure).rejects.toMatchObject({
      name: 'HappierTransportError',
      message: 'The Happier API returned invalid JSON.',
      status: 200,
      cause: invalidJson,
    });
  });

  it('rejects a response whose declared body exceeds the Protocol external Action ceiling', async () => {
    const destroy = vi.fn();
    undiciRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: { 'content-length': '24000001' },
      body: {
        destroy,
        async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
          throw new Error('The SDK must reject the declared oversized body before consuming it.');
        },
      },
    });

    const failure = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
      .actions.execute('machines.list', {});

    await expect(failure).rejects.toMatchObject({
      name: 'HappierTransportError',
      code: 'response_too_large',
      status: 200,
      details: { maxSerializedBytes: 24_000_000 },
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('destroys a streamed response body as soon as it crosses the Protocol ceiling', async () => {
    const destroy = vi.fn();
    undiciRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: {
        destroy,
        async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
          yield new Uint8Array(24_000_000);
          yield new Uint8Array(1);
          throw new Error('The SDK must stop after the first byte over the limit.');
        },
      },
    });

    await expect(
      connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).actions.execute('machines.list', {}),
    ).rejects.toMatchObject({ code: 'response_too_large' });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('surfaces a non-JSON proxy outage without exposing its response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Server unavailable: retry later.', {
      status: 503,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-happier-retry-reason': 'server_unavailable',
      },
    })));

    const failure = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).actions.execute('machines.list', {});

    await expect(failure).rejects.toMatchObject({
      name: 'HappierTransportError',
      message: 'The Happier API is unavailable.',
      code: 'server_unavailable',
      status: 503,
      details: undefined,
    });
  });

  it('normalizes fetch disconnections as a typed transport failure', async () => {
    const disconnection = new TypeError('fetch failed');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw disconnection;
    }));

    const failure = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).actions.execute('machines.list', {});

    await expect(failure).rejects.toBeInstanceOf(HappierTransportError);
    await expect(failure).rejects.toMatchObject({
      name: 'HappierTransportError',
      cause: disconnection,
    });
  });

  it('preserves Action failures as typed SDK errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'account.apiTokens.create',
      execution: {
        ok: false,
        errorCode: 'present_user_required',
        error: 'A present user is required',
      },
    })));

    const client = connect({ endpoint: 'http://server', token: TEST_API_TOKEN });
    const failure = client.actions.execute('account.apiTokens.create', { label: 'automation' });
    await expect(failure).rejects.toMatchObject({
      code: 'present_user_required',
      message: 'A present user is required',
    });
  });

  it('exposes canonical Action discovery and contributed invocation as call-throughs', async () => {
    const requests: Array<Readonly<{ actionId: string; input: unknown; requestId?: string }>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const envelope = JSON.parse(String(init?.body));
      requests.push({
        actionId,
        input: envelope.input,
        ...(typeof envelope.requestId === 'string' ? { requestId: envelope.requestId } : {}),
      });
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: [] } });
    }));

    const actions = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).actions;
    await actions.search({ query: 'session' });
    await actions.invoke({ pluginId: 'acme.notes', localId: 'save' }, { note: 'Remember' });

    expect(requests).toEqual([
      { actionId: 'action.spec.search', input: { query: 'session' } },
      {
        actionId: 'action.invoke',
        input: { action: { pluginId: 'acme.notes', localId: 'save' }, input: { note: 'Remember' } },
        requestId: expect.any(String),
      },
    ]);
  });

  it('exposes canonical Action-definition lookup on root and machine-bound clients', async () => {
    const requests: Array<Readonly<{ actionId: string; body: Record<string, unknown> }>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ actionId, body });
      return response({ v: 1, actionId, execution: { ok: true, result: {} } });
    }));

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    await client.actions.get({ id: 'session.status.get' });
    await client.machine('machine-7').actions.get({ id: 'session.status.get' });

    expect(requests).toEqual([
      {
        actionId: 'action.spec.get',
        body: { v: 1, input: { id: 'session.status.get' } },
      },
      {
        actionId: 'action.spec.get',
        body: {
          v: 1,
          target: { kind: 'machine', machineId: 'machine-7' },
          input: { id: 'session.status.get' },
        },
      },
    ]);
  });

  it('invokes the canonical qualified contributed Action id returned by discovery', async () => {
    const requests: Array<Readonly<{ actionId: string; input: unknown }>> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const envelope = JSON.parse(String(init?.body));
      requests.push({ actionId, input: envelope.input });
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { status: 'executed', value: null } } });
    });
    vi.stubGlobal('fetch', fetch);

    const actions = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).actions;
    const invokeDiscoveredId = (discoveredId: PublicActionResultById[
        'action.spec.search'
      ]['actionSpecs'][number]['id']) => actions.invoke(discoveredId, {});
    void invokeDiscoveredId;
    await actions.invoke(
      'happier.channels/actions/provider/connections-list-v1',
      { accountId: 'account-1' },
    );

    expect(requests).toEqual([{
      actionId: 'action.invoke',
      input: {
        action: {
          pluginId: 'happier.channels',
          localId: 'provider/connections-list-v1',
        },
        input: { accountId: 'account-1' },
      },
    }]);

    expect(() => actions.invoke('happier.channels/provider/connections-list-v1', {})).toThrow(
      new TypeError('Contributed Action id must use the canonical <pluginId>/actions/<localId> spelling.'),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces HTTP authentication failures with their protocol code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'invalid_token' }, 401)));
    const failure = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).actions.execute('machines.list', {});
    await expect(failure).rejects.toBeInstanceOf(HappierTransportError);
    await expect(failure).rejects.toMatchObject({
      code: 'invalid_token',
      status: 401,
    });
  });

  it.each([
    ['invalid_action', 400],
    ['invalid_envelope', 400],
    ['request_too_large', 413],
  ] as const)('uses the protocol HTTP discriminator %s as the transport code', async (code, status) => {
    const details = { error: 'invalid_request' as const, code };
    vi.stubGlobal('fetch', vi.fn(async () => response(details, status)));

    const failure = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).actions.execute('machines.list', {});

    await expect(failure).rejects.toBeInstanceOf(HappierTransportError);
    await expect(failure).rejects.toMatchObject({
      code,
      status,
      details,
    });
  });

  it('does not fetch a second transcript page before the consumer asks for it', async () => {
    let followCalls = 0;
    let releaseSecondPage: ((value: Response) => void) | undefined;
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      if (actionId === 'transcript.follow') {
        followCalls += 1;
        if (followCalls === 1) {
          return response({
            v: 1,
            actionId,
            execution: {
              ok: true,
              result: {
                items: [{ role: 'assistant', text: 'first' }],
                nextCursor: '1',
                truncated: false,
              },
            },
          });
        }
        return await new Promise<Response>((resolve) => {
          releaseSecondPage = resolve;
        });
      }
      return responseForRequest(init, {
        v: 1,
        actionId,
        execution: { ok: true, result: { ok: true, released: true } },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const iterator = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
      .sessions.get('session-1').followTranscript()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { role: 'assistant', text: 'first' },
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(followCalls).toBe(1);

    const second = iterator.next();
    await vi.waitFor(() => expect(followCalls).toBe(2));
    releaseSecondPage?.(response({
      v: 1,
      actionId: 'transcript.follow',
      execution: {
        ok: true,
        result: {
          items: [{ role: 'assistant', text: 'second' }],
          nextCursor: '2',
          truncated: false,
        },
      },
    }));
    await expect(second).resolves.toEqual({
      done: false,
      value: { role: 'assistant', text: 'second' },
    });
    await iterator.return?.();
  });

  it('waits until every buffered transcript item is consumed before fetching another page', async () => {
    let followCalls = 0;
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      if (actionId === 'transcript.follow') {
        followCalls += 1;
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              items: followCalls === 1
                ? [
                    { role: 'assistant', text: 'first' },
                    { role: 'assistant', text: 'second' },
                    { role: 'assistant', text: 'third' },
                  ]
                : [{ role: 'assistant', text: 'fourth' }],
              nextCursor: String(followCalls),
              truncated: false,
            },
          },
        });
      }
      return responseForRequest(init, {
        v: 1,
        actionId,
        execution: { ok: true, result: { ok: true, released: true } },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const iterator = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
      .sessions.get('session-1').followTranscript()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { text: 'first' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { text: 'second' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { text: 'third' } });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(followCalls).toBe(1);

    const fourth = iterator.next();
    await vi.waitFor(() => expect(followCalls).toBe(2));
    await expect(fourth).resolves.toMatchObject({ value: { text: 'fourth' } });
    await iterator.return?.();
  });

  it('releases a transcript follow lease when an iterator is returned early', async () => {
    const requests: Array<Readonly<{ actionId: string; body: Record<string, unknown> }>> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      requests.push({ actionId, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (actionId === 'transcript.follow') {
        return response({
          v: 1,
          actionId,
          execution: { ok: true, result: { items: [{ role: 'assistant' }], nextCursor: '1', truncated: false } },
        });
      }
      return response({
        v: 1,
        actionId,
        execution: { ok: true, result: { ok: true, released: true } },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const transcript = client.sessions.get('session-1').followTranscript();
    expectTypeOf(transcript).toEqualTypeOf<AsyncIterable<HappierTranscriptItem>>();
    expectTypeOf(null as HappierTranscriptItem).toEqualTypeOf<
      PublicActionResultById['transcript.follow']['items'][number]
    >();
    const iterator = transcript[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { role: 'assistant' } });
    await iterator.return?.();

    expect(requests[0]?.actionId).toBe('transcript.follow');
    expect(requests.at(-1)?.actionId).toBe('transcript.unfollow');
    expect(requests.filter(({ actionId }) => actionId === 'transcript.unfollow')).toHaveLength(1);

    const closingClient = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const closingIterator = closingClient.sessions.get('session-2').followTranscript()[Symbol.asyncIterator]();
    await closingIterator.next();
    await closingClient.close();
    expect(requests.filter(({ actionId }) => actionId === 'transcript.unfollow')).toHaveLength(2);
    for (const { body } of requests) {
      expect(body.target).toEqual({ kind: 'session', sessionId: (body.input as { sessionId: string }).sessionId });
    }
  });

  it('reads a typed execution-run stream and cancels it when the stream ends', async () => {
    const requests: Array<Readonly<{ actionId: string; body: Record<string, unknown> }>> = [];
    let reads = 0;
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ actionId, body });
      if (actionId === 'execution.run.stream.start') {
        return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { streamId: 'stream-1' } } });
      }
      if (actionId === 'execution.run.stream.read') {
        reads += 1;
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: reads === 1
              ? { streamId: 'stream-1', events: [{ t: 'delta', textDelta: 'hello' }], nextCursor: 1, done: false }
              : { streamId: 'stream-1', events: [{ t: 'done', assistantText: 'hello' }], nextCursor: 2, done: true },
          },
        });
      }
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { ok: true } } });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'https://api.example.test', token: TEST_API_TOKEN });
    const stream = await client.runs.startStream({
      sessionId: 'session-1',
      runId: 'run-1',
      message: 'Continue.',
    });
    expectTypeOf(stream).toEqualTypeOf<HappierExecutionRunStream>();
    expect(stream).toMatchObject({ runId: 'run-1', streamId: 'stream-1' });

    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { t: 'delta', textDelta: 'hello' },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { t: 'done', assistantText: 'hello' },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });

    expect(requests.map(({ actionId }) => actionId)).toEqual([
      'execution.run.stream.start',
      'execution.run.stream.read',
      'execution.run.stream.read',
      'execution.run.stream.cancel',
    ]);
    for (const { body } of requests) {
      expect(body.target).toEqual({ kind: 'session', sessionId: 'session-1' });
    }
  });

  it('cancels an execution-run stream as soon as its terminal page is delivered', async () => {
    const actionIds: string[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      actionIds.push(actionId);
      if (actionId === 'execution.run.stream.start') {
        return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { streamId: 'stream-1' } } });
      }
      if (actionId === 'execution.run.stream.read') {
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              streamId: 'stream-1',
              events: [{ t: 'done', assistantText: 'complete' }],
              nextCursor: 1,
              done: true,
            },
          },
        });
      }
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { ok: true } } });
    });
    vi.stubGlobal('fetch', fetch);

    const stream = await connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).runs.startStream({
      runId: 'run-1',
      message: 'Continue.',
    });
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { t: 'done', assistantText: 'complete' },
    });

    await vi.waitFor(() => expect(actionIds).toEqual([
      'execution.run.stream.start',
      'execution.run.stream.read',
      'execution.run.stream.cancel',
    ]));
  });

  it('delivers a terminal execution-run event before surfacing its cleanup failure', async () => {
    const actionIds: string[] = [];
    const cancellationFailure = new TypeError('connection reset');
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      actionIds.push(actionId);
      if (actionId === 'execution.run.stream.start') {
        return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { streamId: 'stream-1' } } });
      }
      if (actionId === 'execution.run.stream.read') {
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              streamId: 'stream-1',
              events: [{ t: 'done', assistantText: 'complete' }],
              nextCursor: 1,
              done: true,
            },
          },
        });
      }
      throw cancellationFailure;
    });
    vi.stubGlobal('fetch', fetch);

    const stream = await connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).runs.startStream({
      runId: 'run-1',
      message: 'Continue.',
    });
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { t: 'done', assistantText: 'complete' },
    });
    await expect(iterator.next()).rejects.toMatchObject({
      name: 'HappierTransportError',
      cause: cancellationFailure,
    });
    expect(actionIds).toEqual([
      'execution.run.stream.start',
      'execution.run.stream.read',
      'execution.run.stream.cancel',
    ]);
  });

  it('cancels an execution-run stream when its iterator returns early', async () => {
    const actionIds: string[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      actionIds.push(actionId);
      if (actionId === 'execution.run.stream.start') {
        return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { streamId: 'stream-1' } } });
      }
      if (actionId === 'execution.run.stream.read') {
        return response({
          v: 1,
          actionId,
          execution: { ok: true, result: { streamId: 'stream-1', events: [{ t: 'delta', textDelta: 'hello' }], nextCursor: 1, done: false } },
        });
      }
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { ok: true } } });
    });
    vi.stubGlobal('fetch', fetch);

    const stream = await connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).runs.startStream({
      runId: 'run-1',
      message: 'Continue.',
    });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    expect(actionIds).toEqual([
      'execution.run.stream.start',
      'execution.run.stream.read',
      'execution.run.stream.cancel',
    ]);
  });

  it('cancels an execution-run stream when its caller aborts', async () => {
    const actionIds: string[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      actionIds.push(actionId);
      if (actionId === 'execution.run.stream.start') {
        return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { streamId: 'stream-1' } } });
      }
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { ok: true } } });
    });
    vi.stubGlobal('fetch', fetch);

    const controller = new AbortController();
    await connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).runs.startStream({
      runId: 'run-1',
      message: 'Continue.',
    }, { signal: controller.signal });
    controller.abort(new Error('caller stopped reading'));

    await vi.waitFor(() => expect(actionIds).toEqual([
      'execution.run.stream.start',
      'execution.run.stream.cancel',
    ]));
  });

  it('cancels an execution-run stream when its client closes', async () => {
    const actionIds: string[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      actionIds.push(actionId);
      if (actionId === 'execution.run.stream.start') {
        return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { streamId: 'stream-1' } } });
      }
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { ok: true } } });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    await client.runs.startStream({ runId: 'run-1', message: 'Continue.' });
    await client.close();

    expect(actionIds).toEqual([
      'execution.run.stream.start',
      'execution.run.stream.cancel',
    ]);
  });

  it('binds the complete transcript lifecycle for a spawned machine Session', async () => {
    const requests: Array<Readonly<{ actionId: string; body: Record<string, unknown> }>> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ actionId, body });

      if (actionId === 'agents.backends.list') {
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              items: [{
                targetKey: 'backend:happier.agent.codex',
                label: 'Codex',
                enabled: true,
                agentId: 'codex',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
              }],
            },
          },
        });
      }
      if (actionId === 'session.spawn_new') {
        return responseForRequest(init, {
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              type: 'success',
              disposition: 'created',
              sessionId: 'session-1',
              executionTarget: { serverId: 'server-1', machineId: 'machine-7' },
              organizationPlacement: { folderId: null, tagIds: [] },
              initialInput: { status: 'notRequested' },
            },
          },
        });
      }
      if (actionId === 'transcript.follow') {
        const input = body.input as Readonly<{ sessionId?: unknown }>;
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              items: input.sessionId === 'session-2' ? [{ role: 'assistant' }] : [],
              nextCursor: '1',
              truncated: false,
            },
          },
        });
      }
      if (actionId === 'session.status.get') {
        return response({
          v: 1,
          actionId,
          execution: { ok: true, result: { session: { active: false } } },
        });
      }
      return responseForRequest(init, {
        v: 1,
        actionId,
        execution: { ok: true, result: { ok: true, released: true } },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const session = await connect({ endpoint: 'https://api.example.test', token: TEST_API_TOKEN })
      .machine('machine-7')
      .sessions.spawn({ directory: '/repo', agent: 'codex' });
    const iterator = session.followTranscript()[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await iterator.return?.();

    const transcriptRequests = requests.filter(({ actionId }) => (
      actionId === 'transcript.follow'
      || actionId === 'session.status.get'
      || actionId === 'transcript.unfollow'
    ));
    expect(transcriptRequests.map(({ actionId }) => actionId)).toEqual([
      'transcript.follow',
      'session.status.get',
      'transcript.follow',
      'transcript.unfollow',
    ]);
    expect(transcriptRequests).toHaveLength(4);
    for (const { body } of transcriptRequests) {
      expect(body.target).toEqual({ kind: 'machine', machineId: 'machine-7' });
    }
    expect(transcriptRequests.filter(({ actionId }) => actionId === 'transcript.unfollow')).toHaveLength(1);

    const machine = connect({ endpoint: 'https://api.example.test', token: TEST_API_TOKEN }).machine('machine-7');
    const closingIterator = machine.sessions.get('session-2').followTranscript()[Symbol.asyncIterator]();
    await expect(closingIterator.next()).resolves.toEqual({ done: false, value: { role: 'assistant' } });
    await machine.close();
    expect(requests.filter(({ actionId }) => actionId === 'transcript.unfollow')).toHaveLength(2);

    const allTranscriptRequests = requests.filter(({ actionId }) => (
      actionId === 'transcript.follow'
      || actionId === 'session.status.get'
      || actionId === 'transcript.unfollow'
    ));
    for (const { body } of allTranscriptRequests) {
      expect(body.target).toEqual({ kind: 'machine', machineId: 'machine-7' });
    }
    expect(allTranscriptRequests.filter(({ actionId }) => actionId === 'transcript.unfollow')).toHaveLength(2);
  });
});
