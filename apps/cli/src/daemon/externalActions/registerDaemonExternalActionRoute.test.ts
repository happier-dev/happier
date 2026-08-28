import { Buffer } from 'node:buffer';

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const protocolSerializerSpy = vi.hoisted(() => vi.fn());

vi.mock('@happier-dev/protocol/actions', async (importOriginal) => {
  const protocol = await importOriginal<typeof import('@happier-dev/protocol/actions')>();
  return {
    ...protocol,
    serializeExternalActionResponseEnvelopeV1: (value: unknown) => {
      protocolSerializerSpy(value);
      return protocol.serializeExternalActionResponseEnvelopeV1(value);
    },
  };
});

import {
  EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  measureExternalActionResponseEnvelopeUtf8BytesV1,
  type ActionExecuteResult,
} from '@happier-dev/protocol/actions';

import { handleActionsCommand } from '@/cli/commands/actions';
import {
  createPluginInvocationActionsService,
} from '@/plugins/runtime/invocation/services/actions';
import {
  createPluginActionCallerMaterializationFixture,
} from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import type { DaemonPatVerifier } from '../auth/daemonPatVerifier';
import type { ExternalActionExecutor, ResolveExternalActionTarget } from './executeExternalAction';
import { registerDaemonExternalActionRoute } from './registerDaemonExternalActionRoute';

type CanonicalActionExecutor = Pick<
  ReturnType<typeof import('@happier-dev/protocol/actions').createActionExecutor>,
  'execute'
>;

function verifier(): DaemonPatVerifier {
  return vi.fn(async () => ({
    ok: true as const,
    accountId: 'account-1',
    principalId: 'principal-1',
    credentialId: 'credential-1',
    expiresAt: null,
    authority: 'account_automation' as const,
  }));
}

function executor(result: ActionExecuteResult = { ok: true, result: { sessionId: 'session-1' } }): ExternalActionExecutor {
  return { execute: vi.fn(async () => result) };
}

function resolveTarget(): ResolveExternalActionTarget {
  return vi.fn(async ({ target, currentMachineId }) => target ?? {
    kind: 'machine' as const,
    machineId: currentMachineId,
  });
}

function createDeepExternalActionResult(depth = 12_000): unknown {
  let result: unknown = 'leaf';
  for (let index = 0; index < depth; index += 1) {
    result = { value: result };
  }
  return result;
}

function createExactLimitMultibyteResponseResult(): string {
  const emptyResponse = {
    v: 1,
    actionId: 'session.spawn_new',
    requestId: 'response-limit',
    execution: { ok: true, result: '' },
  } as const;
  const fixedBytes = measureExternalActionResponseEnvelopeUtf8BytesV1(emptyResponse);
  const multibyteMarker = 'é';
  const markerBytes = Buffer.byteLength(multibyteMarker, 'utf8');
  return 'a'.repeat(
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - fixedBytes - markerBytes,
  ) + multibyteMarker;
}

function externalActionJsonPayloadWithByteLength(byteLength: number): string {
  const prefix = '{"v":1,"input":{"blob":"';
  const suffix = '"}}';
  const multiByteCharacter = 'é';
  const paddingLength = byteLength - Buffer.byteLength(`${prefix}${multiByteCharacter}${suffix}`, 'utf8');
  if (paddingLength < 0) throw new Error('Requested payload is too small');

  const payload = `${prefix}${'x'.repeat(paddingLength)}${multiByteCharacter}${suffix}`;
  if (Buffer.byteLength(payload, 'utf8') !== byteLength) {
    throw new Error('External Action payload did not reach the requested byte length');
  }
  return payload;
}

async function createApp(overrides: Partial<Parameters<typeof registerDaemonExternalActionRoute>[1]> = {}) {
  const app = fastify({ bodyLimit: 8 * 1024 * 1024 });
  registerDaemonExternalActionRoute(app, {
    currentMachineId: 'machine-local',
    currentServerId: 'server-local',
    verifyPat: verifier(),
    executor: executor(),
    resolveTarget: resolveTarget(),
    ...overrides,
  });
  await app.ready();
  return app;
}

