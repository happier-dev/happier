import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSessionHandoffAgentBundleRecords } from '@/session/handoff/agentBundle/records';
import type { SessionHandoffAgentBundle } from '@/session/handoff/types';

const SESSION_MEDIA_ENVELOPE_KIND = 'session_media.v1';
const ATTACHMENTS_ENVELOPE_KIND = 'attachments.v1';
const ATTACHMENT_MEDIA_PREFIX = '.happier/uploads/messages/';
const GENERATED_MEDIA_PREFIX = '.happier/uploads/generated/';
const ARTIFACT_MEDIA_PREFIX = '.happier/uploads/artifacts/';
const MAX_REFERENCED_MEDIA_PATH_LENGTH = 500;

const FORBIDDEN_MEDIA_REFERENCE_KEYS = new Set([
  'data',
  'base64',
  'b64',
  'b64_json',
  'inlineData',
  'url',
  'uri',
  'fileUrl',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasForbiddenMediaReferenceKey(value: Record<string, unknown>): boolean {
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_MEDIA_REFERENCE_KEYS.has(key)) {
      return true;
    }
    if (Array.isArray(child)) {
      for (const item of child) {
        const itemRecord = asRecord(item);
        if (itemRecord && hasForbiddenMediaReferenceKey(itemRecord)) {
          return true;
        }
      }
      continue;
    }
    const childRecord = asRecord(child);
    if (childRecord && hasForbiddenMediaReferenceKey(childRecord)) {
      return true;
    }
  }
  return false;
}

export function normalizeReferencedSessionMediaWorkspacePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  if (!path || path.length > MAX_REFERENCED_MEDIA_PATH_LENGTH) return null;
  if (path.includes('\0') || path.includes('\\')) return null;
  if (
    path.startsWith('/')
    || /^[a-z]:[\\/]/i.test(path)
    || /^[a-z][a-z0-9+.-]*:/i.test(path)
  ) {
    return null;
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return path;
}

