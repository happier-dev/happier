import { request as requestHttp } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH,
  CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH,
  CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH,
  SPAWN_SESSION_ERROR_CODES,
} from '@happier-dev/protocol';
import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER,
} from '@happier-dev/agents/request-auth';

import { logger } from '@/ui/logger';
import { createDaemonControlApp } from './controlServer';
import type { ConnectedAccountRequestAuthSubject } from './connectedServices/requestAuth/ConnectedAccountRequestAuthService';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

const purpose = {
  consumer: {
    pluginId: 'happier.agent.test',
    localId: 'consumer',
  },
  purpose: 'model-request',
} as const;
const credentialContext = {
  account: {
    service: {
      pluginId: 'happier.connected-account.test',
      localId: 'subscription',
    },
    accountId: 'work',
  },
  credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
  failingAccessTokenFingerprint: `sha256:${'a'.repeat(64)}`,
} as const;

function testSubject(): ConnectedAccountRequestAuthSubject {
  return {
    subjectId: 'session:test/run:wrapper',
    isCurrent: () => true,
    registerRedaction: () => undefined,
    resolvePurposeUse: () => null,
    listPurposeUses: () => [],
  };
}

function createApp(overrides: Record<string, unknown> = {}) {
  const subject = testSubject();
  const authenticate = vi.fn(
    (capability: unknown) => capability === 'scoped-capability' ? subject : null,
  );
  const lookupRequestAuth = vi.fn(async (_input: Readonly<{ signal?: AbortSignal }>) => ({
    accessToken: 'access-token',
    credentialContext,
  }));
  const refreshAfterAuthFailure = vi.fn(async () => ({ status: 'current_changed' as const }));
  const reportQuotaFailure = vi.fn(async () => ({ status: 'current_changed' as const }));
  const app = createDaemonControlApp({
    getChildren: () => [],
    machineId: 'machine',
    stopSession: async () => ({ status: 'not_found' as const }),
    spawnSession: async () => ({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      errorMessage: 'unused',
    }),
    requestShutdown: () => undefined,
    onHappySessionWebhook: () => undefined,
    controlToken: 'master-token',
    connectedAccountRequestAuth: {
      authenticate,
      lookupRequestAuth,
      refreshAfterAuthFailure,
      reportQuotaFailure,
    },
    ...overrides,
  } as Parameters<typeof createDaemonControlApp>[0]);
  return {
    app,
    authenticate,
    lookupRequestAuth,
    refreshAfterAuthFailure,
    reportQuotaFailure,
  };
}

