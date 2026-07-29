import { createHash } from 'node:crypto';

import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { configuration } from '@/configuration';
import {
  SessionMediaFailureV1Schema,
  SessionMediaItemV1Schema,
  type SessionMediaFailureV1,
  type SessionMediaItemV1,
} from '@happier-dev/protocol';

import type { SessionMediaOrigin } from './_types';
import {
  persistSessionMedia,
  type PersistSessionMediaResult,
} from './persistSessionMedia';
import {
  isCanonicalSessionMediaWorkspacePath,
} from './referencedPaths';
import {
  sanitizeSessionMediaFailureName,
  sanitizeSessionMediaIdentifier,
} from './names';
import { prepareSource } from './source';
import {
  extensionForSessionMediaMimeType,
  sessionMediaKindForMimeType,
  type SupportedSessionMediaMimeType,
} from './mime';

const SESSION_MEDIA_ENVELOPE_KIND = 'session_media.v1';
const HISTORICAL_IMPORT_STAGED_MEDIA_KIND = 'external_session_staged_media.v1';
const FORBIDDEN_DURABLE_MEDIA_KEYS = new Set([
  'data',
  'base64',
  'b64',
  'b64_json',
  'inlineData',
  'url',
  'uri',
  'fileUrl',
  'sourcePath',
  'sourceUri',
  'sourceUrl',
  'filePath',
  'localPath',
  'provider',
  'providerId',
  'backendId',
  'summary',
  'summaryPreview',
  'providerSummary',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readMediaRole(value: unknown): 'input' | 'output' {
  return value === 'input' ? 'input' : 'output';
}

function readMediaCategory(value: unknown): 'attachment' | 'generated' | 'tool-artifact' {
  if (value === 'attachment' || value === 'tool-artifact') return value;
  return 'generated';
}

function readMediaMimeType(value: unknown): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif') {
    return value;
  }
  return undefined;
}

