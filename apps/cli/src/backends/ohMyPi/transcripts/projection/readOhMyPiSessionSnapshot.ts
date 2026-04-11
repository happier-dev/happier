import { readFile } from 'node:fs/promises';

import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { projectOhMyPiSessionSnapshotToDirectMessages } from './projectOhMyPiSessionSnapshotToDirectMessages';

export type OhMyPiSessionSnapshot = Readonly<{
  items: readonly DirectTranscriptRawMessageV1[];
  tailCursor: string;
  title: string | null;
  workingDirectory: string | null;
  createdAtMs: number | null;
  lastActivityAtMs: number | null;
}>;

export function encodeOhMyPiTranscriptCursor(index: number): string {
  return `idx:${Math.max(0, Math.trunc(index))}`;
}

export function decodeOhMyPiTranscriptCursor(cursor: string | null | undefined, fallback: number): number {
  if (cursor === 'tail') return fallback;
  if (typeof cursor !== 'string' || !cursor.startsWith('idx:')) return fallback;
  const parsed = Number.parseInt(cursor.slice(4), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

export async function readOhMyPiSessionSnapshot(params: Readonly<{
  sessionFilePath: string;
  sessionId: string;
}>): Promise<OhMyPiSessionSnapshot> {
  const content = await readFile(params.sessionFilePath, 'utf8');
  const lines: unknown[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    try {
      lines.push(JSON.parse(line) as unknown);
    } catch {
      // oh-my-pi can leave a partial trailing JSONL line while a session is being written.
      // Skip malformed entries so browse/follow keeps working against the last valid snapshot.
      continue;
    }
  }
  const projected = projectOhMyPiSessionSnapshotToDirectMessages({
    sessionFilePath: params.sessionFilePath,
    sessionId: params.sessionId,
    lines,
  });
  return {
    ...projected,
    tailCursor: encodeOhMyPiTranscriptCursor(projected.items.length),
  };
}
