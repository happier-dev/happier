import { posix, win32 } from 'node:path';

type RecordLike = Record<string, unknown>;

export type CodexGeneratedMediaOrigin = Readonly<{
  source: 'provider-generated';
  agentEventId: string;
  generationId: string;
}>;

export type CodexGeneratedMediaCandidate = Readonly<{
  itemId: string;
  origin: CodexGeneratedMediaOrigin;
  source:
    | Readonly<{
        kind: 'local-file';
        path: string;
        fileNameHint: string;
        restrictedRoot: string;
      }>
    | Readonly<{
        kind: 'base64';
        data: string;
        fileNameHint: string;
      }>;
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

function buildOrigin(itemId: string): CodexGeneratedMediaOrigin {
  return {
    source: 'provider-generated',
    agentEventId: itemId,
    generationId: itemId,
  };
}

function buildSavedPathCandidate(
  itemId: string,
  savedPath: string,
): CodexGeneratedMediaCandidate | null {
  if (!isAbsoluteSavedPath(savedPath)) return null;
  const api = pathApiFor(savedPath);
  const restrictedRoot = api.dirname(savedPath);
  if (!restrictedRoot || restrictedRoot === '.') return null;
  return {
    itemId,
    origin: buildOrigin(itemId),
    source: {
      kind: 'local-file',
      path: savedPath,
      fileNameHint: api.basename(savedPath) || `${itemId}.png`,
      restrictedRoot,
    },
  };
}

export function extractCodexGeneratedMediaCandidate(
  itemId: string,
  item: RecordLike,
): CodexGeneratedMediaCandidate | null {
  const savedPath = readSavedPath(item);
  if (savedPath) {
    const media = buildSavedPathCandidate(itemId, savedPath);
    if (media) return media;
  }

  const base64Image = readBase64Image(item);
  return base64Image
    ? {
        itemId,
        origin: buildOrigin(itemId),
        source: {
          kind: 'base64',
          data: base64Image,
          fileNameHint: `${itemId}.png`,
        },
      }
    : null;
}