function readMediaOrigin(value: unknown): SessionMediaOrigin {
  const record = asRecord(value);
  const source = record?.source;
  const agentId = sanitizeSessionMediaIdentifier(readString(record?.agentId));
  const toolCallId = sanitizeSessionMediaIdentifier(readString(record?.toolCallId));
  const generationId = sanitizeSessionMediaIdentifier(readString(record?.generationId));
  const agentEventId = sanitizeSessionMediaIdentifier(readString(record?.agentEventId));
  const providerFileId = sanitizeSessionMediaIdentifier(readString(record?.providerFileId));
  const normalizedSource =
    source === 'user-upload'
    || source === 'provider-generated'
    || source === 'tool-output'
    || source === 'acp-content'
    || source === 'mcp-content'
    || source === 'local-file'
      ? source
      : 'provider-generated';

  return {
    source: normalizedSource,
    ...(agentId ? { agentId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(generationId ? { generationId } : {}),
    ...(agentEventId ? { agentEventId } : {}),
    ...(providerFileId ? { providerFileId } : {}),
  };
}

function isDurableSessionMediaWorkspacePath(
  path: string,
  category: 'attachment' | 'generated' | 'tool-artifact',
): boolean {
  return isCanonicalSessionMediaWorkspacePath(path, category);
}

function buildUnavailableMediaFailure(input: Readonly<{
  index: number;
  mediaRecord: Record<string, unknown> | null;
  code: string;
}>): SessionMediaFailureV1 {
  const mediaRecord = input.mediaRecord ?? {};
  return sanitizeUnavailableMediaFailure({
    index: input.index,
    code: input.code,
    role: readMediaRole(mediaRecord.role),
    category: readMediaCategory(mediaRecord.category),
    mediaKind: 'image',
    name: readString(mediaRecord.name) ?? null,
    ...(readMediaMimeType(mediaRecord.mimeType) ? { mimeType: readMediaMimeType(mediaRecord.mimeType) } : {}),
    origin: readMediaOrigin(mediaRecord.origin),
  });
}

function sanitizeUnavailableMediaFailure(value: Readonly<{
  index: number;
  code: unknown;
  role: unknown;
  category: unknown;
  mediaKind?: unknown;
  name: unknown;
  mimeType?: unknown;
  origin?: unknown;
  createdAtMs?: unknown;
}>): SessionMediaFailureV1 {
  const index = Number.isInteger(value.index) && value.index >= 0 ? value.index : 0;
  const failure: SessionMediaFailureV1 = {
    index,
    code: sanitizeSessionMediaIdentifier(readString(value.code)) ?? 'unavailable',
    role: readMediaRole(value.role),
    category: readMediaCategory(value.category),
    mediaKind: 'image',
    name: sanitizeSessionMediaFailureName(readString(value.name), `image-${index + 1}`),
    ...(readMediaMimeType(value.mimeType) ? { mimeType: readMediaMimeType(value.mimeType) } : {}),
    origin: readMediaOrigin(value.origin),
    ...(typeof value.createdAtMs === 'number' && Number.isInteger(value.createdAtMs) && value.createdAtMs >= 0
      ? { createdAtMs: value.createdAtMs }
      : {}),
  };

  const parsed = SessionMediaFailureV1Schema.safeParse(failure);
  return parsed.success
    ? selectSessionMediaFailureFields(parsed.data)
    : {
        index,
        code: 'unavailable',
        role: failure.role,
        category: failure.category,
        mediaKind: 'image',
        name: `image-${index + 1}`,
        origin: { source: 'provider-generated' },
      };
}

function selectSessionMediaFailureFields(failure: SessionMediaFailureV1): SessionMediaFailureV1 {
  return {
    index: failure.index,
    code: failure.code,
    role: failure.role,
    category: failure.category,
    mediaKind: 'image',
    name: failure.name,
    ...(failure.mimeType ? { mimeType: failure.mimeType } : {}),
    origin: {
      source: failure.origin.source,
      ...(failure.origin.agentId ? { agentId: failure.origin.agentId } : {}),
      ...(failure.origin.toolCallId ? { toolCallId: failure.origin.toolCallId } : {}),
      ...(failure.origin.generationId ? { generationId: failure.origin.generationId } : {}),
      ...(failure.origin.agentEventId ? { agentEventId: failure.origin.agentEventId } : {}),
      ...(failure.origin.providerFileId ? { providerFileId: failure.origin.providerFileId } : {}),
    },
    ...(failure.createdAtMs !== undefined ? { createdAtMs: failure.createdAtMs } : {}),
  };
}

function hasForbiddenDurableMediaKey(value: Record<string, unknown>): boolean {
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_DURABLE_MEDIA_KEYS.has(key)) return true;
    if (Array.isArray(child)) {
      for (const item of child) {
        const itemRecord = asRecord(item);
        if (itemRecord && hasForbiddenDurableMediaKey(itemRecord)) return true;
      }
      continue;
    }
    const childRecord = asRecord(child);
    if (childRecord && hasForbiddenDurableMediaKey(childRecord)) return true;
  }
  return false;
}

function sanitizeDurableSessionMediaItem(mediaRecord: Record<string, unknown>): SessionMediaItemV1 | null {
  if (hasForbiddenDurableMediaKey(mediaRecord)) return null;
  const candidate = {
    id: mediaRecord.id,
    role: mediaRecord.role,
    category: mediaRecord.category,
    mediaKind: mediaRecord.mediaKind,
    mimeType: mediaRecord.mimeType,
    name: mediaRecord.name,
    path: mediaRecord.path,
    sizeBytes: mediaRecord.sizeBytes,
    ...(mediaRecord.sha256 !== undefined ? { sha256: mediaRecord.sha256 } : {}),
    ...(mediaRecord.width !== undefined ? { width: mediaRecord.width } : {}),
    ...(mediaRecord.height !== undefined ? { height: mediaRecord.height } : {}),
    ...(mediaRecord.createdAtMs !== undefined ? { createdAtMs: mediaRecord.createdAtMs } : {}),
    origin: readMediaOrigin(mediaRecord.origin),
  };
  const parsed = SessionMediaItemV1Schema.safeParse(candidate);
  if (!parsed.success || !isCanonicalSessionMediaWorkspacePath(parsed.data.path, parsed.data.category)) return null;
  const item = parsed.data;
  return {
    id: item.id,
    role: item.role,
    category: item.category,
    mediaKind: item.mediaKind,
    mimeType: item.mimeType,
    name: item.name,
    path: item.path,
    sizeBytes: item.sizeBytes,
    ...(item.sha256 ? { sha256: item.sha256 } : {}),
    ...(item.mediaKind === 'image' && item.width !== undefined ? { width: item.width } : {}),
    ...(item.mediaKind === 'image' && item.height !== undefined ? { height: item.height } : {}),
    ...(item.createdAtMs !== undefined ? { createdAtMs: item.createdAtMs } : {}),
    origin: readMediaOrigin(item.origin),
  };
}

