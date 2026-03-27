import { timingSafeEqual } from 'node:crypto';

import fastify from 'fastify';

import { isLoopbackHostname } from '@/server/serverUrlClassification';
import { logger } from '@/ui/logger';

const MAX_WEBHOOK_SECRET_TOKEN_LENGTH = 256;

function secureCompareToken(providedToken: string, expectedToken: string): boolean {
  const providedBytes = Buffer.from(providedToken, 'utf8');
  const expectedBytes = Buffer.from(expectedToken, 'utf8');
  const length = Math.max(1, providedBytes.length, expectedBytes.length);
  const providedPadded = Buffer.alloc(length);
  const expectedPadded = Buffer.alloc(length);
  providedBytes.copy(providedPadded);
  expectedBytes.copy(expectedPadded);

  const matches = timingSafeEqual(providedPadded, expectedPadded);
  return matches && providedBytes.length === expectedBytes.length;
}

export type TelegramWebhookRelayHandle = Readonly<{
  port: number;
  stop: () => Promise<void>;
}>;

export async function startTelegramWebhookRelay(params: Readonly<{
  port: number;
  host?: string;
  secretToken: string;
  onUpdate: (update: unknown) => void | Promise<void>;
}>): Promise<TelegramWebhookRelayHandle> {
  const secretToken = String(params.secretToken ?? '').trim();
  if (!secretToken) {
    throw new Error('Webhook secret token is required');
  }
  if (secretToken.length > MAX_WEBHOOK_SECRET_TOKEN_LENGTH) {
    throw new Error('Webhook secret token is too long');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(secretToken)) {
    throw new Error('Webhook secret token must match [A-Za-z0-9_-]');
  }

  const host = String(params.host ?? '127.0.0.1').trim() || '127.0.0.1';
  if (!isLoopbackHostname(host)) {
    throw new Error('Webhook host must be loopback-only');
  }
  if (params.port !== undefined && params.port !== null && !Number.isFinite(params.port)) {
    throw new Error('Webhook port must be a finite number');
  }
  const requestedPort = params.port === undefined || params.port === null ? 0 : Math.trunc(params.port);
  if (requestedPort < 0 || requestedPort > 65_535) {
    throw new Error('Webhook port must be between 0 and 65535');
  }
  const path = '/telegram/webhook';
  const redactedPath = path;

  const app = fastify({ logger: false, bodyLimit: 1_000_000 });
  app.route({
    method: 'POST',
    url: path,
    onRequest: async (request, reply) => {
      const providedHeader = request.headers['x-telegram-bot-api-secret-token'];
      const providedToken =
        typeof providedHeader === 'string'
          ? providedHeader
          : Array.isArray(providedHeader) && providedHeader.length > 0
            ? providedHeader[0] ?? ''
            : '';
      const trimmedProvidedToken = providedToken.trim();
      if (trimmedProvidedToken.length > MAX_WEBHOOK_SECRET_TOKEN_LENGTH) {
        return reply.status(431).send({ ok: false, error: 'Request Header Fields Too Large' });
      }
      if (!secureCompareToken(trimmedProvidedToken, secretToken)) {
        return reply.status(401).send({ ok: false, error: 'Unauthorized' });
      }
      return undefined;
    },
    handler: async (request, reply) => {
      const providedHeader = request.headers['x-telegram-bot-api-secret-token'];
      const providedToken =
        typeof providedHeader === 'string'
          ? providedHeader
          : Array.isArray(providedHeader) && providedHeader.length > 0
            ? providedHeader[0] ?? ''
            : '';
      const trimmedProvidedToken = providedToken.trim();

      try {
        await params.onUpdate(request.body);
        return reply.send({ ok: true });
      } catch (error) {
        logger.warn('[TELEGRAM_WEBHOOK_RELAY] Failed to process inbound webhook update', {
          path: redactedPath,
          tokenLength: trimmedProvidedToken.length,
          error: error instanceof Error ? error.message : String(error),
        });
        return reply.status(500).send({ ok: false, error: 'Internal Server Error' });
      }
    },
  });

  await app.listen({ port: requestedPort, host });
  const address = app.server.address();
  const boundPort = typeof address === 'object' && address ? address.port : requestedPort;

  return {
    port: boundPort,
    stop: async () => {
      await app.close();
    },
  };
}
