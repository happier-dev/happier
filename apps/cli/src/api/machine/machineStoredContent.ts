import {
  decodePlainMachineStoredContent,
  encodePlainMachineStoredContent,
} from '@happier-dev/protocol';

import {
  decodeBase64,
  decrypt,
  encodeBase64,
  encrypt,
} from '../encryption';

export type MachineContentCodec =
  | Readonly<{
      mode: 'plain';
      encodeStored: (value: unknown) => string;
      decodeStored: (value: string) => unknown;
      encodeRpc: (value: unknown) => unknown;
      decodeRpc: (value: unknown) => unknown;
    }>
  | Readonly<{
      mode: 'e2ee';
      encodeStored: (value: unknown) => string;
      decodeStored: (value: string) => unknown;
      encodeRpc: (value: unknown) => string;
      decodeRpc: (value: unknown) => unknown;
    }>;

export function createMachineContentCodec(machine: Readonly<
  | {
      encryptionMode: 'plain';
      encryptionKey?: never;
      encryptionVariant?: never;
    }
  | {
      encryptionMode?: 'e2ee';
      encryptionKey: Uint8Array;
      encryptionVariant: 'legacy' | 'dataKey';
    }
>): MachineContentCodec {
  if (machine.encryptionMode === 'plain') {
    return {
      mode: 'plain',
      encodeStored: encodePlainMachineStoredContent,
      decodeStored: decodePlainMachineStoredContent,
      encodeRpc: (value) => value,
      decodeRpc: (value) => value,
    };
  }
  return {
    mode: 'e2ee',
    encodeStored: (value) => encodeBase64(
      encrypt(machine.encryptionKey, machine.encryptionVariant, value),
    ),
    decodeStored: (value) => decrypt(
      machine.encryptionKey,
      machine.encryptionVariant,
      decodeBase64(value),
    ),
    encodeRpc: (value) => encodeBase64(
      encrypt(machine.encryptionKey, machine.encryptionVariant, value),
    ),
    decodeRpc: (value) => {
      const encoded = typeof value === 'string' ? value.trim() : '';
      if (!encoded) return null;
      return decrypt(
        machine.encryptionKey,
        machine.encryptionVariant,
        decodeBase64(encoded),
      );
    },
  };
}