async function adoptSessionMediaEnvelope(params: Readonly<{
  envelope: unknown;
  sessionId: string;
  messageLocalId: string;
  workingDirectory: string;
  sourceReadRoots?: readonly string[];
  onCreatedWorkspacePath?: (path: string) => void;
  onAdoptedStagedWorkspacePath?: (path: string) => void;
}>): Promise<unknown> {
  const envelope = asRecord(params.envelope);
  if (!envelope || envelope.kind !== SESSION_MEDIA_ENVELOPE_KIND) return params.envelope;
  const payload = asRecord(envelope.payload);
  const media = Array.isArray(payload?.media) ? payload.media : [];
  const existingFailures = Array.isArray(payload?.failures) ? payload.failures : [];
  if (media.length === 0 && existingFailures.length === 0) return params.envelope;

  const adoptedMedia: unknown[] = [];
  const failures: SessionMediaFailureV1[] = [];
  const pathAllowanceRegistry = createTransferPathAllowanceRegistry();
  const sourceAccessRoots = [
    params.workingDirectory,
    ...(params.sourceReadRoots ?? []).filter((root) => typeof root === 'string' && root.trim().length > 0),
  ];

  for (const [index, mediaValue] of media.entries()) {
    const mediaRecord = asRecord(mediaValue);
    if (!mediaRecord) {
      failures.push(buildUnavailableMediaFailure({ index, mediaRecord: null, code: 'malformed_media_record' }));
      continue;
    }

    const stagedSource = asRecord(mediaRecord.stagedSource);
    if (
      stagedSource?.kind === HISTORICAL_IMPORT_STAGED_MEDIA_KIND
      && typeof stagedSource.data === 'string'
      && typeof stagedSource.mimeType === 'string'
    ) {
      const category = readMediaCategory(mediaRecord.category);
      const result = await persistSessionMedia({
        workingDirectory: params.workingDirectory,
        pathAllowanceRegistry,
        input: {
          sessionId: params.sessionId,
          messageLocalId: params.messageLocalId,
          role: readMediaRole(mediaRecord.role),
          category,
          source: {
            kind: 'base64',
            data: stagedSource.data,
            mimeType: stagedSource.mimeType,
            ...(readString(stagedSource.fileNameHint)
              ? { fileNameHint: readString(stagedSource.fileNameHint)! }
              : {}),
          },
          origin: readMediaOrigin(mediaRecord.origin),
        },
      });
      if (result.success) {
        adoptedMedia.push(result.item);
        if (result.created) params.onCreatedWorkspacePath?.(result.item.path);
        params.onAdoptedStagedWorkspacePath?.(result.item.path);
      } else {
        failures.push(buildUnavailableMediaFailure({ index, mediaRecord, code: result.code }));
      }
      continue;
    }

    const path = readString(mediaRecord.path);
    if (!path) {
      failures.push(buildUnavailableMediaFailure({ index, mediaRecord, code: 'missing_source_path' }));
      continue;
    }

    const category = readMediaCategory(mediaRecord.category);
    if (isDurableSessionMediaWorkspacePath(path, category)) {
      const sanitized = sanitizeDurableSessionMediaItem(mediaRecord);
      if (sanitized) {
        adoptedMedia.push(sanitized);
      } else {
        failures.push(buildUnavailableMediaFailure({ index, mediaRecord, code: 'invalid_media_record' }));
      }
      continue;
    }

    if (isCanonicalSessionMediaWorkspacePath(path)) {
      failures.push(buildUnavailableMediaFailure({ index, mediaRecord, code: 'invalid_media_record' }));
      continue;
    }

    if (/^https?:\/\//iu.test(path) || /^data:/iu.test(path)) {
      failures.push(buildUnavailableMediaFailure({ index, mediaRecord, code: 'unsupported_source_path' }));
      continue;
    }

    const result: PersistSessionMediaResult = await persistSessionMedia({
      workingDirectory: params.workingDirectory,
      sourceAccessPolicy: { kind: 'restrictedRoots', roots: sourceAccessRoots },
      pathAllowanceRegistry,
      input: {
        sessionId: params.sessionId,
        messageLocalId: params.messageLocalId,
        role: readMediaRole(mediaRecord.role),
        category,
        source: path.startsWith('file://')
          ? {
              kind: 'local-uri',
              uri: path,
              ...(readString(mediaRecord.mimeType) ? { mimeType: readString(mediaRecord.mimeType)! } : {}),
              ...(readString(mediaRecord.name) ? { fileNameHint: readString(mediaRecord.name)! } : {}),
            }
          : {
              kind: 'local-file',
              path,
              ...(readString(mediaRecord.mimeType) ? { mimeType: readString(mediaRecord.mimeType)! } : {}),
              ...(readString(mediaRecord.name) ? { fileNameHint: readString(mediaRecord.name)! } : {}),
            },
        origin: readMediaOrigin(mediaRecord.origin),
      },
    });

    if (result.success) {
      adoptedMedia.push(result.item);
      if (result.created) params.onCreatedWorkspacePath?.(result.item.path);
    } else {
      failures.push(buildUnavailableMediaFailure({ index, mediaRecord, code: result.code }));
    }
  }

  for (const [offset, failureValue] of existingFailures.entries()) {
    const failureRecord = asRecord(failureValue);
    failures.push(sanitizeUnavailableMediaFailure({
      index: typeof failureRecord?.index === 'number' ? failureRecord.index : media.length + offset,
      code: failureRecord?.code,
      role: failureRecord?.role,
      category: failureRecord?.category,
      name: failureRecord?.name,
      mimeType: failureRecord?.mimeType,
      origin: failureRecord?.origin,
      createdAtMs: failureRecord?.createdAtMs,
    }));
  }

  if (adoptedMedia.length === 0 && failures.length === 0) return undefined;
  return {
    kind: SESSION_MEDIA_ENVELOPE_KIND,
    payload: {
      media: adoptedMedia,
      ...(failures.length > 0 ? { failures } : {}),
    },
  };
}

