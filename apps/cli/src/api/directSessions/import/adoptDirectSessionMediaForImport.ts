import { SESSION_MEDIA_MESSAGE_META_KIND_V1 } from '@happier-dev/protocol';

import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { persistSessionMediaItem, type PersistSessionMediaInput } from '@/session/sessionMedia/persistSessionMediaItem';
import type { SessionMediaOrigin } from '@/session/sessionMedia/sessionMediaIngestionSource';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isDurableSessionMediaPath(value: string): boolean {
  if (!value.startsWith('.happier/uploads/')) return false;
  if (value.includes('\\') || value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) return false;
  if (value.startsWith('file://') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..');
}

function readMediaOrigin(value: unknown): SessionMediaOrigin {
  const record = asRecord(value);
  const source = record?.source;
  const normalizedSource: SessionMediaOrigin['source'] =
    source === 'user-upload' ||
    source === 'provider-generated' ||
    source === 'tool-output' ||
    source === 'acp-content' ||
    source === 'mcp-content' ||
    source === 'local-file'
      ? source
      : 'provider-generated';

  return {
    source: normalizedSource,
    ...(readString(record?.agentId) ? { agentId: readString(record?.agentId)! } : {}),
    ...(readString(record?.toolCallId) ? { toolCallId: readString(record?.toolCallId)! } : {}),
    ...(readString(record?.generationId) ? { generationId: readString(record?.generationId)! } : {}),
    ...(readString(record?.providerEventId) ? { providerEventId: readString(record?.providerEventId)! } : {}),
    ...(readString(record?.providerFileId) ? { providerFileId: readString(record?.providerFileId)! } : {}),
  };
}

function readMediaCategory(value: unknown): PersistSessionMediaInput['category'] {
  return value === 'attachment' || value === 'generated' || value === 'tool-artifact' ? value : 'generated';
}

function readMediaRole(value: unknown): PersistSessionMediaInput['role'] {
  return value === 'input' || value === 'output' ? value : 'output';
}

async function adoptDirectSessionMediaEnvelope(params: Readonly<{
  envelope: unknown;
  sessionId: string;
  messageLocalId: string;
  workingDirectory: string;
}>): Promise<unknown> {
  const envelope = asRecord(params.envelope);
  if (!envelope || envelope.kind !== SESSION_MEDIA_MESSAGE_META_KIND_V1) return params.envelope;
  const payload = asRecord(envelope.payload);
  const media = Array.isArray(payload?.media) ? payload.media : [];
  if (media.length === 0) return params.envelope;

  const adoptedMedia: unknown[] = [];
  const pathAllowanceRegistry = createTransferPathAllowanceRegistry();

  for (const mediaValue of media) {
    const mediaRecord = asRecord(mediaValue);
    const path = readString(mediaRecord?.path);
    if (!mediaRecord || !path) continue;

    if (isDurableSessionMediaPath(path)) {
      adoptedMedia.push(mediaRecord);
      continue;
    }

    let result: Awaited<ReturnType<typeof persistSessionMediaItem>>;
    try {
      result = await persistSessionMediaItem({
        workingDirectory: params.workingDirectory,
        pathAllowanceRegistry,
        input: {
          sessionId: params.sessionId,
          messageLocalId: params.messageLocalId,
          role: readMediaRole(mediaRecord.role),
          category: readMediaCategory(mediaRecord.category),
          source: path.startsWith('file://')
            ? {
                kind: 'local-uri',
                uri: path,
                ...(readString(mediaRecord.mimeType) ? { mimeType: readString(mediaRecord.mimeType)! } : {}),
                ...(readString(mediaRecord.name) ? { suggestedName: readString(mediaRecord.name)! } : {}),
              }
            : {
                kind: 'local-file',
                path,
                ...(readString(mediaRecord.mimeType) ? { mimeType: readString(mediaRecord.mimeType)! } : {}),
                ...(readString(mediaRecord.name) ? { suggestedName: readString(mediaRecord.name)! } : {}),
              },
          origin: readMediaOrigin(mediaRecord.origin),
        },
      });
    } catch {
      continue;
    }

    if (result.success) {
      adoptedMedia.push(result.item);
    }
  }

  if (adoptedMedia.length === 0) return undefined;
  return {
    kind: SESSION_MEDIA_MESSAGE_META_KIND_V1,
    payload: { media: adoptedMedia },
  };
}

export async function adoptDirectSessionMediaForImport(params: Readonly<{
  raw: Record<string, unknown>;
  sessionId: string;
  messageLocalId: string;
  workingDirectory: string | null;
}>): Promise<Record<string, unknown>> {
  if (!params.workingDirectory) return params.raw;
  const meta = asRecord(params.raw.meta);
  if (!meta) return params.raw;

  const nextMeta: Record<string, unknown> = { ...meta };
  const primary = await adoptDirectSessionMediaEnvelope({
    envelope: nextMeta.happier,
    sessionId: params.sessionId,
    messageLocalId: params.messageLocalId,
    workingDirectory: params.workingDirectory,
  });
  const secondary = await adoptDirectSessionMediaEnvelope({
    envelope: nextMeta.happierMedia,
    sessionId: params.sessionId,
    messageLocalId: params.messageLocalId,
    workingDirectory: params.workingDirectory,
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
