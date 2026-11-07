import { TaskResourceClientErrorV1, type TaskResourceClientOptionsV1 } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { AES256Encryption } from './encryptor';
import type { Encryption, EncryptionScopeInput } from './encryption';

type TaskEncryption = Pick<Encryption, 'encryptRaw' | 'decryptRaw' | 'decryptEncryptionKey'>;
/** Pure platform crypto adapter, also consumed by Account-mode conversion. */
export function createUiTaskResourceCrypto(encryption: TaskEncryption | null, scope?: EncryptionScopeInput): TaskResourceClientOptionsV1['crypto'] {
  const requireEncryption = () => { if (!encryption) throw new TaskResourceClientErrorV1('resource_encryption_material_unavailable'); return encryption; };
  return {
    randomBytes: getRandomBytes,
    openAccount: async ciphertext => ({ value: await requireEncryption().decryptRaw(ciphertext), needsReseal: false }),
    sealAccount: async value => requireEncryption().encryptRaw(value),
    openKey: async envelope => requireEncryption().decryptEncryptionKey(envelope, scope),
    open: async (ciphertext, key) => (await new AES256Encryption(key).decrypt([decodeBase64(ciphertext, 'base64')]))[0],
    seal: async (value, key) => encodeBase64((await new AES256Encryption(key).encrypt([value]))[0]!, 'base64'),
  };
}
