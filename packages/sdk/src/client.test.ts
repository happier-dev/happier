import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  HappierAgentUnavailableError,
  HappierClientClosedError,
  HappierSessionInitialInputError,
  type HappierMachineClient,
  type HappierSessionSpawnInput,
  HappierTransportError,
  type HappierTranscriptItem,
  type PublicActionInputById,
  type PublicActionResultById,
  connect,
} from './index.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function isHappierSessionInitialInputError(
  error: unknown,
): error is HappierSessionInitialInputError {
  return error instanceof HappierSessionInitialInputError;
}

describe('Happier SDK client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('executes one raw typed Action through the frozen HTTP envelope', async () => {
    const fetch = vi.fn(async () => response({
      v: 1,
      actionId: 'machines.list',
      execution: { ok: true, result: [{ id: 'machine-1' }] },
    }));
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://127.0.0.1:3000/', token: 'pat_secret' });
    await expect(client.actions.execute('machines.list', {})).resolves.toEqual([{ id: 'machine-1' }]);

    expect(fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:3000/v1/actions/machines.list'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer pat_secret' }),
        body: JSON.stringify({ v: 1, input: {} }),
      }),
    );
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

    const client = connect({ endpoint: 'http://daemon', token: 'pat' });
    const machine = client.machine('machine-7');
    const otherMachine = { kind: 'machine', machineId: 'machine-8' } as const;

    if (false) {
      // @ts-expect-error A machine-bound Action cannot replace its selected target.
      machine.actions.execute('machines.list', {}, { target: otherMachine });
      // @ts-expect-error Generated Action methods share the machine-bound option contract.
      machine.actions.machines.list({}, { target: otherMachine });
      // @ts-expect-error Action discovery is also sealed when accessed from a machine client.
      machine.actions.search({ query: 'machine' }, { target: otherMachine });
      // @ts-expect-error Contributed Action invocation is also sealed when accessed from a machine client.
      machine.actions.invoke({ pluginId: 'acme.notes', localId: 'save' }, {}, { target: otherMachine });
    }

    await expect(machine.actions.execute('machines.list', {}, {
      // @ts-expect-error Runtime callers cannot redirect a machine-bound client either.
      target: otherMachine,
    })).rejects.toMatchObject({ code: 'machine_target_conflict' });
    await expect(machine.actions.machines.list({}, {
      // @ts-expect-error Generated methods also reject an attempted runtime redirect.
      target: otherMachine,
    })).rejects.toMatchObject({ code: 'machine_target_conflict' });
    await expect(machine.actions.search({ query: 'machine' }, {
      // @ts-expect-error The search convenience method also rejects an attempted runtime redirect.
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
      metadata: '{"host":"workstation"}',
      dataEncryptionKey: 'not-for-the-sdk-projection',
    }]));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;

    const client = connect({ endpoint: 'https://api.example.test/root/', token: 'pat_secret' });
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
        headers: { authorization: 'Bearer pat_secret' },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('makes generated methods zero-logic call-throughs and binds machine targets', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => response({
      v: 1,
      actionId: 'session.spawn_new',
      execution: { ok: true, result: { sessionId: 'session-1' } },
      requestId: JSON.parse(String(init?.body)).requestId,
    }));
    vi.stubGlobal('fetch', fetch);

    const machine = connect({ endpoint: 'http://daemon', token: 'pat' }).machine('machine-7');
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
      return response({
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

    const client = connect({ endpoint: 'http://daemon', token: 'pat' });
    const machine = client.machine('machine-7');
    expectTypeOf(machine).toEqualTypeOf<HappierMachineClient>();
    expectTypeOf<HappierSessionSpawnInput['modelSelection']>().toEqualTypeOf<
      PublicActionInputById['session.spawn_new']['modelSelection']
    >();
    expectTypeOf<HappierSessionSpawnInput['agentModeId']>().toEqualTypeOf<
      PublicActionInputById['session.spawn_new']['agentModeId']
    >();
    expectTypeOf<HappierSessionSpawnInput['environmentVariables']>().toEqualTypeOf<
      PublicActionInputById['session.spawn_new']['environmentVariables']
    >();
    expectTypeOf<HappierSessionSpawnInput['agent']>().toEqualTypeOf<string>();

    const input = {
      directory: '/repo',
      agent: 'codex',
      initialMessage: 'Inspect the failing tests.',
      agentModeId: 'review',
      environmentVariables: { CI: 'true' },
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
            initialMessage: 'Inspect the failing tests.',
            agentModeId: 'review',
            environmentVariables: { CI: 'true' },
            title: 'External agent session',
          },
        },
      },
    ]);

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
      return response({
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

    const session = await connect({ endpoint: 'http://daemon', token: 'pat' }).sessions.spawn({
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

      const failure = connect({ endpoint: 'http://daemon', token: 'pat' })
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
      const fetch = vi.fn(async (url: URL | RequestInfo) => {
        const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
        actionIds.push(actionId);
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
          return response({
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
        return response({
          v: 1,
          actionId,
          execution: { ok: true, result: { accepted: true } },
        });
      });
      vi.stubGlobal('fetch', fetch);

      const failure = connect({ endpoint: 'http://daemon', token: 'pat' })
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
    vi.stubGlobal('fetch', vi.fn(async () => response({
      v: 1,
      actionId: 'session.spawn_new',
      execution: { ok: true, result: partialResult },
    })));

    const result = await connect({ endpoint: 'http://daemon', token: 'pat' })
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

    const client = connect({ endpoint: 'http://daemon', token: 'pat' });
    const pending = client.actions.execute('machines.list', {});
    client.close();

    await expect(pending).rejects.toBeInstanceOf(HappierClientClosedError);
    expect(requestSignal?.aborted).toBe(true);
    await expect(client.actions.execute('machines.list', {})).rejects.toBeInstanceOf(HappierClientClosedError);
  });

  it('preserves Action failures as typed SDK errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      v: 1,
      actionId: 'account.apiTokens.create',
      execution: {
        ok: false,
        errorCode: 'present_user_required',
        error: 'A present user is required',
      },
    })));

    const client = connect({ endpoint: 'http://server', token: 'pat' });
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
      return response({ v: 1, actionId, execution: { ok: true, result: [] } });
    }));

    const actions = connect({ endpoint: 'http://daemon', token: 'pat' }).actions;
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

  it('surfaces HTTP authentication failures with their protocol code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'invalid_token' }, 401)));
    const failure = connect({ endpoint: 'http://daemon', token: 'bad' }).actions.execute('machines.list', {});
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

    const failure = connect({ endpoint: 'http://daemon', token: 'pat' }).actions.execute('machines.list', {});

    await expect(failure).rejects.toBeInstanceOf(HappierTransportError);
    await expect(failure).rejects.toMatchObject({
      code,
      status,
      details,
    });
  });

  it('releases a transcript follow lease when an iterator is returned early', async () => {
    const actionIds: string[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      actionIds.push(actionId);
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

    const client = connect({ endpoint: 'http://daemon', token: 'pat' });
    const transcript = client.sessions.followTranscript('session-1');
    expectTypeOf(transcript).toEqualTypeOf<AsyncIterable<HappierTranscriptItem>>();
    expectTypeOf(null as HappierTranscriptItem).toEqualTypeOf<
      PublicActionResultById['transcript.follow']['items'][number]
    >();
    const iterator = transcript[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { role: 'assistant' } });
    await iterator.return?.();

    expect(actionIds[0]).toBe('transcript.follow');
    expect(actionIds.at(-1)).toBe('transcript.unfollow');
    expect(actionIds.filter((actionId) => actionId === 'transcript.unfollow')).toHaveLength(1);

    const closingClient = connect({ endpoint: 'http://daemon', token: 'pat' });
    const closingIterator = closingClient.sessions.followTranscript('session-2')[Symbol.asyncIterator]();
    await closingIterator.next();
    closingClient.close();
    await vi.waitFor(() => {
      expect(actionIds.filter((actionId) => actionId === 'transcript.unfollow')).toHaveLength(2);
    });
  });
});
