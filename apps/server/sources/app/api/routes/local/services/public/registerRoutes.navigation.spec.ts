import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol';
import { createLocalServicePreviewRuntime } from '@/app/local/services/preview/runtime';
import { createLocalServicePublicRuntime } from '@/app/local/services/public/runtime';
import { registerLocalServiceHostRoutes } from '../hostRoutes';
import {
  handleLocalServicePublicHttpRequest,
  registerLocalServicePublicRoutes,
  type RegisterLocalServicePublicRoutesOptions,
} from './registerRoutes';

const preview: LocalServicePreviewResourceV1 = {
  previewId: 'preview_1',
  sessionId: 'session_1',
  machineId: 'machine_1',
  owner: { kind: 'session', id: 'session_1' },
  target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
  initialPath: { pathname: '/', search: '' },
  display: { title: 'Vite App', addressLabel: '127.0.0.1:5173' },
  originMode: 'host',
};

/**
 * Real Fastify routing with the production precedence (the path-addressed public routes and the
 * exposure-host data plane, composed as `registerLocalServiceRoutes` does) and the real public
 * runtime for exchange, host binding and access. Only the upstream tunnel to the Machine is
 * replaced; it records the forwarded path.
 */
async function createRecipientServer() {
  const app = Fastify({ logger: false });
  app.decorate('authenticate', async () => {});
  const publicRuntime = createLocalServicePublicRuntime({
    publicBaseUrl: 'https://app.happier.test',
    hostOriginBaseDomain: 'preview.happier.test',
    tokenSecret: 'fixture-key',
    policy: {
      enabled: true,
      allowedModes: ['secret_link'],
      maxTtlMs: 60_000,
      dnsTlsRequired: false,
      auditRequired: true,
      rateLimitProfileIds: ['default'],
    },
    allowTestDevAuditSink: true,
    recordAuditEvent: () => {},
    checkRateLimit: () => true,
    resolvePreview: () => preview,
  });
  const created = publicRuntime.createExposure({
    preview,
    requestedMode: 'secret_link',
    requestedTtlMs: 60_000,
    actorId: 'creator',
    sessionAuthorized: true,
    dnsTlsValid: true,
    rateLimitProfileId: 'default',
  });
  if (!created.ok) throw new Error(created.reasonCode);
  const forwardedPaths: string[] = [];
  const options: RegisterLocalServicePublicRoutesOptions = {
    retainMachineAccess: createLocalServicePreviewRuntime({
      tokenSecret: 'fixture-key',
      publicBaseUrl: 'https://app.happier.test',
      hostOriginBaseDomain: 'preview.happier.test',
    }).retainMachineAccess,
    resolvePreview: () => preview,
    createExposure: () => ({ ok: false, reasonCode: 'invalid_policy' }),
    revokeExposure: () => ({ ok: true }),
    resolveExposure: (exposureId) => publicRuntime.resolveExposure(exposureId),
    resolveExposureByHost: (hostname) =>
      publicRuntime.resolveExposureByHost(hostname),
    validateAccess: (input) => publicRuntime.validateAccess(input),
    exchangeAccessToken: (input) => publicRuntime.exchangeAccessToken(input),
    proxyHttp: async ({ request, response }) => {
      forwardedPaths.push(`${request.path}${request.search}`);
      response.writeHead(200, 'OK', { 'content-type': 'text/html' });
      response.end();
      return { ok: true };
    },
  };
  registerLocalServicePublicRoutes(app as never, options);
  registerLocalServiceHostRoutes(
    app as never,
    'preview.happier.test',
    (request, reply) =>
      handleLocalServicePublicHttpRequest(request, reply, options),
  );
  await app.ready();
  const issuedUrl = new URL(created.exposure.publicUrl);
  const recipient = (url: string, cookie?: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: { host: issuedUrl.host, ...(cookie ? { cookie } : {}) },
    });
  return {
    app,
    issuedUrl,
    exposureId: created.exposure.exposureId,
    forwardedPaths,
    recipient,
  };
}

function cookieFrom(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!header) throw new Error('missing Set-Cookie');
  return header.split(';')[0] ?? '';
}

describe('public preview recipient navigation', () => {
  it('serves an ordinary relative link from the issued link landing page inside the exposure', async () => {
    const { app, issuedUrl, exposureId, forwardedPaths, recipient } =
      await createRecipientServer();
    try {
      const exchanged = await recipient(issuedUrl.pathname + issuedUrl.search);
      expect(exchanged.statusCode).toBe(303);
      // The browser resolves relative links against the landing document's URL.
      const linked = new URL(
        'ru2-composed.html',
        new URL(String(exchanged.headers.location), issuedUrl),
      );
      expect(linked.pathname).toBe(
        `/v1/local-services/public/${exposureId}/ru2-composed.html`,
      );
      const page = await recipient(
        linked.pathname,
        cookieFrom(exchanged.headers['set-cookie']),
      );
      expect(page.statusCode).toBe(200);
      expect(forwardedPaths).toEqual(['/ru2-composed.html']);
    } finally {
      await app.close();
    }
  });

  it('keeps a nested landing path and its query so relative links stay in that folder', async () => {
    const { app, issuedUrl, exposureId, forwardedPaths, recipient } =
      await createRecipientServer();
    try {
      const token = encodeURIComponent(
        issuedUrl.searchParams.get('publicToken') ?? '',
      );
      const exchanged = await recipient(
        `/v1/local-services/public/${exposureId}/docs/index.html?tab=a&publicToken=${token}`,
      );
      expect(exchanged.statusCode).toBe(303);
      expect(exchanged.headers.location).toBe(
        `/v1/local-services/public/${exposureId}/docs/index.html?tab=a`,
      );
      const linked = new URL(
        'page.html',
        new URL(String(exchanged.headers.location), issuedUrl),
      );
      expect(
        (
          await recipient(
            linked.pathname,
            cookieFrom(exchanged.headers['set-cookie']),
          )
        ).statusCode,
      ).toBe(200);
      expect(forwardedPaths).toEqual(['/docs/page.html']);
    } finally {
      await app.close();
    }
  });

  it('serves relative links from the exposure host root address', async () => {
    const { app, issuedUrl, forwardedPaths, recipient } =
      await createRecipientServer();
    try {
      const exchanged = await recipient(`/${issuedUrl.search}`);
      expect(exchanged.statusCode).toBe(303);
      expect(exchanged.headers.location).toBe('/');
      const linked = new URL('ru2-composed.html', new URL('/', issuedUrl));
      expect(
        (
          await recipient(
            linked.pathname,
            cookieFrom(exchanged.headers['set-cookie']),
          )
        ).statusCode,
      ).toBe(200);
      expect(forwardedPaths).toEqual(['/ru2-composed.html']);
    } finally {
      await app.close();
    }
  });

  it('still refuses addresses outside the exposure path with the recipient cookie', async () => {
    const { app, issuedUrl, forwardedPaths, recipient } =
      await createRecipientServer();
    try {
      const exchanged = await recipient(issuedUrl.pathname + issuedUrl.search);
      const cookie = cookieFrom(exchanged.headers['set-cookie']);
      for (const outside of [
        '/v1/local-services/public/ru2-composed.html',
        '/v1/local-services/public/other-exposure/index.html',
      ]) {
        const refused = await recipient(outside, cookie);
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toMatchObject({
          reasonCode: 'exposure_binding_mismatch',
        });
      }
      expect(forwardedPaths).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
