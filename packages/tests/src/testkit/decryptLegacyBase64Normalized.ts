import { decryptLegacyBase64 } from './messageCrypto';
import { unwrapSerializedJsonValue } from './unwrapSerializedJsonValue';

export function decryptLegacyBase64Normalized(ciphertextBase64: string, secret: Uint8Array): unknown | null {
  return unwrapSerializedJsonValue(decryptLegacyBase64(ciphertextBase64, secret));
}
