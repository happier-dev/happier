export type SupportedSessionMediaMimeType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif';

const EXTENSIONS_BY_MIME: Record<SupportedSessionMediaMimeType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const MIME_BY_EXTENSION: Record<string, SupportedSessionMediaMimeType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export function extensionForSessionMediaMimeType(mimeType: SupportedSessionMediaMimeType): string {
  return EXTENSIONS_BY_MIME[mimeType];
}

export function normalizeSessionMediaMimeType(value: unknown): SupportedSessionMediaMimeType | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized in EXTENSIONS_BY_MIME ? normalized as SupportedSessionMediaMimeType : null;
}

export function inferSessionMediaMimeTypeFromName(name: string): SupportedSessionMediaMimeType | null {
  const match = name.toLowerCase().match(/\.[^.]+$/);
  return match ? MIME_BY_EXTENSION[match[0]] ?? null : null;
}

export function sniffSessionMediaMimeType(bytes: Uint8Array): SupportedSessionMediaMimeType | null {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6) {
    const header = Buffer.from(bytes.subarray(0, 6)).toString('ascii');
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif';
  }
  if (bytes.length >= 12) {
    const riff = Buffer.from(bytes.subarray(0, 4)).toString('ascii');
    const webp = Buffer.from(bytes.subarray(8, 12)).toString('ascii');
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  }
  return null;
}

export function resolveSessionMediaMimeType(input: Readonly<{
  bytes?: Uint8Array;
  declaredMimeType?: string;
  suggestedName?: string;
}>): SupportedSessionMediaMimeType | null {
  if (input.bytes && input.bytes.byteLength > 0) {
    return sniffSessionMediaMimeType(input.bytes);
  }
  return normalizeSessionMediaMimeType(input.declaredMimeType)
    ?? (input.suggestedName ? inferSessionMediaMimeTypeFromName(input.suggestedName) : null);
}