async function stageSessionMediaEnvelope(params: Readonly<{
  envelope: unknown;
  workingDirectory: string;
  sourceReadRoots?: readonly string[];
}>): Promise<unknown> {
  const envelope = asRecord(params.envelope);
  if (!envelope || envelope.kind !== SESSION_MEDIA_ENVELOPE_KIND) return params.envelope;
  const payload = asRecord(envelope.payload);
  const media = Array.isArray(payload?.media) ? payload.media : [];
  if (media.length === 0) return params.envelope;

  const sourceAccessRoots = [
    params.workingDirectory,
    ...(params.sourceReadRoots ?? []).filter((root) => typeof root === 'string' && root.trim().length > 0),
  ];
  const stagedMedia: unknown[] = [];
  for (const mediaValue of media) {
    const mediaRecord = asRecord(mediaValue);
    if (!mediaRecord) {
      stagedMedia.push(mediaValue);
      continue;
    }
    const path = readString(mediaRecord.path);
    const category = readMediaCategory(mediaRecord.category);
    if (
      !path
      || isDurableSessionMediaWorkspacePath(path, category)
      || isCanonicalSessionMediaWorkspacePath(path)
      || /^https?:\/\//iu.test(path)
      || /^data:/iu.test(path)
    ) {
      stagedMedia.push(mediaValue);
      continue;
    }
    const prepared = await prepareSource({
      source: path.startsWith('file://')
        ? {
            kind: 'local-uri',
            uri: path,
            ...(readString(mediaRecord.mimeType) ? { mimeType: readString(mediaRecord.mimeType)! } : {}),
            ...(readString(mediaRecord.name) ? { fileNameHint: readString(mediaRecord.name)! } : {}),
          }
        : {
            kind: 'local-file',
            path,
            ...(readString(mediaRecord.mimeType) ? { mimeType: readString(mediaRecord.mimeType)! } : {}),
            ...(readString(mediaRecord.name) ? { fileNameHint: readString(mediaRecord.name)! } : {}),
          },
      workingDirectory: params.workingDirectory,
      accessPolicy: { kind: 'restrictedRoots', roots: sourceAccessRoots },
      maxBytes: configuration.filesUploadMaxFileBytes,
      suggestedName: readString(mediaRecord.name) ?? undefined,
    });
    if (!('kind' in prepared)) {
      throw new Error(prepared.code);
    }
    const {
      path: _sourcePath,
      stagedSource: _existingStagedSource,
      ...mediaWithoutSource
    } = mediaRecord;
    stagedMedia.push({
      ...mediaWithoutSource,
      stagedSource: {
        kind: HISTORICAL_IMPORT_STAGED_MEDIA_KIND,
        data: prepared.bytes.toString('base64'),
        mimeType: prepared.mimeType,
        ...(prepared.suggestedName
          ? { fileNameHint: prepared.suggestedName }
          : {}),
      },
    });
  }

  return {
    ...envelope,
    payload: {
      ...payload,
      media: stagedMedia,
    },
  };
}

