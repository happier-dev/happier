export type TransferChunkEncryptionVector = Readonly<{
  name: string;
  transferId: string;
  sequence: number;
  payloadUtf8: string;
  recipientSecretKeySeedBase64: string;
  recipientPublicKeyBase64: string;
  payloadBase64: string;
  encryptedDataKeyEnvelopeBase64: string;
  randomBytesBase64: readonly string[];
}>;

export const transferChunkEncryptionVectors: readonly TransferChunkEncryptionVector[] = [
  {
    name: 'vector_alpha',
    transferId: 'vector_transfer_alpha',
    sequence: 7,
    payloadUtf8: 'vector payload alpha\n',
    recipientSecretKeySeedBase64: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
    recipientPublicKeyBase64: 'SjgH0GTQdxgcwHCYnnaJHSDcpVWVSNwsd8GlAnOIKzg=',
    payloadBase64: 'ALCxsrO0tba3uLm6u4WH8Cwum1QLquwx/Rr64wUWX9qwQ9cWlzLIqgsXLe98h7K5y6s=',
    encryptedDataKeyEnvelopeBase64: 'ANwsyjHo5Du9kd/35HXMozR+tHgQfVvXZaukrkoww11E0NHS09TV1tfY2drb3N3e3+Dh4uPk5ebnQODURx0VgMxW2w7ovZLS001MPRR/bWuNOnE/XvOZhonyT2OClGL3IP5HU+nrGowq',
    randomBytesBase64: [
      'oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8=',
      'sLGys7S1tre4ubq7',
      'wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t8=',
      '0NHS09TV1tfY2drb3N3e3+Dh4uPk5ebn',
    ],
  },
] as const;

export function createDeterministicRandomBytesFromBase64(valuesBase64: readonly string[]): (length: number) => Uint8Array {
  const buffers = valuesBase64.map((value) => Uint8Array.from(Buffer.from(value, 'base64')));
  let index = 0;
  return (length: number): Uint8Array => {
    const next = buffers[index];
    index += 1;
    if (!next || next.length !== length) {
      throw new Error(`Unexpected deterministic randomBytes request at index ${index} for length ${length}`);
    }
    return next;
  };
}
