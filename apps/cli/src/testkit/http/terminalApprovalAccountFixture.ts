import type { FastifyInstance } from 'fastify';
import tweetnacl from 'tweetnacl';
import {
  createAccountContentPublicKeyBindingMessage,
  deriveAccountMachineKeyFromRecoverySecret,
  UserResponseSchema,
  type AccountScopedCryptoMaterial,
} from '@happier-dev/protocol';

/** A current E2EE Account at the HTTP boundary, including its real signed content-key binding. */
export function registerTerminalApprovalAccountFixture(
  app: FastifyInstance,
  material: AccountScopedCryptoMaterial = { type: 'legacy', secret: new Uint8Array(32).fill(9) },
): Readonly<{ token: string }> {
  const accountId = 'pair-remote-account';
  const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.sig`;
  const machineKey = material.type === 'legacy'
    ? deriveAccountMachineKeyFromRecoverySecret(material.secret) : material.machineKey;
  const contentPublicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
  const signing = tweetnacl.sign.keyPair.fromSeed(material.type === 'legacy'
    ? material.secret : new Uint8Array(32).fill(9));
  const profile = UserResponseSchema.parse({ user: {
    id: accountId, firstName: 'Pairing', lastName: null, avatar: null,
    username: 'pairing', bio: null, status: 'none',
    publicKey: Buffer.from(signing.publicKey).toString('hex'),
    contentPublicKey: Buffer.from(contentPublicKey).toString('base64'),
    contentPublicKeySig: Buffer.from(tweetnacl.sign.detached(
      createAccountContentPublicKeyBindingMessage(contentPublicKey), signing.secretKey,
    )).toString('base64'),
  } });
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
