import { hexToBytes } from '@noble/hashes/utils';
import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { verifyAccountContentKeyBindingV1 } from '../../crypto/accountContentKeyBindingV1.js';
import { sealEncryptedDataKeyEnvelopeV1 } from '../../crypto/encryptedDataKeyEnvelopeV1.js';
import type {
  PatchSessionDataKeyEnvelopesV1,
  SessionDataKeyEnvelopeItemV1,
  SessionDataKeyRecipientUnavailableReasonV1,
} from './sessionDataKeyEnvelopes.js';

export type PreparedSessionDataKeyEnvelopeItemV1 =
  | Readonly<{ kind: 'prepared'; entry: PatchSessionDataKeyEnvelopesV1['entries'][number] }>
  | Readonly<{ kind: 'setup_required'; reason: SessionDataKeyRecipientUnavailableReasonV1 }>
  | Readonly<{ kind: 'invalid_binding' }>;

/** Consumes an authorized resource worklist; key verification never grants access. */
export function prepareResourceDataKeyEnvelopeItemV1(params: Readonly<{
  item: SessionDataKeyEnvelopeItemV1;
  resourceDataKey: Uint8Array;
  randomBytes: (length: number) => Uint8Array;
}>): PreparedSessionDataKeyEnvelopeItemV1 {
  const { item } = params;
  if (item.contentKey.status === 'unavailable') {
    return { kind: 'setup_required', reason: item.contentKey.reason };
  }
  let verified: ReturnType<typeof verifyAccountContentKeyBindingV1>;
  try {
    verified = verifyAccountContentKeyBindingV1({
      accountSigningPublicKey: hexToBytes(item.contentKey.accountSigningPublicKey),
      contentPublicKey: decodeBase64(item.contentKey.contentPublicKey),
      signature: decodeBase64(item.contentKey.contentPublicKeySignature),
    });
  } catch {
    return { kind: 'invalid_binding' };
  }
  if (!verified) return { kind: 'invalid_binding' };
  return { kind: 'prepared', entry: {
    recipientAccountId: item.recipientAccountId,
    encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: params.resourceDataKey,
      recipientPublicKey: verified.contentPublicKey,
      randomBytes: params.randomBytes,
    })),
  } };
}

/** Retained Session caller contract; both resource flows share binding verification and sealing. */
export function prepareSessionDataKeyEnvelopeItemV1(params: Readonly<{
  item: SessionDataKeyEnvelopeItemV1;
  sessionDataKey: Uint8Array;
  randomBytes: (length: number) => Uint8Array;
}>): PreparedSessionDataKeyEnvelopeItemV1 {
  return prepareResourceDataKeyEnvelopeItemV1({
    item: params.item, resourceDataKey: params.sessionDataKey, randomBytes: params.randomBytes,
  });
}
