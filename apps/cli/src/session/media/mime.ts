import { open } from 'node:fs/promises';
import type { SESSION_MEDIA_IMAGE_MIME_TYPES_V1, SESSION_MEDIA_VIDEO_MIME_TYPES_V1 } from '@happier-dev/protocol/sessions/messages/sessionMediaV1';

export type SupportedSessionMediaImageMimeType = typeof SESSION_MEDIA_IMAGE_MIME_TYPES_V1[number];

export type SupportedSessionMediaVideoMimeType = typeof SESSION_MEDIA_VIDEO_MIME_TYPES_V1[number];

export type SupportedSessionMediaMimeType =
  | SupportedSessionMediaImageMimeType
  | SupportedSessionMediaVideoMimeType;

// WebP's bytes 8..11 are the longest signature inspected by the shared sniffer.
const IMAGE_SIGNATURE_BYTES = 12;

const IMAGE_EXTENSIONS_BY_MIME: Record<SupportedSessionMediaImageMimeType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const VIDEO_EXTENSIONS_BY_MIME: Record<SupportedSessionMediaVideoMimeType, string> = {
  'video/webm': '.webm',
  'video/mp4': '.mp4',
};

const EXTENSIONS_BY_MIME: Record<SupportedSessionMediaMimeType, string> = {
  ...IMAGE_EXTENSIONS_BY_MIME,
  ...VIDEO_EXTENSIONS_BY_MIME,
};

const MIME_BY_EXTENSION: Record<string, SupportedSessionMediaMimeType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

/** Container signature only; playable codec validation belongs to the player/encoder. */
export function hasSessionMediaVideoHeader(bytes: Uint8Array, mimeType: SupportedSessionMediaVideoMimeType): boolean {
  if (mimeType === 'video/webm') {
    return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
      && Buffer.from(bytes).includes(Buffer.from('webm', 'ascii'));
  }
  if (bytes.length < 12 || Buffer.from(bytes.subarray(4, 8)).toString('ascii') !== 'ftyp') return false;
  const brand = Buffer.from(bytes.subarray(8, 12)).toString('ascii');
  return /^iso[m2-9]$/.test(brand) || brand === 'mp41' || brand === 'mp42' || brand === 'avc1' || brand === 'M4V ';
}

export function extensionForSessionMediaMimeType(mimeType: SupportedSessionMediaMimeType): string {
  return EXTENSIONS_BY_MIME[mimeType];
}

export function isSessionMediaImageMimeType(mimeType: SupportedSessionMediaMimeType): mimeType is SupportedSessionMediaImageMimeType {
  return mimeType in IMAGE_EXTENSIONS_BY_MIME;
}

export function sessionMediaKindForMimeType(mimeType: SupportedSessionMediaMimeType): 'image' | 'video' {
  return isSessionMediaImageMimeType(mimeType) ? 'image' : 'video';
}

function normalizeSupportedSessionMediaMimeType(value: unknown): SupportedSessionMediaMimeType | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized in EXTENSIONS_BY_MIME ? normalized as SupportedSessionMediaMimeType : null;
}

function inferSupportedSessionMediaMimeTypeFromName(name: string): SupportedSessionMediaMimeType | null {
  const match = name.toLowerCase().match(/\.[^.]+$/);
  return match ? MIME_BY_EXTENSION[match[0]] ?? null : null;
}

export function normalizeSessionMediaMimeType(value: unknown): SupportedSessionMediaImageMimeType | null {
  const mimeType = normalizeSupportedSessionMediaMimeType(value);
  return mimeType && isSessionMediaImageMimeType(mimeType) ? mimeType : null;
}

export function inferSessionMediaMimeTypeFromName(name: string): SupportedSessionMediaImageMimeType | null {
  const mimeType = inferSupportedSessionMediaMimeTypeFromName(name);
  return mimeType && isSessionMediaImageMimeType(mimeType) ? mimeType : null;
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
  if (bytes.length >= IMAGE_SIGNATURE_BYTES) {
    const riff = Buffer.from(bytes.subarray(0, 4)).toString('ascii');
    const webp = Buffer.from(bytes.subarray(8, 12)).toString('ascii');
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  }
  return null;
}

/** A staged upload can declare a name without an extension; bytes determine its image kind. */
export async function sniffSessionMediaMimeTypeFromFile(filePath: string): Promise<SupportedSessionMediaMimeType | null> {
  const file = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(IMAGE_SIGNATURE_BYTES);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return sniffSessionMediaMimeType(header.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

export function resolveSessionMediaMimeType(input: Readonly<{
  bytes?: Uint8Array;
  declaredMimeType?: string;
  suggestedName?: string;
  allowVideoByDeclarationOrExtension?: boolean;
}>): SupportedSessionMediaMimeType | null {
  if (input.bytes && input.bytes.byteLength > 0) {
    const sniffedMimeType = sniffSessionMediaMimeType(input.bytes);
    if (sniffedMimeType) return sniffedMimeType;
    if (input.allowVideoByDeclarationOrExtension) {
      const declaredMimeType = normalizeSupportedSessionMediaMimeType(input.declaredMimeType);
      if (declaredMimeType && !isSessionMediaImageMimeType(declaredMimeType)) return declaredMimeType;
      const inferredMimeType = input.suggestedName ? inferSupportedSessionMediaMimeTypeFromName(input.suggestedName) : null;
      if (inferredMimeType && !isSessionMediaImageMimeType(inferredMimeType)) return inferredMimeType;
    }
    return null;
  }
  return normalizeSupportedSessionMediaMimeType(input.declaredMimeType)
    ?? (input.suggestedName ? inferSupportedSessionMediaMimeTypeFromName(input.suggestedName) : null);
}
