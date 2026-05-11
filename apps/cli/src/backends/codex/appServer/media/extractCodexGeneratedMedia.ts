import { basename } from 'node:path';

import type { SessionMediaBridgeInput } from '@/api/session/client/transcript/sessionMediaBridge';
import { sniffSessionMediaMimeType } from '@/session/media/mime';

type RecordLike = Record<string, unknown>;

export type CodexGeneratedMediaResult = Readonly<{
  itemId: string;
  media: readonly SessionMediaBridgeInput[];
  meta?: Record<string, unknown>;
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

function buildMeta(item: RecordLike): Record<string, unknown> | undefined {
  const revisedPrompt = readString(item.revised_prompt) ?? readString(item.revisedPrompt);
  return revisedPrompt
    ? { codexImageGenerationV1: { revisedPrompt } }
    : undefined;
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
  const base64Image = readBase64Image(item);
  if (base64Image) {
    const mimeType = sniffSessionMediaMimeType(Buffer.from(base64Image, 'base64'));
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
      ...(buildMeta(item) ? { meta: buildMeta(item) } : {}),
    };
  }

  const savedPath = readSavedPath(item);
  if (!savedPath) return null;
  return {
    itemId,
    media: [{
      source: {
        kind: 'local-file',
        path: savedPath,
        fileNameHint: basename(savedPath),
      },
      origin,
    }],
    ...(buildMeta(item) ? { meta: buildMeta(item) } : {}),
  };
}
