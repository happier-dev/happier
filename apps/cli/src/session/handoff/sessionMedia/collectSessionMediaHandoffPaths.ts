import type { SessionHandoffProviderBundle } from '../types';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const SESSION_MEDIA_ENVELOPE_KIND = 'session_media.v1';
const ATTACHMENTS_ENVELOPE_KIND = 'attachments.v1';
const ATTACHMENT_MEDIA_PREFIX = '.happier/uploads/messages/';
const GENERATED_MEDIA_PREFIX = '.happier/uploads/generated/';
const ARTIFACT_MEDIA_PREFIX = '.happier/uploads/artifacts/';
const MAX_LITERAL_GIT_PATHSPEC_PATH_LENGTH = 500;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeDurableSessionMediaPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  if (!path || path.length > MAX_LITERAL_GIT_PATHSPEC_PATH_LENGTH) return null;
  if (path.includes('\0') || path.includes('\\')) return null;
  if (path.startsWith('/') || path.startsWith('file://') || /^[a-zA-Z]:[\\/]/.test(path)) return null;
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return path;
}

function readMediaEnvelopePaths(envelope: unknown): readonly string[] {
  const record = asRecord(envelope);
  if (!record || record.kind !== SESSION_MEDIA_ENVELOPE_KIND) return [];

  const payload = asRecord(record.payload);
  const media = Array.isArray(payload?.media) ? payload.media : [];
  const paths: string[] = [];
  for (const item of media) {
    const mediaRecord = asRecord(item);
    if (!mediaRecord) continue;
    const category = mediaRecord.category;
    if (category !== 'attachment' && category !== 'generated' && category !== 'tool-artifact') continue;

    const path = normalizeDurableSessionMediaPath(mediaRecord.path);
    if (!path) continue;

    if (
      (category === 'attachment' && path.startsWith(ATTACHMENT_MEDIA_PREFIX))
      || (category === 'generated' && path.startsWith(GENERATED_MEDIA_PREFIX))
      || (category === 'tool-artifact' && path.startsWith(ARTIFACT_MEDIA_PREFIX))
    ) {
      paths.push(path);
    }
  }
  return paths;
}

function readLegacyAttachmentEnvelopePaths(envelope: unknown): readonly string[] {
  const record = asRecord(envelope);
  if (!record || record.kind !== ATTACHMENTS_ENVELOPE_KIND) return [];

  const payload = asRecord(record.payload);
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  const paths: string[] = [];
  for (const item of attachments) {
    const attachmentRecord = asRecord(item);
    if (!attachmentRecord) continue;
    const path = normalizeDurableSessionMediaPath(attachmentRecord.path);
    if (path?.startsWith(ATTACHMENT_MEDIA_PREFIX)) {
      paths.push(path);
    }
  }
  return paths;
}

function readRecordMeta(record: unknown): Record<string, unknown> | null {
  const rawRecord = asRecord(record);
  const directMeta = asRecord(rawRecord?.meta);
  if (directMeta) return directMeta;

  const nestedRaw = asRecord(rawRecord?.raw);
  return asRecord(nestedRaw?.meta);
}

export function collectSessionMediaHandoffPaths(records: readonly unknown[]): readonly string[] {
  const paths = new Set<string>();
  for (const record of records) {
    const meta = readRecordMeta(record);
    if (!meta) continue;
    for (const path of readMediaEnvelopePaths(meta.happier)) {
      paths.add(path);
    }
    for (const path of readMediaEnvelopePaths(meta.happierMedia)) {
      paths.add(path);
    }
    for (const path of readLegacyAttachmentEnvelopePaths(meta.happier)) {
      paths.add(path);
    }
    for (const path of readLegacyAttachmentEnvelopePaths(meta.happierAttachments)) {
      paths.add(path);
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function decodeBase64Utf8(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

function parseJsonLines(text: string): readonly unknown[] {
  const records: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as unknown);
    } catch {
      // Provider transcripts can contain non-JSON diagnostics; ignore malformed rows.
    }
  }
  return records;
}

function parseOpenCodeExportRecords(text: string): readonly unknown[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed;

    const record = asRecord(parsed);
    const messages = Array.isArray(record?.messages) ? record.messages : [];
    return record ? [record, ...messages] : messages;
  } catch {
    return [];
  }
}

async function collectJsonLineMediaPathsFromFileSlice(file: Readonly<{
  filePath: string;
  offsetBytes: number;
  sizeBytes: number;
}>): Promise<readonly string[]> {
  if (file.sizeBytes === 0) return [];
  const stream = createReadStream(file.filePath, {
    start: file.offsetBytes,
    end: file.offsetBytes + file.sizeBytes - 1,
    encoding: 'utf8',
  });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const records: unknown[] = [];
  const paths = new Set<string>();
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as unknown);
    } catch {
      continue;
    }
    if (records.length >= 256) {
      for (const path of collectSessionMediaHandoffPaths(records)) paths.add(path);
      records.length = 0;
    }
  }
  for (const path of collectSessionMediaHandoffPaths(records)) paths.add(path);
  return [...paths].sort((left, right) => left.localeCompare(right));
}

export async function collectSessionMediaHandoffPathsFromProviderBundle(
  providerBundle: SessionHandoffProviderBundle | undefined,
): Promise<readonly string[]> {
  if (!providerBundle) return [];

  switch (providerBundle.providerId) {
    case 'claude':
      if (providerBundle.transcriptFile) {
        return await collectJsonLineMediaPathsFromFileSlice(providerBundle.transcriptFile);
      }
      return collectSessionMediaHandoffPaths(parseJsonLines(decodeBase64Utf8(providerBundle.transcriptBase64)));
    case 'codex':
      {
        const paths = new Set<string>();
        for (const file of providerBundle.files) {
          const filePaths = file.contentFile
            ? await collectJsonLineMediaPathsFromFileSlice(file.contentFile)
            : collectSessionMediaHandoffPaths(parseJsonLines(decodeBase64Utf8(file.contentBase64)));
          for (const path of filePaths) paths.add(path);
        }
        return [...paths].sort((left, right) => left.localeCompare(right));
      }
    case 'opencode':
      if (providerBundle.exportJsonFile) {
        const chunks: Buffer[] = [];
        for await (const chunk of createReadStream(providerBundle.exportJsonFile.filePath, {
          start: providerBundle.exportJsonFile.offsetBytes,
          end: providerBundle.exportJsonFile.offsetBytes + providerBundle.exportJsonFile.sizeBytes - 1,
        })) {
          chunks.push(Buffer.from(chunk));
        }
        return collectSessionMediaHandoffPaths(parseOpenCodeExportRecords(Buffer.concat(chunks).toString('utf8')));
      }
      return collectSessionMediaHandoffPaths(parseOpenCodeExportRecords(decodeBase64Utf8(providerBundle.exportJsonBase64)));
    default:
      return [];
  }
}
