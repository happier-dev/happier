import { decodeBase64 } from '@/api/encryption';
import type { AgentState, Metadata } from '@/api/types';
import type {
  SessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1,
} from '@happier-dev/protocol';
import { assertSessionAttachFilePathWithinBaseDir, resolveSessionAttachBaseDir } from '@/agent/runtime/sessionAttachPaths';
import { SessionAttachPayloadSchema } from '@/agent/runtime/sessionAttachPayload';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { lstat, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

export type SessionAttachSecret =
  | Readonly<{ encryptionMode: 'plain'; lastObservedMessageSeq?: number; initialTranscriptAfterSeq?: number; snapshot?: SessionAttachSnapshot }>
  | Readonly<{ encryptionMode: 'e2ee'; encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey'; lastObservedMessageSeq?: number; initialTranscriptAfterSeq?: number; snapshot?: SessionAttachSnapshot }>;

export type SessionAttachSnapshot = Readonly<{
  metadata: Metadata;
  metadataVersion: number;
  agentState: AgentState | null;
  agentStateVersion: number;
  metadataLayoutVersion?: 1;
  ownerMetadata?: SessionOwnerMetadataV1;
  ownerMetadataEnvelope?: SessionOwnerMetadataEnvelopeV1;
}>;

function readNonNegativeIntegerProperty(payload: unknown, key: string): number | undefined {
  if (!payload || typeof payload !== 'object' || !(key in payload)) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export async function readSessionAttachFromEnv(): Promise<SessionAttachSecret | null> {
  const rawPath = typeof process.env.HAPPIER_SESSION_ATTACH_FILE === 'string' ? process.env.HAPPIER_SESSION_ATTACH_FILE.trim() : '';
  if (!rawPath) return null;
  delete process.env.HAPPIER_SESSION_ATTACH_FILE;

  return await readSessionAttachFromFile(rawPath);
}

/** Reads a trusted, launch-scoped attach file without consulting or mutating process.env. */
export async function readSessionAttachFromFile(rawPath: string): Promise<SessionAttachSecret> {
  const normalizedRawPath = rawPath.trim();
  if (!normalizedRawPath) throw new Error('Missing session attach file path');

  const filePath = resolve(normalizedRawPath);
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
    const snapshot = 'snapshot' in payload ? payload.snapshot : undefined;
    if ('encryptionMode' in payload && payload.encryptionMode === 'plain') {
      return {
        encryptionMode: 'plain',
        ...(lastObservedMessageSeq !== undefined ? { lastObservedMessageSeq } : {}),
        ...(initialTranscriptAfterSeq !== undefined ? { initialTranscriptAfterSeq } : {}),
        ...(snapshot ? { snapshot: snapshot as SessionAttachSnapshot } : {}),
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
      ...(snapshot ? { snapshot: snapshot as SessionAttachSnapshot } : {}),
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
