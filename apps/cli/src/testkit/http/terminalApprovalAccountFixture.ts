import type { FastifyInstance } from 'fastify';
import {
  UserResponseSchema,
  type AccountScopedCryptoMaterial,
} from '@happier-dev/protocol';
import { createAccountProfileFixture, createAccountTokenFixture } from '../backends/accountFixtures';

/** A current E2EE Account at the HTTP boundary, including its real signed content-key binding. */
export function registerTerminalApprovalAccountFixture(
  app: FastifyInstance,
  material: AccountScopedCryptoMaterial = { type: 'legacy', secret: new Uint8Array(32).fill(9) },
): Readonly<{ token: string }> {
  const accountId = 'pair-remote-account';
  const token = createAccountTokenFixture(accountId);
  const profile = UserResponseSchema.parse({ user: createAccountProfileFixture({
    accountId,
    signingSeed: material.type === 'legacy' ? material.secret : new Uint8Array(32).fill(9),
    ...(material.type === 'dataKey' ? { machineKey: material.machineKey } : {}),
  }) });
  app.get('/v1/account/encryption', async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({ error: 'unauthorized' });
    return { mode: 'e2ee', updatedAt: 1 };
  });
  app.get<{ Params: { id: string } }>('/v1/user/:id', async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({ error: 'unauthorized' });
    if (request.params.id !== accountId) return reply.code(404).send({ error: 'not-found' });
    return profile;
  });
  return { token };
}