describe('daemon private connected-account request-auth routes', () => {
  it('accepts only the scoped capability and a purpose-only lookup body', async () => {
    const { app, lookupRequestAuth } = createApp();
    try {
      const ok = await app.inject({
        method: 'POST',
        url: CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH,
        headers: { [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER]: 'scoped-capability' },
        payload: { purpose },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({
        ok: true,
        value: {
          accessToken: 'access-token',
          credentialContext,
        },
      });
      expect(lookupRequestAuth).toHaveBeenCalledWith({
        subject: expect.objectContaining({ subjectId: 'session:test/run:wrapper' }),
        purpose,
        signal: expect.any(AbortSignal),
      });

      for (const unauthorizedCapability of [
        'master-token',
        'downstream-session-bearer',
        'another-session-wrapper-capability',
      ]) {
        const denied = await app.inject({
          method: 'POST',
          url: CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH,
          headers: {
            [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER]: unauthorizedCapability,
          },
          payload: { purpose },
        });
        expect(denied.statusCode).toBe(401);
      }

      const forceRefresh = await app.inject({
        method: 'POST',
        url: CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH,
        headers: { [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER]: 'scoped-capability' },
        payload: { purpose, forceRefresh: true },
      });
      expect(forceRefresh.statusCode).toBe(400);
      expect(lookupRequestAuth).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('cancels request-auth lookup work when the wrapper connection closes', async () => {
    let resolveObservedSignal!: (signal: AbortSignal) => void;
    const observedSignal = new Promise<AbortSignal>((resolve) => {
      resolveObservedSignal = resolve;
    });
    let resolveObservedAbort!: () => void;
    const observedAbort = new Promise<void>((resolve) => {
      resolveObservedAbort = resolve;
    });
    const created = createApp();
    created.lookupRequestAuth.mockImplementationOnce(async (input: Readonly<{
      signal?: AbortSignal;
    }>) => {
      const signal = input.signal;
      if (!signal) throw new Error('request-auth route did not provide a request lifetime');
      resolveObservedSignal(signal);
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          resolveObservedAbort();
          reject(signal.reason);
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
      return {
        accessToken: 'unreachable-after-client-close',
        credentialContext,
      };
    });
    try {
      await created.app.listen({ host: '127.0.0.1', port: 0 });
      const address = created.app.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected daemon control test server TCP address');
      }
      const payload = JSON.stringify({ purpose });
      const request = requestHttp({
        host: '127.0.0.1',
        port: address.port,
        path: CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER]: 'scoped-capability',
        },
      });
      const requestClosed = new Promise<void>((resolve) => {
        request.once('error', () => resolve());
        request.once('close', () => resolve());
      });
      request.end(payload);
      const signal = await observedSignal;

      request.destroy();

      await requestClosed;
      await expect(observedAbort).resolves.toBeUndefined();
      expect(signal.aborted).toBe(true);
    } finally {
      await created.app.close();
    }
  });

  it('keeps auth and quota reports separate and returns no replay authorization', async () => {
    const { app, refreshAfterAuthFailure, reportQuotaFailure } = createApp();
    try {
      const headers = {
        [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER]: 'scoped-capability',
      };
      const authentication = await app.inject({
        method: 'POST',
        url: CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH,
        headers,
        payload: {
          credentialContext,
          normalizedFailure: {
            class: 'authentication',
            evidence: {
                httpStatus: 401,
                limitCategory: 'auth_invalid',
                quotaScope: 'unknown',
                evidenceSource: { kind: 'structured' },
            },
          },
        },
      });
      const quota = await app.inject({
        method: 'POST',
        url: CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH,
        headers,
        payload: {
          credentialContext,
          normalizedFailure: {
            class: 'quota',
            evidence: {
                httpStatus: 429,
                retryAfterMs: 1_000,
                limitCategory: 'rate_limit',
                quotaScope: 'unknown',
                evidenceSource: { kind: 'structured' },
            },
          },
        },
      });

      expect(authentication.statusCode).toBe(200);
      expect(authentication.json()).toEqual({ ok: true, value: { status: 'current_changed' } });
      expect(quota.statusCode).toBe(200);
      expect(quota.json()).toEqual({ ok: true, value: { status: 'current_changed' } });
      expect(JSON.stringify([authentication.json(), quota.json()])).not.toContain('retry');
      expect(refreshAfterAuthFailure).toHaveBeenCalledOnce();
      expect(reportQuotaFailure).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('rejects forged pinned Pi terminal provenance before quota recovery', async () => {
    const { app, reportQuotaFailure } = createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH,
        headers: {
          [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER]: 'scoped-capability',
        },
        payload: {
          credentialContext,
          normalizedFailure: {
            class: 'quota',
            evidence: {
              httpStatus: 529,
              limitCategory: 'capacity',
              quotaScope: 'unknown',
              evidenceSource: {
                kind: 'pinned_pi_terminal_signature',
                producer: 'pi',
                producerVersion: '0.82.0',
                provider: 'anthropic',
                signatureId: 'anthropic-overloaded-error-v1',
              },
            },
          },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(reportQuotaFailure).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not log unexpected request-auth exception content', async () => {
    const sentinel = 'secret-derived-provider-auth-detail';
    const { app, lookupRequestAuth } = createApp();
    lookupRequestAuth.mockRejectedValueOnce(new Error(sentinel));
    vi.mocked(logger.debug).mockClear();
    try {
      const response = await app.inject({
        method: 'POST',
        url: CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH,
        headers: {
          [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER]: 'scoped-capability',
        },
        payload: { purpose },
      });

      expect(response.statusCode).toBe(503);
      const renderedLogArguments = vi.mocked(logger.debug).mock.calls
        .flat()
        .map((value) => (
          value instanceof Error
            ? `${value.name} ${value.message} ${value.stack ?? ''}`
            : String(value)
        ))
        .join(' ');
      expect(renderedLogArguments).not.toContain(sentinel);
      expect(logger.debug).toHaveBeenCalledWith(
        '[CONTROL SERVER] Connected-account request-auth operation failed',
        { errorCode: 'unexpected_error' },
      );
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      name: 'lookup',
      path: CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH,
      payload: { purpose },
      service: 'lookupRequestAuth' as const,
    },
    {
      name: 'auth failure',
      path: CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH,
      payload: {
        credentialContext,
        normalizedFailure: {
          class: 'authentication',
          evidence: {
            httpStatus: 401,
            limitCategory: 'auth_invalid',
            quotaScope: 'unknown',
            evidenceSource: { kind: 'structured' },
          },
        },
      },
      service: 'refreshAfterAuthFailure' as const,
    },
    {
      name: 'quota failure',
      path: CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH,
      payload: {
        credentialContext,
        normalizedFailure: {
          class: 'quota',
          evidence: {
            httpStatus: 429,
            limitCategory: 'rate_limit',
            quotaScope: 'unknown',
            evidenceSource: { kind: 'structured' },
          },
        },
      },
      service: 'reportQuotaFailure' as const,
    },
  ])('rejects $name before authentication or service work once the daemon is quiescing', async ({
    path,
    payload,
    service,
  }) => {
    const created = createApp({ isShuttingDown: () => true });
    try {
      const response = await created.app.inject({
        method: 'POST',
        url: path,
        headers: {
          [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER]: 'scoped-capability',
        },
        payload,
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        ok: false,
        error: { code: 'request_auth_unavailable' },
      });
      expect(created.authenticate).not.toHaveBeenCalled();
      expect(created[service]).not.toHaveBeenCalled();
    } finally {
      await created.app.close();
    }
  });

  it('lets one request admitted before quiescence finish without a second authorization or replay', async () => {
    let quiescing = false;
    let resolveLookup!: (value: {
      accessToken: string;
      credentialContext: typeof credentialContext;
    }) => void;
    const lookupResult = new Promise<{
      accessToken: string;
      credentialContext: typeof credentialContext;
    }>((resolve) => {
      resolveLookup = resolve;
    });
    const created = createApp({ isShuttingDown: () => quiescing });
    created.lookupRequestAuth.mockImplementationOnce(async () => await lookupResult);
    try {
      const responsePromise = created.app.inject({
        method: 'POST',
        url: CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH,
        headers: {
          [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER]: 'scoped-capability',
        },
        payload: { purpose },
      });
      await vi.waitFor(() => {
        expect(created.lookupRequestAuth).toHaveBeenCalledOnce();
      });

      quiescing = true;
      resolveLookup({
        accessToken: 'lease-admitted-before-quiescence',
        credentialContext,
      });

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        value: { accessToken: 'lease-admitted-before-quiescence' },
      });
      expect(created.authenticate).toHaveBeenCalledOnce();
      expect(created.lookupRequestAuth).toHaveBeenCalledOnce();
    } finally {
      await created.app.close();
    }
  });
});
