import { Buffer } from 'node:buffer';

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES, type ActionExecuteResult } from '@happier-dev/protocol/actions';

import type { DaemonPatVerifier } from '../auth/daemonPatVerifier';
import type { ExternalActionExecutor, ResolveExternalActionTarget } from './executeExternalAction';
import { registerDaemonExternalActionRoute } from './registerDaemonExternalActionRoute';

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
