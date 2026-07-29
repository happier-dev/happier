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
  source: Readonly<{
    kind: 'local-file';
    path: string;
    fileNameHint: string;
    restrictedRoot: string;
  }>;
}>;

const OFFICIAL_ITEM_KEYS = [
  'id',
  'result',
  'revisedPrompt',
  'savedPath',
  'status',
  'type',
] as const;
const MAX_PATH_CODE_UNITS = 4_096;
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp']);

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
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(api.extname(savedPath).toLowerCase())) return null;
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
  const keys = Object.keys(item).sort();
  if (
    keys.length !== OFFICIAL_ITEM_KEYS.length
    || OFFICIAL_ITEM_KEYS.some((key, index) => keys[index] !== key)
    || item.type !== 'imageGeneration'
    || item.id !== itemId
    || item.status !== 'completed'
    || typeof item.result !== 'string'
    || (item.revisedPrompt !== null && typeof item.revisedPrompt !== 'string')
    || typeof item.savedPath !== 'string'
  ) {
    return null;
  }
  const savedPath = item.savedPath.trim();
  if (
    savedPath.length === 0
    || savedPath.length > MAX_PATH_CODE_UNITS
    || savedPath.includes('\0')
  ) {
    return null;
  }
  return buildSavedPathCandidate(itemId, savedPath);
}
