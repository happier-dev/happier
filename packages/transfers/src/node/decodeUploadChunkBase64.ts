import { readPaddedBase64DecodedLength } from '@happier-dev/protocol/crypto/base64';
type DecodeUploadChunkBase64Options = Readonly<{
  // When provided, fail closed before decoding if the input would exceed this decoded byte size.
  maxDecodedBytes?: number;
}>;

function estimateBase64DecodedBytes(value: string): number {
  if (value.length === 0) return 0;
  const paddingBytes = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - paddingBytes);
}

function resolveMaxEncodedChars(maxDecodedBytes: number): number {
  const normalizedMaxDecodedBytes = Math.max(0, Math.floor(maxDecodedBytes));
  // base64 length is 4 * ceil(n / 3)
  return Math.ceil(normalizedMaxDecodedBytes / 3) * 4;
}

export function decodeUploadChunkBase64(
  contentBase64: string,
  options?: DecodeUploadChunkBase64Options,
): Buffer | null {
  const maxDecodedBytes = options?.maxDecodedBytes;
  if (typeof maxDecodedBytes === 'number' && maxDecodedBytes > 0) {
    const maxEncodedChars = resolveMaxEncodedChars(maxDecodedBytes);
    // Fail closed before regex/decoding so callers can't force large allocations.
    if (contentBase64.length > maxEncodedChars) {
      return null;
    }
    if (contentBase64.length % 4 !== 0) {
      return null;
    }
    if (estimateBase64DecodedBytes(contentBase64) > maxDecodedBytes) {
      return null;
    }
  }

  if (readPaddedBase64DecodedLength(contentBase64) === null) {
    return null;
  }

  try {
    return Buffer.from(contentBase64, 'base64');
  } catch {
    return null;
  }
}