export async function stageSessionMediaMetadataForHistoricalImport(params: Readonly<{
  raw: Record<string, unknown>;
  workingDirectory: string | null;
  sourceReadRoots?: readonly string[];
}>): Promise<Record<string, unknown>> {
  const meta = asRecord(params.raw.meta);
  if (!meta) return params.raw;
  if (!params.workingDirectory) {
    const hasMedia = [meta.happier, meta.happierMedia].some((value) => {
      const envelope = asRecord(value);
      const payload = asRecord(envelope?.payload);
      return envelope?.kind === SESSION_MEDIA_ENVELOPE_KIND
        && Array.isArray(payload?.media)
        && payload.media.length > 0;
    });
    if (hasMedia) {
      throw new Error('historical_import_media_working_directory_unavailable');
    }
    return params.raw;
  }
  const nextMeta: Record<string, unknown> = { ...meta };
  const primary = await stageSessionMediaEnvelope({
    envelope: nextMeta.happier,
    workingDirectory: params.workingDirectory,
    sourceReadRoots: params.sourceReadRoots,
  });
  const secondary = await stageSessionMediaEnvelope({
    envelope: nextMeta.happierMedia,
    workingDirectory: params.workingDirectory,
    sourceReadRoots: params.sourceReadRoots,
  });
  if (primary === undefined) {
    delete nextMeta.happier;
  } else {
    nextMeta.happier = primary;
  }
  if (secondary === undefined) {
    delete nextMeta.happierMedia;
  } else {
    nextMeta.happierMedia = secondary;
  }
  return { ...params.raw, meta: nextMeta };
}

export function countStagedSessionMediaMetadata(raw: Record<string, unknown>): number {
  const meta = asRecord(raw.meta);
  if (!meta) return 0;
  let count = 0;
  for (const value of [meta.happier, meta.happierMedia]) {
    const envelope = asRecord(value);
    const payload = asRecord(envelope?.payload);
    const media = Array.isArray(payload?.media) ? payload.media : [];
    for (const mediaValue of media) {
      const stagedSource = asRecord(asRecord(mediaValue)?.stagedSource);
      if (stagedSource?.kind === HISTORICAL_IMPORT_STAGED_MEDIA_KIND) count += 1;
    }
  }
  return count;
}

