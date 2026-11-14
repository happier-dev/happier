import { stringifySerializedJsonValue } from '@happier-dev/protocol';

import { ENCRYPTED_PAYLOAD_MAX_OVERHEAD_BYTES } from '@/api/encryption';

/** Bytes the serialized-value envelope adds around a value before encryption. */
const SERIALIZED_VALUE_ENVELOPE_BYTES = Buffer.byteLength(stringifySerializedJsonValue(null), 'utf8') - 'null'.length;

/**
 * Largest UTF-8 JSON size of a handler result whose encoded reply stays within `replyMaxBytes`,
 * the ceiling RpcHandlerManager enforces (configuration.rpcResponseMaxBytes). Covers the
 * encrypted path, which is the larger one: serialized-value envelope, cipher overhead, then base64
 * (4 output bytes per 3 input bytes). A plain reply is measured as JSON directly and is never larger.
 * Producers that bound their own reply size derive it from here, so they cut only what the reply
 * guard would otherwise refuse.
 */
export function resolveRpcReplyJsonMaxBytes(replyMaxBytes: number): number {
    const encryptedJsonMaxBytes = Math.floor(replyMaxBytes / 4) * 3
        - ENCRYPTED_PAYLOAD_MAX_OVERHEAD_BYTES
        - SERIALIZED_VALUE_ENVELOPE_BYTES;
    return Math.max(0, Math.min(replyMaxBytes, encryptedJsonMaxBytes));
}
