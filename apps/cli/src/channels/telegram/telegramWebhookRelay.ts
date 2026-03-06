import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

import fastify from 'fastify';

function secureCompareToken(providedToken: string, expectedToken: string): boolean {
  const providedBytes = Buffer.from(providedToken, 'utf8');
  const expectedBytes = Buffer.from(expectedToken, 'utf8');
  if (providedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(providedBytes, expectedBytes);
}

export type TelegramWebhookRelayHandle = Readonly<{
  port: number;
  path: string;
  stop: () => Promise<void>;
}>;

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost') return true;

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return normalized.startsWith('127.');
  }
  if (ipVersion === 6) {
    return normalized === '::1';
  }

  return false;
}

export async function startTelegramWebhookRelay(params: Readonly<{
  port: number;
  host?: string;
  secretPathToken: string;
  secretHeaderToken?: string;
  onUpdate: (update: unknown) => void | Promise<void>;
}>): Promise<TelegramWebhookRelayHandle> {
  const secretPathToken = String(params.secretPathToken ?? '').trim();
  if (!secretPathToken) {
    throw new Error('Webhook secret token is required');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(secretPathToken)) {
    throw new Error('Webhook secret token must match [A-Za-z0-9_-]');
  }

  const secretHeaderToken = String(params.secretHeaderToken ?? '').trim();
  if (!secretHeaderToken) {
    throw new Error('Webhook header secret token is required');
  }

  const host = String(params.host ?? '127.0.0.1').trim() || '127.0.0.1';
  if (!isLoopbackHost(host)) {
    throw new Error('Webhook host must be loopback-only');
  }
  const requestedPort = Number.isFinite(params.port) ? Math.trunc(params.port) : 0;
  if (requestedPort < 0 || requestedPort > 65_535) {
    throw new Error('Webhook port must be between 0 and 65535');
  }
  const path = `/telegram/webhook/${secretPathToken}`;

  const app = fastify({ logger: false });
  app.post(path, async (request, reply) => {
    const providedHeader = request.headers['x-telegram-bot-api-secret-token'];
    const providedToken =
      typeof providedHeader === 'string'
        ? providedHeader
        : Array.isArray(providedHeader) && providedHeader.length > 0
          ? providedHeader[0] ?? ''
          : '';
    if (!secureCompareToken(providedToken.trim(), secretHeaderToken)) {
      return reply.status(401).send({ ok: false, error: 'Unauthorized' });
    }

    await params.onUpdate(request.body);
    return reply.send({ ok: true });
  });

  await app.listen({ port: requestedPort, host });
  const address = app.server.address();
  const boundPort = typeof address === 'object' && address ? address.port : requestedPort;

  return {
    port: boundPort,
    path,
    stop: async () => {
      await app.close();
    },
  };
}
