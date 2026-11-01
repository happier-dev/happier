import { createHash } from 'node:crypto';

import type {
  SessionMediaDiagnostic,
  SessionMediaSource,
  SessionMediaSourceOrigin,
} from '@/agent/core/AgentMessage';
import {
  resolveSessionMediaMimeType,
  sniffSessionMediaMimeTypeFromBase64,
} from '@/session/sessionMedia/sessionMediaMime';

type ExtractMediaOptions = Readonly<{
  source: string;
  originSource: SessionMediaSourceOrigin['source'];
  toolCallId?: string;
  providerEventId?: string;
  generationId?: string;
  dedupePrefix?: string;
}>;

export type ExtractedAcpMediaContent = Readonly<{
  media: SessionMediaSource[];
  diagnostics: SessionMediaDiagnostic[];
  /** Inline payloads to redact from transcript copies, including rejected formats. */
  inlineData: string[];
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeMimeType(value: unknown): string | null {
  const raw = readString(value);
  return raw ? raw.toLowerCase() : null;
}

function readMimeType(record: Record<string, unknown>): string | null {
  return normalizeMimeType(record.mimeType ?? record.mime_type ?? record.mediaType ?? record.media_type);
}

function readData(record: Record<string, unknown>): string | null {
  return readString(record.data) ?? readString(record.blob);
}

function readUri(record: Record<string, unknown>): string | null {
  return readString(record.uri) ?? readString(record.url);
}

function readSuggestedName(record: Record<string, unknown>): string | undefined {
  const raw = readString(record.name) ?? readString(record.filename);
  if (!raw) return undefined;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > 160 ? cleaned.slice(0, 160).trim() : cleaned;
}

function isHttpUri(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

function contentItems(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  const record = asRecord(content);
  if (record && Array.isArray(record.content)) return record.content;
  return content === undefined || content === null ? [] : [content];
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function buildOrigin(options: ExtractMediaOptions, contentIndex: number): SessionMediaSourceOrigin {
  return {
    source: options.originSource,
    ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
    ...(options.providerEventId ? { providerEventId: options.providerEventId } : {}),
    ...(options.generationId ? { generationId: options.generationId } : {}),
    contentIndex,
  };
}

function buildDedupeKey(params: Readonly<{
  options: ExtractMediaOptions;
  contentIndex: number;
  data?: string;
  uri?: string;
}>): string {
  const prefix = params.options.dedupePrefix ?? params.options.source;
  const stableId =
    params.options.providerEventId ??
    params.options.generationId ??
    params.options.toolCallId ??
    null;
  const fingerprint = params.data ? hashText(params.data) : params.uri ? hashText(params.uri) : null;
  if (fingerprint) return `${prefix}:${stableId ?? 'content'}:${fingerprint}`;
  if (stableId) return `${prefix}:${stableId}:${params.contentIndex}`;
  return `${prefix}:content:${params.contentIndex}:unknown`;
}

function diagnostic(
  code: SessionMediaDiagnostic['code'],
  contentIndex: number,
  message: string,
): SessionMediaDiagnostic {
  return { code, contentIndex, message };
}

function readNestedResource(record: Record<string, unknown>): Record<string, unknown> {
  const resource = asRecord(record.resource);
  return resource ? { ...record, ...resource } : record;
}

function readAnthropicImage(record: Record<string, unknown>): Record<string, unknown> | null {
  const source = asRecord(record.source);
  if (!source || source.type !== 'base64') return null;
  return {
    type: 'image',
    data: source.data,
    mimeType: source.media_type ?? source.mimeType,
  };
}

export function extractAcpMediaContentBlocks(
  content: unknown,
  options: ExtractMediaOptions,
): ExtractedAcpMediaContent {
  const media: SessionMediaSource[] = [];
  const diagnostics: SessionMediaDiagnostic[] = [];
  const inlineData: string[] = [];

  contentItems(content).forEach((item, contentIndex) => {
    const rawRecord = asRecord(item);
    if (!rawRecord) return;

    const anthropicRecord = rawRecord.type === 'image' ? readAnthropicImage(rawRecord) : null;
    const record = readNestedResource(anthropicRecord ?? rawRecord);
    const type = readString(record.type)?.toLowerCase() ?? null;

    if (type === 'audio') {
      diagnostics.push(diagnostic(
        'unsupported_audio',
        contentIndex,
        'ACP/MCP audio content is diagnostic-only in this version',
      ));
      return;
    }

    const declaredMimeType = readMimeType(record);
    const isImageLike =
      type === 'image' ||
      type === 'resource' ||
      type === 'resource_link' ||
      type === 'blob' ||
      (declaredMimeType?.startsWith('image/') ?? false);
    if (!isImageLike) return;

    const data = readData(record);
    const uri = readUri(record);
    const origin = buildOrigin(options, contentIndex);
    const suggestedName = readSuggestedName(record);

    if (data) {
      inlineData.push(data);
      const mimeType = sniffSessionMediaMimeTypeFromBase64(data);
      if (!mimeType) {
        diagnostics.push(diagnostic('unsupported_mime', contentIndex, 'Unsupported image MIME type'));
        return;
      }
      const localUri = uri && !isHttpUri(uri) ? uri : undefined;
      media.push({
        kind: 'base64',
        data,
        mimeType,
        ...(suggestedName ? { suggestedName } : {}),
        ...(localUri ? { uri: localUri } : {}),
        origin,
        dedupeKey: buildDedupeKey({ options, contentIndex, data }),
      });
      return;
    }

    if (uri) {
      const mimeType = resolveSessionMediaMimeType({
        ...(declaredMimeType ? { declaredMimeType } : {}),
        ...(suggestedName ? { suggestedName } : {}),
      });
      if (!mimeType) {
        diagnostics.push(diagnostic('unsupported_mime', contentIndex, 'Unsupported image MIME type'));
        return;
      }

      if (isHttpUri(uri)) {
        diagnostics.push(diagnostic(
          'http_uri_unavailable',
          contentIndex,
          'HTTP(S) media URI ingestion is unavailable in this version',
        ));
        return;
      }

      media.push({
        kind: 'local-uri',
        uri,
        mimeType,
        ...(suggestedName ? { suggestedName } : {}),
        origin,
        dedupeKey: buildDedupeKey({ options, contentIndex, uri }),
      });
      return;
    }

    diagnostics.push(diagnostic('malformed_media_block', contentIndex, 'Image media block has no data or URI'));
  });

  return { media, diagnostics, inlineData };
}

export function emitSessionMediaExtractionResult(params: Readonly<{
  result: ExtractedAcpMediaContent;
  source: string;
  emit: (message: { type: 'session-media'; source: string; media: SessionMediaSource[] } | { type: 'event'; name: 'session_media_diagnostics'; payload: { diagnostics: SessionMediaDiagnostic[] } }) => void;
}>): boolean {
  let handled = false;
  if (params.result.media.length > 0) {
    params.emit({
      type: 'session-media',
      source: params.source,
      media: params.result.media,
    });
    handled = true;
  }
  if (params.result.diagnostics.length > 0) {
    params.emit({
      type: 'event',
      name: 'session_media_diagnostics',
      payload: { diagnostics: params.result.diagnostics },
    });
    handled = true;
  }
  return handled;
}