function projectStagedEnvelopeForValidation(params: Readonly<{
  envelope: unknown;
  sessionId: string;
  messageLocalId: string;
}>): unknown {
  const envelope = asRecord(params.envelope);
  if (!envelope || envelope.kind !== SESSION_MEDIA_ENVELOPE_KIND) return params.envelope;
  const payload = asRecord(envelope.payload);
  const media = Array.isArray(payload?.media) ? payload.media : [];
  return {
    ...envelope,
    payload: {
      ...payload,
      media: media.map((mediaValue) => {
        const mediaRecord = asRecord(mediaValue);
        const stagedSource = asRecord(mediaRecord?.stagedSource);
        if (
          !mediaRecord
          || stagedSource?.kind !== HISTORICAL_IMPORT_STAGED_MEDIA_KIND
          || typeof stagedSource.data !== 'string'
          || typeof stagedSource.mimeType !== 'string'
        ) {
          return mediaValue;
        }
        const bytes = Buffer.from(stagedSource.data, 'base64');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const category = readMediaCategory(mediaRecord.category);
        const transferCategory = category === 'attachment'
          ? 'messages'
          : category === 'tool-artifact'
            ? 'artifacts'
            : 'generated';
        const mimeType = stagedSource.mimeType as SupportedSessionMediaMimeType;
        const extension = extensionForSessionMediaMimeType(mimeType);
        const conservativeFileName = `${'x'.repeat(220)}${extension}`;
        return {
          id: sha256.slice(0, 16),
          role: readMediaRole(mediaRecord.role),
          category,
          mediaKind: sessionMediaKindForMimeType(mimeType),
          mimeType,
          // Validation must never undercount the publish-time socket item. Persisted names are
          // capped at 200 characters plus hash/collision suffix; this private projection stays
          // deliberately longer and includes the largest JSON-width image dimensions.
          name: conservativeFileName,
          path: `.happier/uploads/${transferCategory}/${params.sessionId}/${params.messageLocalId}/${sha256.slice(0, 12)}-${conservativeFileName}`,
          sizeBytes: bytes.byteLength,
          sha256,
          width: Number.MAX_SAFE_INTEGER,
          height: Number.MAX_SAFE_INTEGER,
          origin: readMediaOrigin(mediaRecord.origin),
        };
      }),
    },
  };
}

export function projectSessionMediaMetadataForHistoricalImportValidation(params: Readonly<{
  raw: Record<string, unknown>;
  sessionId: string;
  messageLocalId: string;
}>): Record<string, unknown> {
  const meta = asRecord(params.raw.meta);
  if (!meta) return params.raw;
  return {
    ...params.raw,
    meta: {
      ...meta,
      happier: projectStagedEnvelopeForValidation({
        envelope: meta.happier,
        sessionId: params.sessionId,
        messageLocalId: params.messageLocalId,
      }),
      happierMedia: projectStagedEnvelopeForValidation({
        envelope: meta.happierMedia,
        sessionId: params.sessionId,
        messageLocalId: params.messageLocalId,
      }),
    },
  };
}

export async function adoptSessionMediaMetadataForManagedSession(params: Readonly<{
  raw: Record<string, unknown>;
  sessionId: string;
  messageLocalId: string;
  workingDirectory: string | null;
  sourceReadRoots?: readonly string[];
  onCreatedWorkspacePath?: (path: string) => void;
  onAdoptedStagedWorkspacePath?: (path: string) => void;
}>): Promise<Record<string, unknown>> {
  if (!params.workingDirectory) return params.raw;
  const meta = asRecord(params.raw.meta);
  if (!meta) return params.raw;

  const nextMeta: Record<string, unknown> = { ...meta };
  const primary = await adoptSessionMediaEnvelope({
    envelope: nextMeta.happier,
    sessionId: params.sessionId,
    messageLocalId: params.messageLocalId,
    workingDirectory: params.workingDirectory,
    sourceReadRoots: params.sourceReadRoots,
    onCreatedWorkspacePath: params.onCreatedWorkspacePath,
    onAdoptedStagedWorkspacePath: params.onAdoptedStagedWorkspacePath,
  });
  const secondary = await adoptSessionMediaEnvelope({
    envelope: nextMeta.happierMedia,
    sessionId: params.sessionId,
    messageLocalId: params.messageLocalId,
    workingDirectory: params.workingDirectory,
    sourceReadRoots: params.sourceReadRoots,
    onCreatedWorkspacePath: params.onCreatedWorkspacePath,
    onAdoptedStagedWorkspacePath: params.onAdoptedStagedWorkspacePath,
  });

  if (primary === undefined) {
    delete nextMeta.happier;
  } else {
    nextMeta.happier = primary;
  }
  if (secondary === undefined) {
    delete nextMeta.happierMedia;
  } else {
    nextMeta.happierMedia = secondary;
  }

  return { ...params.raw, meta: nextMeta };
}
