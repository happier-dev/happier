import { posix, win32 } from 'node:path';

import type { SessionMediaBridgeInput } from '@/api/session/client/transcript/sessionMediaBridge';
import { decodeSessionMediaBase64Prefix } from '@/session/media/base64';
import { sniffSessionMediaMimeType } from '@/session/media/mime';

type RecordLike = Record<string, unknown>;

const BASE64_IMAGE_SNIFF_PREFIX_BYTES = 4096;

export type CodexGeneratedMediaResult = Readonly<{
  itemId: string;
  media: readonly SessionMediaBridgeInput[];
}>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readBase64Image(item: RecordLike): string | null {
  return readString(item.result)
    ?? readString(item.image)
    ?? readString(item.imageData)
    ?? readString(item.image_data)
    ?? readString(item.b64_json)
    ?? readString(item.base64);
}

function readSavedPath(item: RecordLike): string | null {
  return readString(item.savedPath)
    ?? readString(item.saved_path)
    ?? readString(item.outputPath)
    ?? readString(item.output_path)
    ?? readString(item.path);
}

function pathApiFor(value: string): typeof posix | typeof win32 {
  return /^[a-z]:[\\/]/iu.test(value) || value.includes('\\') ? win32 : posix;
}

function isAbsoluteSavedPath(value: string): boolean {
  return posix.isAbsolute(value) || win32.isAbsolute(value);
}

function buildSavedPathMediaInput(
  itemId: string,
  savedPath: string,
  origin: SessionMediaBridgeInput['origin'],
): SessionMediaBridgeInput | null {
  if (!isAbsoluteSavedPath(savedPath)) return null;
  const api = pathApiFor(savedPath);
  const root = api.dirname(savedPath);
  if (!root || root === '.') return null;
  const fileNameHint = api.basename(savedPath) || `${itemId}.png`;
  return {
    source: {
      kind: 'local-file',
      path: savedPath,
      fileNameHint,
    },
    origin,
    sourceAccessPolicy: {
      kind: 'restrictedRoots',
      roots: [root],
    },
  };
}

export function extractCodexGeneratedMedia(
  itemId: string,
  item: RecordLike,
): CodexGeneratedMediaResult | null {
  const origin = {
    source: 'provider-generated' as const,
    providerEventId: itemId,
    generationId: itemId,
  };
  const savedPath = readSavedPath(item);
  if (savedPath) {
    const media = buildSavedPathMediaInput(itemId, savedPath, origin);
    if (media) {
      return {
        itemId,
        media: [media],
      };
    }
  }

  const base64Image = readBase64Image(item);
  if (base64Image) {
    const decoded = decodeSessionMediaBase64Prefix(base64Image, BASE64_IMAGE_SNIFF_PREFIX_BYTES);
    if (!decoded.success) return null;
    const mimeType = sniffSessionMediaMimeType(decoded.bytes);
    if (!mimeType) return null;
    return {
      itemId,
      media: [{
        source: {
          kind: 'base64',
          data: base64Image,
          mimeType,
          fileNameHint: `${itemId}.png`,
        },
        origin,
      }],
    };
  }

  return null;
}