describe('registerDaemonExternalActionRoute', () => {
  it('sends the ingress owner\'s prepared response without serializing it again', async () => {
    protocolSerializerSpy.mockClear();
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/actions/session.spawn_new',
        headers: { authorization: 'Bearer pat-secret' },
        payload: { v: 1, input: {} },
      });

      expect(response.statusCode).toBe(200);
      expect(protocolSerializerSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('accepts only a verified PAT, stamps its provenance through the canonical executor, and sends a finite no-store response', async () => {
    const verifyPat = verifier();
    const execute = vi.fn(async () => ({ ok: true as const, result: { sessionId: 'session-1' } }));
    const target = resolveTarget();
    const app = await createApp({
      verifyPat,
      executor: { execute },
      resolveTarget: target,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/actions/session.spawn_new',
        headers: { authorization: 'Bearer pat-secret' },
        payload: {
          v: 1,
          requestId: 'request-1',
          input: { directory: '/workspace', prompt: 'hello' },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Number(response.headers['content-length'])).toBe(Buffer.byteLength(response.body, 'utf8'));
      expect(response.json()).toEqual({
        v: 1,
        actionId: 'session.spawn_new',
        requestId: 'request-1',
        execution: { ok: true, result: { sessionId: 'session-1' } },
      });
      expect(verifyPat).toHaveBeenCalledWith('pat-secret', expect.any(AbortSignal));
      expect(verifyPat).toHaveBeenCalledTimes(1);
      expect(target).toHaveBeenCalledWith(expect.objectContaining({
        actionId: 'session.spawn_new',
        currentMachineId: 'machine-local',
      }));
      expect(execute).toHaveBeenCalledWith(
        'session.spawn_new',
        { directory: '/workspace', prompt: 'hello' },
        expect.objectContaining({
          surface: 'api',
          authority: 'account_automation',
          actionCaller: { kind: 'host' },
          serverId: 'server-local',
          actionRequestId: 'request-1',
          externalActionCredential: {
            accountId: 'account-1',
            principalId: 'principal-1',
            credentialId: 'credential-1',
          },
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('routes the CLI, plugin ActionsService, and HTTP ingress through one injected canonical executor', async () => {
    const result = { v: 1 as const, ok: true as const, hits: [] };
    const execute = vi.fn<CanonicalActionExecutor['execute']>(async () => ({
      ok: true,
      result,
    }));
    const canonicalExecutor: CanonicalActionExecutor = { execute };
    const actionInput = {
      machineId: 'machine-local',
      query: {
        v: 1 as const,
        query: 'executor convergence',
        scope: { type: 'global' as const },
        mode: 'hints' as const,
      },
    };

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((
      _chunk: unknown,
      ...args: unknown[]
    ) => {
      const callback = args.find((value): value is () => void => typeof value === 'function');
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    try {
      await handleActionsCommand([
        'invoke',
        'memory.search',
        '--input-json',
        JSON.stringify(actionInput),
        '--json',
      ], {
        readCredentialsFn: async () => ({
          token: 'pat-secret',
          encryption: null,
          credentialProvenance: 'api_token',
        }),
        createExecutorFn: () => canonicalExecutor,
      });
    } finally {
      stdout.mockRestore();
    }

    const materialization = createPluginActionCallerMaterializationFixture('acme.convergence');
    const pluginActions = createPluginInvocationActionsService({
      seed: {
        plugin: { id: 'acme.convergence', version: '1.0.0' },
        resolveCurrentPluginMaterializationRef: materialization.resolveCurrentPluginMaterializationRef,
        generation: 'generation-1',
        surface: 'background',
        signal: new AbortController().signal,
        isGenerationCurrent: () => true,
      },
      actionExecutor: canonicalExecutor,
      invokeContributedAction: vi.fn(),
    });
    await pluginActions.execute('memory.search', actionInput);

    const app = await createApp({ executor: canonicalExecutor });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/actions/memory.search',
        headers: { authorization: 'Bearer pat-secret' },
        payload: { v: 1, input: actionInput },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        actionId: 'memory.search',
        execution: { ok: true, result },
      });
    } finally {
      await app.close();
    }

    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls.map(([actionId, input, context]) => ({
      actionId,
      input,
      surface: context?.surface,
      authority: context?.authority,
      caller: context?.actionCaller,
    }))).toEqual([
      {
        actionId: 'memory.search',
        input: actionInput,
        surface: 'api',
        authority: undefined,
        caller: undefined,
      },
      {
        actionId: 'memory.search',
        input: actionInput,
        surface: 'plugin',
        authority: 'account_automation',
        caller: expect.objectContaining({ kind: 'plugin', pluginId: 'acme.convergence' }),
      },
      {
        actionId: 'memory.search',
        input: actionInput,
        surface: 'api',
        authority: 'account_automation',
        caller: { kind: 'host' },
      },
    ]);
  });

  it('returns typed invalid_action_output rather than a recursive JSON response failure', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, result: createDeepExternalActionResult() })
      .mockResolvedValueOnce({ ok: true as const, result: { carrier: 'usable' } });
    const app = await createApp({ executor: { execute } });
    try {
      const deepResponse = await app.inject({
        method: 'POST',
        url: '/v1/actions/session.spawn_new',
        headers: { authorization: 'Bearer pat-secret' },
        payload: { v: 1, input: {} },
      });

      expect(deepResponse.statusCode).toBe(200);
      expect(deepResponse.json()).toMatchObject({
        v: 1,
        actionId: 'session.spawn_new',
        execution: {
          ok: false,
          errorCode: 'invalid_action_output',
          error: 'invalid_action_output',
        },
      });

      const nextResponse = await app.inject({
        method: 'POST',
        url: '/v1/actions/session.spawn_new',
        headers: { authorization: 'Bearer pat-secret' },
        payload: { v: 1, input: {} },
      });
      expect(nextResponse.statusCode).toBe(200);
      expect(nextResponse.json()).toMatchObject({
        execution: { ok: true, result: { carrier: 'usable' } },
      });
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('serializes exact response bytes, projects one extra byte, and stays usable through the Fastify adapter', async () => {
    const exactLimitResult = createExactLimitMultibyteResponseResult();
    const execute = vi.fn<ExternalActionExecutor['execute']>()
      .mockResolvedValueOnce({ ok: true, result: exactLimitResult })
      .mockResolvedValueOnce({ ok: true, result: `${exactLimitResult}a` })
      .mockResolvedValueOnce({ ok: true, result: { carrier: 'usable' } });
    const app = await createApp({ executor: { execute } });
    const request = {
      method: 'POST' as const,
      url: '/v1/actions/session.spawn_new',
      headers: { authorization: 'Bearer pat-secret' },
      payload: { v: 1, requestId: 'response-limit', input: {} },
    };
    try {
      const exact = await app.inject(request);
      expect(exact.statusCode).toBe(200);
      expect(exact.headers['cache-control']).toBe('no-store');
      expect(Number(exact.headers['content-length'])).toBe(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
      expect(Buffer.byteLength(exact.body, 'utf8')).toBe(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
      expect(exact.json()).toMatchObject({
        execution: { ok: true, result: exactLimitResult },
      });

      const oversized = await app.inject(request);
      expect(oversized.statusCode).toBe(200);
      expect(oversized.json()).toMatchObject({
        execution: {
          ok: false,
          errorCode: 'result_too_large',
          details: {
            executionCompleted: true,
            maxSerializedBytes: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
          },
        },
      });

      const followUp = await app.inject(request);
      expect(followUp.statusCode).toBe(200);
      expect(followUp.json()).toMatchObject({
        execution: { ok: true, result: { carrier: 'usable' } },
      });
      expect(execute).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });

  it('rejects missing and invalid PAT credentials before the JSON parser or Action executor', async () => {
    const verifyPat = vi.fn<DaemonPatVerifier>(async () => ({
      ok: false as const,
      code: 'invalid_token' as const,
    }));
    const execute = vi.fn();
    const parse = vi.fn();
    const app = fastify({ bodyLimit: 8 * 1024 * 1024 });
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
      parse();
      done(null, { received: body });
    });
    registerDaemonExternalActionRoute(app, {
      currentMachineId: 'machine-local',
      currentServerId: 'server-local',
      verifyPat,
      executor: { execute },
      resolveTarget: resolveTarget(),
    });
    await app.ready();

    try {
      for (const headers of [
        {},
        { authorization: 'Bearer not-a-valid-token' },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/actions/session.spawn_new',
          headers: {
            ...headers,
            'content-type': 'application/json',
          },
          payload: '{not-json',
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: 'invalid_token' });
      }

      expect(verifyPat).toHaveBeenCalledTimes(1);
      expect(parse).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not accept the daemon control token or disclose bearer failures', async () => {
    const verifyPat = verifier();
    const app = await createApp({ verifyPat });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/actions/session.spawn_new',
        headers: { 'x-happier-daemon-token': 'internal-control-token' },
        payload: { v: 1, input: {} },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'invalid_token' });
      expect(verifyPat).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects malformed caller-owned envelope fields before executing an Action', async () => {
    const execute = vi.fn();
    const app = await createApp({ executor: { execute } });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/actions/session.spawn_new',
        headers: { authorization: 'Bearer pat-secret' },
        payload: { v: 1, input: {}, authority: 'present_user' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_request', code: 'invalid_envelope' });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a custom-parser non-finite input before daemon-local execution', async () => {
    const execute = vi.fn();
    const app = fastify({ bodyLimit: 8 * 1024 * 1024 });
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, _body, done) => {
      done(null, { v: 1, input: Number.NaN });
    });
    registerDaemonExternalActionRoute(app, {
      currentMachineId: 'machine-local',
      currentServerId: 'server-local',
      verifyPat: verifier(),
      executor: { execute },
      resolveTarget: resolveTarget(),
    });
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/actions/session.spawn_new',
        headers: { authorization: 'Bearer pat-secret' },
        payload: '{}',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_request', code: 'invalid_envelope' });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    ['malformed JSON', '{"v":', 'application/json'],
    ['empty JSON', '', 'application/json'],
    ['unsupported media type', '{"v":1,"input":{}}', 'application/x-happier-external-action'],
  ])('maps %s parser failures to invalid_envelope without executing an Action', async (_label, payload, contentType) => {
    const execute = vi.fn();
    const app = await createApp({ executor: { execute } });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/actions/session.spawn_new',
        headers: {
          authorization: 'Bearer pat-secret',
          'content-type': contentType,
        },
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.json()).toEqual({ error: 'invalid_request', code: 'invalid_envelope' });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('projects an invalid action id through the same typed HTTP error contract', async () => {
    const execute = vi.fn();
    const app = await createApp({ executor: { execute } });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/actions/not-a-public-action',
        headers: { authorization: 'Bearer pat-secret' },
        payload: { v: 1, input: {} },
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.json()).toEqual({ error: 'invalid_request', code: 'invalid_action' });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('enforces the shared byte ceiling with a typed non-CORS no-store response', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, result: { accepted: true } }));
    const app = await createApp({ executor: { execute } });
    try {
      expect(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES).toBe(33_554_432);
      const exactLimitPayload = externalActionJsonPayloadWithByteLength(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES);
      const exactLimitResponse = await app.inject({
        method: 'POST',
        url: '/v1/actions/session.spawn_new',
        headers: {
          authorization: 'Bearer pat-secret',
          'content-type': 'application/json',
        },
        payload: exactLimitPayload,
      });
      expect(exactLimitResponse.statusCode).toBe(200);
      expect(exactLimitResponse.headers['cache-control']).toBe('no-store');
      expect(exactLimitResponse.headers['access-control-allow-origin']).toBeUndefined();
      expect(execute).toHaveBeenCalledOnce();

      execute.mockClear();
      const oneByteOverLimitPayload = externalActionJsonPayloadWithByteLength(
        EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES + 1,
      );
      const oneByteOverLimitResponse = await app.inject({
        method: 'POST',
        url: '/v1/actions/session.spawn_new',
        headers: {
          authorization: 'Bearer pat-secret',
          'content-type': 'application/json',
        },
        payload: oneByteOverLimitPayload,
      });
      expect(oneByteOverLimitResponse.statusCode).toBe(413);
      expect(oneByteOverLimitResponse.headers['cache-control']).toBe('no-store');
      expect(oneByteOverLimitResponse.headers['access-control-allow-origin']).toBeUndefined();
      expect(oneByteOverLimitResponse.json()).toEqual({
        error: 'invalid_request',
        code: 'request_too_large',
      });
      expect(execute).not.toHaveBeenCalled();

      const postRejectionResponse = await app.inject({
        method: 'POST',
        url: '/v1/actions/session.spawn_new',
        headers: {
          authorization: 'Bearer pat-secret',
          'content-type': 'application/json',
        },
        payload: { v: 1, input: { executor: 'still-usable' } },
      });
      expect(postRejectionResponse.statusCode).toBe(200);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('keeps preflight unhandled and accepts a body larger than the private control-server limit', async () => {
    const app = await createApp();
    try {
      const preflight = await app.inject({
        method: 'OPTIONS',
        url: '/v1/actions/session.spawn_new',
        headers: {
          origin: 'https://example.test',
          'access-control-request-method': 'POST',
        },
      });
      expect(preflight.statusCode).toBe(404);
      expect(preflight.headers['cache-control']).toBe('no-store');
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/actions/session.spawn_new',
        headers: { authorization: 'Bearer pat-secret' },
        payload: {
          v: 1,
          input: { blob: 'x'.repeat((8 * 1024 * 1024) + 1) },
        },
      });
      expect(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES).toBeGreaterThan(8 * 1024 * 1024);
      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
