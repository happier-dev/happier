import type { FastifyReply, FastifyRequest } from 'fastify';

import { secretEquals as safeTokenEquals } from '@/utils/crypto/secretEquals';

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
