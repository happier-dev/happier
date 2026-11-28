import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';

import { createCodexRolloutFileIdentity } from '../rollout/codexRolloutFileIdentity';
import type { CodexDurableStreamForwardProgress } from './codexDirectForwardCursor';

const FINGERPRINT_SAMPLE_BYTES = 4 * 1024;

export type CodexRolloutFileBoundary = Readonly<{
  fingerprintOffsetBytes: number;
  fileIdentity: string;
  contentFingerprint: string;
}>;

type BoundaryProgress = Readonly<{
  nextOffsetBytes: number;
  subIndex: number;
  fingerprintOffsetBytes: number;
}>;

function hashParts(parts: readonly (string | Buffer)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    if (typeof part === 'string') {
      hash.update(Buffer.from(part, 'utf8'));
    } else {
      hash.update(part);
    }
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

async function readRange(file: FileHandle, startOffsetBytes: number, lengthBytes: number): Promise<Buffer> {
  if (lengthBytes <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(lengthBytes);
  const result = await file.read(buffer, 0, lengthBytes, startOffsetBytes);
  return result.bytesRead === lengthBytes ? buffer : buffer.subarray(0, result.bytesRead);
}

async function captureFromOpenFile(
  file: FileHandle,
  fingerprintOffsetBytes: number,
  sourceFileIdentity?: string,
): Promise<Readonly<{ sizeBytes: number; boundary: CodexRolloutFileBoundary }> | null> {
  const stats = await file.stat({ bigint: true });
  const sizeBytes = Number(stats.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || fingerprintOffsetBytes > sizeBytes) return null;

  const prefixLength = Math.min(FINGERPRINT_SAMPLE_BYTES, fingerprintOffsetBytes);
  const boundaryLength = Math.min(FINGERPRINT_SAMPLE_BYTES, fingerprintOffsetBytes);
  const boundaryStart = fingerprintOffsetBytes - boundaryLength;
  const [prefix, boundaryBytes] = await Promise.all([
    readRange(file, 0, prefixLength),
    readRange(file, boundaryStart, boundaryLength),
  ]);
  if (prefix.length !== prefixLength || boundaryBytes.length !== boundaryLength) return null;

  // Node exposes device/file identifiers on every supported host. They are only one half
  // of the check: the content anchor below catches in-place rewrites and identifier reuse.
  // Do not include birthtime because Node may synthesize it from mutable ctime on some filesystems.
  const fileIdentity = sourceFileIdentity ?? createCodexRolloutFileIdentity(stats);
  const contentFingerprint = hashParts([
    'codex-rollout-content-boundary-v1',
    String(fingerprintOffsetBytes),
    prefix,
    boundaryBytes,
  ]);
  return {
    sizeBytes,
    boundary: { fingerprintOffsetBytes, fileIdentity, contentFingerprint },
  };
}

export async function captureCodexRolloutFileBoundary(
  filePath: string,
  fingerprintOffsetBytes: number,
  sourceFileIdentity?: string,
): Promise<Readonly<{ sizeBytes: number; boundary: CodexRolloutFileBoundary }> | null> {
  if (!Number.isSafeInteger(fingerprintOffsetBytes) || fingerprintOffsetBytes < 0) return null;
  let file: FileHandle | null = null;
  try {
    file = await open(filePath, 'r');
    return await captureFromOpenFile(file, fingerprintOffsetBytes, sourceFileIdentity);
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

export async function codexRolloutFileBoundaryMatches(
  filePath: string,
  expected: Pick<CodexDurableStreamForwardProgress, 'fingerprintOffsetBytes' | 'fileIdentity' | 'contentFingerprint'>,
  sourceFileIdentity?: string,
): Promise<boolean> {
  const captured = await captureCodexRolloutFileBoundary(filePath, expected.fingerprintOffsetBytes, sourceFileIdentity);
  return captured !== null
    && captured.boundary.fileIdentity === expected.fileIdentity
    && captured.boundary.contentFingerprint === expected.contentFingerprint;
}

export async function captureCodexRolloutTailProgress(filePath: string, sourceFileIdentity?: string): Promise<Readonly<{
  progress: BoundaryProgress;
  boundary: CodexRolloutFileBoundary;
}> | null> {
  let file: FileHandle | null = null;
  try {
    file = await open(filePath, 'r');
    const stats = await file.stat({ bigint: true });
    const sizeBytes = Number(stats.size);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return null;

    const nextOffsetBytes = sizeBytes;
    const captured = await captureFromOpenFile(file, nextOffsetBytes, sourceFileIdentity);
    if (!captured) return null;
    return {
      progress: { nextOffsetBytes, subIndex: 0, fingerprintOffsetBytes: nextOffsetBytes },
      boundary: captured.boundary,
    };
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}