function readSessionMediaEnvelopePaths(envelope: unknown): readonly string[] {
  const record = asRecord(envelope);
  if (!record || record.kind !== SESSION_MEDIA_ENVELOPE_KIND) return [];
  if (hasForbiddenMediaReferenceKey(record)) return [];

  const payload = asRecord(record.payload);
  const media = Array.isArray(payload?.media) ? payload.media : [];
  const paths: string[] = [];
  for (const item of media) {
    const mediaRecord = asRecord(item);
    if (!mediaRecord || hasForbiddenMediaReferenceKey(mediaRecord)) continue;
    const category = mediaRecord.category;
    if (category !== 'attachment' && category !== 'generated' && category !== 'tool-artifact') continue;

    const path = normalizeReferencedSessionMediaWorkspacePath(mediaRecord.path);
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

export function isCanonicalSessionMediaWorkspacePath(
  path: string,
  category?: 'attachment' | 'generated' | 'tool-artifact',
): boolean {
  const normalizedPath = normalizeReferencedSessionMediaWorkspacePath(path);
  if (!normalizedPath) return false;

  if (category === 'attachment') return normalizedPath.startsWith(ATTACHMENT_MEDIA_PREFIX);
  if (category === 'generated') return normalizedPath.startsWith(GENERATED_MEDIA_PREFIX);
  if (category === 'tool-artifact') return normalizedPath.startsWith(ARTIFACT_MEDIA_PREFIX);

  return normalizedPath.startsWith(ATTACHMENT_MEDIA_PREFIX)
    || normalizedPath.startsWith(GENERATED_MEDIA_PREFIX)
    || normalizedPath.startsWith(ARTIFACT_MEDIA_PREFIX);
}

function isPathWithinAllowedRoots(path: string, allowedRoots: readonly string[]): boolean {
  const resolvedPath = resolve(path);
  return isResolvedPathWithinAllowedRoots(resolvedPath, allowedRoots);
}

function isResolvedPathWithinAllowedRoots(resolvedPath: string, allowedRoots: readonly string[]): boolean {
  for (const root of allowedRoots) {
    if (typeof root !== 'string' || root.trim().length === 0) continue;
    const resolvedRoot = resolve(root.trim());
    const rel = relative(resolvedRoot, resolvedPath);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) {
      return true;
    }
  }
  return false;
}

function isRealPathWithinAllowedRoots(realPath: string, allowedRoots: readonly string[]): boolean {
  for (const root of allowedRoots) {
    if (typeof root !== 'string' || root.trim().length === 0) continue;
    try {
      if (isResolvedPathWithinAllowedRoots(realPath, [realpathSync(root.trim())])) {
        return true;
      }
    } catch {
      // Invalid roots cannot safely authorize provider-controlled media paths.
    }
  }
  return false;
}

function realRegularFilePath(path: string): string | null {
  try {
    const linkOrFile = lstatSync(path);
    if (!linkOrFile.isFile() && !linkOrFile.isSymbolicLink()) return null;

    const realPath = realpathSync(path);
    return statSync(realPath).isFile() ? realPath : null;
  } catch {
    return null;
  }
}

function isTransientMediaFileAllowed(path: string, allowedRoots: readonly string[]): boolean {
  if (!isPathWithinAllowedRoots(path, allowedRoots)) return false;

  const realPath = realRegularFilePath(path);
  return realPath !== null && isRealPathWithinAllowedRoots(realPath, allowedRoots);
}

function readTransientSessionMediaFiles(
  envelope: unknown,
  options: Readonly<{ allowedRoots: readonly string[] }>,
): readonly string[] {
  const record = asRecord(envelope);
  if (!record || record.kind !== SESSION_MEDIA_ENVELOPE_KIND) return [];
  if (hasForbiddenMediaReferenceKey(record)) return [];

  const payload = asRecord(record.payload);
  const media = Array.isArray(payload?.media) ? payload.media : [];
  const files: string[] = [];
  for (const item of media) {
    const mediaRecord = asRecord(item);
    if (!mediaRecord || hasForbiddenMediaReferenceKey(mediaRecord)) continue;
    if (typeof mediaRecord.path !== 'string') continue;
    const path = mediaRecord.path.trim();
    if (!path || /^https?:\/\//iu.test(path) || /^data:/iu.test(path)) continue;

    if (path.startsWith('file://')) {
      try {
        const filePath = fileURLToPath(path);
        if (isTransientMediaFileAllowed(filePath, options.allowedRoots)) {
          files.push(filePath);
        }
      } catch {
        // Invalid provider file URI; ignore instead of broadening file access.
      }
      continue;
    }

    if (isAbsolute(path) && isTransientMediaFileAllowed(path, options.allowedRoots)) {
      files.push(path);
    }
  }
  return files;
}

function readLegacyAttachmentEnvelopePaths(envelope: unknown): readonly string[] {
  const record = asRecord(envelope);
  if (!record || record.kind !== ATTACHMENTS_ENVELOPE_KIND) return [];
  if (hasForbiddenMediaReferenceKey(record)) return [];

  const payload = asRecord(record.payload);
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  const paths: string[] = [];
  for (const item of attachments) {
    const attachmentRecord = asRecord(item);
    if (!attachmentRecord || hasForbiddenMediaReferenceKey(attachmentRecord)) continue;
    const path = normalizeReferencedSessionMediaWorkspacePath(attachmentRecord.path);
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

export function collectReferencedSessionMediaWorkspacePaths(records: readonly unknown[]): readonly string[] {
  const paths = new Set<string>();
  for (const record of records) {
    const meta = readRecordMeta(record);
    if (!meta) continue;
    for (const path of readSessionMediaEnvelopePaths(meta.happier)) paths.add(path);
    for (const path of readSessionMediaEnvelopePaths(meta.happierMedia)) paths.add(path);
    for (const path of readLegacyAttachmentEnvelopePaths(meta.happier)) paths.add(path);
    for (const path of readLegacyAttachmentEnvelopePaths(meta.happierAttachments)) paths.add(path);
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

export function collectTransientSessionMediaReadFiles(
  records: readonly unknown[],
  options: Readonly<{ allowedRoots: readonly string[] }>,
): readonly string[] {
  const files = new Set<string>();
  for (const record of records) {
    const meta = readRecordMeta(record);
    if (!meta) continue;
    for (const file of readTransientSessionMediaFiles(meta.happier, options)) files.add(file);
    for (const file of readTransientSessionMediaFiles(meta.happierMedia, options)) files.add(file);
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

export async function collectReferencedSessionMediaWorkspacePathsFromAgentBundle(
  agentBundle: SessionHandoffAgentBundle | undefined,
): Promise<readonly string[]> {
  if (!agentBundle) return [];
  return collectReferencedSessionMediaWorkspacePaths(
    await readSessionHandoffAgentBundleRecords(agentBundle),
  );
}

export function collectReferencedSessionMediaWorkspacePathsFromSessionMetadata(
  metadata: Record<string, unknown> | undefined,
): readonly string[] {
  const continuity = asRecord(metadata?.sessionMediaContinuityV1);
  const referencedPaths = Array.isArray(continuity?.referencedWorkspacePaths)
    ? continuity.referencedWorkspacePaths
    : [];
  const paths = new Set<string>();
  for (const value of referencedPaths) {
    if (typeof value !== 'string') continue;
    if (isCanonicalSessionMediaWorkspacePath(value)) {
      paths.add(value);
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}
