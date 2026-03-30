import { assertSessionAttachFilePathWithinBaseDir, resolveSessionAttachBaseDir } from '@/agent/runtime/sessionAttachPaths';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import type { SessionAttachFilePayload } from '@/agent/runtime/sessionAttachPayload';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type { SessionAttachFilePayload } from '@/agent/runtime/sessionAttachPayload';

function sanitizeHappySessionIdForFilename(happySessionId: string): string {
  const safe = happySessionId.replace(/[^A-Za-z0-9._-]+/g, '_');
  const trimmed = safe
    .replace(/_+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[_-]+$/, '');

  const normalized = trimmed.length > 0 ? trimmed : 'session';
  return normalized.length > 96 ? normalized.slice(0, 96) : normalized;
}

async function pruneStaleSessionAttachFiles(baseDir: string): Promise<void> {
  const maxAgeMs = configuration.sessionAttachFileMaxAgeMs;
  if (maxAgeMs <= 0) return;

  try {
    const entries = await readdir(baseDir, { withFileTypes: true, encoding: 'utf8' });
    const nowMs = Date.now();
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      if (!(entry.isFile() || entry.isSymbolicLink())) continue;

      const candidate = resolve(join(baseDir, entry.name));
      try {
        assertSessionAttachFilePathWithinBaseDir(baseDir, candidate);
        const s = await lstat(candidate);
        if (nowMs - s.mtimeMs <= maxAgeMs) continue;
        await unlink(candidate);
      } catch {
        // ignore: best-effort only
      }
    }
  } catch {
    return;
  }
}

export async function createSessionAttachFile(params: {
  happySessionId: string;
  payload: SessionAttachFilePayload;
}): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const baseDir = resolveSessionAttachBaseDir(configuration.happyHomeDir, configuration.publicReleaseRing);
  await mkdir(baseDir, { recursive: true, mode: 0o700 });
  // Best-effort: mkdir does not update permissions for existing dirs.
  await chmod(baseDir, 0o700).catch(() => {});
  await pruneStaleSessionAttachFiles(baseDir);

  const safeSessionId = sanitizeHappySessionIdForFilename(params.happySessionId);
  const filePath = resolve(join(baseDir, `${safeSessionId}-${randomUUID()}.json`));
  assertSessionAttachFilePathWithinBaseDir(baseDir, filePath);

  const payloadJson = JSON.stringify(params.payload);
  await writeFile(filePath, payloadJson, { mode: 0o600 });

  const cleanup = async () => {
    try {
      await unlink(filePath);
    } catch {
      // ignore
    }
  };

  logger.debug('[daemon] Created session attach file', { filePath });

  return { filePath, cleanup };
}
