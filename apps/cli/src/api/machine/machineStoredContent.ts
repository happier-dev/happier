import { decodePlainMachineStoredContent, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { Machine } from '@/api/types';

type MachineContentContext = Pick<Machine, 'encryptionKey' | 'encryptionVariant'>;

export function encodeMachineStoredContent(context: MachineContentContext, value: unknown): string {
  if (context.encryptionVariant === 'plain') return encodePlainMachineStoredContent(value);
  if (!context.encryptionKey) throw new Error('Missing machine encryption key');
  return encodeBase64(encrypt(context.encryptionKey, context.encryptionVariant, value));
}

/** Network content is decoded once at the machine storage boundary. */
export function decodeMachineStoredContent<T>(context: MachineContentContext, value: string): T {
  let decoded: unknown;
  try {
    decoded = context.encryptionVariant === 'plain'
      ? decodePlainMachineStoredContent(value)
      : context.encryptionKey ? decrypt(context.encryptionKey, context.encryptionVariant, decodeBase64(value)) : null;
  } catch {
    decoded = null;
  }
  if (decoded === null) {
    throw Object.assign(new Error('Cannot open stored machine content. Retain the original account encryption material before retrying.'), {
      code: 'MACHINE_CONTENT_KEY_UNAVAILABLE',
    });
  }
  return decoded as T;
}
