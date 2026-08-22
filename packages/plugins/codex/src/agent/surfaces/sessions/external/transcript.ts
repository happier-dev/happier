import type { AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';

import type { CodexExternalSessionCandidate } from './models.js';

export type CodexExternalSessionAppServerMetadata = Readonly<{
  updatedAtMs: number;
  previewText: string | null;
  workingDirectory: string | null;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

type CodexAppServerForwardCursorV2 = Readonly<{
  v: 2;
  kind: 'codexForwardAppServer';
  updatedAtMs: number;
  previewText: string | null;
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
  | CodexAppServerForwardCursorV2
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
}>): AgentExternalSessionTranscriptItem | null {
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
  candidate: CodexExternalSessionCandidate | null;
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
