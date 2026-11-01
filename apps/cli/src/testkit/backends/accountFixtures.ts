import tweetnacl from 'tweetnacl';
import {
  createAccountContentPublicKeyBindingMessage,
  deriveAccountMachineKeyFromRecoverySecret,
  type UserProfile,
} from '@happier-dev/protocol';

export function createAccountTokenFixture(accountId: string, claims: Record<string, unknown> = {}): string {
  return `header.${Buffer.from(JSON.stringify({ ...claims, sub: accountId })).toString('base64url')}.sig`;
}

export function createAccountProfileFixture(params: Readonly<{
  accountId: string;
  signingSeed: Uint8Array;
  machineKey?: Uint8Array;
}>): UserProfile {
  const signing = tweetnacl.sign.keyPair.fromSeed(params.signingSeed);
  const machineKey = params.machineKey ?? deriveAccountMachineKeyFromRecoverySecret(params.signingSeed);
  const contentPublicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
  return {
    id: params.accountId,
    firstName: 'Terminal',
    lastName: null,
    avatar: null,
    username: 'terminal-approval',
    bio: null,
    badges: [],
    status: 'none',
    publicKey: Buffer.from(signing.publicKey).toString('hex'),
    contentPublicKey: Buffer.from(contentPublicKey).toString('base64'),
    contentPublicKeySig: Buffer.from(tweetnacl.sign.detached(
      createAccountContentPublicKeyBindingMessage(contentPublicKey), signing.secretKey,
    )).toString('base64'),
  };
}
