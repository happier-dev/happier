import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

function safeTokenEquals(provided: string, expected: string): boolean {
  const providedHash = createHash('sha256').update(provided).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

export function createDaemonControlAuthGuard(
  controlToken: string,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const normalizedControlToken = controlToken.trim();
  if (!normalizedControlToken) {
    throw new Error('Daemon control token is required');
  }
  return async (request, reply) => {
    const rawHeader = request.headers['x-happier-daemon-token'];
    const provided = typeof rawHeader === 'string'
      ? rawHeader
      : Array.isArray(rawHeader)
        ? rawHeader[0]
        : null;
    if (provided && safeTokenEquals(provided, normalizedControlToken)) return;
    await reply.code(401).send({ success: false as const, error: 'Unauthorized' });
  };
}
