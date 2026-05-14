import { decodeBase64 } from '@/api/encryption';
import { assertSessionAttachFilePathWithinBaseDir, resolveSessionAttachBaseDir } from '@/agent/runtime/sessionAttachPaths';
import { SessionAttachPayloadSchema } from '@/agent/runtime/sessionAttachPayload';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { lstat, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

export type SessionAttachSecret =
  | Readonly<{ encryptionMode: 'plain'; lastObservedMessageSeq?: number }>
  | Readonly<{ encryptionMode: 'e2ee'; encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey'; lastObservedMessageSeq?: number }>;

function readLastObservedMessageSeq(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object' || !('lastObservedMessageSeq' in payload)) return undefined;
  const value = payload.lastObservedMessageSeq;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export async function readSessionAttachFromEnv(): Promise<SessionAttachSecret | null> {
  const rawPath = typeof process.env.HAPPIER_SESSION_ATTACH_FILE === 'string' ? process.env.HAPPIER_SESSION_ATTACH_FILE.trim() : '';
  if (!rawPath) return null;
  delete process.env.HAPPIER_SESSION_ATTACH_FILE;

  const filePath = resolve(rawPath);
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
    const lastObservedMessageSeq = readLastObservedMessageSeq(payload);
    if ('encryptionMode' in payload && payload.encryptionMode === 'plain') {
      return {
        encryptionMode: 'plain',
        ...(lastObservedMessageSeq !== undefined ? { lastObservedMessageSeq } : {}),
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
