import { decodeBase64 } from '@/api/encryption';
import { assertSessionAttachFilePathWithinBaseDir, resolveSessionAttachBaseDir } from '@/agent/runtime/sessionAttachPaths';
import { readSessionRoleForAttachPayload, SessionAttachPayloadSchema } from '@/agent/runtime/sessionAttachPayload';
import type { SessionRoleV1 } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { lstat, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

export type SessionAttachSecret =
  | Readonly<{ encryptionMode: 'plain'; lastObservedMessageSeq?: number; initialTranscriptAfterSeq?: number; sessionRoleV1?: SessionRoleV1 }>
  | Readonly<{ encryptionMode: 'e2ee'; encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey'; lastObservedMessageSeq?: number; initialTranscriptAfterSeq?: number; sessionRoleV1?: SessionRoleV1 }>;

function readNonNegativeIntegerProperty(payload: unknown, key: string): number | undefined {
  if (!payload || typeof payload !== 'object' || !(key in payload)) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export async function readSessionAttachFromEnv(): Promise<SessionAttachSecret | null> {
  const rawPath = typeof process.env.HAPPIER_SESSION_ATTACH_FILE === 'string' ? process.env.HAPPIER_SESSION_ATTACH_FILE.trim() : '';
  if (!rawPath) return null;
  delete process.env.HAPPIER_SESSION_ATTACH_FILE;

  const filePath = resolve(expandHomeDirPath(rawPath, process.env));
  const baseDir = resolveSessionAttachBaseDir(configuration.happyHomeDir, configuration.publicReleaseRing);

  // Safety: require attach file to live within the session-attach temp dir.
  // This prevents accidental reads from arbitrary locations when a user sets env vars manually.
  assertSessionAttachFilePathWithinBaseDir(baseDir, filePath);

  try {
    const s = await lstat(filePath);
    if (!s.isFile()) {
      throw new Error('Invalid session attach file');
    }
    if (process.platform !== 'win32') {
      // Ensure file is not readable by group/others (0600).
      if ((s.mode & 0o077) !== 0) {
        throw new Error('Session attach file permissions are too permissive');
      }
    }

    const raw = await readFile(filePath, 'utf-8');
    const parsed = SessionAttachPayloadSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger.debug('[sessionAttach] Failed to parse attach file', parsed.error);
      throw new Error('Invalid session attach file');
    }

    const payload = parsed.data;
    const lastObservedMessageSeq = readNonNegativeIntegerProperty(payload, 'lastObservedMessageSeq');
    const initialTranscriptAfterSeq = readNonNegativeIntegerProperty(payload, 'initialTranscriptAfterSeq');
    const role = readSessionRoleForAttachPayload(payload);
    if ('encryptionMode' in payload && payload.encryptionMode === 'plain') {
      return {
        encryptionMode: 'plain',
        ...(lastObservedMessageSeq !== undefined ? { lastObservedMessageSeq } : {}),
        ...(initialTranscriptAfterSeq !== undefined ? { initialTranscriptAfterSeq } : {}),
        ...role,
      };
    }

    const keyBase64 = payload.encryptionKeyBase64;
    const key = decodeBase64(keyBase64, 'base64');
    if (key.length !== 32) {
      throw new Error('Invalid session encryption key length');
    }

    return {
      encryptionMode: 'e2ee',
      encryptionKey: key,
      encryptionVariant: payload.encryptionVariant,
      ...(lastObservedMessageSeq !== undefined ? { lastObservedMessageSeq } : {}),
      ...(initialTranscriptAfterSeq !== undefined ? { initialTranscriptAfterSeq } : {}),
      ...role,
    };
  } finally {
    // Best-effort cleanup to keep the key short-lived on disk.
    try {
      await unlink(filePath);
    } catch {
      // ignore
    }
  }
}
