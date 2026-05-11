import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';

import type { SessionMediaOrigin } from './_types';
import {
  persistSessionMedia,
  type PersistSessionMediaResult,
} from './persistSessionMedia';
import {
  normalizeReferencedSessionMediaWorkspacePath,
} from './referencedPaths';

const SESSION_MEDIA_ENVELOPE_KIND = 'session_media.v1';

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

function readMediaOrigin(value: unknown): SessionMediaOrigin {
  const record = asRecord(value);
  const source = record?.source;
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
    ...(readString(record?.agentId) ? { agentId: readString(record?.agentId)! } : {}),
    ...(readString(record?.toolCallId) ? { toolCallId: readString(record?.toolCallId)! } : {}),
    ...(readString(record?.generationId) ? { generationId: readString(record?.generationId)! } : {}),
    ...(readString(record?.providerEventId) ? { providerEventId: readString(record?.providerEventId)! } : {}),
    ...(readString(record?.providerFileId) ? { providerFileId: readString(record?.providerFileId)! } : {}),
  };
}

function isDurableSessionMediaWorkspacePath(path: string): boolean {
  return normalizeReferencedSessionMediaWorkspacePath(path) !== null;
}

async function adoptSessionMediaEnvelope(params: Readonly<{
  envelope: unknown;
  sessionId: string;
  messageLocalId: string;
  workingDirectory: string;
}>): Promise<unknown> {
  const envelope = asRecord(params.envelope);
  if (!envelope || envelope.kind !== SESSION_MEDIA_ENVELOPE_KIND) return params.envelope;
  const payload = asRecord(envelope.payload);
  const media = Array.isArray(payload?.media) ? payload.media : [];
  if (media.length === 0) return params.envelope;

  const adoptedMedia: unknown[] = [];
  const pathAllowanceRegistry = createTransferPathAllowanceRegistry();

  for (const mediaValue of media) {
    const mediaRecord = asRecord(mediaValue);
    const path = readString(mediaRecord?.path);
    if (!mediaRecord || !path) continue;

    if (isDurableSessionMediaWorkspacePath(path)) {
      adoptedMedia.push(mediaRecord);
      continue;
    }

    if (/^https?:\/\//iu.test(path) || /^data:/iu.test(path)) {
      continue;
    }

    const result: PersistSessionMediaResult = await persistSessionMedia({
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
    }
  }

  if (adoptedMedia.length === 0) return undefined;
  return {
    kind: SESSION_MEDIA_ENVELOPE_KIND,
    payload: { media: adoptedMedia },
  };
}

export async function adoptSessionMediaMetadataForManagedSession(params: Readonly<{
  raw: Record<string, unknown>;
  sessionId: string;
  messageLocalId: string;
  workingDirectory: string | null;
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
  });
  const secondary = await adoptSessionMediaEnvelope({
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
