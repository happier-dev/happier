export function decodeUploadChunkBase64(contentBase64: string): Buffer | null {
  const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!canonicalBase64Pattern.test(contentBase64)) {
    return null;
  }

  try {
    return Buffer.from(contentBase64, 'base64');
  } catch {
    return null;
  }
}
