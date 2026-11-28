import type { V2SessionRecord } from '@happier-dev/protocol';

import { MetadataSchema } from '@/sync/domains/state/storageTypes';
import type { Encryption } from '@/sync/encryption/encryption';
import { EncryptionCache } from '@/sync/encryption/encryptionCache';
import { SessionEncryption } from '@/sync/encryption/sessionEncryption';
import { parsePlainSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';

export async function readListedSessionMetadata(
    row: Pick<V2SessionRecord, 'id' | 'metadata' | 'metadataVersion' | 'encryptionMode' | 'dataEncryptionKey'>,
    encryption: Encryption,
    serverId: string,
) {
    if (row.encryptionMode === 'plain') {
        return { metadata: parsePlainSessionMetadata(row.metadata), sessionEncryption: null };
    }
    const scope = { serverId, sessionId: row.id };
    const key = row.dataEncryptionKey ? await encryption.decryptEncryptionKey(row.dataEncryptionKey, scope) : null;
    if (row.dataEncryptionKey && !key) throw new Error('Could not decrypt session key');
    const encryptor = await encryption.openEncryption(key, scope);
    const sessionEncryption = new SessionEncryption(row.id, encryptor, new EncryptionCache());
    const decrypted = MetadataSchema.safeParse(await sessionEncryption.decryptMetadata(row.metadataVersion, row.metadata));
    return { metadata: decrypted.success ? decrypted.data : null, sessionEncryption };
}
