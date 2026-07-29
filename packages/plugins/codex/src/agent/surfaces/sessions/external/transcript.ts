import type {
  ExternalSessionCandidateV1,
  ExternalSessionTranscriptRawMessageV1,
} from '@happier-dev/plugin-sdk/experimental/sessions';

export type CodexExternalSessionAppServerMetadata = Readonly<{
  updatedAtMs: number;
  previewText: string | null;
  workingDirectory: string | null;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

type CodexForwardCursorV1 = Readonly<{
  v: 1;
  kind: 'codexForward';
  fileRelPath: string;
  offsetBytes: number;
}>;

type CodexAppServerForwardCursorV2 = Readonly<{
  v: 2;
  kind: 'codexForwardAppServer';
  updatedAtMs: number;
  previewText: string | null;
}>;

type CodexMergedForwardCursorV3 = Readonly<{
  v: 3;
  kind: 'codexForwardMerged';
  lastCreatedAtMs: number;
  lastId: string | null;
}>;

type CodexStreamVectorForwardCursorV4 = Readonly<{
  v: 4;
  kind: 'codexForwardStreamVector';
  streams: readonly Readonly<{
    fileRelPath: string;
    nextOffsetBytes: number;
    subIndex?: number;
  }>[];
}>;

type CodexGenerationStreamVectorForwardCursorV6 = Readonly<{
  v: 6;
  kind: 'codexForwardStreamVector';
  sourceGeneration: readonly string[];
  streams: readonly Readonly<{
    fileRelPath: string;
    physicalGeneration: string;
    nextOffsetBytes: number;
    subIndex: number;
  }>[];
}>;

type CodexAnchoredGenerationStreamVectorForwardCursorV7 = Readonly<{
  v: 7;
  kind: 'codexForwardStreamVector';
  sourceGeneration: readonly string[];
  streams: readonly Readonly<{
    fileRelPath: string;
    physicalGeneration: string;
    nextOffsetBytes: number;
    subIndex: number;
    fingerprintOffsetBytes: number;
    contentFingerprint: string;
  }>[];
}>;

export type CodexExternalForwardCursor =
  | CodexForwardCursorV1
  | CodexAppServerForwardCursorV2
  | CodexMergedForwardCursorV3
  | CodexStreamVectorForwardCursorV4
  | CodexGenerationStreamVectorForwardCursorV6
  | CodexAnchoredGenerationStreamVectorForwardCursorV7;

export function encodeCodexExternalForwardCursor(value: CodexExternalForwardCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCodexExternalForwardCursor(raw: string): CodexExternalForwardCursor | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (record.v === 1 && record.kind === 'codexForward') {
      const fileRelPath = typeof record.fileRelPath === 'string' ? record.fileRelPath : '';
      const offsetBytes = typeof record.offsetBytes === 'number' && Number.isFinite(record.offsetBytes) ? Math.trunc(record.offsetBytes) : NaN;
      if (!fileRelPath.trim()) return null;
      if (!Number.isFinite(offsetBytes) || offsetBytes < 0) return null;
      return { v: 1, kind: 'codexForward', fileRelPath, offsetBytes };
    }
    if (record.v === 2 && record.kind === 'codexForwardAppServer') {
      const updatedAtMs = typeof record.updatedAtMs === 'number' && Number.isFinite(record.updatedAtMs)
        ? Math.trunc(record.updatedAtMs)
        : NaN;
      const previewText = typeof record.previewText === 'string' && record.previewText.trim().length > 0
        ? record.previewText.trim()
        : null;
      if (!Number.isFinite(updatedAtMs) || updatedAtMs < 0) return null;
      return { v: 2, kind: 'codexForwardAppServer', updatedAtMs, previewText };
    }
    if (record.v === 3 && record.kind === 'codexForwardMerged') {
      const lastCreatedAtMs = typeof record.lastCreatedAtMs === 'number' && Number.isFinite(record.lastCreatedAtMs)
        ? Math.trunc(record.lastCreatedAtMs)
        : NaN;
      const lastId = typeof record.lastId === 'string' && record.lastId.trim().length > 0
        ? record.lastId
        : null;
      if (!Number.isFinite(lastCreatedAtMs) || lastCreatedAtMs < 0) return null;
      return { v: 3, kind: 'codexForwardMerged', lastCreatedAtMs, lastId };
    }
    if (record.v === 4 && record.kind === 'codexForwardStreamVector') {
      const rawStreams = Array.isArray(record.streams) ? record.streams : [];
      const streams = rawStreams
        .map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
          const streamRecord = entry as Record<string, unknown>;
          const fileRelPath = typeof streamRecord.fileRelPath === 'string' ? streamRecord.fileRelPath.trim() : '';
          const nextOffsetBytes =
            typeof streamRecord.nextOffsetBytes === 'number' && Number.isFinite(streamRecord.nextOffsetBytes)
              ? Math.trunc(streamRecord.nextOffsetBytes)
              : NaN;
          const subIndex =
            typeof streamRecord.subIndex === 'number' && Number.isFinite(streamRecord.subIndex)
              ? Math.trunc(streamRecord.subIndex)
              : 0;
          if (!fileRelPath || !Number.isFinite(nextOffsetBytes) || nextOffsetBytes < 0 || subIndex < 0) {
            return null;
          }
          return { fileRelPath, nextOffsetBytes, subIndex };
        })
        .filter((entry): entry is { fileRelPath: string; nextOffsetBytes: number; subIndex: number } => entry !== null);
      return { v: 4, kind: 'codexForwardStreamVector', streams };
    }
    if (record.v === 6 && record.kind === 'codexForwardStreamVector') {
      const sourceGeneration = Array.isArray(record.sourceGeneration)
        ? record.sourceGeneration.filter(
          (entry): entry is string => typeof entry === 'string' && entry.length > 0,
        )
        : [];
      if (
        !Array.isArray(record.sourceGeneration)
        || sourceGeneration.length !== record.sourceGeneration.length
      ) {
        return null;
      }
      const rawStreams = Array.isArray(record.streams) ? record.streams : [];
      const streams = rawStreams
        .map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
          const streamRecord = entry as Record<string, unknown>;
          const fileRelPath = typeof streamRecord.fileRelPath === 'string'
            ? streamRecord.fileRelPath.trim()
            : '';
          const physicalGeneration =
            typeof streamRecord.physicalGeneration === 'string'
              ? streamRecord.physicalGeneration.trim()
              : '';
          const nextOffsetBytes =
            typeof streamRecord.nextOffsetBytes === 'number'
              && Number.isFinite(streamRecord.nextOffsetBytes)
              ? Math.trunc(streamRecord.nextOffsetBytes)
              : NaN;
          const subIndex =
            typeof streamRecord.subIndex === 'number'
              && Number.isFinite(streamRecord.subIndex)
              ? Math.trunc(streamRecord.subIndex)
              : NaN;
          if (
            !fileRelPath
            || !physicalGeneration
            || !Number.isFinite(nextOffsetBytes)
            || nextOffsetBytes < 0
            || !Number.isFinite(subIndex)
            || subIndex < 0
          ) {
            return null;
          }
          return {
            fileRelPath,
            physicalGeneration,
            nextOffsetBytes,
            subIndex,
          };
        })
        .filter((entry): entry is {
          fileRelPath: string;
          physicalGeneration: string;
          nextOffsetBytes: number;
          subIndex: number;
        } => entry !== null);
      if (streams.length !== rawStreams.length) return null;
      return {
        v: 6,
        kind: 'codexForwardStreamVector',
        sourceGeneration,
        streams,
      };
    }
    if (record.v === 7 && record.kind === 'codexForwardStreamVector') {
      const sourceGeneration = Array.isArray(record.sourceGeneration)
        ? record.sourceGeneration.filter(
          (entry): entry is string => typeof entry === 'string' && entry.length > 0,
        )
        : [];
      if (
        !Array.isArray(record.sourceGeneration)
        || sourceGeneration.length !== record.sourceGeneration.length
      ) {
        return null;
      }
      const rawStreams = Array.isArray(record.streams) ? record.streams : [];
      const streams = rawStreams
        .map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
          const streamRecord = entry as Record<string, unknown>;
          const fileRelPath = typeof streamRecord.fileRelPath === 'string'
            ? streamRecord.fileRelPath.trim()
            : '';
          const physicalGeneration =
            typeof streamRecord.physicalGeneration === 'string'
              ? streamRecord.physicalGeneration.trim()
              : '';
          const nextOffsetBytes =
            typeof streamRecord.nextOffsetBytes === 'number'
              && Number.isSafeInteger(streamRecord.nextOffsetBytes)
              ? streamRecord.nextOffsetBytes
              : NaN;
          const subIndex =
            typeof streamRecord.subIndex === 'number'
              && Number.isSafeInteger(streamRecord.subIndex)
              ? streamRecord.subIndex
              : NaN;
          const fingerprintOffsetBytes =
            typeof streamRecord.fingerprintOffsetBytes === 'number'
              && Number.isSafeInteger(streamRecord.fingerprintOffsetBytes)
              ? streamRecord.fingerprintOffsetBytes
              : NaN;
          const contentFingerprint =
            typeof streamRecord.contentFingerprint === 'string'
              ? streamRecord.contentFingerprint.trim()
              : '';
          if (
            !fileRelPath
            || !physicalGeneration
            || !Number.isSafeInteger(nextOffsetBytes)
            || nextOffsetBytes < 0
            || !Number.isSafeInteger(subIndex)
            || subIndex < 0
            || !Number.isSafeInteger(fingerprintOffsetBytes)
            || fingerprintOffsetBytes < nextOffsetBytes
            || (subIndex === 0 && fingerprintOffsetBytes !== nextOffsetBytes)
            || (subIndex > 0 && fingerprintOffsetBytes === nextOffsetBytes)
            || !/^[a-f0-9]{64}$/u.test(contentFingerprint)
          ) {
            return null;
          }
          return {
            fileRelPath,
            physicalGeneration,
            nextOffsetBytes,
            subIndex,
            fingerprintOffsetBytes,
            contentFingerprint,
          };
        })
        .filter((entry): entry is {
          fileRelPath: string;
          physicalGeneration: string;
          nextOffsetBytes: number;
          subIndex: number;
          fingerprintOffsetBytes: number;
          contentFingerprint: string;
        } => entry !== null);
      if (
        streams.length === 0
        || streams.length !== rawStreams.length
        || new Set(streams.map((entry) => entry.fileRelPath)).size !== streams.length
      ) {
        return null;
      }
      return {
        v: 7,
        kind: 'codexForwardStreamVector',
        sourceGeneration,
        streams,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function mapCodexExternalSessionAppServerPreviewToMessage(params: Readonly<{
  remoteSessionId: string;
  metadata: CodexExternalSessionAppServerMetadata;
}>): ExternalSessionTranscriptRawMessageV1 | null {
  const previewText = typeof params.metadata.previewText === 'string' ? params.metadata.previewText.trim() : '';
  if (!previewText) return null;
  const stableId = `codex:app-server:${params.remoteSessionId}:${params.metadata.updatedAtMs}`;
  return {
    id: stableId,
    localId: stableId,
    createdAtMs: params.metadata.updatedAtMs,
    raw: {
      role: 'agent',
      content: {
        type: 'codex',
        data: {
          type: 'message',
          message: previewText,
        },
      },
    },
  };
}

export function mapCodexExternalSessionAppServerCandidateToMetadata(params: Readonly<{
  candidate: ExternalSessionCandidateV1 | null;
}>): CodexExternalSessionAppServerMetadata | null {
  const candidate = params.candidate;
  if (!candidate) return null;

  const updatedAtMs = Number.isFinite(candidate.updatedAtMs)
    ? Math.trunc(candidate.updatedAtMs)
    : NaN;
  if (!Number.isFinite(updatedAtMs) || updatedAtMs < 0) return null;

  const details = candidate.details && typeof candidate.details === 'object' && !Array.isArray(candidate.details)
    ? candidate.details as Record<string, unknown>
    : null;

  return {
    updatedAtMs,
    previewText: normalizeNonEmptyString(candidate.title),
    workingDirectory: normalizeNonEmptyString(details?.cwd),
  };
}
