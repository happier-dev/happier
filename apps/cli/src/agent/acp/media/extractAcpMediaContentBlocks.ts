import type { SessionMediaBridgeInput } from '@/api/session/client/transcript/sessionMediaBridge';
import { decodeSessionMediaBase64Prefix } from '@/session/media/base64';
import {
  resolveSessionMediaMimeType,
  sniffSessionMediaMimeType,
} from '@/session/media/mime';
import type { SessionMediaOrigin } from '@/session/media/_types';

const BASE64_IMAGE_SNIFF_PREFIX_BYTES = 4096;

export type AcpSessionMediaDiagnostic = Readonly<{
  code: 'unsupported_audio' | 'unsupported_mime' | 'invalid_base64' | 'http_uri_unavailable' | 'malformed_media_block';
  contentIndex: number;
  message: string;
}>;

export type ExtractAcpMediaContentOptions = Readonly<{
  originSource: Extract<SessionMediaOrigin['source'], 'acp-content' | 'mcp-content' | 'provider-generated' | 'tool-output'>;
  toolCallId?: string;
  agentEventId?: string;
  generationId?: string;
}>;

export type ExtractedAcpMediaContent = Readonly<{
  media: SessionMediaBridgeInput[];
  diagnostics: AcpSessionMediaDiagnostic[];
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readMimeType(record: Record<string, unknown>): string | null {
  return readString(record.mimeType ?? record.mime_type ?? record.mediaType ?? record.media_type)?.toLowerCase() ?? null;
}

function readSuggestedName(record: Record<string, unknown>): string | undefined {
  const raw =
    readString(record.name)
    ?? readString(record.filename)
    ?? readString(record.fileName)
    ?? readNameFromUri(readUri(record));
  if (!raw) return undefined;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > 160 ? cleaned.slice(0, 160).trim() : cleaned;
}

function readNameFromUri(uri: string | null): string | null {
  if (!uri) return null;
  const withoutQuery = uri.split(/[?#]/, 1)[0] ?? uri;
  const match = withoutQuery.match(/([^/\\]+)$/);
  return match ? decodeURIComponent(match[1] ?? '') : null;
}

function readData(record: Record<string, unknown>): string | null {
  return readString(record.data)
    ?? readString(record.blob)
    ?? readString(record.b64)
    ?? readString(record.b64_json);
}

function readUri(record: Record<string, unknown>): string | null {
  return readString(record.uri) ?? readString(record.url);
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

function readNestedResource(record: Record<string, unknown>): Record<string, unknown> {
  const resource = asRecord(record.resource);
  return resource ? { ...record, ...resource } : record;
}

function readAnthropicImage(record: Record<string, unknown>): Record<string, unknown> | null {
  if (record.type !== 'image') return null;
  const source = asRecord(record.source);
  if (!source || source.type !== 'base64') return null;
  return {
    type: 'image',
    data: source.data,
    mimeType: source.media_type ?? source.mimeType,
    name: record.name ?? record.filename,
  };
}

function buildOrigin(options: ExtractAcpMediaContentOptions): SessionMediaOrigin {
  return {
    source: options.originSource,
    ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
    ...(options.agentEventId ? { agentEventId: options.agentEventId } : {}),
    ...(options.generationId ? { generationId: options.generationId } : {}),
  };
}

function diagnostic(
  code: AcpSessionMediaDiagnostic['code'],
  contentIndex: number,
  message: string,
): AcpSessionMediaDiagnostic {
  return { code, contentIndex, message };
}

export function extractAcpMediaContentBlocks(
  content: unknown,
  options: ExtractAcpMediaContentOptions,
): ExtractedAcpMediaContent {
  const media: SessionMediaBridgeInput[] = [];
  const diagnostics: AcpSessionMediaDiagnostic[] = [];

  contentItems(content).forEach((item, contentIndex) => {
    const rawRecord = asRecord(item);
    if (!rawRecord) return;

    const anthropicRecord = readAnthropicImage(rawRecord);
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
      type === 'image'
      || type === 'resource'
      || type === 'resource_link'
      || type === 'blob'
      || (declaredMimeType?.startsWith('image/') ?? false);
    if (!isImageLike) return;

    const data = readData(record);
    const uri = readUri(record);
    const suggestedName = readSuggestedName(record);
    const origin = buildOrigin(options);

    if (data) {
      const decoded = decodeSessionMediaBase64Prefix(data, BASE64_IMAGE_SNIFF_PREFIX_BYTES);
      if (!decoded.success) {
        diagnostics.push(diagnostic(decoded.code, contentIndex, decoded.error));
        return;
      }
      const mimeType = sniffSessionMediaMimeType(decoded.bytes);
      if (!mimeType) {
        diagnostics.push(diagnostic('unsupported_mime', contentIndex, 'Unsupported image MIME type'));
        return;
      }
      media.push({
        source: {
          kind: 'base64',
          data,
          mimeType,
          ...(suggestedName ? { fileNameHint: suggestedName } : {}),
        },
        origin,
        ...(suggestedName ? { suggestedName } : {}),
      });
      return;
    }

    if (uri) {
      if (isHttpUri(uri)) {
        diagnostics.push(diagnostic(
          'http_uri_unavailable',
          contentIndex,
          'HTTP(S) media URI ingestion is unavailable in this version',
        ));
        return;
      }
      const mimeType = resolveSessionMediaMimeType({
        ...(declaredMimeType ? { declaredMimeType } : {}),
        ...(suggestedName ? { suggestedName } : {}),
      });
      if (!mimeType) {
        diagnostics.push(diagnostic('unsupported_mime', contentIndex, 'Unsupported image MIME type'));
        return;
      }
      media.push({
        source: {
          kind: 'local-uri',
          uri,
          mimeType,
          ...(suggestedName ? { fileNameHint: suggestedName } : {}),
        },
        origin,
        ...(suggestedName ? { suggestedName } : {}),
      });
      return;
    }

    diagnostics.push(diagnostic('malformed_media_block', contentIndex, 'Image media block has no data or URI'));
  });

  return { media, diagnostics };
}
